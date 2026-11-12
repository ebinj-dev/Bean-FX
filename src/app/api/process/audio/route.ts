import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import path from "path";
import { jobManager } from "@/lib/job-runner";
import { MEDIA_ROOT, removeFileQuiet } from "@/lib/media-storage";
import {
  getOwnedMedia,
  unauthorized,
  notFound,
  badRequest,
  createExportRecord,
} from "@/lib/process-helpers";
import { getCurrentUser } from "@/lib/auth";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 800;

const AUDIO_FORMATS = ["mp3", "wav", "m4a", "aac", "flac"] as const;

const schema = z.object({
  mediaId: z.string(),
  format: z.enum(AUDIO_FORMATS),
  bitrateKbps: z.number().int().min(64).max(320).optional(),
  trim: z.object({ start: z.number().min(0), end: z.number().positive() }).optional(),
  gainDb: z.number().min(-40).max(24).optional(),
  fadeInSec: z.number().min(0).max(30).optional(),
  fadeOutSec: z.number().min(0).max(30).optional(),
  normalize: z.enum(["loudness", "peak", "off"]).optional(),
  denoise: z.boolean().optional(),
  channelMode: z.enum(["keep", "mono", "stereo"]).optional(),
});

function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr).slice(-400) || err.message));
      else resolve(stdout);
    });
  });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const p = parsed.data;

  const media = await getOwnedMedia(p.mediaId, user);
  if (!media) return notFound();
  if (!media.hasAudio) return badRequest("This media has no audio stream.");

  // Build the real filter chain in a deterministic order.
  const filters: string[] = [];
  if (p.trim) {
    if (p.trim.end <= p.trim.start) return badRequest("Trim end must be greater than trim start.");
    filters.push(`atrim=start=${p.trim.start.toFixed(3)}:end=${p.trim.end.toFixed(3)}`, "asetpts=PTS-STARTPTS");
  }
  if (p.gainDb) filters.push(`volume=${p.gainDb}dB`);
  if (p.normalize === "loudness") filters.push("loudnorm=I=-16:TP=-1.5:LRA=11");
  if (p.denoise) filters.push("afftdn=nf=-25");
  // pan with c1 fails on mono sources — only downmix when there is a second channel.
  if (p.channelMode === "mono" && (media.channels ?? 2) > 1) filters.push("pan=mono|c0=0.5*c0+0.5*c1");
  if (p.channelMode === "stereo") filters.push("aformat=channel_layouts=stereo");

  // Peak normalization requires a real measurement pass first.
  let peakAdjust = "";
  if (p.normalize === "peak") {
    try {
      const out = await run(
        "ffmpeg",
        ["-hide_banner", "-i", media.storagePath, "-vn", "-af", "volumedetect", "-f", "null", "-"],
        120_000
      );
      const m = /max_volume:\s*(-?[\d.]+)\s*dB/.exec(out);
      if (m) {
        const maxDb = parseFloat(m[1]);
        // Guard against corrupted/empty measurements.
        if (Number.isFinite(maxDb) && maxDb <= 0) peakAdjust = `volume=${(-maxDb).toFixed(2)}dB`;
      }
    } catch {
      return badRequest("Peak measurement pass failed — peak normalization was not applied. Try loudness mode instead.");
    }
  }
  const chain = [peakAdjust, ...filters].filter(Boolean);
  if (p.fadeInSec && p.fadeInSec > 0) chain.push(`afade=t=in:st=0:d=${p.fadeInSec}`);

  // Determine effective output duration for progress and fade-out timing.
  const totalDur = p.trim ? p.trim.end - p.trim.start : (media.durationSec ?? null);
  if (p.fadeOutSec && p.fadeOutSec > 0 && !totalDur) {
    return badRequest("Fade-out requires a known media duration, which this file does not expose.");
  }
  if (p.fadeOutSec && p.fadeOutSec > 0 && totalDur) {
    chain.push(`afade=t=out:st=${(totalDur - p.fadeOutSec).toFixed(3)}:d=${p.fadeOutSec}`);
  }

  const codecArgs: Record<string, string[]> = {
    mp3: ["-c:a", "libmp3lame", "-b:a", `${p.bitrateKbps ?? 192}k`],
    wav: ["-c:a", "pcm_s16le"],
    m4a: ["-c:a", "aac", "-b:a", `${p.bitrateKbps ?? 192}k`],
    aac: ["-c:a", "aac", "-b:a", `${p.bitrateKbps ?? 192}k`],
    flac: ["-c:a", "flac"],
  };

  const outPath = path.join(MEDIA_ROOT, "tmp", `aud_${Date.now()}_${Math.random().toString(36).slice(2)}.${p.format}`);
  const args = ["-i", media.storagePath, "-vn", "-map", "0:a:0"];
  if (chain.length) args.push("-af", chain.join(","));
  args.push(...codecArgs[p.format]);

  const jobId = await jobManager.createJob(user.id, "AUDIO_PROCESS", { ...p });
  jobManager.setProgress(jobId, 1, "Starting").catch(() => undefined);

  jobManager.runFfmpeg(jobId, [...args, outPath], {
    totalDurationSec: totalDur,
    stageLabel: "Processing audio",
    onDone: async () => {
      const { record } = await createExportRecord(user.id, media.id, "AUDIO", p.format, outPath, p);
      await jobManager.complete(jobId, record.id, `Export created: ${record.filename}`);
    },
    onSettled: async () => {
      // No-op after a successful rename in createExportRecord; removes the
      // partial output when ffmpeg failed or the job was cancelled.
      await removeFileQuiet(outPath);
    },
  });

  return NextResponse.json({ jobId });
}
