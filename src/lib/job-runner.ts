import { spawn, ChildProcess } from "child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { db } from "@/lib/db";
import { MEDIA_ROOT } from "@/lib/media-storage";
import type { JobStatus } from "@/lib/types";

// ── M37: scoped orphan recovery ─────────────────────────────────────────────
// The stale-claim recovery path previously ran a host-wide `pkill -9 ffmpeg`,
// which also killed live proxy/variant/composition encoders owned by OTHER
// jobs. Instead, every spawned ffmpeg records its PID in a per-job pidfile;
// recovery kills ONLY that verified PID (its /proc cmdline must still be
// ffmpeg — no PID-reuse collateral). Cross-process safe, no schema change.
export function ffmpegPidFile(jobId: string): string {
  return path.join(MEDIA_ROOT, "tmp", `ffmpeg-${jobId}.pid`);
}

/** Kill the orphaned ffmpeg recorded for this job, if any. Returns true when
 *  a live ffmpeg process was actually killed. */
export async function killOrphanFfmpegForJob(jobId: string): Promise<boolean> {
  const file = ffmpegPidFile(jobId);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8").trim();
  } catch {
    return false; // no pidfile — the encoder already settled or never started
  }
  rmSync(file, { force: true });
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    const cmdline = await (await import("fs/promises")).readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
    if (!cmdline || !cmdline.includes("ffmpeg")) return false; // PID reused by an unrelated process
    process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false; // already gone, or not permitted — never escalate to pkill
  }
}

interface ActiveJob {
  child: ChildProcess;
  cancelled: boolean;
  /** Set by killChildForTimeout — the close handler must fail, not cancel. */
  timedOut?: boolean;
}

/**
 * In-process job manager. Progress comes from ffmpeg's real `-progress pipe:1`
 * output — never fabricated increments. Jobs are also persisted in the DB so
 * status survives navigation.
 */
export class JobManager {
  private active = new Map<string, ActiveJob>();

  async createJob(userId: string, type: string, params: unknown): Promise<string> {
    const job = await db.job.create({
      data: {
        userId,
        type,
        status: "QUEUED",
        stage: "Queued",
        paramsJson: JSON.stringify(params ?? {}),
      },
    });
    return job.id;
  }

  async setStatus(jobId: string, status: JobStatus, stage?: string, message?: string) {
    await db.job
      .update({
        where: { id: jobId },
        data: { status, ...(stage !== undefined ? { stage } : {}), ...(message !== undefined ? { message } : {}) },
      })
      .catch(() => undefined);
  }

  async setProgress(jobId: string, progress: number, stage?: string) {
    const clamped = Math.max(0, Math.min(100, Math.round(progress)));
    await db.job
      // lastHeartbeatAt doubles as the worker's liveness marker (M3): every
      // real progress write proves a live process is behind the job.
      .update({ where: { id: jobId }, data: { progress: clamped, lastHeartbeatAt: new Date(), ...(stage ? { stage } : {}) } })
      .catch(() => undefined);
  }

  /** exportId is null for job types whose result is not an ExportFile row
   *  (e.g. GANGZII — the result lives on its own process row). */
  async complete(jobId: string, exportId: string | null, message: string) {
    await db.job
      .update({
        where: { id: jobId },
        data: { status: "COMPLETED", progress: 100, stage: "Completed", message, exportId },
      })
      .catch(() => undefined);
    this.active.delete(jobId);
  }

  async fail(jobId: string, error: string) {
    await db.job
      .update({ where: { id: jobId }, data: { status: "FAILED", stage: "Failed", message: error } })
      .catch(() => undefined);
    this.active.delete(jobId);
  }

  /** Spawn ffmpeg with -progress and stream real progress into the DB. */
  /**
   * M20 §3 root-cause fix: runFfmpeg previously returned `void` while every
   * caller (8 sites: timeline windows, concat, single-pass, proxies, autocut)
   * `await`-ed it expecting completion. The await resolved instantly, so the
   * long-form window loop spawned ALL windows concurrently (OOM on 4GB hosts)
   * and the concat step read window segments that were still being written
   * ("Invalid data found when processing input"). Now returns a promise that
   * settles exactly when ffmpeg settles (done / failed / cancelled / timeout),
   * making every existing `await` correct without touching call sites.
   */
  runFfmpeg(
    jobId: string,
    args: string[],
    opts: {
      totalDurationSec: number | null;
      onDone: () => Promise<void>;
      stageLabel: string;
      /** Runs once after ffmpeg settles (done, failed, or cancelled) — used for temp-file cleanup. */
      onSettled?: () => Promise<void>;
    }
  ): Promise<void> {
    return new Promise<void>((resolveFfmpeg) => {
      const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args, "-progress", "pipe:1", "-nostats"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.active.set(jobId, { child, cancelled: false });
      if (child.pid) {
        try {
          const pidFile = ffmpegPidFile(jobId);
          mkdirSync(path.dirname(pidFile), { recursive: true });
          writeFileSync(pidFile, String(child.pid));
        } catch { /* best effort — recovery falls back to "no orphan known" */ }
      }

      let stderrBuf = "";
      let lastUpdate = 0;

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        const match = [...text.matchAll(/out_time_ms=(\d+)/g)].pop();
        if (match && opts.totalDurationSec && opts.totalDurationSec > 0) {
          const outMs = Number(match[1]);
          const pct = (outMs / 1_000_000 / opts.totalDurationSec) * 100;
          const now = Date.now();
          if (now - lastUpdate > 400) {
            lastUpdate = now;
            void this.setProgress(jobId, Math.min(99, pct), opts.stageLabel);
          }
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        stderrBuf = (stderrBuf + chunk.toString()).slice(-8000);
      });

      child.on("error", (err) => {
        void this.fail(jobId, `Failed to start ffmpeg: ${err.message}`).catch(() => undefined);
        resolveFfmpeg();
      });

      child.on("close", (code, signal) => {
        void (async () => {
          try { rmSync(ffmpegPidFile(jobId), { force: true }); } catch { /* best effort */ }
          const entry = this.active.get(jobId);
          const timedOut = entry?.timedOut === true;
          // M18 §6 fix: a SIGKILL the user did not request is almost always the
          // OOM killer (observed on the 600s render: ffmpeg at 2.5GB RSS on a
          // 4GB sandbox). Reporting it as a user cancellation hid the real cause.
          const wasCancelled = !timedOut && (entry?.cancelled || signal === "SIGTERM");
          const wasKilled = !timedOut && !entry?.cancelled && signal === "SIGKILL";
          this.active.delete(jobId);
          if (timedOut) {
            await this.fail(jobId, "Processing exceeded its time limit and was stopped.");
            await opts.onSettled?.().catch(() => undefined);
            return;
          }
          if (wasCancelled) {
            await db.job
              .update({ where: { id: jobId }, data: { status: "CANCELLED", stage: "Cancelled", message: "Processing was cancelled. Original media is intact." } })
              .catch(() => undefined);
            await opts.onSettled?.().catch(() => undefined);
            return;
          }
          if (wasKilled) {
            await this.fail(jobId, `The encoder process was killed by the system (signal SIGKILL) — most likely out of memory while rendering this timeline. Try a proxy workflow or shorter segments. ${stderrBuf.trim().slice(-200)}`);
            await opts.onSettled?.().catch(() => undefined);
            return;
          }
          if (code === 0) {
            try {
              await opts.onDone();
            } catch (err) {
              await this.fail(jobId, err instanceof Error ? err.message : "Post-processing failed.");
            }
          } else {
            const tail = stderrBuf.trim().split("\n").slice(-3).join(" | ");
            await this.fail(jobId, `ffmpeg exited with code ${code}. ${tail || "No error detail available."}`);
          }
          await opts.onSettled?.().catch(() => undefined);
        })()
          .catch((e) => {
            // The settle path itself must never reject the promise or crash the worker.
            console.error(`[job-runner] ffmpeg settle bookkeeping failed for ${jobId}:`, e);
          })
          .finally(() => resolveFfmpeg());
      });
    });
  }

  async cancel(jobId: string, userId: string): Promise<boolean> {
    const job = await db.job.findUnique({ where: { id: jobId } });
    if (!job || job.userId !== userId) return false;
    if (job.status === "COMPLETED" || job.status === "FAILED" || job.status === "CANCELLED") return false;
    const entry = this.active.get(jobId);
    if (entry) {
      entry.cancelled = true;
      entry.child.kill("SIGTERM");
    } else {
      await db.job
        .update({ where: { id: jobId }, data: { status: "CANCELLED", stage: "Cancelled", message: "Cancelled before processing started." } })
        .catch(() => undefined);
    }
    return true;
  }

  /**
   * Kill a running child because its job exceeded its time limit (M3 worker).
   * Unlike cancel() this writes no status itself — the close handler observes
   * `timedOut` and fails the job, keeping timeout accounting in one place.
   */
  killChildForTimeout(jobId: string): boolean {
    const entry = this.active.get(jobId);
    if (!entry) return false;
    entry.timedOut = true;
    try {
      entry.child.kill("SIGKILL");
    } catch {
      // already exited
    }
    return true;
  }
}

/**
 * Jobs left QUEUED/PROCESSING by a server restart have no process behind them
 * anymore (children die with the server) — mark them FAILED once at startup so
 * the UI stops polling them forever. On success the rename already moved the
 * output file, so this only ever affects genuinely interrupted jobs.
 */
async function failOrphanedJobs(): Promise<void> {
  // Only jobs with NO update for two minutes can be orphans: every live job
  // (ffmpeg progress or pipeline stage events) writes to its record every few
  // seconds. This matters in dev, where route modules can be re-evaluated
  // with fresh module state — an unconditional module-load sweep re-ran on
  // the first /api/jobs poll and marked a LIVE analysis job as failed.
  await db.job
    .updateMany({
      where: { status: { in: ["QUEUED", "PROCESSING"] }, updatedAt: { lt: new Date(Date.now() - 120_000) } },
      data: {
        status: "FAILED",
        stage: "Failed",
        message: "Processing was interrupted because the server restarted. The original media is intact — start the job again.",
      },
    })
    .catch(() => undefined);
}

void failOrphanedJobs();

export const jobManager = new JobManager();
