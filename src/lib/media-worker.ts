import { promises as fs } from "fs";
import path from "path";
import { db } from "@/lib/db";
import { jobManager } from "@/lib/job-runner";
import {
  DEFAULT_TIMEOUT_SEC,
  MEDIA_JOB_TYPES,
  JOB_TYPE_MEDIA_PROBE,
  JOB_TYPE_MEDIA_PROXY,
  JOB_TYPE_GANGZII_ANALYZE,
  JOB_TYPE_GANGZII_PROCESS,
  JOB_TYPE_NIKKI_RENDER,
  JOB_TYPE_JAZMII_GENERATE,
  JOB_TYPE_JAZMII_ANALYZE,
  JOB_TYPE_LAXII_GENERATE,
  JOB_TYPE_STUDIO_TOPIC,
  JOB_TYPE_PUBLISH_THUMBNAIL,
  JOB_TYPE_EXPORT_VARIANT,
  JOB_TYPE_PUBLISH_PACKAGE,
  JOB_TYPE_CREATIVE_REVIEW,
  JOB_TYPE_CREATIVE_VARIANTS,
  PermanentJobError,
  handleJobError,
  requeueJob,
  failJob,
  retryBackoff,
} from "@/lib/job-helpers";
import { MEDIA_ROOT, PROXIES_DIR, removeFileQuiet } from "@/lib/media-storage";
import { runProbeJob } from "@/lib/media-analysis";
import { runProxyJob } from "@/lib/media-proxy";
import { runGangziiAnalyzeJob, runGangziiProcessJob } from "@/lib/gangzii/jobs";
import { runNikkiRenderJob } from "@/lib/nikki/jobs";
import { runJazmiiGenerateJob, runJazmiiAnalyzeJob } from "@/lib/jazmii/jobs";
import { runLaxiiGenerateJob } from "@/lib/laxii/jobs";
import { runStudioTopicJob } from "@/lib/studio/jobs";
import { runPublishThumbnailJob, runExportVariantJob, runPublishPackageJob } from "@/lib/publish/jobs";
import { runCreativeReviewJob, runCreativeVariantsJob } from "@/lib/creative/jobs";

/**
 * M3.4 — durable background worker for media processing.
 *
 * Design (matches this repo's constraints):
 * - The queue is the Job table itself: durable across restarts, no extra
 *   infrastructure (SQLite has no SELECT … FOR UPDATE SKIP LOCKED, so claims
 *   are made atomic with a conditional updateMany on status="QUEUED").
 * - The loop runs in-process with a lazy timer, exactly like the existing
 *   orphan sweep in job-runner.ts — zero changes to how the server starts.
 * - Liveness: every job writes lastHeartbeatAt (progress updates and a 15 s
 *   ticker). Claims whose heartbeat goes stale for CLAIM_STALE_MS are dead
 *   with their process — recovery re-queues them (retry) or fails them.
 * - Concurrency: a global cap (this sandbox has 2 vCPU; one transcode
 *   saturates a core) plus per-user caps so one user cannot starve others.
 * - Idempotency: probe re-reads the file; proxy short-circuits when a READY
 *   proxy file already exists. A recovered job can therefore safely re-run.
 * - Ownership: MEDIA_PROBE / MEDIA_PROXY (M3 media pipeline),
 *   GANGZII_ANALYZE / GANGZII_PROCESS (M5 audio engine) and NIKKI_RENDER
 *   (M6 motion graphics) are owned by this worker; the legacy fire-and-forget
 *   job types keep their existing behavior.
 */

const TICK_MS = 2_000;
/** A PROCESSING job silent this long is considered dead with its worker. */
const CLAIM_STALE_MS = 90_000;
/** Global concurrent MEDIA_* jobs. */
const GLOBAL_MAX_ACTIVE = 2;
/** Per-user concurrent jobs by type. */
const USER_MAX_ACTIVE: Record<string, number> = {
  [JOB_TYPE_MEDIA_PROBE]: 2,
  [JOB_TYPE_MEDIA_PROXY]: 1,
  [JOB_TYPE_GANGZII_ANALYZE]: 1,
  [JOB_TYPE_GANGZII_PROCESS]: 1,
  [JOB_TYPE_NIKKI_RENDER]: 1,
  [JOB_TYPE_JAZMII_GENERATE]: 1,
  [JOB_TYPE_JAZMII_ANALYZE]: 1,
  [JOB_TYPE_LAXII_GENERATE]: 1,
  [JOB_TYPE_STUDIO_TOPIC]: 1,
  [JOB_TYPE_PUBLISH_THUMBNAIL]: 1,
  [JOB_TYPE_EXPORT_VARIANT]: 1,
  [JOB_TYPE_PUBLISH_PACKAGE]: 1,
  [JOB_TYPE_CREATIVE_REVIEW]: 1,
  [JOB_TYPE_CREATIVE_VARIANTS]: 1,
};
/** Scratch sweeps run at most this often. */
const SWEEP_INTERVAL_MS = 15 * 60_000;
const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60_000;
const ASSEMBLED_TTL_MS = 6 * 60 * 60_000;

type MediaJobHandler = (job: {
  id: string;
  userId: string;
  attempts: number;
  maxAttempts: number;
  paramsJson: string | null;
}) => Promise<void>;

const HANDLERS: Record<string, MediaJobHandler> = {
  [JOB_TYPE_MEDIA_PROBE]: runProbeJob,
  [JOB_TYPE_MEDIA_PROXY]: runProxyJob,
  [JOB_TYPE_GANGZII_ANALYZE]: runGangziiAnalyzeJob,
  [JOB_TYPE_GANGZII_PROCESS]: runGangziiProcessJob,
  [JOB_TYPE_NIKKI_RENDER]: runNikkiRenderJob,
  [JOB_TYPE_JAZMII_GENERATE]: runJazmiiGenerateJob,
  [JOB_TYPE_JAZMII_ANALYZE]: runJazmiiAnalyzeJob,
  [JOB_TYPE_LAXII_GENERATE]: runLaxiiGenerateJob,
  [JOB_TYPE_STUDIO_TOPIC]: runStudioTopicJob,
  [JOB_TYPE_PUBLISH_THUMBNAIL]: runPublishThumbnailJob,
  [JOB_TYPE_EXPORT_VARIANT]: runExportVariantJob,
  [JOB_TYPE_PUBLISH_PACKAGE]: runPublishPackageJob,
  [JOB_TYPE_CREATIVE_REVIEW]: runCreativeReviewJob,
  [JOB_TYPE_CREATIVE_VARIANTS]: runCreativeVariantsJob,
};

interface WorkerState {
  timer: ReturnType<typeof setInterval> | null;
  ticking: boolean;
  lastSweepAt: number;
}

// Module state must survive dev-time route re-evaluation (same pattern as db.ts).
const globalForWorker = globalThis as unknown as { __beanfxMediaWorker?: WorkerState };
const state: WorkerState =
  globalForWorker.__beanfxMediaWorker ?? (globalForWorker.__beanfxMediaWorker = { timer: null, ticking: false, lastSweepAt: 0 });

/**
 * Re-queue (or fail) PROCESSING jobs whose worker died: no heartbeat for
 * CLAIM_STALE_MS means no live process is writing progress behind the claim.
 */
async function recoverStaleClaims(): Promise<void> {
  const cut = new Date(Date.now() - CLAIM_STALE_MS);
  const stale = await db.job.findMany({
    where: { type: { in: [...MEDIA_JOB_TYPES] }, status: "PROCESSING", lastHeartbeatAt: { lt: cut } },
    take: 20,
  });
  for (const job of stale) {
    const guarded = { id: job.id, status: "PROCESSING", lastHeartbeatAt: { lt: cut } };
    if (job.attempts < job.maxAttempts) {
      const resumed = await db.job.updateMany({
        where: guarded,
        data: {
          status: "QUEUED",
          stage: "Retrying",
          message: `Recovered after a worker interruption (attempt ${job.attempts}/${job.maxAttempts}).`,
          runAfter: retryBackoff(job.attempts),
          claimedAt: null,
          lastHeartbeatAt: new Date(),
        },
      });
      if (resumed.count === 1) await resetAssetMarkers(job.type, job.paramsJson, "pending", null);
    } else {
      const failed = await db.job.updateMany({
        where: guarded,
        data: {
          status: "FAILED",
          stage: "Failed",
          message: "Processing was interrupted and every retry was already used. The original media is intact.",
        },
      });
      if (failed.count === 1) await resetAssetMarkers(job.type, job.paramsJson, "failed", "Processing was interrupted.");
    }
  }
}

/** Keep the MediaAsset processing flags in step with the job lifecycle. */
async function resetAssetMarkers(type: string, paramsJson: string | null, mode: "pending" | "failed", message: string | null) {
  const mediaId = (JSON.parse(paramsJson ?? "{}") as { mediaId?: string }).mediaId;
  if (!mediaId) return;
  if (type === JOB_TYPE_MEDIA_PROBE) {
    await db.mediaAsset
      .updateMany({
        where: { id: mediaId, probeStatus: "PROCESSING" },
        data: mode === "pending" ? { probeStatus: "PENDING" } : { probeStatus: "FAILED", probeError: (message ?? "").slice(0, 500) },
      })
      .catch(() => undefined);
  } else if (type === JOB_TYPE_MEDIA_PROXY) {
    await db.mediaAsset
      .updateMany({
        where: { id: mediaId, proxyStatus: "PROCESSING" },
        data: mode === "pending" ? { proxyStatus: "QUEUED" } : { proxyStatus: "FAILED", proxyError: (message ?? "").slice(0, 500) },
      })
      .catch(() => undefined);
  }
}

/** Mark the asset as actively processing right after a successful claim. */
async function markAssetProcessing(type: string, paramsJson: string | null): Promise<void> {
  const mediaId = (JSON.parse(paramsJson ?? "{}") as { mediaId?: string }).mediaId;
  if (!mediaId) return;
  if (type === JOB_TYPE_MEDIA_PROBE) {
    await db.mediaAsset
      .updateMany({ where: { id: mediaId, probeStatus: { in: ["PENDING", "QUEUED"] } }, data: { probeStatus: "PROCESSING" } })
      .catch(() => undefined);
  } else if (type === JOB_TYPE_MEDIA_PROXY) {
    await db.mediaAsset
      .updateMany({ where: { id: mediaId, proxyStatus: { in: ["QUEUED", "PENDING"] } }, data: { proxyStatus: "PROCESSING" } })
      .catch(() => undefined);
  }
}

/** Execute one claimed job with a heartbeat ticker and a hard timeout. */
async function executeClaimed(job: {
  id: string;
  userId: string;
  type: string;
  attempts: number;
  maxAttempts: number;
  paramsJson: string | null;
  timeoutSec: number | null;
}): Promise<void> {
  const handler = HANDLERS[job.type];
  const timeoutMs = ((job.timeoutSec ?? DEFAULT_TIMEOUT_SEC[job.type] ?? 600) as number) * 1000;
  const heartbeat = setInterval(() => {
    void db.job
      .updateMany({ where: { id: job.id, status: "PROCESSING" }, data: { lastHeartbeatAt: new Date() } })
      .catch(() => undefined);
  }, 15_000);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // Kill any spawned child first so the handler unwinds promptly; the race
    // rejection below is the net for handlers without a killable child.
    jobManager.killChildForTimeout(job.id);
  }, timeoutMs);

  try {
    if (!handler) throw new PermanentJobError(`No handler registered for job type ${job.type}.`);
    await Promise.race([
      handler({ id: job.id, userId: job.userId, attempts: job.attempts, maxAttempts: job.maxAttempts, paramsJson: job.paramsJson }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Job exceeded its ${Math.round(timeoutMs / 1000)}s time limit.`)), timeoutMs)
      ),
    ]);
  } catch (err) {
    if (timedOut) {
      if (job.attempts < job.maxAttempts) {
        await requeueJob(job.id, job.attempts, "Job exceeded its time limit (attempt used, retrying).");
        await resetAssetMarkers(job.type, job.paramsJson, "pending", null);
      } else {
        await failJob(job.id, "Job exceeded its time limit with no attempts left.");
        await resetAssetMarkers(job.type, job.paramsJson, "failed", "Job exceeded its time limit.");
      }
    } else {
      const outcome = await handleJobError(job.id, err, job.attempts, job.maxAttempts, "Media processing failed");
      // Handler catch blocks already recorded asset errors for failures;
      // make sure a requeued job's asset returns to its queue-side marker.
      if (outcome === "requeued") await resetAssetMarkers(job.type, job.paramsJson, "pending", null);
    }
  } finally {
    clearInterval(heartbeat);
    clearTimeout(timer);
  }
}

/**
 * One worker tick: recovery pass, then claim-and-run until a cap is hit.
 * Exported so tests (and anyone debugging) can drive it deterministically.
 */
export async function tickWorkerOnce(): Promise<void> {
  if (state.ticking) return;
  state.ticking = true;
  try {
    await recoverStaleClaims();
    await claimAndRun();
    if (Date.now() - state.lastSweepAt > SWEEP_INTERVAL_MS) {
      state.lastSweepAt = Date.now();
      await runScratchSweeps().catch(() => undefined);
    }
  } finally {
    state.ticking = false;
  }
}

async function claimAndRun(): Promise<void> {
  const now = new Date();
  const candidates = await db.job.findMany({
    where: {
      type: { in: [...MEDIA_JOB_TYPES] },
      status: "QUEUED",
      OR: [{ runAfter: null }, { runAfter: { lte: now } }],
    },
    orderBy: { createdAt: "asc" },
    take: 20,
  });
  if (candidates.length === 0) return;

  const active = await db.job.findMany({
    where: { type: { in: [...MEDIA_JOB_TYPES] }, status: "PROCESSING" },
    select: { userId: true, type: true },
  });
  let globalActive = active.length;
  const perUser = new Map<string, Map<string, number>>();
  for (const row of active) {
    const byType = perUser.get(row.userId) ?? new Map<string, number>();
    byType.set(row.type, (byType.get(row.type) ?? 0) + 1);
    perUser.set(row.userId, byType);
  }

  for (const candidate of candidates) {
    if (globalActive >= GLOBAL_MAX_ACTIVE) break;
    const userActive = perUser.get(candidate.userId)?.get(candidate.type) ?? 0;
    if (userActive >= (USER_MAX_ACTIVE[candidate.type] ?? 1)) continue;

    const claimed = await db.job.updateMany({
      // Atomic claim: only one caller can flip this exact row QUEUED→PROCESSING.
      where: { id: candidate.id, status: "QUEUED" },
      data: { status: "PROCESSING", claimedAt: now, lastHeartbeatAt: now, attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) continue; // cancelled, or claimed by another worker

    await markAssetProcessing(candidate.type, candidate.paramsJson);
    globalActive += 1;
    const byType = perUser.get(candidate.userId) ?? new Map<string, number>();
    byType.set(candidate.type, userActive + 1);
    perUser.set(candidate.userId, byType);

    void executeClaimed({
      id: candidate.id,
      userId: candidate.userId,
      type: candidate.type,
      attempts: candidate.attempts + 1,
      maxAttempts: candidate.maxAttempts,
      paramsJson: candidate.paramsJson,
      timeoutSec: candidate.timeoutSec,
    }).catch(() => undefined);
  }
}

/** Storage hygiene: abandoned upload sessions, stale scratch, orphan proxies. */
export async function runScratchSweeps(): Promise<{ sessions: number; scratch: number; orphans: number }> {
  const now = Date.now();
  let sessions = 0;
  let scratch = 0;
  let orphans = 0;

  // 1. Upload sessions with no chunk for 24 h are abandoned — cancel and clear scratch.
  const abandoned = await db.uploadSession.findMany({
    where: { status: "OPEN", lastChunkAt: { lt: new Date(now - UPLOAD_SESSION_TTL_MS) } },
    take: 100,
  });
  for (const session of abandoned) {
    const cancelled = await db.uploadSession.updateMany({
      where: { id: session.id, status: "OPEN", lastChunkAt: session.lastChunkAt },
      data: { status: "CANCELLED" },
    });
    if (cancelled.count === 1) {
      await fs.rm(path.join(MEDIA_ROOT, "tmp", `up_${session.id}`), { recursive: true, force: true }).catch(() => undefined);
      sessions += 1;
    }
  }

  // 2. Stale scratch that predates the request-path GC (idle servers, crashed uploads).
  const tmpDir = path.join(MEDIA_ROOT, "tmp");
  const entries = await fs.readdir(tmpDir).catch(() => [] as string[]);
  for (const entry of entries) {
    const ttlMs = entry.startsWith("up_") ? UPLOAD_SESSION_TTL_MS : ASSEMBLED_TTL_MS;
    const p = path.join(tmpDir, entry);
    const st = await fs.stat(p).catch(() => null);
    if (st && now - st.mtimeMs > ttlMs) {
      await fs.rm(p, { recursive: true, force: true }).catch(() => undefined);
      scratch += 1;
    }
  }

  // 3. Proxy files whose asset is gone or no longer points at them — the
  //    originals are NEVER swept here; user deletion is the only path.
  const proxyFiles = await fs.readdir(PROXIES_DIR).catch(() => [] as string[]);
  for (const file of proxyFiles) {
    if (!file.endsWith(".mp4")) continue;
    const assetId = file.replace(/\.mp4$/, "");
    const asset = await db.mediaAsset.findUnique({ where: { id: assetId }, select: { proxyPath: true } });
    if (!asset || asset.proxyPath !== path.join(PROXIES_DIR, file)) {
      await removeFileQuiet(path.join(PROXIES_DIR, file));
      orphans += 1;
    }
  }
  return { sessions, scratch, orphans };
}

/** Start the worker loop once per process (idempotent across module re-evals). */
export function ensureMediaWorker(): void {
  if (state.timer) return;
  const timer = setInterval(() => {
    void tickWorkerOnce().catch(() => undefined);
  }, TICK_MS);
  // Unref so bun test runs and CLI scripts importing this module can exit.
  timer.unref?.();
  state.timer = timer;
  void tickWorkerOnce().catch(() => undefined);
}

// Autostart on first import (server process). Tests opt out with
// BEANFX_MEDIA_WORKER_AUTOSTART=0 and drive tickWorkerOnce() manually.
if (process.env.BEANFX_MEDIA_WORKER_AUTOSTART !== "0") {
  ensureMediaWorker();
}
