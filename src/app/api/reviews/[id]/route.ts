/** M30 §5/§6 — review detail, comments, decisions and state transitions.
 * All authorization server-side via resolveReviewActor (member matrix or
 * scoped guest session). Comments carry INTEGER frames in the sequence
 * timebase; seconds are derived display data only. */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { canActorApprove, canActorComment, canActorResolve, previewRangeFromParams, resolveReviewActor, type ReviewActor } from "@/lib/review-access";

import { DECISIONS, transitionRevision } from "@/lib/collab";
import { notify, notifyMany } from "@/lib/notify";

type Actor = Exclude<ReviewActor, { kind: "NONE" }>;


export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const r = await resolveReviewActor(id, req);
  if (!r.ok) return r.error;
  const { actor, revision } = r;
  const comments = await db.reviewComment.findMany({
    where: { revisionId: id },
    orderBy: { createdAt: "asc" },
  });
  const assignments = await db.reviewAssignment.findMany({ where: { revisionId: id } });
  const preview = revision.previewExportId ? await db.exportFile.findUnique({
    where: { id: revision.previewExportId },
    select: { id: true, durationSec: true, sizeBytes: true, format: true, filename: true, paramsJson: true },
  }) : null;
  // M40 §7 — the timeline range this preview represents, derived read-only
  // from the export's own render params (frames, per the M39 range contract).
  // Absent for legacy/full-timeline previews — never invented. Read-only:
  // immutable revisions are untouched; guests see frames only (no paths,
  // no storage identifiers).
  const previewRange = preview ? previewRangeFromParams(preview.paramsJson) : null;
  const myDecision = actor.kind === "USER"
    ? assignments.find((a) => a.reviewerUserId === actor.userId) ?? null
    : actor.kind === "GUEST"
      ? assignments.find((a) => a.guestLinkId === actor.linkId) ?? null
      : null;
  const canApproveNow = actor.kind === "USER"
    ? Boolean(myDecision) && myDecision!.state === "PENDING"
    : actor.kind === "GUEST" && actor.permission === "APPROVE" && (!myDecision || myDecision.state === "PENDING");
  return NextResponse.json({
    revision: {
      id: revision.id, sessionNo: revision.sessionNo, versionNumber: revision.versionNumber,
      fingerprint: revision.fingerprint, status: revision.status, title: revision.title,
      instruction: revision.instruction, dueAt: revision.dueAt, approvalPolicy: revision.approvalPolicy,
      createdAt: revision.createdAt, approvedAt: revision.approvedAt,
      sequenceId: revision.timelineVersionId,
    },
    project: { id: revision.project.id, name: revision.project.name },
    preview: preview ? { id: preview.id, durationSec: preview.durationSec, sizeBytes: preview.sizeBytes, format: preview.format, filename: preview.filename, url: `/api/reviews/${id}/preview`, range: previewRange } : null,
    comments: comments.map((c) => ({
      id: c.id, parentId: c.parentId, authorUserId: c.authorUserId, guestName: c.guestName,
      frame: c.frame, fpsNum: c.fpsNum, fpsDen: c.fpsDen, timeSeconds: c.timeSeconds,
      clipId: c.clipId, body: c.body, status: c.status, editCount: c.editCount,
      editedAt: c.editedAt, createdAt: c.createdAt,
    })),
    decisions: assignments.map((a) => ({
      state: a.state, reviewerUserId: a.reviewerUserId, guestName: a.guestName, note: a.note, decidedAt: a.decidedAt,
    })),
    myDecision: myDecision ? { state: myDecision.state, decidedAt: myDecision.decidedAt } : null,
    can: { comment: canActorComment(actor), approveNow: canApproveNow && revision.status !== "SUPERSEDED" && revision.status !== "CANCELLED" },
    viewerKind: actor.kind,
  });
}
/** PATCH action=CANCEL: the creator (or an admin/owner) cancels an open
 * revision — reviewers are notified; decisions close immediately. */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const r = await resolveReviewActor(id, req);
  if (!r.ok) return r.error;
  const { actor, revision } = r;
  if (actor.kind !== "USER") return NextResponse.json({ error: "Review not found." }, { status: 404 });
  const allowed = revision.createdById === actor.userId || actor.isAdminish;
  if (!allowed) return NextResponse.json({ error: "Review not found." }, { status: 404 });
  if (!transitionRevision(revision.status, "CANCELLED")) {
    return NextResponse.json({ error: `A ${revision.status} revision cannot be cancelled.` }, { status: 409 });
  }
  await db.reviewRevision.update({ where: { id }, data: { status: "CANCELLED" } });
  await db.auditEvent.create({
    data: { userId: actor.userId, action: "review.cancelled", detail: `revision=${id}` },
  }).catch(() => undefined);
  const recipients = (await db.reviewAssignment.findMany({ where: { revisionId: id }, select: { reviewerUserId: true } }))
    .map((a) => a.reviewerUserId).filter((x): x is string => Boolean(x));
  await notifyMany(recipients, {
    type: "review.cancelled",
    projectId: revision.projectId,
    payload: { revisionId: id, sessionNo: revision.sessionNo, title: revision.title },
    dedupKey: `review.cancelled:${id}`,
  }).catch(() => undefined);
  return NextResponse.json({ ok: true, status: "CANCELLED" });
}
/** POST /decision via PATCH action=DECIDE is avoided; this route handles the
 * reviewer decision: APPROVE | REQUEST_CHANGES | REJECT (assigned reviewers
 * and APPROVE-permission guests). Approval binds to THIS revision only. */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const r = await resolveReviewActor(id, req);
  if (!r.ok) return r.error;
  const { actor, revision } = r;
  if (!canActorApprove(actor)) {
    return NextResponse.json({ error: "You do not have approval permission for this review." }, { status: 403 });
  }
  if (["SUPERSEDED", "CANCELLED"].includes(revision.status)) {
    return NextResponse.json({ error: `This revision is ${revision.status} — decisions are closed. Submit a new review instead.` }, { status: 409 });
  }
  const body = await req.json().catch(() => null);
  const decision = body?.decision;
  if (!DECISIONS.includes(decision)) {
    return NextResponse.json({ error: `decision must be one of ${DECISIONS.join(", ")}.` }, { status: 400 });
  }
  const note = typeof body?.note === "string" ? body.note.slice(0, 2000) : null;

  // Eligible authenticated reviewers: explicitly assigned users OR project
  // collaborators (Owner/Admin/Editor/REVIEWER share) — the permission matrix
  // grants approval to all of these; strangers never get here (404 upstream).
  const existing = actor.kind === "USER"
    ? await db.reviewAssignment.findFirst({ where: { revisionId: id, reviewerUserId: actor.userId } })
      ?? (canActorComment({ kind: "USER", userId: actor.userId, access: actor.access, isAdminish: actor.isAdminish })
        ? await db.reviewAssignment.create({
          data: { revisionId: id, reviewerUserId: actor.userId, state: "PENDING" },
        }) : null)
    : await db.reviewAssignment.findFirst({ where: { revisionId: id, guestLinkId: (actor as { linkId: string }).linkId } })
      ?? await db.reviewAssignment.create({
        data: { revisionId: id, guestLinkId: (actor as { linkId: string }).linkId, guestName: (actor as { guestName: string }).guestName, state: "PENDING" },
      });
  if (!existing) return NextResponse.json({ error: "You are not a reviewer on this revision." }, { status: 403 });
  if (existing.state !== "PENDING") {
    return NextResponse.json({ error: "You have already submitted your decision on this revision." }, { status: 409 });
  }

  const decidedState = decision === "APPROVE" ? "APPROVED" : decision === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "REJECTED";
  await db.reviewAssignment.update({
    where: { id: existing.id },
    data: { state: decidedState, note, decidedAt: new Date() },
  });
  await db.auditEvent.create({
    data: {
      userId: actor.kind === "USER" ? actor.userId : null,
      action: `review.${decidedState.toLowerCase()}`,
      detail: `revision=${id} reviewer=${actor.kind === "USER" ? actor.userId : `guest:${(actor as { guestName: string }).guestName}`}`,
    },
  }).catch(() => undefined);

  // Recompute the FINAL status deterministically from all decisions.
  const all = await db.reviewAssignment.findMany({ where: { revisionId: id }, select: { state: true } });
  const pending = all.filter((a) => a.state === "PENDING").length;
  const decided = all.filter((a) => a.state !== "PENDING" && a.state !== "DECLINED").map((a) => a.state === "APPROVED" ? "APPROVE" : "CHANGES");
  const policy = revision.approvalPolicy === "ANY" ? "ANY" : "ALL";
  let finalStatus = revision.status;
  let approvedAt = revision.approvedAt;
  if (policy === "ANY") {
    if (decided.includes("APPROVE")) { finalStatus = "APPROVED"; approvedAt = new Date(); }
    else if (pending === 0) { finalStatus = "CHANGES_REQUESTED"; }
  } else if (pending === 0 && all.length > 0) {
    finalStatus = decided.every((d) => d === "APPROVE") ? "APPROVED" : "CHANGES_REQUESTED";
    if (finalStatus === "APPROVED") approvedAt = new Date();
  }
  if (finalStatus !== revision.status && transitionRevision(revision.status, finalStatus)) {
    await db.reviewRevision.update({ where: { id }, data: { status: finalStatus, approvedAt } });
  }
  const rev = { createdById: revision.createdById, sessionNo: revision.sessionNo, title: revision.title };
  const stateType = finalStatus === "APPROVED" ? "review.approved" : finalStatus === "CHANGES_REQUESTED" ? "review.changes_requested" : `review.${decidedState.toLowerCase()}`;
  await notify({
    userId: rev.createdById,
    type: stateType,
    projectId: revision.projectId,
    payload: { revisionId: id, sessionNo: rev.sessionNo, decision, finalStatus },
    dedupKey: `${stateType}:${existing.id}`,
  }).catch(() => undefined);

  return NextResponse.json({ ok: true, decision: decidedState, revisionStatus: finalStatus, pendingDecisions: pending });
}
