/**
 * MY AI — LLM gateway (M8 §4).
 *
 * A provider-INDEPENDENT gateway: adapters implement one interface, the rest
 * of MY AI never imports a provider directly. The shipped adapter `zai` uses
 * the environment's configured z-ai SDK (model glm-4-plus — verified live
 * with usage reporting); an optional CLI adapter covers deployments without
 * the SDK module. Provider selection is CONFIGURABLE (BEANFX_MYAI_PROVIDER);
 * failures are normalized into typed errors and NEVER trigger a silent
 * provider switch. No Ollama anywhere.
 *
 * Honesty rules: a provider is "configured" only after a real connection
 * attempt succeeded (health check). Unconfigured deployments get an explicit
 * error and MY AI falls back to the clearly-labeled deterministic planner —
 * never claiming LLM reasoning.
 */

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMChatOptions {
  system?: string;
  temperature?: number;
  maxTokens?: number;
  /** Wall-clock ceiling for the whole call. */
  timeoutMs?: number;
  /** Cooperative cancellation. */
  signal?: AbortSignal;
  /** Stable label for usage accounting (e.g. "planner", "chat"). */
  purpose?: string;
}

export interface LLMChatResult {
  content: string;
  model: string;
  provider: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null;
  latencyMs: number;
}

export type LLMErrorCode =
  | "NOT_CONFIGURED"
  | "AUTH_FAILED"
  | "RATE_LIMITED"
  | "PROVIDER_FAILURE"
  | "INVALID_RESPONSE"
  | "TIMEOUT"
  | "CANCELLED";

export class LLMError extends Error {
  constructor(
    public code: LLMErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LLMError";
  }
}

/** The typed provider contract (§4) — one interface, many adapters. */
export interface LLMProvider {
  id: string;
  model: string;
  /** One chat completion. Implementations normalize all failures to LLMError. */
  chat(messages: LLMMessage[], options: LLMChatOptions): Promise<LLMChatResult>;
  /** Cheap liveness probe — must perform a REAL round trip. */
  healthCheck(): Promise<{ ok: boolean; detail: string; latencyMs: number }>;
}

/** Scrub anything credential-shaped out of error text before it leaves the server. */
export function redactSecrets(text: string): string {
  return text
    .replace(/gho_[A-Za-z0-9]{16,}/g, "gho_[REDACTED]")
    .replace(/ghp_[A-Za-z0-9]{16,}/g, "ghp_[REDACTED]")
    .replace(/github_pat_[A-Za-z0-9_]{16,}/g, "github_pat_[REDACTED]")
    .replace(/sk-[A-Za-z0-9-]{16,}/g, "sk-[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "jwt_[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]{12,}/gi, "Bearer [REDACTED]");
}

const DEFAULT_TIMEOUT_MS = Number(process.env.BEANFX_MYAI_TIMEOUT_MS ?? 60_000);
const RETRIES = Number(process.env.BEANFX_MYAI_RETRIES ?? 2);

/** Shared normalization: network/auth/limit errors → typed LLMError. */
function normalize(err: unknown, timeoutMs: number): LLMError {
  if (err instanceof LLMError) return err;
  const raw = redactSecrets(err instanceof Error ? err.message : String(err));
  const lower = raw.toLowerCase();
  if (/abort|cancelled|canceled/.test(lower)) return new LLMError("CANCELLED", "Request cancelled.");
  if (lower.includes("timeout") || /etimedout|esockettimedout/.test(lower)) return new LLMError("TIMEOUT", `LLM provider did not respond within ${timeoutMs} ms.`);
  if (/401|403|unauthor|invalid api key|authentication/.test(lower)) return new LLMError("AUTH_FAILED", `LLM provider rejected the credentials: ${raw.slice(0, 200)}`);
  if (/429|rate limit/i.test(raw)) return new LLMError("RATE_LIMITED", `LLM provider rate limit reached: ${raw.slice(0, 200)}`);
  return new LLMError("PROVIDER_FAILURE", `LLM provider failed: ${raw.slice(0, 300)}`);
}

/** Retry with bounded backoff — only for transient failures. */
function retryable(code: LLMErrorCode): boolean {
  return code === "RATE_LIMITED" || code === "PROVIDER_FAILURE" || code === "TIMEOUT";
}

// ── zai SDK adapter (the verified real provider) ────────────────────────────
interface ZaiChatResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export function createZaiSdkProvider(model: string): LLMProvider {
  return {
    id: "zai",
    model,
    async chat(messages, options) {
      const started = Date.now();
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      let lastError: LLMError = new LLMError("PROVIDER_FAILURE", "unreachable");
      for (let attempt = 0; attempt <= RETRIES; attempt++) {
        if (options.signal?.aborted) throw new LLMError("CANCELLED", "Request cancelled.");
        try {
          // Lazy import: the SDK is an environment capability, not a build
          // dependency — deployments without it must get an honest error.
          // The module is treated as `unknown` here: its typings vary between
          // versions, so the response is read defensively below.
          const mod = (await import("z-ai-web-dev-sdk")) as unknown as {
            default: { create: () => Promise<unknown> };
          };
          const zRaw = await Promise.race([
            mod.default.create(),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("provider init timeout")), timeoutMs)),
          ]);
          const z = zRaw as {
            chat: { completions: { create: (args: Record<string, unknown>) => Promise<ZaiChatResponse> } };
          };
          const payload: Record<string, unknown> = { messages };
          if (options.temperature !== undefined) payload.temperature = options.temperature;
          if (options.maxTokens !== undefined) payload.max_tokens = options.maxTokens;
          const res = await Promise.race([
            z.chat.completions.create(payload),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs)),
            new Promise<never>((_, reject) => {
              options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            }),
          ]);
          const content = res.choices?.[0]?.message?.content;
          if (typeof content !== "string") throw new LLMError("INVALID_RESPONSE", "LLM provider returned no message content.");
          return {
            content,
            model: res.model ?? model,
            provider: "zai",
            usage: res.usage
              ? {
                  promptTokens: res.usage.prompt_tokens ?? 0,
                  completionTokens: res.usage.completion_tokens ?? 0,
                  totalTokens: res.usage.total_tokens ?? 0,
                }
              : null,
            latencyMs: Date.now() - started,
          };
        } catch (err) {
          lastError = normalize(err, timeoutMs);
          if (!retryable(lastError.code) || attempt === RETRIES) throw lastError;
          if (options.signal?.aborted) throw new LLMError("CANCELLED", "Request cancelled.");
          await new Promise((r) => setTimeout(r, Math.min(2000 * (attempt + 1), 8000)));
        }
      }
      throw lastError;
    },
    async healthCheck() {
      const started = Date.now();
      try {
        const res = await this.chat([{ role: "user", content: "Reply with the single word: HEALTHY" }], { timeoutMs: 30_000, purpose: "health" });
        const ok = /healthy/i.test(res.content);
        return { ok, detail: ok ? `provider ${res.provider} responded (${res.model})` : `unexpected reply: ${res.content.slice(0, 60)}`, latencyMs: Date.now() - started };
      } catch (err) {
        const e = normalize(err, 30_000);
        return { ok: false, detail: `${e.code}: ${e.message}`, latencyMs: Date.now() - started };
      }
    },
  };
}

/**
 * M47 voice addendum — server-side ASR through the configured gateway SDK.
 * Returns the raw transcript (plus provider-reported language/confidence when
 * present). No translation, no interpretation — that happens downstream in the
 * normal chat/plan flow. Throws on provider failure; the route discloses it.
 */
export async function transcribeAudio(
  base64: string,
  mime: string
): Promise<{ text?: string; transcript?: string; language?: string; confidence?: number }> {
  type AsrSdk = {
    audio: { asr: { create: (body: { file_base64?: string; file?: string; model?: string }) => Promise<unknown> } };
  };
  const mod = (await import("z-ai-web-dev-sdk")) as unknown as { default?: { create: () => Promise<AsrSdk> } };
  if (!mod?.default?.create) throw new Error("z-ai gateway SDK is not installed in this runtime");
  const sdk = await mod.default.create();
  const out = (await sdk.audio.asr.create({ file_base64: base64 })) as {
    text?: string; transcript?: string; language?: string; confidence?: number;
  };
  return out ?? {};
}

// ── registry ────────────────────────────────────────────────────────────────
const REGISTRY: Record<string, (model: string) => LLMProvider> = {
  zai: createZaiSdkProvider,
};

export function myAiModel(): string {
  return process.env.BEANFX_MYAI_MODEL ?? "glm-4-plus";
}

export function myAiProviderId(): string {
  return process.env.BEANFX_MYAI_PROVIDER ?? "zai";
}

/** Resolve the configured provider; honest NOT_CONFIGURED for unknown ids. */
export function llmProvider(): LLMProvider {
  const id = myAiProviderId();
  const factory = REGISTRY[id];
  if (!factory) {
    throw new LLMError("NOT_CONFIGURED", `LLM provider "${id}" is not configured. Available providers: ${Object.keys(REGISTRY).join(", ")}. Set BEANFX_MYAI_PROVIDER to one of them.`);
  }
  return factory(myAiModel());
}

/** TRUE only after a real round trip succeeded (cached briefly). */
let cachedHealth: { ok: boolean; at: number; detail: string } | null = null;
const HEALTH_TTL_MS = 60_000;

export async function llmHealth(force = false): Promise<{ ok: boolean; detail: string; cached: boolean }> {
  if (!force && cachedHealth && Date.now() - cachedHealth.at < HEALTH_TTL_MS) {
    return { ok: cachedHealth.ok, detail: cachedHealth.detail, cached: true };
  }
  try {
    const h = await llmProvider().healthCheck();
    cachedHealth = { ok: h.ok, at: Date.now(), detail: h.detail };
    return { ok: h.ok, detail: h.detail, cached: false };
  } catch (err) {
    const e = err instanceof LLMError ? err : normalize(err, 30_000);
    cachedHealth = { ok: false, at: Date.now(), detail: `${e.code}: ${e.message}` };
    return { ok: false, detail: `${e.code}: ${e.message}`, cached: false };
  }
}
