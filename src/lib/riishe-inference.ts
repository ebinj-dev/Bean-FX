/**
 * BEAN FX — RIISHE semantic inference (the ONE inference implementation).
 *
 * Used by BOTH /api/autocut/analyze (the unified RIISHE pipeline stage 9) and
 * /api/riishe (standalone re-classification endpoint, kept for compatibility).
 * There is no other inference code path.
 *
 * The provider receives the measured audio evidence plus the validated
 * transcript and must return strictly-structured classifications. Candidates
 * are batched (60 per call) so long lists cannot blow the provider's context;
 * every batch is retried once on transient failure and bounded by a hard
 * timeout. A provider outage or malformed output raises — the caller reports
 * the stage honestly and the deterministic classification stands. No fake
 * inference, and speech is never REMOVE merely because inference failed.
 */
import ZAI from "z-ai-web-dev-sdk";
import { z } from "zod";

export interface RiisheCandidateInput {
  id: string;
  start: number;
  end: number;
  duration: number;
  rms: number;
  snr: number;
  transcriptText: string | null;
  transcriptWordsInRange?: number;
  intraSentence?: boolean;
  quietSpeechNearby?: boolean;
  repeatedTake?: boolean;
  /** Text of the sentence before / after the pause (continuity context). */
  prevSentence?: string | null;
  nextSentence?: string | null;
  deterministicReview?: "REMOVE" | "REVIEW" | "KEEP";
  /** Set when the candidate comes from the user's words-to-remove list: the
   *  user WANTS this phrase considered for removal, but each occurrence must
   *  still be judged in context (never blind deletion). */
  wordMatchPhrase?: string | null;
}

export interface RiisheInput {
  mediaName: string;
  durationSec: number;
  sensitivity: "LOW" | "BALANCED" | "HIGH";
  candidates: RiisheCandidateInput[];
  transcriptSegments: { id: string; start: number; end: number; text: string }[];
}

export interface RiisheSuggestion {
  id: string;
  action: "REMOVE" | "KEEP" | "REVIEW";
  confidence: number;
  reason: string;
  riskNotes?: string | null;
}

export interface RiisheInferenceResult {
  model: string;
  suggestions: RiisheSuggestion[];
  summary: string | null;
  candidatesClassified: number;
  batches: number;
  batchErrors: string[];
}

const candidateSchema = z.object({
  id: z.string(),
  start: z.number().min(0),
  end: z.number().min(0),
  duration: z.number().min(0),
  rms: z.number(),
  snr: z.number(),
  transcriptText: z.string().nullable(),
  transcriptWordsInRange: z.number().optional(),
  intraSentence: z.boolean().optional(),
  quietSpeechNearby: z.boolean().optional(),
  repeatedTake: z.boolean().optional(),
  prevSentence: z.string().nullable().optional(),
  nextSentence: z.string().nullable().optional(),
  deterministicReview: z.enum(["REMOVE", "REVIEW", "KEEP"]).optional(),
  wordMatchPhrase: z.string().nullable().optional(),
});

const inputSchema = z.object({
  mediaName: z.string().max(200),
  durationSec: z.number().positive(),
  sensitivity: z.enum(["LOW", "BALANCED", "HIGH"]),
  candidates: z.array(candidateSchema).max(400),
  transcriptSegments: z.array(z.object({ id: z.string(), start: z.number().min(0), end: z.number().min(0), text: z.string() })).max(1200),
});

const suggestionSchema = z.object({
  id: z.string(),
  action: z.enum(["REMOVE", "KEEP", "REVIEW"]),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(600),
  riskNotes: z.string().max(600).optional().nullable(),
});

const outputSchema = z.object({
  suggestions: z.array(suggestionSchema).min(1),
  summary: z.string().max(1200).optional().nullable(),
});

const BATCH_SIZE = 30; // small batches keep provider responses well under truncation size
const BATCH_TIMEOUT_MS = 120_000;

export type SemanticProviderId = "zai" | "local-http";

export interface SemanticProviderConfig {
  id: SemanticProviderId;
  label: string;
  endpoint?: string;
  model?: string;
  /** Why this provider was selected — safe to log verbatim (no secret values). */
  reason: string;
}

/**
 * Resolve the semantic-classification provider from the environment.
 * Default stays "zai"; workstation deployments can select an OpenAI-compatible
 * local chat endpoint (e.g. llama.cpp server / LM Studio / vLLM behind /v1/chat/completions):
 *
 *   BEANFX_SEMANTIC_PROVIDER=local-http
 *   BEANFX_SEMANTIC_ENDPOINT=http://127.0.0.1:9001/v1/chat/completions
 *   BEANFX_SEMANTIC_MODEL=<local model id>   (optional)
 *
 * There is deliberately NO automatic fallback: an unavailable provider raises
 * and the caller reports the stage honestly.
 */
export function resolveSemanticProvider(env: Record<string, string | undefined> = process.env): SemanticProviderConfig {
  const id = (env.BEANFX_SEMANTIC_PROVIDER ?? "zai").trim().toLowerCase();
  if (id === "local-http") {
    const endpoint = env.BEANFX_SEMANTIC_ENDPOINT?.trim();
    if (!endpoint) {
      throw new Error("BEANFX_SEMANTIC_PROVIDER=local-http requires BEANFX_SEMANTIC_ENDPOINT (an OpenAI-compatible /chat/completions URL).");
    }
    return {
      id: "local-http",
      label: `local-http (${endpoint})`,
      endpoint,
      model: env.BEANFX_SEMANTIC_MODEL?.trim() || undefined,
      reason: "BEANFX_SEMANTIC_PROVIDER=local-http",
    };
  }
  return {
    id: "zai",
    label: "zai (configured cloud SDK)",
    reason: env.BEANFX_SEMANTIC_PROVIDER ? "BEANFX_SEMANTIC_PROVIDER=zai" : "BEANFX_SEMANTIC_PROVIDER unset — default",
  };
}

/** Parse the provider's JSON leniently: trailing commas stripped, and on a
 *  mid-array parse failure the suggestions array is rescued up to the last
 *  complete object instead of losing the whole batch. */
function lenientParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const noTrailing = text.replace(/,\s*([}\]])/g, "$1");
    try {
      return JSON.parse(noTrailing);
    } catch {
      // Rescue: keep everything up to the last complete object and close the
      // array/object — suggestions before the truncation survive.
      const arrStart = noTrailing.indexOf('"suggestions"');
      const lastBrace = noTrailing.lastIndexOf("}");
      if (arrStart === -1 || lastBrace < arrStart) throw new Error("No usable suggestions array in provider response.");
      return JSON.parse(`${noTrailing.slice(0, lastBrace + 1).replace(/,\s*$/, "")}]}`);
    }
  }
}

/** Safe-parse validator shared by every inference entry point. */
export function validateRiisheInput(body: unknown) {
  return inputSchema.safeParse(body);
}

function systemPrompt(): string {
  return [
    "You are RIISHE, the content-aware editing coordinator inside BEAN FX, a professional media editor.",
    "You classify proposed cut ranges for a recording. You must be conservative: never remove speech or meaningful pauses.",
    "Classify each candidate as:",
    '- REMOVE: evidence (silence + low SNR + no transcript speech in range) clearly supports removing unwanted silence or clearly unwanted segments (e.g., repeated false takes, production chatter).',
    '- KEEP: the range contains or borders speech, breaths, meaningful pauses, music, or important context. A pause inside an ongoing sentence must be KEEP — e.g. "The reason this happened... [pause] ...was because the system failed." is ONE sentence; the pause carries meaning and the next fragment continues the thought (starts lowercase, or with a connective like "because", "and", "which", "was", "so", "that").',
    "- REVIEW: evidence is ambiguous or conflicting (e.g., silence but transcript shows words, a possible dramatic pause, a possible repeated take, unknown sentence boundaries).",
    "Some ranges carry wordMatch=\"…\": the USER asked for this word/phrase to be considered for removal. Even so, judge every occurrence in context: a standalone filler between pauses may be REMOVE; the same word doing real work in a sentence (technical term, meaningful repetition, quoted speech) must be KEEP or REVIEW. Never remove a whole sentence because one unwanted word appears in it — the range only covers the matched words.",
    "Sensitivity arrives with each request (LOW = keep more, HIGH = remove more, but speech is always preserved).",
    "If the transcript has no sentence punctuation, sentence boundaries are UNKNOWN: never REMOVE on your own guess — use REVIEW.",
    'Respond with ONLY a JSON object: {"suggestions": [{"id": string, "action": "REMOVE"|"KEEP"|"REVIEW", "confidence": 0..1, "reason": string, "riskNotes": string|null}], "summary": string}',
    "Every candidate id must appear exactly once. Do not invent new ids. Do not output any other keys or prose.",
  ].join("\n");
}

/** Pull the JSON object substring out of the provider's reply (fenced or bare). */
function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("No JSON object found in provider response.");
  return raw.slice(start, end + 1);
}

function candidateLine(c: RiisheCandidateInput): string {
  const flags = [
    c.transcriptWordsInRange ? `wordsInRange=${c.transcriptWordsInRange}` : null,
    c.intraSentence ? "intraSentence=true" : null,
    c.quietSpeechNearby ? "quietSpeechNearby=true" : null,
    c.repeatedTake ? "repeatedTake=true" : null,
    c.deterministicReview ? `deterministic=${c.deterministicReview}` : null,
    c.wordMatchPhrase ? `wordMatch="${c.wordMatchPhrase}"` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const prev = c.prevSentence ? ` prev="${c.prevSentence.slice(-90)}"` : "";
  const next = c.nextSentence ? ` next="${c.nextSentence.slice(0, 90)}"` : "";
  return `id=${c.id} start=${c.start.toFixed(2)}s end=${c.end.toFixed(2)}s dur=${c.duration.toFixed(2)}s rms=${c.rms.toFixed(4)} snr=${c.snr.toFixed(2)}${c.transcriptText ? ` text="${c.transcriptText.slice(0, 160)}"` : " text=null"}${prev}${next}${flags ? ` ${flags}` : ""}`;
}

/** One chat completion: messages in, assistant text out — provider-agnostic. */
type CompleteFn = (messages: { role: string; content: string }[]) => Promise<string>;

function zaiComplete(): CompleteFn {
  return async (messages) => {
    const zai = await ZAI.create();
    const completion = await zai.chat.completions.create({
      messages: messages as Parameters<typeof zai.chat.completions.create>[0]["messages"],
      thinking: { type: "disabled" },
    });
    return completion?.choices?.[0]?.message?.content ?? "";
  };
}

/** OpenAI-compatible POST for self-hosted models (llama.cpp / vLLM / LM Studio …). */
function localHttpComplete(cfg: SemanticProviderConfig): CompleteFn {
  return async (messages) => {
    let res: Response;
    try {
      res = await fetch(cfg.endpoint!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: cfg.model ?? "local", messages, temperature: 0.2 }),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (err) {
      // Name the endpoint so job logs identify WHICH provider failed — and so
      // isProviderUnavailable() can classify the outage honestly.
      throw new Error(`local semantic endpoint unreachable (${cfg.endpoint}): ${err instanceof Error ? err.message : err}`);
    }
    if (!res.ok) {
      throw new Error(`local semantic endpoint answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string } }[] } | null;
    return data?.choices?.[0]?.message?.content ?? "";
  };
}

async function inferBatch(
  complete: CompleteFn,
  mediaName: string,
  durationSec: number,
  sensitivity: RiisheInput["sensitivity"],
  transcriptForPrompt: string,
  batch: RiisheCandidateInput[]
): Promise<{ suggestions: RiisheSuggestion[]; summary: string | null }> {
  const userPrompt = [
    `Recording: "${mediaName}" — total duration ${durationSec.toFixed(2)}s. Sensitivity: ${sensitivity}.`,
    "",
    "TRANSCRIPT (timing is estimated from speech energy; treat as approximate):",
    transcriptForPrompt,
    "",
    "CANDIDATE RANGES (measured audio evidence; prev/next show the neighbouring sentences for continuity):",
    batch.map(candidateLine).join("\n"),
  ].join("\n");

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const content = await Promise.race([
        complete([
          { role: "assistant", content: systemPrompt() },
          { role: "user", content: userPrompt },
        ]),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("provider timed out after 120s")), BATCH_TIMEOUT_MS)),
      ]);
      if (!content.trim()) throw new Error("provider returned an empty response");
      const parsedOut = outputSchema.parse(lenientParse(extractJson(content)));
      return { suggestions: parsedOut.suggestions, summary: parsedOut.summary ?? null };
    } catch (err) {
      lastErr = err;
      if (attempt < 1) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("inference failed");
}

/** True when the error means "no provider configured / unreachable" rather
 *  than "provider answered but the output was unusable". */
export function isProviderUnavailable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /credentials|api key|unauthorized|401|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network|not configured|no provider|unreachable|unable to connect/i.test(msg);
}

export async function runRiisheInference(input: RiisheInput): Promise<RiisheInferenceResult> {
  if (input.candidates.length === 0) {
    throw new Error("No candidate ranges supplied for inference.");
  }
  const transcriptForPrompt = input.transcriptSegments.length
    ? input.transcriptSegments
        .slice(0, 400)
        .map((s) => `[${s.start.toFixed(2)}s - ${s.end.toFixed(2)}s] ${s.text}`)
        .join("\n")
    : "(no validated transcript available — classify on audio evidence only)";

  const provider = resolveSemanticProvider();
  console.log(`[riishe] provider_resolution stage=semantic selected=${provider.id} model=${provider.model ?? "provider-default"} reason=${provider.reason}`);
  const complete = provider.id === "local-http" ? localHttpComplete(provider) : zaiComplete();
  const modelLabel = provider.id === "local-http" ? `local-http${provider.model ? `:${provider.model}` : ""}` : "zai-chat";
  const batches: RiisheCandidateInput[][] = [];
  for (let i = 0; i < input.candidates.length; i += BATCH_SIZE) batches.push(input.candidates.slice(i, i + BATCH_SIZE));

  const all: RiisheSuggestion[] = [];
  const summaries: string[] = [];
  const batchErrors: string[] = [];
  for (let i = 0; i < batches.length; i++) {
    try {
      const out = await inferBatch(complete, input.mediaName, input.durationSec, input.sensitivity, transcriptForPrompt, batches[i]);
      all.push(...out.suggestions);
      if (out.summary) summaries.push(out.summary);
    } catch (err) {
      // One unusable batch must not fabricate classifications for it — the
      // caller decides how to report the incomplete coverage.
      batchErrors.push(`batch ${i + 1}/${batches.length}: ${err instanceof Error ? err.message : "inference failed"}`);
    }
  }

  const byId = new Map(all.map((s) => [s.id, s]));
  const missing = input.candidates.filter((c) => !byId.has(c.id)).map((c) => c.id);
  if (missing.length || batchErrors.length) {
    const detail = [
      missing.length ? `${missing.length} candidate range(s) received no classification (${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""})` : null,
      ...batchErrors,
    ]
      .filter(Boolean)
      .join("; ");
    const err = new Error(detail || "RIISHE inference produced no usable output.");
    (err as Error & { partial?: RiisheInferenceResult }).partial = {
      model: modelLabel,
      suggestions: all,
      summary: summaries.join(" ") || null,
      candidatesClassified: all.length,
      batches: batches.length,
      batchErrors,
    };
    throw err;
  }

  return {
    model: modelLabel,
    suggestions: all,
    summary: summaries.join(" ") || null,
    candidatesClassified: input.candidates.length,
    batches: batches.length,
    batchErrors,
  };
}
