/**
 * BEAN FX — ASR provider adapters for the RIISHE pipeline.
 *
 * The default provider is the configured z-ai SDK (cloud). For workstation
 * deployments a local, OpenAI-compatible HTTP endpoint can be selected:
 *
 *   BEANFX_ASR_PROVIDER=local-http
 *   BEANFX_ASR_ENDPOINT=http://127.0.0.1:9000/v1/audio/transcriptions
 *   BEANFX_ASR_MODEL=faster-whisper-large-v3   (optional)
 *
 * That contract is spoken by faster-whisper servers (speaches), whisper.cpp
 * server, and most self-hosted ASR gateways — one adapter covers them. RIISHE
 * still owns every decision: a provider only returns text for a chunk, never
 * classifications, and an unavailable or failed provider is reported honestly
 * by the pipeline — nothing is invented.
 */

export type AsrProviderId = "zai" | "local-http";

export interface AsrProviderConfig {
  id: AsrProviderId;
  label: string;
  endpoint?: string;
  model?: string;
  /** Why this provider was selected — safe to log verbatim (no secret values). */
  reason: string;
}

/** Resolve the active ASR provider from the environment (default: zai). */
export function resolveAsrProvider(env: Record<string, string | undefined> = process.env): AsrProviderConfig {
  const id = (env.BEANFX_ASR_PROVIDER ?? "zai").trim().toLowerCase();
  if (id === "local-http") {
    const endpoint = env.BEANFX_ASR_ENDPOINT?.trim();
    if (!endpoint) {
      throw new Error("BEANFX_ASR_PROVIDER=local-http requires BEANFX_ASR_ENDPOINT (an OpenAI-compatible /audio/transcriptions URL).");
    }
    return {
      id: "local-http",
      label: `local-http (${endpoint})`,
      endpoint,
      model: env.BEANFX_ASR_MODEL?.trim() || undefined,
      reason: "BEANFX_ASR_PROVIDER=local-http",
    };
  }
  return {
    id: "zai",
    label: "zai (configured cloud SDK)",
    reason: env.BEANFX_ASR_PROVIDER ? "BEANFX_ASR_PROVIDER=zai" : "BEANFX_ASR_PROVIDER unset — default",
  };
}

/** Memoized z-ai SDK client — created once per server process. */
let zaiClientPromise: Promise<{ audio: { asr: { create: (input: { file_base64: string }) => Promise<{ text?: string }> } } }> | null = null;
async function getZaiClient() {
  if (!zaiClientPromise) {
    zaiClientPromise = import("z-ai-web-dev-sdk")
      .then((m) => m.default.create())
      .catch((err) => {
        zaiClientPromise = null;
        throw err;
      });
  }
  return zaiClientPromise;
}

/**
 * Transcribe one 16 kHz mono WAV chunk with the active provider. Returns the
 * recognized text (possibly empty for silence) — never a fabricated result.
 * The caller owns retries, rate-limit pacing and failure accounting.
 */
export async function transcribeChunkViaProvider(cfg: AsrProviderConfig, wav: Buffer): Promise<string> {
  if (cfg.id === "local-http") {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "chunk.wav");
    form.append("model", cfg.model ?? "whisper-1");
    form.append("response_format", "json");
    let res: Response;
    try {
      res = await fetch(cfg.endpoint!, { method: "POST", body: form, signal: AbortSignal.timeout(120_000) });
    } catch (err) {
      // Name the endpoint so job logs identify WHICH provider failed — and so
      // isProviderUnavailable() can classify the outage honestly.
      throw new Error(`local ASR endpoint unreachable (${cfg.endpoint}): ${err instanceof Error ? err.message : err}`);
    }
    if (!res.ok) {
      throw new Error(`local ASR endpoint answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = (await res.json().catch(() => null)) as { text?: string } | null;
    return String(data?.text ?? "").trim();
  }
  const zai = await getZaiClient();
  const res = await zai.audio.asr.create({ file_base64: wav.toString("base64") });
  return String(res?.text ?? "").trim();
}
