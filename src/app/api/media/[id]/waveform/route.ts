import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { MEDIA_ROOT, pathExists } from "@/lib/media-storage";
import { computeMediaWaveform } from "@/lib/autocut-analysis";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Waveform peaks for the Auto Cut timeline — computed from the REAL decoded
 * audio of the uploaded media, cached on disk under media-store/waveforms/.
 * Originals are immutable, so a cache file keyed by media id never goes
 * stale; the endpoint is what lets the timeline render the actual waveform
 * immediately after upload instead of waiting for a RIISHE analysis.
 */

const waveformsDir = path.join(MEDIA_ROOT, "waveforms");

async function getOwnedAsset(id: string, userId: string) {
  const asset = await db.mediaAsset.findUnique({ where: { id } });
  if (!asset || asset.userId !== userId) return null;
  return asset;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { id } = await ctx.params;
  const asset = await getOwnedAsset(id, user.id);
  if (!asset) return NextResponse.json({ error: "Media not found." }, { status: 404 });
  if (asset.kind === "SUBTITLE" || !asset.audioCodec) {
    return NextResponse.json(
      { error: "This media has no audio stream — a waveform does not apply." },
      { status: 422 }
    );
  }
  if (!(await pathExists(asset.storagePath))) {
    return NextResponse.json({ error: "Media file is missing from storage." }, { status: 410 });
  }

  const cachePath = path.join(waveformsDir, `${asset.id}.json`);
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    const cached = JSON.parse(raw);
    if (cached && cached.ok && Array.isArray(cached.min) && Array.isArray(cached.max) && cached.min.length > 0) {
      return NextResponse.json({ ...cached, cached: true });
    }
  } catch {
    /* no cache yet — compute below */
  }

  try {
    const peaks = await computeMediaWaveform(asset.storagePath);
    const body = {
      ok: true as const,
      mediaId: asset.id,
      originalName: asset.originalName,
      durationSec: peaks.durationSec,
      sampleRate: peaks.sampleRate,
      pointsPerSecond: peaks.pointsPerSecond,
      min: peaks.min,
      max: peaks.max,
    };
    await fs.mkdir(waveformsDir, { recursive: true });
    const tmp = `${cachePath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify(body));
    await fs.rename(tmp, cachePath);
    return NextResponse.json({ ...body, cached: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Waveform generation failed.";
    console.error("[media-waveform]", message);
    return NextResponse.json({ error: `Waveform could not be generated: ${message}` }, { status: 502 });
  }
}
