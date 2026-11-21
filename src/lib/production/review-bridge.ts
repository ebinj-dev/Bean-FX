/**
 * M31 — bridge between the Production pipeline and the M30 client-review
 * system. Creates a review revision on the production's project using the SAME
 * code path semantics as the reviews API (fingerprint of the head timeline,
 * PROCESSING → render via the durable job queue). No review logic is
 * duplicated or bypassed — approvals still flow through /api/reviews.
 */
import { db } from "@/lib/db";
import { revisionFingerprint } from "@/lib/collab";
import { enqueueMediaJob, JOB_TYPE_RENDER_TIMELINE } from "@/lib/job-helpers";
import { notify } from "@/lib/notify";

export async function createReviewForProduction(projectId: string, userId: string, productionId: string): Promise<{ revisionId: string }> {
  const head = await db.timelineVersion.findFirst({ where: { projectId }, orderBy: { versionNumber: "desc" }, select: { id: true, versionNumber: true, sequenceJson: true } });
  if (!head) throw new Error("The project has no sequence to review yet.");
  const sessionRows = await db.reviewRevision.findMany({ where: { projectId }, select: { sessionNo: true }, orderBy: { sessionNo: "desc" }, take: 1 });
  const sessionNo = (sessionRows[0]?.sessionNo ?? 0) + 1;
  const fingerprint = revisionFingerprint({ projectId, sessionNo, versionNumber: head.versionNumber, sequenceJson: head.sequenceJson, settingsJson: null });
  const revision = await db.reviewRevision.create({
    data: {
      projectId,
      sessionNo,
      timelineVersionId: head.id,
      versionNumber: head.versionNumber,
      fingerprint,
      status: "PROCESSING",
      title: `Production review — ${productionId.slice(-6)}`,
      instruction: "Automatically created by the BEAN AI Production Studio rough-cut review stage.",
      approvalPolicy: "ALL",
      createdById: userId,
    },
  });
  await db.auditEvent.create({
    data: { userId, action: "review.created", detail: `revision=${revision.id} project=${projectId} version=${head.versionNumber} source=production-studio` },
  }).catch(() => undefined);
  await enqueueMediaJob(userId, JOB_TYPE_RENDER_TIMELINE, { projectId, reviewRevisionId: revision.id });
  await notify({ userId, type: "revision.processing", projectId, payload: { revisionId: revision.id, sessionNo }, dedupKey: `revision.processing:${revision.id}` });
  return { revisionId: revision.id };
}
