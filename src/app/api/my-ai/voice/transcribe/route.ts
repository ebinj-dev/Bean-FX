/**
 * M47 VOICE ADDENDUM — server transcription route.
 *
 * Auth-required, ownership-safe, honest by design:
 *  - audio type and size are validated before anything is processed;
 *  - transcription runs ONLY through the capability-registered speech provider
 *    (asr-speech: BEANFX_ASR_ENABLED + gateway SDK). When it is not ready the
 *    route answers 200 with { supported:false, reason } so the UI can disclose
 *    the limitation and offer manual transcript entry — never a fake result;
 *  - the raw transcript and detected language are returned as-is; translation
 *    or interpretation happens later, in the normal chat/plan flow;
 *  - the audio buffer lives only for this request — nothing is retained.
 */
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { probeModelRegistry } from "@/lib/ai/models";
import { VOICE_LANGUAGES, voiceLanguageById } from "@/lib/voice-language";
import { detectScriptMix } from "@/lib/voice-language";

export const runtime = "nodejs";

const MAX_BYTES = 15 * 1024 * 1024;
const ALLOWED_PREFIXES = ["audio/", "video/webm", "video/mp4"];

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  const ct = req.headers.get("content-type") ?? "";
  if (!ct.includes("multipart/form-data")) {
    return NextResponse.json({ error: "Expected multipart form data with an `audio` field." }, { status: 400 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Malformed upload body." }, { status: 400 });
  }
  const audio = form.get("audio");
  if (!(audio instanceof File)) {
    return NextResponse.json({ error: "Missing `audio` field." }, { status: 400 });
  }
  const typeOk = ALLOWED_PREFIXES.some((p) => audio.type.startsWith(p));
  if (!typeOk) {
    return NextResponse.json({ error: `Unsupported audio type ${audio.type || "unknown"} — record as webm/opus audio.` }, { status: 415 });
  }
  if (audio.size > MAX_BYTES) {
    return NextResponse.json({ error: `Audio too large (${(audio.size / 1024 / 1024).toFixed(1)} MB).` }, { status: 413 });
  }

  // Registry gate — configuration alone is not capability proof.
  const registry = probeModelRegistry();
  const asr = registry.models.find((m) => m.id === "asr-speech");
  if (!asr?.ready) {
    return NextResponse.json({
      supported: false,
      reason: asr?.readyReason ?? "No speech-to-text provider is enabled — enable BEANFX_ASR_ENABLED with the configured gateway, or type the instruction.",
      fallback: "manual-transcript",
    }, { status: 503 });
  }

  // M47.1 §A2 — the requested language is recorded and echoed with its honest
  // status. The configured gateway documents NO ASR language parameter (the
  // call takes file_base64 only), so nothing is silently dropped into the
  // provider call: the transcript comes back as recognised, and Tamil /
  // Tanglish requests keep their "unverified — needs native-speaker
  // validation" status instead of a fake language promise.
  const requestedLanguageRaw = form.get("language");
  const requestedLanguage = typeof requestedLanguageRaw === "string" && requestedLanguageRaw.trim() ? requestedLanguageRaw.trim() : null;
  const langInfo = voiceLanguageById(requestedLanguage ?? undefined);

  const buf = Buffer.from(await audio.arrayBuffer());
  let transcript = "";
  let language: string | undefined;
  let confidence: number | undefined;
  try {
    const { transcribeAudio } = await import("@/lib/my-ai/gateway/provider");
    const out = await transcribeAudio(buf.toString("base64"), audio.type || "audio/webm");
    transcript = String(out?.text ?? out?.transcript ?? "");
    language = out?.language;
    confidence = out?.confidence;
  } catch (err) {
    return NextResponse.json({
      supported: false,
      reason: `The speech provider failed: ${err instanceof Error ? err.message : "unknown error"} — nothing was invented; try again or type the instruction.`,
      fallback: "manual-transcript",
    }, { status: 502 });
  }

  const scriptMix = detectScriptMix(transcript);
  return NextResponse.json({
    supported: true,
    transcript,
    language,
    confidence,
    requestedLanguage: langInfo
      ? { id: langInfo.id, label: langInfo.label, status: langInfo.status, note: langInfo.note }
      : null,
    scriptMix: { mix: scriptMix.mix, tamilChars: scriptMix.tamilChars, latinChars: scriptMix.latinChars, disclosure: scriptMix.disclosure },
    provider: "asr-speech (configured gateway)",
    disclosure:
      "Audio was processed by the configured server provider for this request only; no audio retention beyond this transcription." +
      (langInfo && langInfo.status !== "verified"
        ? ` Requested language "${langInfo.label}" is ${langInfo.status} — the configured provider documents no language parameter for ASR, so accuracy needs native-speaker validation.`
        : ""),
  });
}

export async function GET() {
  // Capability probe for the UI (no processing) — includes the truthful
  // language register so the picker never promises what the provider cannot do.
  const registry = probeModelRegistry();
  const asr = registry.models.find((m) => m.id === "asr-speech");
  return NextResponse.json({
    supported: Boolean(asr?.ready),
    reason: asr?.readyReason ?? null,
    maxSeconds: 120,
    maxBytes: MAX_BYTES,
    languages: VOICE_LANGUAGES.map((l) => ({ id: l.id, label: l.label, status: l.status, note: l.note })),
    privacy: "Audio is uploaded only after you activate recording, validated, transcribed, and not retained.",
  });
}
