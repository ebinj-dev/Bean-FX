/** M30 §4/§6 — review revisions. POST captures an IMMUTABLE revision from the
 * current editor head (TimelineVersion + fingerprint), supersedes earlier
 * open revisions, assigns reviewers, and rides the REAL render pipeline for
 * the reviewable preview. GET lists the project's revision history. */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { getProjectAccess, canCreateReview, canEdit, revisionFingerprint, transitionRevision } from "@/lib/collab";
import { enqueueMediaJob, JOB_TYPE_RENDER_TIMELINE } from "@/lib/job-helpers";
import { notify, notifyMany } from "@/lib/notify";
import { previewRangeFromParams } from "@/lib/review-access";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { id: projectId } = await ctx.params;
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });
  const access = await getProjectAccess(user.id, project);
  if (!canCreateReview(access)) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  const body = await req.json().catch(() => null);
  const title: string = typeof body?.title === "string" ? body.title.trim() : "";
  if (!title || title.length > 160) {
    return NextResponse.json({ error: "A title (1–160 chars) is required." }, { status: 400 });
  }
  const instruction = typeof body?.instruction === "string" ? body.instruction.slice(0, 4000) : null;
  const dueAt = typeof body?.dueAt === "string" && !Number.isNaN(Date.parse(body.dueAt)) ? new Date(body.dueAt) : null;
  const approvalPolicy = body?.approvalPolicy === "ANY" ? "ANY" : "ALL";
  const reviewerIds: string[] = Array.isArray(body?.reviewerIds)
    ? (body.reviewerIds as unknown[]).filter((x): x is string => typeof x === "string")
    : [];

  const head = await db.timelineVersion.findFirst({
    where: { projectId },
    orderBy: { versionNumber: "desc" },
  });
  if (!head) {
    return NextResponse.json({ error: "The project has no sequence to review yet." }, { status: 409 });
  }

  // Reviewers must hold real project access (no inviting strangers through
  // assignment); assignment alone never grants project membership.
  const validReviewerIds: string[] = [];
  for (const rid of [...new Set(reviewerIds)]) {
    if (rid === user.id) continue; // the requester never reviews their own cut
    const target = await db.user.findUnique({ where: { id: rid }, select: { id: true } });
    if (!target) continue;
    const targetAccess = await getProjectAccess(rid, project);
    if (targetAccess.role !== "NONE") validReviewerIds.push(rid);
  }

  const sessionNo = ((await db.reviewRevision.aggregate({ where: { projectId }, _max: { sessionNo: true } }))._max.sessionNo ?? 0) + 1;
  const fingerprint = revisionFingerprint({
    projectId, sessionNo, versionNumber: head.versionNumber,
    sequenceJson: head.sequenceJson, settingsJson: project.settingsJson,
  });

  // Supersede earlier non-terminal revisions — approval NEVER carries over.
  const open = await db.reviewRevision.findMany({
    where: { projectId, status: { in: ["READY_FOR_REVIEW", "IN_REVIEW", "CHANGES_REQUESTED", "PROCESSING"] } },
    select: { id: true, status: true, createdById: true, assignments: { select: { reviewerUserId: true } } },
  });
  for (const r of open) {
    if (!transitionRevision(r.status, "SUPERSEDED")) continue;
    await db.reviewRevision.update({ where: { id: r.id }, data: { status: "SUPERSEDED", supersededById: null } });
    await db.auditEvent.create({
      data: { userId: user.id, action: "review.superseded", detail: `revision=${r.id} by=session ${sessionNo}` },
    }).catch(() => undefined);
    const recipients = [r.createdById, ...r.assignments.map((a) => a.reviewerUserId).filter((x): x is string => Boolean(x))];
    await notifyMany(recipients, {
      type: "revision.superseded",
      projectId,
      payload: { revisionId: r.id, sessionNo, newSessionNo: sessionNo, title },
      dedupKey: `revision.superseded:${r.id}:${sessionNo}`,
    });
  }

  const revision = await db.reviewRevision.create({
    data: {
      projectId,
      sessionNo,
      timelineVersionId: head.id,
      versionNumber: head.versionNumber,
      fingerprint,
      status: "PROCESSING",
      title: title.slice(0, 160),
      instruction,
      dueAt,
      approvalPolicy,
      createdById: user.id,
      assignments: { create: validReviewerIds.map((rid) => ({ reviewerUserId: rid })) },
    },
  });
  await db.auditEvent.create({
    data: { userId: user.id, action: "review.created", detail: `revision=${revision.id} project=${projectId} version=${head.versionNumber} fingerprint=${fingerprint.slice(0, 12)}` },
  }).catch(() => undefined);

  // The preview comes from the REAL render pipeline (validated, gated).
  await enqueueMediaJob(user.id, JOB_TYPE_RENDER_TIMELINE, { projectId, reviewRevisionId: revision.id });
  await notify({
    userId: user.id,
    type: "revision.processing",
    projectId,
    payload: { revisionId: revision.id, sessionNo },
    dedupKey: `revision.processing:${revision.id}`,
  });

  return NextResponse.json({
    revision: {
      id: revision.id, sessionNo, versionNumber: head.versionNumber, fingerprint,
      status: revision.status, title: revision.title, approvalPolicy,
      assignedReviewers: validReviewerIds,
      supersededCount: open.length,
    },
  }, { status: 201 });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { id: projectId } = await ctx.params;
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });
  const access = await getProjectAccess(user.id, project);
  if (!canEdit(access) && access.role !== "REVIEWER" && access.role !== "VIEWER") {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  const revisions = await db.reviewRevision.findMany({
    where: { projectId },
    orderBy: { sessionNo: "desc" },
    include: {
      assignments: { select: { reviewerUserId: true, guestName: true, state: true, decidedAt: true } },
      _count: { select: { comments: true } },
    },
  });
  // M40 §7 — per-revision preview range, derived read-only from each preview
  // export's own render params (frames, per the M39 range contract). Absent
  // for legacy/full-timeline previews — never invented.
  const previewIds = revisions.map((r) => r.previewExportId).filter((v): v is string => Boolean(v));
  const previewRows = previewIds.length > 0 ? await db.exportFile.findMany({ where: { id: { in: previewIds } }, select: { id: true, paramsJson: true } }) : [];
  const rangeByExport = new Map(previewRows.map((p) => [p.id, previewRangeFromParams(p.paramsJson)]));
  return NextResponse.json({
    revisions: revisions.map((r) => ({
      id: r.id, sessionNo: r.sessionNo, versionNumber: r.versionNumber,
      fingerprint: r.fingerprint.slice(0, 16), status: r.status, title: r.title,
      instruction: r.instruction, dueAt: r.dueAt, approvalPolicy: r.approvalPolicy,
      approvedAt: r.approvedAt, createdAt: r.createdAt, supersededById: r.supersededById,
      previewReady: Boolean(r.previewExportId), previewDurationSec: r.previewDurationSec,
      previewRange: r.previewExportId ? rangeByExport.get(r.previewExportId) ?? null : null,
      commentCount: r._count.comments,
      decisions: r.assignments.map((a) => ({ state: a.state, reviewerUserId: a.reviewerUserId, guestName: a.guestName, decidedAt: a.decidedAt })),
    })),
    myAccess: access.role,
  });
}
