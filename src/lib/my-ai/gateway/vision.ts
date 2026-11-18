/**
 * M12 — Vision provider gateway (§3).
 *
 * A provider-INDEPENDENT vision seam beside the M8 LLM gateway: adapters
 * implement one interface, callers never import a provider SDK directly. The
 * shipped adapter `zai` uses the environment SDK's REAL `createVision`
 * endpoint with base64 data-URL image content (the recommended transport).
 *
 * Honesty rules (mirror provider.ts):
 *  - a vision provider is "available" only after a REAL round trip succeeded
 *    (health probe with a real 1×1 JPEG);
 *  - failures normalize into typed errors — never a silent provider switch;
 *  - no Ollama anywhere; credentials stay inside the server-side SDK.
 */
import { LLMError, redactSecrets, type LLMChatOptions } from "./provider";

export interface VisionImage {
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  /** Raw image bytes (NOT a URL — frames never pass through third-party hosts). */
  base64: string;
}

export interface VisionAnalyzeOptions extends LLMChatOptions {
  /** Extra instruction appended to the structured-analysis prompt. */
  instruction?: string;
}

export interface VisionAnalyzeResult {
  content: string;
  model: string;
  provider: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
  latencyMs: number;
}

/** The typed vision contract (§3) — one interface, many adapters. */
export interface VisionProvider {
  id: string;
  model: string;
  /** One vision completion over 1..4 images. All failures → LLMError. */
  analyze(prompt: string, images: VisionImage[], options: VisionAnalyzeOptions): Promise<VisionAnalyzeResult>;
  /** REAL round trip against a tiny JPEG. */
  healthCheck(): Promise<{ ok: boolean; detail: string; latencyMs: number }>;
}

/** Minimal valid 1×1 white JPEG — the liveness-probe payload. */
const PROBE_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==";

function normalizeVision(err: unknown, timeoutMs: number): LLMError {
  if (err instanceof LLMError) return err;
  const raw = redactSecrets(err instanceof Error ? err.message : String(err));
  const lower = raw.toLowerCase();
  if (/abort|cancelled|canceled/.test(lower)) return new LLMError("CANCELLED", "Vision request cancelled.");
  if (lower.includes("timeout") || /etimedout|esockettimedout/.test(lower)) return new LLMError("TIMEOUT", `Vision provider did not respond within ${timeoutMs} ms.`);
  if (/401|403|unauthor|invalid api key|authentication/.test(lower)) return new LLMError("AUTH_FAILED", `Vision provider rejected the credentials: ${raw.slice(0, 200)}`);
  if (/429|rate limit/i.test(raw)) return new LLMError("RATE_LIMITED", `Vision provider rate limit reached: ${raw.slice(0, 200)}`);
  return new LLMError("PROVIDER_FAILURE", `Vision provider failed: ${raw.slice(0, 300)}`);
}

function retryableVision(code: LLMError["code"]): boolean {
  return code === "RATE_LIMITED" || code === "PROVIDER_FAILURE" || code === "TIMEOUT";
}

// ── zai SDK adapter (the verified real provider endpoint) ───────────────────
interface ZaiVisionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

interface VisionContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
}

export function createZaiVisionProvider(model: string): VisionProvider {
  return {
    id: "zai",
    model,
    async analyze(prompt, images, options) {
      const started = Date.now();
      const timeoutMs = options.timeoutMs ?? 90_000;
      if (images.length > 4) {
        throw new LLMError("INVALID_RESPONSE", `Vision adapter accepts 0..4 images per call (text-only allowed for ranking/matching), got ${images.length}.`);
      }
      let lastError: LLMError = new LLMError("PROVIDER_FAILURE", "unreachable");
      const retries = Number(process.env.BEANFX_MYAI_RETRIES ?? 2);
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (options.signal?.aborted) throw new LLMError("CANCELLED", "Vision request cancelled.");
        try {
          const mod = (await import("z-ai-web-dev-sdk")) as unknown as {
            default: { create: () => Promise<unknown> };
          };
          const zRaw = await Promise.race([
            mod.default.create(),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("provider init timeout")), timeoutMs)),
          ]);
          const z = zRaw as {
            chat: { completions: { createVision: (body: Record<string, unknown>) => Promise<ZaiVisionResponse> } };
          };
          const content: VisionContentPart[] = [
            { type: "text", text: prompt + (options.instruction ? `\n\n${options.instruction}` : "") },
            ...images.map((img) => ({ type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.base64}` } })),
          ];
          const res = await Promise.race([
            z.chat.completions.createVision({ model, messages: [{ role: "user", content }], thinking: { type: "disabled" } }),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs)),
            new Promise<never>((_, reject) => {
              options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            }),
          ]);
          const text = res.choices?.[0]?.message?.content;
          if (typeof text !== "string") throw new LLMError("INVALID_RESPONSE", "Vision provider returned no message content.");
          return {
            content: text,
            model: res.model ?? model,
            provider: "zai",
            usage: res.usage
              ? { promptTokens: res.usage.prompt_tokens ?? 0, completionTokens: res.usage.completion_tokens ?? 0, totalTokens: res.usage.total_tokens ?? 0 }
              : null,
            latencyMs: Date.now() - started,
          };
        } catch (err) {
          lastError = normalizeVision(err, timeoutMs);
          if (!retryableVision(lastError.code) || attempt === retries) throw lastError;
          if (options.signal?.aborted) throw new LLMError("CANCELLED", "Vision request cancelled.");
          await new Promise((r) => setTimeout(r, Math.min(2000 * (attempt + 1), 8000)));
        }
      }
      throw lastError;
    },
    async healthCheck() {
      const started = Date.now();
      try {
        const res = await this.analyze("What color dominates this image? Answer with one word.", [{ mimeType: "image/jpeg", base64: PROBE_JPEG_BASE64 }], { timeoutMs: 45_000, purpose: "vision-health" });
        return { ok: true, detail: `vision provider responded (${res.model})`, latencyMs: Date.now() - started };
      } catch (err) {
        const e = normalizeVision(err, 45_000);
        return { ok: false, detail: `${e.code}: ${e.message}`, latencyMs: Date.now() - started };
      }
    },
  };
}

// ── registry ────────────────────────────────────────────────────────────────
const VISION_REGISTRY: Record<string, (model: string) => VisionProvider> = {
  zai: createZaiVisionProvider,
};

export function visionModel(): string {
  return process.env.BEANFX_VISUAL_MODEL ?? "glm-4.5v";
}

export function visionProviderId(): string {
  return process.env.BEANFX_VISUAL_PROVIDER ?? "zai";
}

/** Resolve the configured vision provider; honest NOT_CONFIGURED for unknown ids. */
export function visionProvider(): VisionProvider {
  const id = visionProviderId();
  const factory = VISION_REGISTRY[id];
  if (!factory) {
    throw new LLMError("NOT_CONFIGURED", `Vision provider "${id}" is not configured. Available: ${Object.keys(VISION_REGISTRY).join(", ")}. Set BEANFX_VISUAL_PROVIDER to one of them.`);
  }
  return factory(visionModel());
}

let cachedVisionHealth: { ok: boolean; at: number; detail: string } | null = null;
const VISION_HEALTH_TTL_MS = 60_000;

/** TRUE only after a real vision round trip succeeded (cached briefly). */
export async function visionHealth(force = false): Promise<{ ok: boolean; detail: string; cached: boolean }> {
  if (!force && cachedVisionHealth && Date.now() - cachedVisionHealth.at < VISION_HEALTH_TTL_MS) {
    return { ok: cachedVisionHealth.ok, detail: cachedVisionHealth.detail, cached: true };
  }
  try {
    const h = await visionProvider().healthCheck();
    cachedVisionHealth = { ok: h.ok, at: Date.now(), detail: h.detail };
    return { ok: h.ok, detail: h.detail, cached: false };
  } catch (err) {
    const e = normalizeVision(err, 45_000);
    cachedVisionHealth = { ok: false, at: Date.now(), detail: `${e.code}: ${e.message}` };
    return { ok: false, detail: `${e.code}: ${e.message}`, cached: false };
  }
}
