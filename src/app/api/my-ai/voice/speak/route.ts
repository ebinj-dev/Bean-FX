/**
 * M47 VOICE ADDENDUM — RIISHE spoken responses.
 * M47.1 §A1 — RELIABLE FORMAT CONTRACT:
 *  - the gateway TTS is called with an explicit `response_format: "wav"`;
 *  - the returned bytes are then VERIFIED by magic number, not assumed:
 *      · real WAV / MP3 / OGG / FLAC / AAC / WebM → passed through with the
 *        MIME the bytes actually carry;
 *      · headerless raw PCM (the documented fallback contract, 16 kHz mono
 *        16-bit LE) → wrapped in a REAL RIFF/WAVE header;
 *      · anything unrecognised → honest 502, no fake audio;
 *  - the response carries `mimeType` + `format` so the client never has to
 *    guess (the old defect: WAV bytes labelled `audio/mpeg` at playback);
 *  - when the gateway is absent the route reports { supported:false } and the
 *    UI falls back to silent text (never claiming speech it cannot do).
 * Audio is returned as base64 for a single playback — nothing is stored.
 */
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { detectAudioFormat, wrapPcmAsWav } from "@/lib/audio-format";
import { voiceLanguageById } from "@/lib/voice-language";

export const runtime = "nodejs";

const MAX_CHARS = 1200;
const MIN_AUDIO_BYTES = 100;

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  const body = await req.json().catch(() => null);
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  const language = typeof body?.language === "string" ? body.language : undefined;
  if (!text) return NextResponse.json({ error: "`text` is required." }, { status: 400 });
  if (text.length > MAX_CHARS) {
    return NextResponse.json({ error: `Reply too long for speech synthesis (${text.length} > ${MAX_CHARS} chars) — show the transcript instead.` }, { status: 413 });
  }
  // Truthful language handling: the TTS provider documents voice/speed/format
  // but no language parameter. The requested language is echoed with its
  // honest status instead of being silently dropped or faked.
  const langInfo = voiceLanguageById(language);

  let sdk: unknown;
  try {
    const mod = await import("z-ai-web-dev-sdk");
    sdk = mod;
  } catch {
    return NextResponse.json({
      supported: false,
      reason: "Voice output requires the configured gateway SDK, which is not installed — text transcript is always available.",
    }, { status: 503 });
  }

  type TtsClient = { audio: { tts: { create: (b: { input: string; voice?: string; speed?: number; response_format?: string; stream?: boolean }) => Promise<unknown> } } };
  try {
    const mod = sdk as { default?: { create: () => Promise<TtsClient> } } | undefined;
    if (!mod?.default?.create) throw new Error("gateway adapter unavailable");
    const client = await mod.default.create();
    // Explicit, documented request: WAV container, no streaming.
    const raw = (await client.audio.tts.create({ input: text, response_format: "wav", stream: false })) as
      | Response
      | { audio?: string; audio_base64?: string; data?: string };
    let bytes: Uint8Array | undefined;
    let providerShape = "unknown";
    if (typeof raw === "string") {
      bytes = new Uint8Array(Buffer.from(raw, "base64"));
      providerShape = "base64-string";
    } else if (raw && typeof (raw as Response).arrayBuffer === "function") {
      bytes = new Uint8Array(await (raw as Response).arrayBuffer());
      providerShape = "binary-response";
    } else {
      const b64 = (raw as { audio_base64?: string }).audio_base64
        ?? (raw as { audio?: string }).audio
        ?? (raw as { data?: string }).data;
      if (typeof b64 === "string") {
        bytes = new Uint8Array(Buffer.from(b64, "base64"));
        providerShape = "object-base64";
      }
    }
    if (!bytes || bytes.length < MIN_AUDIO_BYTES) {
      return NextResponse.json({
        supported: false,
        reason: "The speech provider returned no usable audio — the transcript remains available.",
      }, { status: 502 });
    }

    // M47.1: verify the bytes, then label them. Never the reverse.
    const info = detectAudioFormat(bytes);
    let payload: Uint8Array;
    let mime: string;
    let wrappedFrom: string | null = null;
    if (info.headered && info.mime) {
      payload = bytes;
      mime = info.mime;
    } else if (info.format === "raw-pcm") {
      // Documented provider fallback: 16 kHz mono 16-bit LE PCM → real WAV.
      payload = wrapPcmAsWav(bytes, 16000, 1, 16);
      mime = "audio/wav";
      wrappedFrom = "raw-pcm";
    } else {
      return NextResponse.json({
        supported: false,
        reason: `The speech provider returned unrecognised audio bytes (${bytes.length} B) — playback refused; the transcript remains available.`,
      }, { status: 502 });
    }

    return NextResponse.json({
      supported: true,
      audioBase64: Buffer.from(payload).toString("base64"),
      mimeType: mime,
      format: wrappedFrom ? "wav" : info.format,
      bytes: payload.length,
      wrappedFrom,
      providerShape,
      requestedLanguage: langInfo ? { id: langInfo.id, status: langInfo.status, note: langInfo.note } : undefined,
      provider: "gateway TTS",
      disclosure:
        `Audio verified by magic number and delivered as ${mime}` +
        (wrappedFrom ? ` (headerless PCM wrapped in a real WAV container)` : "") +
        `. Native-language accuracy depends on the provider voice — the text transcript is authoritative.`,
    });
  } catch (err) {
    return NextResponse.json({
      supported: false,
      reason: `Speech synthesis failed: ${err instanceof Error ? err.message : "unknown error"} — the text transcript remains available.`,
    }, { status: 502 });
  }
}
