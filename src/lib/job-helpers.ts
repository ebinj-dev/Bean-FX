import { db } from "@/lib/db";

/**
 * Shared, dependency-free plumbing for the M3 durable media worker.
 * Both the worker loop and the job handlers import from here — keeping this
 * module free of handler imports is what makes the dependency graph acyclic.
 */

export const JOB_TYPE_MEDIA_PROBE = "MEDIA_PROBE";
export const JOB_TYPE_MEDIA_PROXY = "MEDIA_PROXY";
export const JOB_TYPE_GANGZII_ANALYZE = "GANGZII_ANALYZE";
export const JOB_TYPE_GANGZII_PROCESS = "GANGZII_PROCESS";
export const JOB_TYPE_NIKKI_RENDER = "NIKKI_RENDER";
export const JOB_TYPE_JAZMII_GENERATE = "JAZMII_GENERATE";
export const JOB_TYPE_JAZMII_ANALYZE = "JAZMII_ANALYZE";
export const JOB_TYPE_LAXII_GENERATE = "LAXII_GENERATE";
export const JOB_TYPE_STUDIO_TOPIC = "STUDIO_TOPIC";
// ── M9 Professional Publishing ──
export const JOB_TYPE_PUBLISH_THUMBNAIL = "PUBLISH_THUMBNAIL";
export const JOB_TYPE_EXPORT_VARIANT = "EXPORT_VARIANT";
export const JOB_TYPE_PUBLISH_PACKAGE = "PUBLISH_PACKAGE";
// ── M10 AI Creative Director ──
export const JOB_TYPE_CREATIVE_REVIEW = "CREATIVE_REVIEW";
export const JOB_TYPE_CREATIVE_VARIANTS = "CREATIVE_VARIANTS";
export const JOB_TYPE_CREATIVE_MULTIMODAL = "CREATIVE_MULTIMODAL";
export const JOB_TYPE_TRANSCRIBE_PROJECT = "TRANSCRIBE_PROJECT";
// ── M12 Visual Intelligence ──
export const JOB_TYPE_VISUAL_INTELLIGENCE = "VISUAL_INTELLIGENCE";
// ── M13 Temporal Visual Intelligence ──
export const JOB_TYPE_TEMPORAL_INTELLIGENCE = "TEMPORAL_INTELLIGENCE";
/** Worker-owned job types: M3 media pipeline + M5 GANGZII + M6 NIIKI + M7 engines + M8.1 studio + M9 publishing; legacy job types keep their existing behavior. */
export const MEDIA_JOB_TYPES = [
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
  JOB_TYPE_CREATIVE_MULTIMODAL,
  JOB_TYPE_TRANSCRIBE_PROJECT,
  JOB_TYPE_VISUAL_INTELLIGENCE,
  JOB_TYPE_TEMPORAL_INTELLIGENCE,
] as const;

/** Default hard wall-clock limits per job type (seconds). */
export const DEFAULT_TIMEOUT_SEC: Record<string, number> = {
  [JOB_TYPE_MEDIA_PROBE]: 120,
  [JOB_TYPE_MEDIA_PROXY]: 45 * 60,
  [JOB_TYPE_GANGZII_ANALYZE]: 15 * 60,
  [JOB_TYPE_GANGZII_PROCESS]: 30 * 60,
  [JOB_TYPE_NIKKI_RENDER]: 45 * 60,
  [JOB_TYPE_JAZMII_GENERATE]: 20 * 60,
  [JOB_TYPE_JAZMII_ANALYZE]: 10 * 60,
  [JOB_TYPE_LAXII_GENERATE]: 15 * 60,
  [JOB_TYPE_STUDIO_TOPIC]: 15 * 60,
  [JOB_TYPE_PUBLISH_THUMBNAIL]: 15 * 60,
  [JOB_TYPE_EXPORT_VARIANT]: 45 * 60,
  [JOB_TYPE_PUBLISH_PACKAGE]: 30 * 60,
  [JOB_TYPE_CREATIVE_REVIEW]: 30 * 60,
  [JOB_TYPE_CREATIVE_VARIANTS]: 10 * 60,
  [JOB_TYPE_CREATIVE_MULTIMODAL]: 30 * 60,
  [JOB_TYPE_TRANSCRIBE_PROJECT]: 15 * 60,
  [JOB_TYPE_VISUAL_INTELLIGENCE]: 45 * 60,
  [JOB_TYPE_TEMPORAL_INTELLIGENCE]: 45 * 60,
};

export const MAX_ATTEMPTS_DEFAULT = 3;

/** Error subclass for deterministic failures — retried attempts can never succeed. */
export class PermanentJobError extends Error {}

export interface EnqueueOpts {
  maxAttempts?: number;
  timeoutSec?: number;
  runAfter?: Date;
}

/**
 * Create a QUEUED job owned by the media worker. Starting the worker loop is
 * an import-time side effect of media-worker; enqueueing through this helper
 * keeps every producer honest (a queued job with no live worker would sit
 * forever).
 */
export async function enqueueMediaJob(
  userId: string,
  type: string,
  params: unknown,
  opts: EnqueueOpts = {}
): Promise<string> {
  const job = await db.job.create({
    data: {
      userId,
      type,
      status: "QUEUED",
      stage: "Queued",
      paramsJson: JSON.stringify(params ?? {}),
      maxAttempts: opts.maxAttempts ?? MAX_ATTEMPTS_DEFAULT,
      timeoutSec: opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC[type] ?? 600,
      ...(opts.runAfter ? { runAfter: opts.runAfter } : {}),
    },
  });
  return job.id;
}

/**
 * Terminal status write guarded on status="PROCESSING": a job cancelled
 * (CANCELLED) or recovered between our claim and its completion must never be
 * resurrected by a late handler result.
 */
export async function finishJob(jobId: string, data: Record<string, unknown>): Promise<void> {
  await db.job
    .updateMany({ where: { id: jobId, status: "PROCESSING" }, data })
    .catch(() => undefined);
}

export async function completeJob(jobId: string, message: string): Promise<void> {
  await finishJob(jobId, {
    status: "COMPLETED",
    progress: 100,
    stage: "Completed",
    message,
    lastHeartbeatAt: new Date(),
  });
}

export async function failJob(jobId: string, message: string): Promise<void> {
  await finishJob(jobId, {
    status: "FAILED",
    stage: "Failed",
    message: message.slice(0, 500),
    lastHeartbeatAt: new Date(),
  });
}

/** Re-queue a PROCESSING job for another attempt after exponential backoff. */
export async function requeueJob(jobId: string, attempts: number, message: string): Promise<void> {
  const backoffMs = Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 5 * 60_000);
  await finishJob(jobId, {
    status: "QUEUED",
    stage: "Retrying",
    message: message.slice(0, 500),
    runAfter: new Date(Date.now() + backoffMs),
    claimedAt: null,
    lastHeartbeatAt: new Date(),
  });
}

/**
 * Route a handler failure: permanent errors (invalid media, missing file)
 * fail immediately; transient errors retry until maxAttempts is exhausted.
 * `attempts` is the claim attempt that just failed (already incremented).
 * Returns what happened so callers can keep associated asset state in sync.
 */
export async function handleJobError(
  jobId: string,
  err: unknown,
  attempts: number,
  maxAttempts: number,
  context: string
): Promise<"requeued" | "failed"> {
  const message = err instanceof Error ? err.message : String(err);
  // name-based check works across module instances (bun/bundlers can load the
  // same module under two specifiers, breaking instanceof for subclasses).
  const permanent = err instanceof PermanentJobError || (err instanceof Error && err.name === PermanentJobError.name);
  if (!permanent && attempts < maxAttempts) {
    await requeueJob(jobId, attempts, `${context}: ${message} (attempt ${attempts}/${maxAttempts} failed, retrying)`);
    return "requeued";
  }
  await failJob(jobId, permanent ? message : `${context}: ${message} (no attempts left)`);
  return "failed";
}

/** Exponential-backoff timestamp for recovered stale claims. */
export function retryBackoff(attempts: number): Date {
  return new Date(Date.now() + Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 5 * 60_000));
}
