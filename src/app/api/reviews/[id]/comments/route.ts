/** M30 §5 — review comments: add (POST) and edit/resolve/reopen (PATCH).
 * Frame identity = INTEGER frames in the sequence timebase (fps num/den
 * persisted); seconds are derived display data. Authorization via
 * resolveReviewActor (member matrix or scoped guest session). */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { canActorComment, canActorResolve, resolveReviewActor } from "@/lib/review-access";
import { notify } from "@/lib/notify";

/** POST creates a comment or reply; body { body, frame?, fpsNum?, fpsDen?,
 * clipId?, parentId? }. Guest comments record the self-reported display name
 * bound to the link — never an authenticated identity. */
/** Frame validation: integer frame + canonical fps (num/den) → derived seconds. */
function parseFrame(body: Record<string, unknown>): { frame: number; fpsNum: number; fpsDen: number; timeSeconds: number } | null {
  const frame = body.frame;
  const fpsNum = body.fpsNum;
  const fpsDen = body.fpsDen;
  if (!Number.isInteger(frame) || (frame as number) < 0) return null;
  if (!Number.isInteger(fpsNum) || !Number.isInteger(fpsDen) || (fpsNum as number) <= 0 || (fpsDen as number) <= 0) return null;
  const timeSeconds = (frame as number) * (fpsDen as number) / (fpsNum as number);
  return { frame: frame as number, fpsNum: fpsNum as number, fpsDen: fpsDen as number, timeSeconds };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const r = await resolveReviewActor(id, req);
  if (!r.ok) return r.error;
  const { actor, revision } = r;
  if (!canActorComment(actor)) {
    return NextResponse.json({ error: "You do not have comment permission for this review." }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const text = typeof body?.body === "string" ? body.body.trim() : "";
  if (!text || text.length > 4000) {
    return NextResponse.json({ error: "A comment body (1–4000 chars) is required." }, { status: 400 });
  }
  const parentId = typeof body?.parentId === "string" ? body.parentId : null;
  if (parentId) {
    const parent = await db.reviewComment.findFirst({ where: { id: parentId, revisionId: id } });
    if (!parent) return NextResponse.json({ error: "Parent comment not found." }, { status: 404 });
    if (parent.parentId) return NextResponse.json({ error: "Replies to replies are not supported — reply to the top-level comment." }, { status: 400 });
  }
  const frameInfo = body?.frame !== undefined && body.frame !== null ? parseFrame(body) : null;
  if (body?.frame !== undefined && body.frame !== null && !frameInfo) {
    return NextResponse.json({ error: "frame must be a non-negative integer with fpsNum/fpsDen (positive integers)." }, { status: 400 });
  }
  const clipId = typeof body?.clipId === "string" ? body.clipId.slice(0, 64) : null;

  // First comment flips READY_FOR_REVIEW → IN_REVIEW (state machine enforced).
  if (revision.status === "READY_FOR_REVIEW") {
    await db.reviewRevision.update({ where: { id }, data: { status: "IN_REVIEW" } }).catch(() => undefined);
  }
  const comment = await db.reviewComment.create({
    data: {
      revisionId: id,
      parentId,
      authorUserId: actor.kind === "USER" ? actor.userId : null,
      guestName: actor.kind === "GUEST" ? actor.guestName.slice(0, 80) : null,
      frame: frameInfo?.frame ?? null,
      fpsNum: frameInfo?.fpsNum ?? null,
      fpsDen: frameInfo?.fpsDen ?? null,
      timeSeconds: frameInfo?.timeSeconds ?? null,
      clipId,
      body: text,
    },
  });
  await db.auditEvent.create({
    data: {
      userId: actor.kind === "USER" ? actor.userId : null,
      action: "review.comment.created",
      detail: `revision=${id} comment=${comment.id}${frameInfo ? ` frame=${frameInfo.frame}@${frameInfo.fpsNum}/${frameInfo.fpsDen}` : ""}`,
    },
  }).catch(() => undefined);

  // Notify: revision creator + other reviewers (deduped, bounded payloads).
  const rev = await db.reviewRevision.findUnique({
    where: { id },
    select: { createdById: true, sessionNo: true, title: true, assignments: { select: { reviewerUserId: true } } },
  });
  if (rev) {
    const authorLabel = actor.kind === "USER" ? (await db.user.findUnique({ where: { id: actor.userId }, select: { name: true, email: true } }))?.name ?? "a collaborator" : actor.guestName;
    const recipients = new Set<string>([rev.createdById, ...rev.assignments.map((a) => a.reviewerUserId).filter((x): x is string => Boolean(x))]);
    if (actor.kind === "USER") recipients.delete(actor.userId);
    await Promise.all([...recipients].map((uid) => notify({
      userId: uid,
      type: parentId ? "comment.replied" : "comment.created",
      projectId: revision.projectId,
      payload: { revisionId: id, sessionNo: rev.sessionNo, commentId: comment.id, author: authorLabel, frame: frameInfo?.frame ?? null },
      dedupKey: `comment.created:${comment.id}:${uid}`,
    })));
  }

  return NextResponse.json({
    comment: {
      id: comment.id, parentId: comment.parentId, authorUserId: comment.authorUserId,
      guestName: comment.guestName, frame: comment.frame, fpsNum: comment.fpsNum,
      fpsDen: comment.fpsDen, timeSeconds: comment.timeSeconds, clipId: comment.clipId,
      body: comment.body, status: comment.status, createdAt: comment.createdAt,
    },
  }, { status: 201 });
}

/** PATCH: edit own comment (editCount history marker) or resolve/reopen with
 * permission. Guests can never edit or resolve. */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const r = await resolveReviewActor(id, req);
  if (!r.ok) return r.error;
  const { actor, revision } = r;
  const body = await req.json().catch(() => null);
  const commentId = typeof body?.commentId === "string" ? body.commentId : "";
  const action = body?.action;
  if (!commentId || !["EDIT", "RESOLVE", "REOPEN"].includes(action)) {
    return NextResponse.json({ error: "commentId and action (EDIT | RESOLVE | REOPEN) are required." }, { status: 400 });
  }
  const comment = await db.reviewComment.findFirst({ where: { id: commentId, revisionId: id } });
  if (!comment) return NextResponse.json({ error: "Comment not found." }, { status: 404 });

  if (action === "EDIT") {
    if (actor.kind !== "USER" || comment.authorUserId !== actor.userId) {
      return NextResponse.json({ error: "Only the comment author can edit it." }, { status: 403 });
    }
    const text = typeof body?.body === "string" ? body.body.trim() : "";
    if (!text || text.length > 4000) {
      return NextResponse.json({ error: "A comment body (1–4000 chars) is required." }, { status: 400 });
    }
    const updated = await db.reviewComment.update({
      where: { id: comment.id },
      data: { body: text, editCount: { increment: 1 }, editedAt: new Date() },
    });
    await db.auditEvent.create({
      data: { userId: actor.userId, action: "review.comment.edited", detail: `comment=${comment.id} editCount=${updated.editCount}` },
    }).catch(() => undefined);
    return NextResponse.json({ ok: true, editCount: updated.editCount, editedAt: updated.editedAt });
  }

  // RESOLVE / REOPEN — authenticated editors/admins/owners only.
  if (actor.kind !== "USER" || !canActorResolve(actor, comment.authorUserId)) {
    return NextResponse.json({ error: "You do not have permission to change this comment's status." }, { status: 403 });
  }
  const nextStatus = action === "RESOLVE" ? "RESOLVED" : "OPEN";
  await db.reviewComment.update({ where: { id: comment.id }, data: { status: nextStatus } });
  await db.auditEvent.create({
    data: { userId: actor.userId, action: `review.comment.${nextStatus === "RESOLVED" ? "resolved" : "reopened"}`, detail: `comment=${comment.id}` },
  }).catch(() => undefined);
  const rev = await db.reviewRevision.findUnique({ where: { id }, select: { createdById: true, sessionNo: true } });
  if (rev && action === "RESOLVE") {
    await notify({
      userId: rev.createdById,
      type: "comment.resolved",
      projectId: revision.projectId,
      payload: { revisionId: id, sessionNo: rev.sessionNo, commentId: comment.id },
      dedupKey: `comment.resolved:${comment.id}`,
    }).catch(() => undefined);
  }
  return NextResponse.json({ ok: true, status: nextStatus });
}
