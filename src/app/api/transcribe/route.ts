import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { pathExists } from "@/lib/media-storage";
import { transcribeWithAsr, detectLanguage } from "@/lib/autocut-analysis";

export const runtime = "nodejs";
export const maxDuration = 800;

/**
 * Real transcription via the configured ASR provider (z-ai-web-dev-sdk).
 *
 * The provider hard-limits input files to 30 seconds (error 1214), so audio
 * is chunked at 25s with bounded concurrency. The provider returns plain
 * text WITHOUT word or sentence timestamps — BEAN FX reports this honestly
 * (timingGranularity: "chunk") and every timing shown downstream is
 * estimated from measured speech energy and labeled as such.
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  const body = await req.json().catch(() => null);
  const mediaId = body?.mediaId as string | undefined;
  if (!mediaId) return NextResponse.json({ error: "mediaId is required." }, { status: 400 });

  const asset = await db.mediaAsset.findUnique({ where: { id: mediaId } });
  if (!asset || asset.userId !== user.id) {
    return NextResponse.json({ error: "Media not found." }, { status: 404 });
  }
  if (!asset.audioCodec) {
    return NextResponse.json({ error: "This media has no audio stream to transcribe." }, { status: 400 });
  }
  if (!(await pathExists(asset.storagePath))) {
    return NextResponse.json({ error: "Media file is missing from storage." }, { status: 410 });
  }

  try {
    const asr = await transcribeWithAsr(asset.storagePath, asset.durationSec ?? 0);
    if (!asr.text.trim()) {
      return NextResponse.json(
        {
          error:
            "The transcription provider returned no text for this recording (silence, non-speech content, unsupported language, or recognition failure). No caption text was invented.",
          providerUsed: true,
        },
        { status: 422 }
      );
    }
    const language = detectLanguage(asr.text);

    return NextResponse.json({
      text: asr.text,
      provider: "zai-asr",
      // Honest granularity: the provider gives no timestamps; only chunk
      // boundaries are exact. Sentence timing downstream is estimated.
      timingGranularity: "none",
      chunkGranularity: asr.chunkTexts.map((c) => ({ start: c.start, end: c.end })),
      chunkCount: asr.chunkCount,
      failedChunks: asr.failedChunks,
      language,
      warnings: asr.warnings,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Transcription failed.";
    console.error("[transcribe]", message);
    return NextResponse.json({ error: `Transcription failed: ${message}` }, { status: 502 });
  }
}
