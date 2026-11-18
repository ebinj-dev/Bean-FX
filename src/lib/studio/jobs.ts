/**
 * Social Video Studio — durable STUDIO_TOPIC job handler (M8.1 §11).
 * One job = one topic → create plan row → run the production planner (M8
 * gateway) → persist scenes. Per-topic failure is independent and recorded
 * on the Job row like every other worker job.
 */
import { db } from "@/lib/db";
import { jobManager } from "@/lib/job-runner";
import { PermanentJobError } from "@/lib/job-helpers";
import { StudioBriefSchema } from "./brief";
import { createStudioPlan } from "./planner";

interface HandlerJob {
  id: string;
  userId: string;
  paramsJson: string | null;
}

export async function runStudioTopicJob(job: HandlerJob): Promise<void> {
  const raw = JSON.parse(job.paramsJson ?? "{}") as { batchId?: string; brief?: unknown };
  const parsed = StudioBriefSchema.safeParse(raw.brief);
  if (!parsed.success) throw new PermanentJobError(`STUDIO_TOPIC invalid brief: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const brief = parsed.data;
  await jobManager.setProgress(job.id, 5, "Creating studio plan");

  const plan = await db.studioPlan.create({
    data: {
      userId: job.userId,
      status: "DRAFT",
      briefJson: JSON.stringify(brief),
      plannerMode: "pending",
    },
  });
  await jobManager.setProgress(job.id, 25, `Planning topic: ${brief.topic.slice(0, 60)}`);
  const outcome = await createStudioPlan(job.userId, plan.id, brief);
  await jobManager.complete(job.id, plan.id, `Studio plan ready (${outcome.mode}): ${outcome.plan.scenes.length} scenes for "${brief.topic.slice(0, 60)}". ${outcome.note.slice(0, 160)}`);
}
