/**
 * NIIKI — durable render job (M6 §9).
 *
 * NIKKI_RENDER renders a validated sequence's graphics + transitions over the
 * chosen media through the M3.4 durable worker (claim/heartbeat/retry/timeout)
 * and the JobManager.runFfmpeg execution path (real progress, cancellation,
 * timeout kill). The render plan is built SERVER-SIDE from the validated
 * sequence snapshot — clients cannot submit FFmpeg arguments.
 *
 * Non-destructive: output is a new ExportFile asset; sources are read-only.
 */
import { execFile } from "child_process";
import { stat } from "fs/promises";
import path from "path";
import { db } from "@/lib/db";
import { jobManager } from "@/lib/job-runner";
import { PermanentJobError } from "@/lib/job-helpers";
import { parseSequence } from "@/lib/editor/model";
import { MEDIA_ROOT, pathInsideMediaRoot } from "@/lib/media-storage";
import { buildNikkiRenderPlan } from "./render";
import { mkdir } from "fs/promises";

interface HandlerJob {
  id: string;
  userId: string;
  attempts: number;
  maxAttempts: number;
  paramsJson: string | null;
}

export const NIKKI_RENDERS_DIR = path.join(MEDIA_ROOT, "nikki-renders");

async function ensureRendersDir(): Promise<void> {
  await mkdir(NIKKI_RENDERS_DIR, { recursive: true });
}

function probeDurationSec(file: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", file], { maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve(null);
      try {
        const v = Number((JSON.parse(out) as { format?: { duration?: string } }).format?.duration);
        resolve(Number.isFinite(v) ? v : null);
      } catch {
        resolve(null);
      }
    });
  });
}

/** NIKKI_RENDER — build the server-side plan and run FFmpeg. */
export async function runNikkiRenderJob(job: HandlerJob): Promise<void> {
  const parsed = JSON.parse(job.paramsJson ?? "{}") as {
    sequence?: unknown;
    sourceAssetId?: string;
    startFrame?: number;
    endFrame?: number;
  };
  if (!parsed.sequence) throw new PermanentJobError("NIKKI_RENDER params missing sequence snapshot");
  const seq = parseSequence(parsed.sequence);
  if (seq.clips.length === 0) throw new PermanentJobError("Nothing to render: the sequence has no clips");

  // Resolve the render window and source media (owner-checked).
  let sourcePath: string | null = null;
  if (parsed.sourceAssetId) {
    const asset = await db.mediaAsset.findUnique({ where: { id: parsed.sourceAssetId } });
    if (!asset || asset.userId !== job.userId) throw new PermanentJobError("NIKKI_RENDER source asset not found or not owned by the caller");
    sourcePath = asset.storagePath;
  }
  const sourceAssetIdForPlan = parsed.sourceAssetId ?? null;
  const plan = buildNikkiRenderPlan(seq, {
    startFrame: parsed.startFrame,
    endFrame: parsed.endFrame,
    sourceMediaPath: sourcePath,
    resolveAssetPath: (assetId) => {
      // Multi-clip renders: the caller's assets must be owned by the user —
      // resolved synchronously from the validated snapshot's clip list via a
      // preloaded map built by the route (jobs carry paths, never client text).
      const map = (parsed as { assetPaths?: Record<string, string> }).assetPaths ?? {};
      return map[assetId] ?? null;
    },
  });

  // Ownership re-check for any asset path the route embedded.
  const assetPaths = (parsed as { assetPaths?: Record<string, string> }).assetPaths ?? {};
  for (const [assetId, p] of Object.entries(assetPaths)) {
    const asset = await db.mediaAsset.findUnique({ where: { id: assetId } });
    if (!asset || asset.userId !== job.userId || asset.storagePath !== p) {
      throw new PermanentJobError(`NIKKI_RENDER asset ${assetId} failed the ownership check`);
    }
  }

  await ensureRendersDir();
  const outPath = pathInsideMediaRoot("nikki-renders", `nikki_${job.id}.mp4`);
  const args = [...plan.inputs, "-filter_complex", plan.filterGraph, ...plan.outputArgs, outPath];

  await jobManager.runFfmpeg(job.id, args, {
    totalDurationSec: plan.durationSec,
    stageLabel: "NIIKI render",
    onDone: async () => {
      const st = await stat(outPath).catch(() => null);
      if (!st || st.size === 0) throw new Error("NIIKI render produced no output file");
      // A/V sync guard: rendered duration must match the plan window.
      const dur = await probeDurationSec(outPath);
      if (dur !== null && Math.abs(dur - plan.durationSec) > Math.max(0.15, 2 / (seq.fps.num / seq.fps.den))) {
        throw new Error(`A/V sync guard: rendered duration ${dur?.toFixed(3)}s differs from the planned ${plan.durationSec.toFixed(3)}s`);
      }
      const exportFile = await db.exportFile.create({
        data: {
          userId: job.userId,
          kind: "VIDEO",
          format: "mp4",
          filename: `nikki_${job.id}.mp4`,
          storagePath: outPath,
          sizeBytes: st.size,
          durationSec: dur ?? plan.durationSec,
          paramsJson: JSON.stringify({ summary: plan.summary, width: seq.width, height: seq.height }),
        },
      });
      await jobManager.complete(job.id, exportFile.id, `NIIKI render ready: ${plan.summary.join("; ")}`);
    },
    onSettled: async () => {
      const jobRow = await db.job.findUnique({ where: { id: job.id } }).catch(() => null);
      if (jobRow && (jobRow.status === "CANCELLED" || jobRow.status === "FAILED")) {
        const { rm } = await import("fs/promises");
        await rm(outPath, { force: true }).catch(() => undefined);
      }
    },
  });

  await new Promise<void>((resolve, reject) => {
    let open = true;
    const poll = setInterval(async () => {
      const jobRow = await db.job.findUnique({ where: { id: job.id } }).catch(() => null);
      if (!open || !jobRow) return;
      if (jobRow.status === "COMPLETED") {
        open = false;
        clearInterval(poll);
        resolve();
      } else if (jobRow.status === "FAILED" || jobRow.status === "CANCELLED") {
        open = false;
        clearInterval(poll);
        reject(new Error(jobRow.message ?? `NIKKI job ${jobRow.status}`));
      }
    }, 500);
    poll.unref?.();
  });
}
