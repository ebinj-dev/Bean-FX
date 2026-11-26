/**
 * BEAN FX — M45 Unit B: real video stabilization via libvidstab (two-pass).
 *
 * A durable MEDIA_STABILIZE job — no side-door processing:
 *   pass 1  vidstabdetect   → transforms file (.trf)
 *   pass 2  vidstabtransform → stabilized derivative MP4 in PROXIES_DIR
 * The derivative is registered with provenance through the EXISTING asset
 * lifecycle (registerGeneratedAsset) so it appears in the media library as a
 * real, traceable asset. License note: libvidstab is GPL-2.0-or-later; this
 * deployment's ffmpeg build already ships GPL components (libx264), so no new
 * licensing class is introduced (recorded in vfx-capabilities.ts).
 *
 * Failure honesty: a detect/transform failure fails the job with the ffmpeg
 * stderr tail — a stabilization that did not happen is never reported as done.
 */
import path from "node:path";
import { db } from "@/lib/db";
import { jobManager } from "@/lib/job-runner";
import { PermanentJobError, completeJob, finishJob, handleJobError } from "@/lib/job-helpers";
import { PROXIES_DIR, MEDIA_ROOT, pathExists, ffprobe } from "@/lib/media-storage";
import { registerGeneratedAsset } from "@/lib/ai/asset-lifecycle";

function vidstabDetectArgs(source: string, trfPath: string): string[] {
  // runFfmpeg prepends -hide_banner -loglevel error -y and appends -progress/-nostats.
  return [
    "-i", source,
    "-vf", `vidstabdetect=shakiness=6:accuracy=12:result=${trfPath}`,
    "-f", "null", "-",
  ];
}

function vidstabTransformArgs(source: string, trfPath: string, outPath: string, hasAudio: boolean): string[] {
  const vf = `vidstabtransform=input=${trfPath}:smoothing=20:optzoom=1,unsharp=5:5:0.8:5:5:0.4`;
  return [
    "-i", source,
    "-vf", vf,
    "-c:v", "libx264", "-preset", "medium", "-crf", "20",
    "-pix_fmt", "yuv420p",
    ...(hasAudio ? ["-c:a", "aac", "-b:a", "160k"] : ["-an"]),
    "-movflags", "+faststart",
    outPath,
  ];
}

export async function runStabilizeJob(job: {
  id: string;
  userId: string;
  attempts: number;
  maxAttempts: number;
  paramsJson: string | null;
}): Promise<void> {
  try {
    const params = JSON.parse(job.paramsJson ?? "{}") as { mediaId?: string };
    const mediaId = params.mediaId;
    if (!mediaId) throw new PermanentJobError("Stabilize job is missing its mediaId parameter.");

    const asset = await db.mediaAsset.findUnique({ where: { id: mediaId } });
    if (!asset) throw new PermanentJobError("Media asset no longer exists.");
    if (asset.userId !== job.userId) throw new PermanentJobError("Media asset does not belong to the job owner.");
    if (asset.kind !== "VIDEO") throw new PermanentJobError("Stabilization applies only to video assets.");
    if (asset.probeStatus !== "READY") throw new PermanentJobError("Probe the media before stabilizing it.");
    if (!(await pathExists(asset.storagePath))) {
      throw new PermanentJobError("Original media file is missing from storage.");
    }

    const trfPath = path.join(MEDIA_ROOT, "tmp", `stb_${asset.id}_${job.id.slice(-6)}.trf`);
    const outPath = path.join(PROXIES_DIR, `${asset.id}-stabilized.mp4`);
    if (await pathExists(outPath)) {
      await completeJob(job.id, "A stabilized derivative already exists for this asset.");
      return;
    }

    await jobManager.setProgress(job.id, 10, "Analyzing motion (pass 1/2)");
    const detect = await runFfmpeg(job.id, vidstabDetectArgs(asset.storagePath, trfPath), null);
    if (detect !== "ok") return; // cancelled or failed — the runner recorded the outcome
    if (!(await pathExists(trfPath))) {
      throw new Error("vidstabdetect produced no transforms file — clip may be too short or static.");
    }

    await jobManager.setProgress(job.id, 45, "Stabilizing (pass 2/2)");
    const transform = await runFfmpeg(job.id, vidstabTransformArgs(asset.storagePath, trfPath, outPath, Boolean(asset.audioCodec)), asset.durationSec);
    if (transform !== "ok") return;

    // Validate the derivative with real ffprobe: duration within 5% of source.
    const probe = await ffprobe(outPath);
    const srcDur = asset.durationSec ?? 0;
    if (probe.durationSec != null && srcDur > 0 && Math.abs(probe.durationSec - srcDur) > Math.max(0.5, srcDur * 0.05)) {
      throw new Error(`stabilized output duration ${probe.durationSec.toFixed(2)}s deviates from source ${srcDur.toFixed(2)}s — refusing to register.`);
    }

    await jobManager.setProgress(job.id, 85, "Registering derivative");
    const registered = await registerGeneratedAsset(outPath, {
      userId: job.userId,
      expectClass: "VIDEO",
      engine: "NIIKI",
      originalName: `${asset.originalName.replace(/\.[^.]+$/, "")} (stabilized)`,
      provider: "libvidstab (GPL-2.0-or-later ffmpeg filter)",
      model: "vidstabdetect+vidstabtransform",
      prompt: `stabilize ${asset.originalName}`,
      params: { sourceAssetId: asset.id, shakiness: 6, accuracy: 12, smoothing: 20, optzoom: 1 },
      license: "GPL-2.0-or-later (ffmpeg build components; no non-commercial weights used)",
      attribution: "NIIKI VFX stabilization (M45)",
      providerTaskId: job.id,
      referenceAssetId: asset.id,
    });

    await finishJob(job.id, { status: "COMPLETED", progress: 100, stage: "Completed", message: `Stabilized derivative registered: ${registered.id}`, resultJson: JSON.stringify({ outputAssetId: registered.id, sourceAssetId: asset.id }) });
  } catch (err) {
    await handleJobError(job.id, err, job.attempts, job.maxAttempts, "Media stabilization failed");
  }
}

/** ffmpeg through the cancellation-aware runner; mirrors the proxy job pattern. */
function runFfmpeg(jobId: string, args: string[], totalDurationSec: number | null): Promise<"ok" | "aborted"> {
  return new Promise<"ok" | "aborted">((resolve) => {
    let settled = false;
    const settle = (v: "ok" | "aborted") => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    jobManager.runFfmpeg(jobId, args, {
      totalDurationSec,
      stageLabel: "Stabilizing",
      onDone: async () => settle("ok"),
      onSettled: async () => settle("aborted"),
    });
  });
}
