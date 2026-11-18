import { promises as fs } from "fs";
import path from "path";
import { db } from "@/lib/db";
import { jobManager } from "@/lib/job-runner";
import { PermanentJobError, completeJob } from "@/lib/job-helpers";
import { MEDIA_ROOT, PROXIES_DIR, evenDim, pathExists, removeFileQuiet } from "@/lib/media-storage";
import { probeMediaDeep, proxyEligible } from "@/lib/media-analysis";

/**
 * M3.3 — editing proxies. Lower-resolution H.264/AAC copies that preserve the
 * source's frame timestamps (fps_mode passthrough + fine track timescale) so
 * the editor timeline stays aligned. Exports never touch proxies: they read
 * the original file from disk (process-helpers/getOwnedMedia → storagePath).
 */

/** Proxy target: long edge capped at 960 px, source aspect ratio preserved. */
export const PROXY_LONG_EDGE = 960;

export interface ProxyPlan {
  args: string[];
  outputPath: string;
  outWidth: number;
  outHeight: number;
}

/**
 * Pure arg builder — deterministic and unit-testable without spawning ffmpeg.
 * Rotation-aware: ffmpeg auto-applies the display matrix, so the OUTPUT frame
 * is already rotated; the scale filter must target the rotated dimensions.
 */
export function buildProxyPlan(
  srcPath: string,
  src: { width: number | null; height: number | null; rotation: number | null; hasAudio: boolean; durationSec: number | null },
  outputPath: string
): ProxyPlan {
  const w = src.width ?? 0;
  const h = src.height ?? 0;
  const rot = ((src.rotation ?? 0) % 180 + 180) % 180;
  // Effective (on-screen) dimensions after ffmpeg applies rotation.
  const effW = rot === 90 ? h : w;
  const effH = rot === 90 ? w : h;
  const longEdge = Math.max(effW, effH);
  const scale = longEdge > 0 ? PROXY_LONG_EDGE / longEdge : 1;
  const outW = evenDim(Math.max(2, effW * scale));
  const outH = evenDim(Math.max(2, effH * scale));

  const args: string[] = ["-i", srcPath, "-map", "0:v:0"];
  if (src.hasAudio) args.push("-map", "0:a:0?");
  args.push(
    "-vf",
    `scale=${outW}:${outH}`,
    // Preserve source timestamps exactly — CFR re-timing would misalign VFR
    // sources on the editor timeline. 90 kHz track timescale keeps sub-ms pts.
    "-fps_mode",
    "passthrough",
    "-video_track_timescale",
    "90000",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "26",
    "-pix_fmt",
    "yuv420p"
  );
  if (src.hasAudio) {
    args.push("-c:a", "aac", "-b:a", "128k", "-ac", "2");
  }
  args.push("-movflags", "+faststart", "-y", outputPath);
  return { args, outputPath, outWidth: outW, outHeight: outH };
}

/**
 * MEDIA_PROXY handler: transcode the original into an editing proxy, verify
 * timestamp alignment, and persist proxy state. Idempotent — a READY proxy
 * with its file intact short-circuits to COMPLETED (crash-recovery safe).
 */
export async function runProxyJob(job: {
  id: string;
  userId: string;
  attempts: number;
  maxAttempts: number;
  paramsJson: string | null;
}): Promise<void> {
  const params = JSON.parse(job.paramsJson ?? "{}") as { mediaId?: string };
  const mediaId = params.mediaId;
  if (!mediaId) throw new PermanentJobError("Proxy job is missing its mediaId parameter.");

  const asset = await db.mediaAsset.findUnique({ where: { id: mediaId } });
  if (!asset) throw new PermanentJobError("Media asset no longer exists.");
  if (asset.userId !== job.userId) throw new PermanentJobError("Media asset does not belong to the job owner.");
  if (asset.kind !== "VIDEO") throw new PermanentJobError("Proxies apply only to video assets.");
  if (!proxyEligible({ hasVideo: Boolean(asset.videoCodec), width: asset.width, height: asset.height, durationSec: asset.durationSec })) {
    await db.mediaAsset.update({ where: { id: asset.id }, data: { proxyStatus: "UNSUPPORTED" } }).catch(() => undefined);
    await completeJob(job.id, "Source does not justify a proxy — original will be used.");
    return;
  }

  const proxyPath = path.join(PROXIES_DIR, `${asset.id}.mp4`);
  if (asset.proxyStatus === "READY" && (await pathExists(proxyPath))) {
    await completeJob(job.id, "Proxy already exists — nothing to do.");
    return;
  }
  if (!(await pathExists(asset.storagePath))) {
    throw new PermanentJobError("Original media file is missing from storage.");
  }

  await db.mediaAsset.updateMany({
    where: { id: asset.id, proxyStatus: { in: ["QUEUED", "PROCESSING", "FAILED"] } },
    data: { proxyStatus: "PROCESSING", proxyError: null },
  });

  const tmpOut = path.join(MEDIA_ROOT, "tmp", `px_${asset.id}_${job.id.slice(-6)}.mp4`);
  const plan = buildProxyPlan(
    asset.storagePath,
    {
      width: asset.width,
      height: asset.height,
      rotation: asset.rotation,
      hasAudio: Boolean(asset.audioCodec),
      durationSec: asset.durationSec,
    },
    tmpOut
  );
  // Proxy duration must track the source within max(0.5s, 2%) or alignment fails.
  const tolerance = Math.max(0.5, (asset.durationSec ?? 0) * 0.02);

  try {
    await jobManager.setProgress(job.id, 5, "Transcoding");
    const outcome = await new Promise<"ok" | "aborted">((resolve) => {
      let settled = false;
      const settle = (v: "ok" | "aborted") => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      jobManager.runFfmpeg(job.id, plan.args, {
        totalDurationSec: asset.durationSec,
        stageLabel: "Transcoding proxy",
        onDone: async () => settle("ok"),
        onSettled: async () => settle("aborted"),
      });
    });

    if (outcome === "aborted") {
      // runFfmpeg already wrote the terminal job status (CANCELLED / FAILED /
      // timeout). Mirror it on the asset so the pipeline view stays truthful.
      const terminal = await db.job.findUnique({ where: { id: job.id }, select: { status: true, message: true } });
      const status = terminal?.status === "CANCELLED" ? "NONE" : "FAILED";
      await db.mediaAsset
        .update({
          where: { id: asset.id },
          data: {
            proxyStatus: status,
            proxyError: (terminal?.message ?? "Proxy processing stopped.").slice(0, 500),
          },
        })
        .catch(() => undefined);
      await removeFileQuiet(tmpOut);
      return;
    }

    await jobManager.setProgress(job.id, 92, "Verifying alignment");
    const probe = await probeMediaDeep(tmpOut);
    if (!probe.hasVideo) {
      throw new PermanentJobError("Proxy output contains no video stream.");
    }
    if (asset.durationSec !== null && probe.durationSec !== null && Math.abs(probe.durationSec - asset.durationSec) > tolerance) {
      throw new PermanentJobError(
        `Proxy duration ${probe.durationSec.toFixed(3)}s does not align with source ${asset.durationSec.toFixed(3)}s (tolerance ${tolerance.toFixed(3)}s).`
      );
    }

    await jobManager.setProgress(job.id, 97, "Publishing proxy");
    await fs.mkdir(PROXIES_DIR, { recursive: true });
    const stat = await fs.stat(tmpOut);
    await fs.rename(tmpOut, proxyPath);
    await db.mediaAsset.update({
      where: { id: asset.id },
      data: {
        proxyStatus: "READY",
        proxyPath,
        proxySizeBytes: stat.size,
        proxyDurationSec: probe.durationSec,
        proxyError: null,
      },
    });
    await completeJob(job.id, `Proxy ready: ${plan.outWidth}×${plan.outHeight}, ${probe.durationSec?.toFixed(2)}s.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.mediaAsset
      .updateMany({
        where: { id: asset.id, proxyStatus: { in: ["QUEUED", "PROCESSING"] } },
        data: { proxyStatus: "FAILED", proxyError: message.slice(0, 500) },
      })
      .catch(() => undefined);
    throw err; // worker decides retry vs permanent failure
  } finally {
    await removeFileQuiet(tmpOut);
  }
}
