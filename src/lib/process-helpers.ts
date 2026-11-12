import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { db } from "@/lib/db";
import { getCurrentUser, type SafeUser } from "@/lib/auth";
import { MEDIA_ROOT, pathExists, exportFileName, ffprobe } from "@/lib/media-storage";

export interface OwnedMedia {
  id: string;
  storagePath: string;
  originalName: string;
  kind: string;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  channels: number | null;
  hasAudio: boolean;
  hasVideo: boolean;
}

export async function getOwnedMedia(mediaId: string, user: SafeUser): Promise<OwnedMedia | null> {
  const asset = await db.mediaAsset.findUnique({ where: { id: mediaId } });
  if (!asset || asset.userId !== user.id) return null;
  if (!(await pathExists(asset.storagePath))) return null;
  return {
    id: asset.id,
    storagePath: asset.storagePath,
    originalName: asset.originalName,
    kind: asset.kind,
    durationSec: asset.durationSec,
    width: asset.width,
    height: asset.height,
    fps: asset.fps,
    channels: asset.channels,
    hasAudio: Boolean(asset.audioCodec),
    hasVideo: Boolean(asset.videoCodec),
  };
}

export function unauthorized() {
  return NextResponse.json({ error: "Authentication required." }, { status: 401 });
}

export function notFound() {
  return NextResponse.json({ error: "Media not found." }, { status: 404 });
}

export function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

/** Half-open [start, end) range validation with deterministic normalization errors. */
export function validateRanges(
  cuts: { start: number; end: number }[],
  duration: number
): { ok: true; normalized: { start: number; end: number }[] } | { ok: false; error: string } {
  if (!Array.isArray(cuts) || cuts.length === 0) return { ok: false, error: "No cut ranges supplied." };
  const sorted = [...cuts].sort((a, b) => a.start - b.start);
  const normalized: { start: number; end: number }[] = [];
  for (const c of sorted) {
    const { start, end } = c;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { ok: false, error: "Cut range contains non-numeric bounds." };
    if (start < 0 || end <= start) return { ok: false, error: `Invalid range [${start}, ${end}) — must satisfy 0 <= start < end.` };
    if (duration > 0 && end > duration + 0.05) return { ok: false, error: `Range end ${end.toFixed(2)}s exceeds media duration ${duration.toFixed(2)}s.` };
    const prev = normalized[normalized.length - 1];
    if (prev && start < prev.end - 1e-6) {
      return { ok: false, error: `Overlapping ranges detected near ${start.toFixed(2)}s — resolve overlaps before applying.` };
    }
    normalized.push({ start, end: Math.min(end, duration > 0 ? duration : end) });
  }
  return { ok: true, normalized };
}

export async function createExportRecord(
  userId: string,
  mediaId: string | null,
  kind: string,
  format: string,
  srcPath: string,
  params: unknown
) {
  const stat = await fs.stat(srcPath);
  const outDir = path.join(MEDIA_ROOT, "exports");
  await fs.mkdir(outDir, { recursive: true });
  const finalName = exportFileName(kind === "CAPTIONS" ? "captions" : kind === "PLAN" ? "edit_plan" : path.basename(srcPath), format);
  const finalPath = path.join(outDir, finalName);
  await fs.rename(srcPath, finalPath);

  let durationSec: number | null = null;
  if (kind === "AUDIO" || kind === "VIDEO") {
    try {
      const probe = await ffprobe(finalPath);
      durationSec = probe.durationSec;
      if (!probe.hasAudio && !probe.hasVideo) throw new Error("Output file has no audio or video streams.");
    } catch (err) {
      await fs.unlink(finalPath).catch(() => undefined);
      throw new Error(`Output validation failed: ${err instanceof Error ? err.message : "unreadable output"}`);
    }
  }

  const record = await db.exportFile.create({
    data: {
      userId,
      mediaId,
      kind,
      format,
      filename: finalName,
      storagePath: finalPath,
      sizeBytes: stat.size,
      durationSec,
      paramsJson: JSON.stringify(params ?? {}),
    },
  });
  return { record, finalPath };
}
