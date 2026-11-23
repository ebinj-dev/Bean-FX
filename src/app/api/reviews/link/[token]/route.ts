/** M30 §3 — guest access through a review link token.
 * GET  — view the submitted revision (token = capability; optional password).
 * POST — establish the scoped guest session (displayName + optional
 *        password). The session cookie is bound to the link and grants
 *        NOTHING beyond this revision: no workspace membership, no project
 *        role, no original media, no downloads. */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sha256Hex, expireStaleReviewLinks, newOpaqueToken } from "@/lib/collab";
import { REVIEW_COOKIE, guestHeaders } from "@/lib/review-access";
import { previewRangeFromParams } from "@/lib/review-access";

const GUEST_SESSION_TTL_SEC = 30 * 24 * 3600;

async function loadLinkByToken(token: string) {
  await expireStaleReviewLinks().catch(() => undefined);
  return db.reviewLink.findUnique({
    where: { tokenHash: sha256Hex(token) },
    include: {
      revision: {
        select: {
          id: true, sessionNo: true, versionNumber: true, fingerprint: true, status: true,
          title: true, instruction: true, dueAt: true, createdAt: true,
          previewExportId: true, previewDurationSec: true, projectId: true,
          project: { select: { name: true } },
        },
      },
    },
  });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const link = await loadLinkByToken(token.trim());
  // Generic error for unknown/expired/revoked — no state discrimination.
  if (!link || link.state !== "ACTIVE" || link.expiresAt <= new Date()) {
    return NextResponse.json({ error: "This review link is no longer valid." }, { status: 410 });
  }
  if (link.passwordHash) {
    const provided = new URL(req.url).searchParams.get("password") ?? "";
    if (sha256Hex(provided) !== link.passwordHash) {
      return NextResponse.json({ error: "Password required.", passwordRequired: true }, { status: 401 });
    }
  }
  const unresolved = await db.reviewComment.count({ where: { revisionId: link.revision.id, status: "OPEN" } });
  // M40 §7 — guest-safe range summary: frames + fps only, derived read-only
  // from the preview export's own render params. No paths, no storage ids.
  const previewParams = link.revision.previewExportId
    ? (await db.exportFile.findUnique({ where: { id: link.revision.previewExportId }, select: { paramsJson: true } }))?.paramsJson ?? null
    : null;
  return NextResponse.json({
    revision: { ...link.revision, fingerprint: link.revision.fingerprint.slice(0, 16) },
    permission: link.permission,
    expiresAt: link.expiresAt,
    unresolvedComments: unresolved,
    previewRange: previewRangeFromParams(previewParams),
    previewUrl: link.revision.previewExportId ? `/api/reviews/link/${encodeURIComponent(token)}/preview` : null,
  });
}

/** Establish the guest session (and optional password check) → HttpOnly cookie. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const link = await loadLinkByToken(token.trim());
  if (!link || link.state !== "ACTIVE" || link.expiresAt <= new Date()) {
    return NextResponse.json({ error: "This review link is no longer valid." }, { status: 410 });
  }
  const body = await req.json().catch(() => null);
  const displayName = typeof body?.displayName === "string" ? body.displayName.trim().slice(0, 80) : "";
  if (!displayName) return NextResponse.json({ error: "A display name is required." }, { status: 400 });
  if (link.passwordHash) {
    const password = typeof body?.password === "string" ? body.password : "";
    if (sha256Hex(password) !== link.passwordHash) {
      return NextResponse.json({ error: "Incorrect password." }, { status: 401 });
    }
  }
  // Rate-limit session creation per link (anti-enumeration + anti-storm):
  const recent = await db.guestAccess.count({
    where: { linkId: link.id, createdAt: { gte: new Date(Date.now() - 10 * 60_000) } },
  });
  if (recent >= 20) {
    return NextResponse.json({ error: "Too many sessions for this link — try again later." }, { status: 429 });
  }
  const guestToken = newOpaqueToken();
  const guest = await db.guestAccess.create({
    data: { linkId: link.id, displayName, tokenHash: sha256Hex(guestToken) },
  });
  await db.auditEvent.create({
    data: { userId: null, action: "review.guest_session.created", detail: `link=${link.id} guest=${displayName}` },
  }).catch(() => undefined);
  return NextResponse.json({
    ok: true,
    guest: { displayName, permission: link.permission },
    revision: { id: link.revision.id, sessionNo: link.revision.sessionNo, title: link.revision.title },
  }, {
    headers: {
      "Set-Cookie": guestHeaders(link.id, guestToken, Math.min(GUEST_SESSION_TTL_SEC, Math.max(60, Math.floor((link.expiresAt.getTime() - Date.now()) / 1000))))[0],
    },
  });
}
