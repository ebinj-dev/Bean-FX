import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { jobManager } from "@/lib/job-runner";
import { MEDIA_ROOT, removeFileQuiet } from "@/lib/media-storage";
import {
  getOwnedMedia,
  unauthorized,
  notFound,
  badRequest,
  validateRanges,
  createExportRecord,
} from "@/lib/process-helpers";
import { getCurrentUser } from "@/lib/auth";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 800;

const schema = z.object({
  mediaId: z.string(),
  cuts: z.array(z.object({ start: z.number(), end: z.number() })).min(1).max(2000),
  outputFormat: z.enum(["mp4", "mov", "wav", "mp3"]),
});

/**
 * Applies an explicitly approved cut plan with ffmpeg. The original file is
 * never modified — output is a new validated export.
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const { mediaId, cuts, outputFormat } = parsed.data;

  const media = await getOwnedMedia(mediaId, user);
  if (!media) return notFound();
  const isVideoOut = outputFormat === "mp4" || outputFormat === "mov";
  if (isVideoOut && !media.hasVideo) {
    return badRequest("Media has no video stream — choose an audio output format (WAV or MP3).");
  }
  // A video without any audio stream is still cuttable — the export is then
  // video-only. Audio outputs require an audio stream, obviously.
  if (!isVideoOut && !media.hasAudio) {
    return badRequest("This media has no audio stream — choose a video output format (MP4 or MOV).");
  }

  const duration = media.durationSec ?? 0;
  const check = validateRanges(cuts, duration);
  if (!check.ok) return badRequest(check.error);

  // Compute kept segments [0, duration) minus removals — deterministic merge.
  // For video outputs the boundaries are snapped to the frame grid so the
  // video and audio trims are IDENTICAL: video quantizes to whole frames
  // while audio cuts exactly, and an unsnapped plan lets A/V drift
  // accumulate with every cut.
  const removals = check.normalized;
  const snapFps = isVideoOut && media.fps && media.fps > 0 ? media.fps : null;
  const kept: { start: number; end: number }[] = [];
  const pushKept = (s: number, e: number) => {
    let start = s;
    let end = e;
    if (snapFps) {
      start = Math.round(start * snapFps) / snapFps;
      end = Math.round(end * snapFps) / snapFps;
    }
    if (end - start > 1 / (snapFps ?? 1000)) kept.push({ start, end });
  };
  let cursor = 0;
  for (const r of removals) {
    if (r.start > cursor + 1e-6) pushKept(cursor, r.start);
    cursor = Math.max(cursor, r.end);
  }
  if (duration - cursor > 1e-6) pushKept(cursor, duration);
  if (kept.length === 0) return badRequest("The approved plan removes the entire recording — nothing to export.");

  const totalOut = kept.reduce((acc, k) => acc + (k.end - k.start), 0);

  // Build filter_complex: one trim per kept segment, then concat. A video
  // without audio produces a video-only graph (never a silent fake track).
  const parts: string[] = [];
  const audioLabels: string[] = [];
  const videoLabels: string[] = [];
  kept.forEach((k, i) => {
    if (isVideoOut) {
      parts.push(`[0:v]trim=start=${k.start.toFixed(3)}:end=${k.end.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
      videoLabels.push(`[v${i}]`);
    }
    if (media.hasAudio) {
      parts.push(`[0:a]atrim=start=${k.start.toFixed(3)}:end=${k.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
      audioLabels.push(`[a${i}]`);
    }
  });
  if (isVideoOut) {
    parts.push(`${videoLabels.join("")}concat=n=${kept.length}:v=1:a=0[vout]`);
    if (media.hasAudio) parts.push(`${audioLabels.join("")}concat=n=${kept.length}:v=0:a=1[aout]`);
  } else {
    parts.push(`${audioLabels.join("")}concat=n=${kept.length}:v=0:a=1[aout]`);
  }

  const codecArgs =
    outputFormat === "mp4"
      ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]
      : outputFormat === "mov"
        ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-c:a", "aac", "-b:a", "192k"]
        : outputFormat === "wav"
          ? ["-c:a", "pcm_s16le"]
          : ["-c:a", "libmp3lame", "-b:a", "192k"];
  if (isVideoOut && !media.hasAudio) {
    // strip audio codec args — there is no audio stream to encode
    const i = codecArgs.indexOf("-c:a");
    if (i !== -1) codecArgs.splice(i, 2);
    const b = codecArgs.indexOf("-b:a");
    if (b !== -1) codecArgs.splice(b, 2);
  }

  const outPath = path.join(MEDIA_ROOT, "tmp", `cut_${Date.now()}_${Math.random().toString(36).slice(2)}.${outputFormat}`);
  const finalArgs = isVideoOut
    ? ["-i", media.storagePath, "-filter_complex", parts.join(";"), "-map", "[vout]", ...(media.hasAudio ? ["-map", "[aout]"] : [])]
    : ["-i", media.storagePath, "-filter_complex", parts.join(";"), "-map", "[aout]", "-vn"];
  finalArgs.push(...codecArgs);

  const jobId = await jobManager.createJob(user.id, "AUTOCUT_APPLY", {
    mediaId,
    cutCount: removals.length,
    outputFormat,
    removedSec: duration - totalOut,
  });
  jobManager.setProgress(jobId, 1, "Applying approved cuts").catch(() => undefined);

  jobManager.runFfmpeg(jobId, [...finalArgs, outPath], {
    totalDurationSec: duration,
    stageLabel: "Applying approved cuts",
    onDone: async () => {
      const { record } = await createExportRecord(user.id, media.id, isVideoOut ? "VIDEO" : "AUDIO", outputFormat, outPath, {
        approvedCuts: removals,
        keptSegments: kept,
        originalDurationSec: duration,
        finalDurationSec: totalOut,
      });
      await jobManager.complete(jobId, record.id, `Edit applied: ${record.filename} (${totalOut.toFixed(1)}s final)`);
    },
    onSettled: async () => {
      // No-op after a successful rename in createExportRecord; removes the
      // partial output when ffmpeg failed or the job was cancelled.
      await removeFileQuiet(outPath);
    },
  });

  return NextResponse.json({ jobId, estimatedFinalSec: totalOut, keptSegments: kept.length });
}
