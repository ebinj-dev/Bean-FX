/**
 * M30 — review access resolution. One authority for "who may see and act on
 * a review revision": authenticated users through the project permission
 * matrix, guests only through an ACTIVE review link with a scoped session.
 * Guests never receive workspace membership, project roles, or original
 * media — only the submitted revision's validated preview.
 */
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { getProjectAccess, canView, canCommentOnReviews, canEdit, sha256Hex, type ProjectAccess } from "@/lib/collab";

export const REVIEW_COOKIE = "beanfx_review";

export type ReviewActor =
  | { kind: "USER"; userId: string; access: ProjectAccess; isAdminish: boolean }
  | { kind: "GUEST"; guestName: string; linkId: string; guestAccessId: string; permission: "VIEW" | "COMMENT" | "APPROVE" }
  | { kind: "NONE" };

export type RevisionWithProject = Awaited<ReturnType<typeof loadRevision>>;

export async function loadRevision(revisionId: string) {
  return db.reviewRevision.findUnique({
    where: { id: revisionId },
    include: { project: { select: { id: true, userId: true, workspaceId: true, name: true, settingsJson: true } } },
  });
}

/** Resolve the actor for a revision: authenticated member/share holder, or a
 * guest with an active link session for THIS revision. */
export type ReviewActorResolution =
  | { ok: false; error: NextResponse }
  | { ok: true; actor: Exclude<ReviewActor, { kind: "NONE" }>; revision: NonNullable<Awaited<ReturnType<typeof loadRevision>>> };

export async function resolveReviewActor(revisionId: string, req?: NextRequest): Promise<ReviewActorResolution> {
  const revision = await loadRevision(revisionId);
  if (!revision) return { ok: false, error: NextResponse.json({ error: "Review not found." }, { status: 404 }) };

  const user = await getCurrentUser();
  if (user) {
    const access = await getProjectAccess(user.id, revision.project);
    if (canView(access)) {
      return {
        ok: true,
        actor: {
          kind: "USER",
          userId: user.id,
          access,
          isAdminish: access.role === "OWNER" || access.role === "ADMIN",
        },
        revision,
      };
    }
    // An authenticated user WITHOUT project access may still hold a guest
    // session (e.g. a client who also has a BEAN FX account) — fall through
    // to the guest path instead of leaking 403/404.
  }

  // Guest path: cookie `<linkId>.<guestToken>` for an ACTIVE link of this revision.
  const cookieHeader = req?.headers.get("cookie") ?? "";
  const raw = cookieHeader.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${REVIEW_COOKIE}=`))?.slice(REVIEW_COOKIE.length + 1);
  if (raw) {
    const [linkId, guestToken] = decodeURIComponent(raw).split(".");
    if (linkId && guestToken) {
      const link = await db.reviewLink.findUnique({ where: { id: linkId } });
      if (link && link.revisionId === revisionId && link.state === "ACTIVE" && link.expiresAt > new Date()) {
        // The cookie's second component identifies the GUEST SESSION — verify
        // it against GuestAccess.tokenHash (NOT the link's own token hash;
        // the link token itself is only known to the invite URL holder).
        const guest = await db.guestAccess.findFirst({
          where: { linkId: link.id, tokenHash: sha256Hex(guestToken) },
          orderBy: { createdAt: "desc" },
        });
        if (guest) {
          await db.guestAccess.update({ where: { id: guest.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
          await db.reviewLink.update({ where: { id: link.id }, data: { accessCount: { increment: 1 }, lastAccessAt: new Date() } }).catch(() => undefined);
          return {
            ok: true,
            actor: { kind: "GUEST", guestName: guest.displayName, linkId: link.id, guestAccessId: guest.id, permission: link.permission as "VIEW" | "COMMENT" | "APPROVE" },
            revision,
          };
        }
      }
    }
  }
  return { ok: false, error: NextResponse.json({ error: "Review not found." }, { status: 404 }) };
}

export function canActorComment(actor: ReviewActor): boolean {
  if (actor.kind === "USER") return canCommentOnReviews(actor.access);
  return actor.kind === "GUEST" && (actor.permission === "COMMENT" || actor.permission === "APPROVE");
}

export function canActorApprove(actor: ReviewActor): boolean {
  if (actor.kind === "USER") {
    // Authenticated approval happens through an assignment (created by the
    // editor) — owners/admins/editors may also vote when assigned.
    return true; // assignment check happens against the DB row in the route
  }
  return actor.kind === "GUEST" && actor.permission === "APPROVE";
}

export function canActorResolve(actor: ReviewActor, commentAuthorUserId: string | null): boolean {
  if (actor.kind !== "USER") return false; // guests never resolve
  if (actor.isAdminish) return true;
  if (canEdit(actor.access)) return true;
  return false;
}

export function guestHeaders(linkId: string, guestToken: string, maxAgeSec: number): string[] {
  return [`beanfx_review=${encodeURIComponent(`${linkId}.${guestToken}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`];
}

/**
 * M40 §7 — the timeline range a review preview represents, parsed from the
 * preview export's OWN render params (the M39 range contract: frames, not
 * rounded timestamps). Returns null when the historical record has no range
 * (legacy/full-timeline renders) — "unknown" is never invented. Read-only
 * derivation for display: nothing here mutates the immutable revision.
 */
export function previewRangeFromParams(paramsJson: string | null | undefined): { startFrame: number; endFrame: number; fps: string | null } | null {
  if (!paramsJson) return null;
  try {
    const p = JSON.parse(paramsJson) as { startFrame?: number; endFrame?: number; fps?: string };
    // A field that is PRESENT but malformed makes the whole record
    // untrustworthy — sanitize-and-guess is exactly the reconstruction this
    // helper exists to avoid. Absent fields are open boundaries (M39: an
    // end-only range means "from the timeline start").
    const startField = p.startFrame;
    const endField = p.endFrame;
    const startPresent = startField !== undefined && startField !== null;
    const endPresent = endField !== undefined && endField !== null;
    const startOk = !startPresent || (typeof startField === "number" && Number.isInteger(startField) && startField >= 0);
    const endOk = !endPresent || (typeof endField === "number" && Number.isInteger(endField) && endField > 0);
    if (!startOk || !endOk) return null;
    if (!startPresent && !endPresent) return null; // legacy/full-timeline record
    const fps = typeof p.fps === "string" && /^\d+\/\d+$/.test(p.fps) ? p.fps : null;
    return {
      startFrame: startPresent ? (startField as number) : 0,
      endFrame: endPresent ? (endField as number) : 0,
      fps,
    };
  } catch {
    return null; // unreadable record — stay silent rather than guess
  }
}
