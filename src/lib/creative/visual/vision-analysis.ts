/**
 * M12 — Semantic frame understanding (§3).
 *
 * Sends REAL extracted frames (base64 JPEG data URLs) to the configured
 * vision provider through the VisionProvider gateway and validates the
 * structured response with zod (one informed repair attempt, mirroring
 * chatValidated). Frames are batched (≤ visionBatchSize per request) with an
 * explicit "IMAGE n" label per image so per-frame provenance stays intact.
 *
 * Honesty rules:
 *  - a frame analysis exists ONLY where the provider actually inspected the
 *    frame — provider failures mark frames `failed` with the typed error;
 *  - NOTHING here reads filenames, metadata or transcripts: this module
 *    cannot fabricate visual understanding from text;
 *  - consent is enforced by the CALLER (jobs.ts) — this module only runs
 *    when the user explicitly consented to external frame transmission;
 *  - usage is reported via onUsage for AIUsage accounting (token counts as
 *    reported by the provider — no invented cost rates).
 */
import { VisionBatchResponseSchema, type FrameAnalysis, type VisualFrame, type VisualSettings } from "./contracts";
import { visionProvider, type VisionImage } from "@/lib/my-ai/gateway/vision";
import { LLMError } from "@/lib/my-ai/gateway/provider";
import { extractJson } from "@/lib/my-ai/gateway/structured";
import { readFrameBase64 } from "./frames";

const PROMPT = `You are a video-editing assistant analyzing extracted video frames. For EACH image (labeled IMAGE 1, IMAGE 2, ... in order) return ONE JSON object in the "frames" array, in the SAME order as the images:
{"frames":[{"description":"1-2 sentence scene description","objects":["object","..."],"activities":["activity","..."],"environment":"setting/location or null","visibleText":"any legible on-screen text, or null","shotType":"wide|medium|close-up|unknown","composition":"brief framing note or null","subjectPosition":"where the main subject sits in frame, or null"}]}
Rules: describe ONLY what is actually visible. If something is uncertain, say so in the description — never guess. Respond with ONLY the JSON object.`;

export interface VisionRunOptions {
  /** Injectable provider (fixture tests); default = configured gateway provider. */
  provider?: ReturnType<typeof visionProvider>;
  signal?: AbortSignal;
  onUsage?: (r: { provider: string; model: string; usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null }) => void;
  /** Called after each batch with (done, total). */
  onProgress?: (done: number, total: number) => Promise<void> | void;
}

export interface VisionRunResult {
  analyzedCount: number;
  failedCount: number;
  providerId: string | null;
  model: string | null;
  errors: string[];
}

function issuesOf(err: unknown): string {
  if (err && typeof err === "object" && "issues" in err) {
    const issues = (err as { issues: Array<{ path: (string | number)[]; message: string }> }).issues.slice(0, 6);
    return issues.map((i) => `- ${i.path.join(".") || "root"}: ${i.message}`).join("; ");
  }
  return err instanceof Error ? err.message.slice(0, 300) : "schema validation failed";
}

/** Analyze a batch of frames; returns per-frame analyses or throws a typed error. */
async function analyzeBatch(batch: VisualFrame[], images: VisionImage[], provider: ReturnType<typeof visionProvider>, opts: VisionRunOptions): Promise<FrameAnalysis[]> {
  const labeled = batch.map((f, i) => `IMAGE ${i + 1} (at ${f.sourceSec.toFixed(2)}s)`).join("; ");
  const first = await provider.analyze(PROMPT, images, { timeoutMs: 120_000, signal: opts.signal, purpose: "visual-frame-analysis", instruction: labeled });
  opts.onUsage?.({ provider: provider.id, model: first.model, usage: first.usage });
  try {
    return VisionBatchResponseSchema.parse(extractJson(first.content)).frames;
  } catch (firstErr) {
    // One informed repair attempt with the ACTUAL violations in view.
    const repair = await provider.analyze(
      `${PROMPT}\n\nYour previous reply failed JSON validation with: ${issuesOf(firstErr)}. Respond AGAIN with ONLY corrected JSON.`,
      images,
      { timeoutMs: 120_000, signal: opts.signal, purpose: "visual-frame-analysis-repair", temperature: 0, instruction: labeled },
    );
    opts.onUsage?.({ provider: provider.id, model: repair.model, usage: repair.usage });
    return VisionBatchResponseSchema.parse(extractJson(repair.content)).frames;
  }
}

/**
 * Analyze extracted frames with the configured vision provider. Frames are
 * updated IN PLACE (status → analyzed | failed). Batches continue on failure
 * so one bad request never loses the whole run.
 */
export async function analyzeFramesSemantic(frames: VisualFrame[], files: Map<string, string>, settings: VisualSettings, opts: VisionRunOptions = {}): Promise<VisionRunResult> {
  const provider = opts.provider ?? visionProvider();
  const errors: string[] = [];
  const pending = frames.filter((f) => f.status === "extracted" && files.has(f.frameId));
  const total = pending.length;
  let done = 0;
  let analyzed = 0;
  let failed = 0;

  for (let i = 0; i < pending.length; i += settings.visionBatchSize) {
    if (opts.signal?.aborted) {
      errors.push(`vision analysis cancelled after ${analyzed} frame(s)`);
      break;
    }
    const batch = pending.slice(i, i + settings.visionBatchSize);
    const images: VisionImage[] = [];
    for (const f of batch) {
      try {
        images.push({ mimeType: "image/jpeg", base64: await readFrameBase64(files.get(f.frameId)!) });
      } catch (err) {
        f.status = "failed";
        f.error = `frame file unreadable: ${(err as Error).message.slice(0, 200)}`;
        failed += 1;
      }
    }
    if (images.length === 0) continue;
    try {
      const analyses = await analyzeBatch(batch.filter((f) => f.status === "extracted"), images, provider, opts);
      // The provider may return fewer entries than images — only bind what arrived.
      batch.forEach((f, idx) => {
        if (f.status !== "extracted") return;
        const a = analyses[idx];
        if (!a) {
          f.status = "failed";
          f.error = "vision response had no entry for this image position";
          failed += 1;
          return;
        }
        f.status = "analyzed";
        f.analysis = a;
        f.provider = provider.id;
        f.model = provider.model;
        f.confidence = 0.7; // provider-reported structured description; never a measured fact
        analyzed += 1;
      });
      // Extra entries beyond images are dropped (schema caps ≤ batch size).
    } catch (err) {
      const msg = err instanceof LLMError ? `${err.code}: ${err.message}` : (err as Error).message;
      const short = msg.slice(0, 280);
      for (const f of batch) {
        if (f.status === "extracted") {
          f.status = "failed";
          f.error = short;
          failed += 1;
        }
      }
      errors.push(short);
    }
    done += batch.length;
    await opts.onProgress?.(done, total);
  }
  return { analyzedCount: analyzed, failedCount: failed, providerId: provider.id, model: provider.model, errors };
}
