import { spawn, ChildProcess } from "child_process";
import { db } from "@/lib/db";
import type { JobStatus } from "@/lib/types";

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
  ): void {
    const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args, "-progress", "pipe:1", "-nostats"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.active.set(jobId, { child, cancelled: false });

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
      void this.fail(jobId, `Failed to start ffmpeg: ${err.message}`);
    });

    child.on("close", async (code, signal) => {
      const entry = this.active.get(jobId);
      const timedOut = entry?.timedOut === true;
      const wasCancelled = !timedOut && (entry?.cancelled || signal === "SIGTERM" || signal === "SIGKILL");
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
