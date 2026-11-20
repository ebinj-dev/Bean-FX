/** M30 §3 — external review links: creation, inspection, revocation.
 * 256-bit token; ONLY the SHA-256 hash stored. The raw token is returned
 * once for the copyable URL. Revocation takes effect on the next request.
 * Password protection uses the same SHA-256-at-rest hygiene. */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { getProjectAccess, canEdit, newOpaqueToken, sha256Hex, REVIEW_LINK_PERMISSIONS, expireStaleReviewLinks } from "@/lib/collab";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const revision = await db.reviewRevision.findUnique({
    where: { id },
    include: { project: { select: { id: true, userId: true, workspaceId: true } } },
  });
  if (!revision) return NextResponse.json({ error: "Review not found." }, { status: 404 });
  const access = await getProjectAccess(user.id, revision.project);
  if (!canEdit(access)) return NextResponse.json({ error: "Review not found." }, { status: 404 });

  const body = await req.json().catch(() => null);
  const permission = body?.permission;
  if (!REVIEW_LINK_PERMISSIONS.includes(permission)) {
    return NextResponse.json({ error: `permission must be one of ${REVIEW_LINK_PERMISSIONS.join(", ")}.` }, { status: 400 });
  }
  const ttlHours = Number(body?.ttlHours);
  const expiresAt = Number.isFinite(ttlHours) && ttlHours > 0 && ttlHours <= 24 * 30
    ? new Date(Date.now() + ttlHours * 3600_000)
    : new Date(Date.now() + 14 * 24 * 3600_000);
  const password = typeof body?.password === "string" && body.password.length >= 6 ? body.password : null;
  if (body?.password && !password) {
    return NextResponse.json({ error: "If set, the password must be at least 6 characters." }, { status: 400 });
  }

  await expireStaleReviewLinks().catch(() => undefined);
  const token = newOpaqueToken();
  const link = await db.reviewLink.create({
    data: {
      revisionId: id,
      tokenHash: sha256Hex(token),
      state: "ACTIVE",
      permission,
      expiresAt,
      passwordHash: password ? sha256Hex(password) : null,
      createdById: user.id,
    },
  });
  await db.auditEvent.create({
    data: { userId: user.id, action: "review.link.created", detail: `link=${link.id} revision=${id} permission=${permission}` },
  }).catch(() => undefined);
  return NextResponse.json({
    link: { id: link.id, permission, expiresAt, hasPassword: Boolean(password), state: "ACTIVE", createdAt: link.createdAt },
    // Raw token appears exactly once.
    token,
    linkUrl: `/review/${token}`,
  }, { status: 201 });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const revision = await db.reviewRevision.findUnique({
    where: { id },
    include: { project: { select: { id: true, userId: true, workspaceId: true } } },
  });
  if (!revision) return NextResponse.json({ error: "Review not found." }, { status: 404 });
  const access = await getProjectAccess(user.id, revision.project);
  if (!canEdit(access)) return NextResponse.json({ error: "Review not found." }, { status: 404 });
  await expireStaleReviewLinks().catch(() => undefined);
  const links = await db.reviewLink.findMany({
    where: { revisionId: id },
    select: { id: true, state: true, permission: true, expiresAt: true, createdAt: true, accessCount: true, lastAccessAt: true },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({
    // Token hashes are NEVER exposed — display ids only.
    links: links.map((l) => ({ ...l, tokenHash: undefined })),
  });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const revision = await db.reviewRevision.findUnique({
    where: { id },
    include: { project: { select: { id: true, userId: true, workspaceId: true } } },
  });
  if (!revision) return NextResponse.json({ error: "Review not found." }, { status: 404 });
  const access = await getProjectAccess(user.id, revision.project);
  if (!canEdit(access)) return NextResponse.json({ error: "Review not found." }, { status: 404 });
  const linkId = new URL(req.url).searchParams.get("linkId");
  if (!linkId) return NextResponse.json({ error: "linkId is required." }, { status: 400 });
  const link = await db.reviewLink.findFirst({ where: { id: linkId, revisionId: id } });
  if (!link) return NextResponse.json({ error: "Link not found." }, { status: 404 });
  if (link.state !== "ACTIVE") return NextResponse.json({ error: `Link is already ${link.state}.` }, { status: 409 });
  await db.reviewLink.update({ where: { id: link.id }, data: { state: "REVOKED" } });
  // Kill guest sessions immediately: their session tokens belong to the link.
  await db.guestAccess.deleteMany({ where: { linkId: link.id } });
  await db.auditEvent.create({
    data: { userId: user.id, action: "review.link.revoked", detail: `link=${link.id} revision=${id}` },
  }).catch(() => undefined);
  return NextResponse.json({ ok: true, state: "REVOKED" });
}
