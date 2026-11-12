import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { jobManager } from "@/lib/job-runner";
import { MEDIA_ROOT, removeFileQuiet } from "@/lib/media-storage";
import { getOwnedMedia, unauthorized, notFound, badRequest, createExportRecord } from "@/lib/process-helpers";
import { getCurrentUser } from "@/lib/auth";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 800;

const schema = z.object({
  mediaId: z.string(),
  srtContent: z.string().min(1).max(2_000_000),
  fontSize: z.number().int().min(10).max(72).optional(),
});

/** Burns validated SRT captions into the video (real ffmpeg subtitles filter). */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const { mediaId, srtContent, fontSize } = parsed.data;

  const media = await getOwnedMedia(mediaId, user);
  if (!media) return notFound();
  if (!media.hasVideo) return badRequest("Caption burning requires a video stream.");

  const workDir = path.join(MEDIA_ROOT, "tmp");
  await fs.mkdir(workDir, { recursive: true });
  const srtPath = path.join(workDir, `srt_${Date.now()}_${Math.random().toString(36).slice(2)}.srt`);
  const outPath = path.join(workDir, `cap_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);

  try {
    await fs.writeFile(srtPath, srtContent, "utf8");
    const style = `FontSize=${fontSize ?? 20},PrimaryColour=&H00FFFFFF,OutlineColour=&H90000000,BorderStyle=1,Outline=1,Shadow=0,MarginV=24`;
    // Escape for the subtitles filter (path may contain special chars).
    const escaped = srtPath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
    const filter = `subtitles=filename='${escaped}':force_style='${style}'`;

    const args = [
      "-i", media.storagePath,
      "-vf", filter,
      "-map", "0:v", "-map", "0:a?",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "19",
      "-c:a", "aac", "-b:a", "160k",
      "-movflags", "+faststart",
    ];

    const jobId = await jobManager.createJob(user.id, "BURN_CAPTIONS", { mediaId, fontSize: fontSize ?? 20 });
    jobManager.setProgress(jobId, 1, "Burning captions").catch(() => undefined);

    jobManager.runFfmpeg(jobId, [...args, outPath], {
      totalDurationSec: media.durationSec,
      stageLabel: "Burning captions",
      onDone: async () => {
        const { record } = await createExportRecord(user.id, media.id, "VIDEO", "mp4", outPath, {
          burnedCaptions: true,
          fontSize: fontSize ?? 20,
        });
        await jobManager.complete(jobId, record.id, `Burned captions: ${record.filename}`);
      },
      onSettled: async () => {
        // The subtitle file is only needed while ffmpeg runs; remove it plus
        // any partial output (no-op after a successful rename).
        await removeFileQuiet(srtPath);
        await removeFileQuiet(outPath);
      },
    });

    return NextResponse.json({ jobId });
  } catch (err) {
    await fs.unlink(srtPath).catch(() => undefined);
    await fs.unlink(outPath).catch(() => undefined);
    return badRequest(err instanceof Error ? err.message : "Caption burning failed.");
  }
}
