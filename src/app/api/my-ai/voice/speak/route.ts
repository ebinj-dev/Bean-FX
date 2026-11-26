/**
 * M47 VOICE ADDENDUM — RIISHE spoken responses.
 * Text → speech through the configured gateway SDK. Gated honestly: when the
 * gateway is absent the route reports { supported:false } and the UI falls
 * back to silent text (never claiming Tamil speech generation it cannot do).
 * Audio is returned as base64 for a single playback — nothing is stored.
 */
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";

export const runtime = "nodejs";

const MAX_CHARS = 1200;

/** The gateway TTS returns raw 16 kHz mono PCM — wrap it so browsers can play it. */
function wavHeader(pcm: Buffer, rate = 16000, channels = 1, bits = 16): Buffer {
  const bps = (rate * channels * bits) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(bps, 28);
  header.writeUInt16LE((channels * bits) / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

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

  type TtsClient = { audio: { tts: { create: (b: { input: string; voice?: string; speed?: number }) => Promise<unknown> } } };
  try {
    const mod = sdk as { default?: { create: () => Promise<TtsClient> } } | undefined;
    if (!mod?.default?.create) throw new Error("gateway adapter unavailable");
    const client = await mod.default.create();
    // The gateway TTS takes `input` (+ optional voice). Language/voice selection
    // stays honest: unsupported languages surface as provider errors, never as
    // fake native speech.
    // The gateway SDK returns the raw Response for TTS — handle both shapes.
    const raw = (await client.audio.tts.create({ input: text })) as
      | Response
      | { audio?: string; audio_base64?: string; data?: string };
    let b64: string | undefined;
    if (typeof raw === "string") {
      b64 = raw;
    } else if (raw && typeof (raw as Response).arrayBuffer === "function") {
      const bytes = Buffer.from(await (raw as Response).arrayBuffer());
      b64 = wavHeader(bytes).toString("base64");
    } else {
      b64 = (raw as { audio?: string; audio_base64?: string; data?: string })?.audio_base64
        ?? (raw as { audio?: string })?.audio
        ?? (raw as { data?: string })?.data;
    }
    if (!b64) {
      return NextResponse.json({ supported: false, reason: "The speech provider returned no audio — the transcript remains available." }, { status: 502 });
    }
    return NextResponse.json({
      supported: true,
      audioBase64: b64,
      provider: "gateway TTS",
      disclosure: "Spoken via the configured gateway. Native-language accuracy depends on the provider voice — the text transcript is authoritative.",
    });
  } catch (err) {
    return NextResponse.json({
      supported: false,
      reason: `Speech synthesis failed: ${err instanceof Error ? err.message : "unknown error"} — the text transcript remains available.`,
    }, { status: 502 });
  }
}
