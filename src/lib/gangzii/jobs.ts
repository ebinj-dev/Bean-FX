/**
 * GANGZII — durable job handlers (M5 §7).
 *
 * Both handlers run inside the M3 durable worker (claim, heartbeat, stale
 * recovery, retry, hard timeout). FFmpeg execution reuses the proven
 * JobManager.runFfmpeg path: real `-progress` streaming into the Job row,
 * user cancellation via DELETE /api/jobs/[id], and timeout kill support.
 *
 * Non-destructive guarantee: handlers only READ the source file; outputs are
 * new files under media-store/derived/, registered as their own MediaAsset
 * rows (derivedFromId → original). Cancellation or failure never touches the
 * original; partial outputs are removed on settle.
 */
import { execFile } from "child_process";
import { stat, rm } from "fs/promises";
import path from "path";
import { db } from "@/lib/db";
import { jobManager } from "@/lib/job-runner";
import { PermanentJobError } from "@/lib/job-helpers";
import { buildGangziiChain, parseGangziiParams } from "./dsp";
import { inspectAudioFile, probeAudioStream } from "./inspect";
import { derivedPath, ensureDerivedDir } from "./storage";
import type { GangziiInspection, GangziiParams } from "./types";

interface HandlerJob {
  id: string;
  userId: string;
  attempts: number;
  maxAttempts: number;
  paramsJson: string | null;
}

async function loadProcess(job: HandlerJob) {
  const parsed = JSON.parse(job.paramsJson ?? "{}") as { processId?: string };
  if (!parsed.processId) throw new PermanentJobError("GANGZII job params missing processId");
  const row = await db.gangziiProcess.findUnique({ where: { id: parsed.processId } });
  if (!row) throw new PermanentJobError("GANGZII process row no longer exists");
  if (row.jobId && row.jobId !== job.id) throw new PermanentJobError("GANGZII process row is bound to a different job");
  const source = await db.mediaAsset.findUnique({ where: { id: row.sourceAssetId } });
  if (!source) throw new PermanentJobError("GANGZII source asset no longer exists");
  if (source.userId !== job.userId || row.userId !== job.userId) {
    throw new PermanentJobError("GANGZII ownership mismatch");
  }
  return { row, source };
}

function ffprobeNumber(file: string, entry: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      "ffprobe",
      ["-v", "error", "-select_streams", "a:0", "-show_entries", `stream=${entry}`, "-of", "json", file],
      { maxBuffer: 4 * 1024 * 1024 },
      (err, out) => {
        if (err) return resolve(null);
        try {
          const v = Number((JSON.parse(out) as { streams?: Record<string, string>[] }).streams?.[0]?.[entry]);
          resolve(Number.isFinite(v) ? v : null);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/**
 * Sync a process row after its handler threw. Respects cancellation: a
 * CANCELLED job must leave the row CANCELLED — never downgraded to FAILED
 * (the handler's own error path races with runFfmpeg's onSettled hook).
 */
async function syncFailedRow(processId: string, jobId: string, err: unknown): Promise<void> {
  if (!processId) return;
  const jobRow = await db.job.findUnique({ where: { id: jobId } }).catch(() => null);
  const cancelled = jobRow?.status === "CANCELLED";
  const message = cancelled
    ? (jobRow?.message ?? "Cancelled by user.")
    : err instanceof Error
      ? err.message
      : "GANGZII job failed";
  await db.gangziiProcess
    .update({ where: { id: processId }, data: { status: cancelled ? "CANCELLED" : "FAILED", error: message.slice(0, 500) } })
    .catch(() => undefined);
}

/** GANGZII_ANALYZE — stream-decode the source and store the structured inspection. */
export async function runGangziiAnalyzeJob(job: HandlerJob): Promise<void> {
  const processId = (JSON.parse(job.paramsJson ?? "{}") as { processId?: string }).processId ?? "";
  try {
    const { row, source } = await loadProcess(job);
    await db.gangziiProcess.update({ where: { id: row.id }, data: { status: "PROCESSING", error: null } });
    const inspection = await inspectAudioFile(source.storagePath, {
      onProgress: (fraction) => {
        void jobManager.setProgress(job.id, Math.max(1, Math.min(99, Math.round(fraction * 100))), "Analyzing audio");
      },
    });
    const summary =
      `Loudness ${inspection.loudness.integratedLufs ?? "n/a"} LUFS · ` +
      `true peak ${inspection.truePeakDbtp} dBTP · ` +
      `${inspection.channels} ch · ${inspection.durationSec.toFixed(1)} s` +
      (inspection.clipping.suspected ? " · CLIPPING DETECTED" : "");
    await db.gangziiProcess.update({
      where: { id: row.id },
      data: { status: "COMPLETED", analysisJson: JSON.stringify(inspection), error: null },
    });
    await jobManager.complete(job.id, null, summary);
  } catch (err) {
    await syncFailedRow(processId, job.id, err);
    throw err;
  }
}

/** GANGZII_PROCESS — build the validated chain, run FFmpeg, register the derived asset. */
export async function runGangziiProcessJob(job: HandlerJob): Promise<void> {
  const processId = (JSON.parse(job.paramsJson ?? "{}") as { processId?: string }).processId ?? "";
  try {
    const { row, source } = await loadProcess(job);
    await db.gangziiProcess.update({ where: { id: row.id }, data: { status: "PROCESSING", error: null } });
    const params: GangziiParams = parseGangziiParams(JSON.parse(row.paramsJson ?? "{}"));
    const stream = await probeAudioStream(source.storagePath);
    const channels = stream.channels;
    const sourceDuration = stream.durationSec ?? source.durationSec ?? 0;
    let measured: { integratedLufs: number | null; truePeakDbtp: number | null } | undefined;
    if (row.analysisJson) {
      try {
        const inspection = JSON.parse(row.analysisJson) as GangziiInspection;
        measured = { integratedLufs: inspection.loudness.integratedLufs, truePeakDbtp: inspection.truePeakDbtp };
      } catch {
        measured = undefined;
      }
    }
    const chain = buildGangziiChain(params, {
      durationSec: sourceDuration,
      channels,
      channelLayout: stream.channelLayout,
      measured,
    });
    if (chain.filters.length === 0) {
      throw new PermanentJobError("No GANGZII processing operations were requested — nothing to apply.");
    }

    const isVideo = source.kind === "VIDEO";
    const ext = isVideo ? "mp4" : "flac";
    await ensureDerivedDir();
    const outPath = derivedPath(row.id, ext);
    const label = row.name ?? "processed";
    const args: string[] = [
      "-i", source.storagePath,
      "-map", "0:a:0",
      ...(isVideo ? ["-map", "0:v:0?", "-c:v", "copy"] : []),
      "-af", chain.filters.join(","),
      "-c:a", isVideo ? "aac" : "flac",
      ...(isVideo ? ["-b:a", "256k"] : []),
      ...chain.outputArgs,
      outPath,
    ];

    await jobManager.runFfmpeg(job.id, args, {
      totalDurationSec: sourceDuration > 0 ? sourceDuration : null,
      stageLabel: "GANGZII processing",
      onDone: async () => {
        const st = await stat(outPath).catch(() => null);
        if (!st || st.size === 0) throw new Error("GANGZII produced no output file");
        // A/V sync guard: every chain filter here is duration-neutral (fades,
        // limiter, EQ, compressor, static gain); only dynamic loudnorm may
        // flush a few ms through its internal resampler.
        const derived = await probeAudioStream(outPath);
        const tolerance = params.loudness.mode === "dynamic" ? 0.5 : 0.05;
        const delta = Math.abs((derived.durationSec ?? 0) - sourceDuration);
        if (sourceDuration > 0 && derived.durationSec !== null && delta > tolerance) {
          throw new Error(
            `A/V sync guard: derived duration ${derived.durationSec?.toFixed(3)}s differs from source ${sourceDuration.toFixed(3)}s by ${delta.toFixed(3)}s (tolerance ${tolerance}s) — output rejected, original untouched.`,
          );
        }
        const resultAsset = await db.mediaAsset.create({
          data: {
            userId: source.userId,
            projectId: source.projectId,
            originalName: `GANGZII · ${label} · ${path.basename(source.originalName)}`,
            storagePath: outPath,
            kind: isVideo ? "VIDEO" : "AUDIO",
            mimeType: isVideo ? "video/mp4" : "audio/flac",
            sizeBytes: st.size,
            durationSec: derived.durationSec,
            audioCodec: isVideo ? "aac" : "flac",
            sampleRate: derived.sampleRate,
            channels,
            derivedFromId: source.id,
          },
        });
        await db.gangziiProcess.update({
          where: { id: row.id },
          data: {
            status: "COMPLETED",
            resultAssetId: resultAsset.id,
            resultMetaJson: JSON.stringify({
              filters: chain.filters,
              notes: chain.notes,
              warnings: chain.warnings,
              durationDeltaSec: Number(delta.toFixed(3)),
              derivedAssetId: resultAsset.id,
              derivedDurationSec: derived.durationSec,
            }),
            error: null,
          },
        });
        await jobManager.complete(
          job.id,
          null,
          `GANGZII done: ${chain.filters.length} filter stage(s) → derived asset ${resultAsset.id}` +
            (chain.warnings.length ? ` (${chain.warnings.length} warning(s))` : ""),
        );
      },
      onSettled: async () => {
        // Sync the process row with the final Job state (cancel/fail paths)
        // and remove partial outputs — the original is never touched.
        const jobRow = await db.job.findUnique({ where: { id: job.id } }).catch(() => null);
        if (!jobRow) return;
        if (jobRow.status === "CANCELLED" || jobRow.status === "FAILED") {
          await db.gangziiProcess
            .update({
              where: { id: row.id },
              data: { status: jobRow.status, error: (jobRow.message ?? null) as string | null },
            })
            .catch(() => undefined);
          await rm(outPath, { force: true }).catch(() => undefined);
        }
      },
    });

    // runFfmpeg is fire-and-forget; hold the handler open until the Job row
    // reaches a terminal state so the worker's timeout/heartbeat semantics
    // keep applying while ffmpeg runs.
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
          reject(new Error(jobRow.message ?? `GANGZII job ${jobRow.status}`));
        }
      }, 500);
      poll.unref?.();
    });
  } catch (err) {
    // Respects cancellation (CANCELLED stays CANCELLED) and also fires when
    // loadProcess rejects before `row` was ever loaded.
    await syncFailedRow(processId, job.id, err);
    throw err;
  }
}
