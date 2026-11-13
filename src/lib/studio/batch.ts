/**
 * Social Video Studio — batch production (M8.1 §11).
 *
 * Multiple topics with shared defaults, dispatched through the EXISTING
 * durable job infrastructure (jobManager + STUDIO_TOPIC handler in the
 * media worker). No new queue, no second job database. Per-topic status =
 * the Job rows themselves; failures are independent; concurrency limits and
 * cancellation come from the worker's existing machinery.
 */
import { db } from "@/lib/db";
import { jobManager } from "@/lib/job-runner";
import { StudioBriefSchema, type StudioBrief } from "./brief";

export const JOB_TYPE_STUDIO_TOPIC = "STUDIO_TOPIC";

export interface BatchOutcome {
  batchId: string;
  dispatched: number;
  jobIds: string[];
  note: string;
}

/**
 * Validate all topics against the shared brief BEFORE dispatch (§11: no
 * partial dispatch of invalid input). Each valid topic becomes one durable
 * job whose payload carries the topic + shared brief.
 */
export async function dispatchBatch(userId: string, sharedBrief: StudioBrief, topics: string[]): Promise<BatchOutcome> {
  const rawTopics = topics.map((t) => t.trim());
  const invalid = rawTopics.filter((t) => t.length > 0 && t.length < 3);
  if (invalid.length > 0) throw new Error(`Invalid topics (each needs ≥3 characters): ${invalid.slice(0, 3).map((t) => `"${t.slice(0, 20)}"`).join(", ")}`);
  const cleanTopics = rawTopics.filter((t) => t.length >= 3).slice(0, 10);
  if (cleanTopics.length === 0) throw new Error("No topics supplied (each needs ≥3 characters); max 10 per batch.");
  // Validate every topic as a brief BEFORE creating anything.
  for (const topic of cleanTopics) {
    const check = StudioBriefSchema.safeParse({ ...sharedBrief, topic });
    if (!check.success) throw new Error(`Topic "${topic.slice(0, 60)}" fails validation: ${check.error.issues.map((i) => i.message).join("; ")}`);
  }
  const batch = await db.studioBatch.create({
    data: { userId, status: "RUNNING", briefJson: JSON.stringify(sharedBrief), topicsJson: JSON.stringify(cleanTopics) },
  });
  const jobIds: string[] = [];
  for (const topic of cleanTopics) {
    const jobId = await jobManager.createJob(userId, JOB_TYPE_STUDIO_TOPIC, {
      batchId: batch.id,
      brief: { ...sharedBrief, topic },
    });
    jobIds.push(jobId);
  }
  return {
    batchId: batch.id,
    dispatched: jobIds.length,
    jobIds,
    note: `${jobIds.length} topic job(s) dispatched on the durable queue (per-topic status via /api/jobs/{jobId}); each produces its own StudioPlan.`,
  };
}

/** Cancel: stops future dispatch work at the worker level; queued jobs are cancelled individually. */
export async function cancelBatch(userId: string, batchId: string): Promise<{ ok: boolean; cancelledJobs: number; note: string }> {
  const batch = await db.studioBatch.findFirst({ where: { id: batchId, userId } });
  if (!batch) throw new Error("Batch not found or not owned.");
  if (batch.status === "CANCELLED") return { ok: true, cancelledJobs: 0, note: "Batch already cancelled." };
  // Jobs created for this batch: find STUDIO_TOPIC jobs created in the batch window.
  const since = new Date(batch.createdAt.getTime() - 1000);
  const jobs = await db.job.findMany({
    where: { userId, type: JOB_TYPE_STUDIO_TOPIC, createdAt: { gte: since }, status: { in: ["QUEUED", "PROCESSING"] } },
    select: { id: true },
  });
  let cancelled = 0;
  for (const j of jobs) {
    const ok = await jobManager.cancel(j.id, userId);
    if (ok) cancelled += 1;
  }
  await db.studioBatch.update({ where: { id: batchId }, data: { status: "CANCELLED" } });
  return { ok: true, cancelledJobs: cancelled, note: `Batch cancelled; ${cancelled} queued/running topic job(s) cancelled. Completed topics are kept.` };
}

export async function batchStatus(userId: string, batchId: string): Promise<{ status: string; topics: { topic: string; jobId: string | null; jobStatus: string | null; planId: string | null }[]; note: string }> {
  const batch = await db.studioBatch.findFirst({ where: { id: batchId, userId } });
  if (!batch) throw new Error("Batch not found or not owned.");
  const topics = JSON.parse(batch.topicsJson) as string[];
  const since = new Date(batch.createdAt.getTime() - 1000);
  const jobs = await db.job.findMany({ where: { userId, type: JOB_TYPE_STUDIO_TOPIC, createdAt: { gte: since } }, orderBy: { createdAt: "asc" } });
  const plans = await db.studioPlan.findMany({ where: { userId, createdAt: { gte: since } }, select: { id: true, briefJson: true }, orderBy: { createdAt: "asc" } });
  const rows = topics.map((topic, i) => {
    const job = jobs[i];
    const plan = plans.find((p) => (JSON.parse(p.briefJson) as StudioBrief).topic === topic);
    return { topic, jobId: job?.id ?? null, jobStatus: job?.status ?? null, planId: plan?.id ?? null };
  });
  const done = rows.filter((r) => r.jobStatus === "COMPLETED" || r.planId).length;
  return {
    status: batch.status,
    topics: rows,
    note: `${done}/${rows.length} topic(s) produced plans.`,
  };
}
