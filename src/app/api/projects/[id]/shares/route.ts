/** M30 §3 — named-collaborator shares on ONE project. Grants never widen the
 * granter's own rights; revocation is immediate (next-request effect). */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { getProjectAccess, shareablesFor, type CollabRole } from "@/lib/collab";
import { notify } from "@/lib/notify";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });
  const access = await getProjectAccess(user.id, project);
  const body = await req.json().catch(() => null);
  const role = body?.role;
  const targetUserId = typeof body?.userId === "string" ? body.userId : "";
  if (!targetUserId || !role) {
    return NextResponse.json({ error: "userId and role are required." }, { status: 400 });
  }
  const allowed = shareablesFor(access.role as CollabRole);
  if (!allowed.includes(role)) {
    return NextResponse.json({ error: `Your role (${access.role}) may grant only: ${allowed.join(", ") || "nothing"}.` }, { status: 403 });
  }
  const target = await db.user.findUnique({ where: { id: targetUserId }, select: { id: true, email: true, name: true } });
  if (!target) return NextResponse.json({ error: "User not found." }, { status: 404 });
  if (target.id === project.userId) {
    return NextResponse.json({ error: "The project owner already has full access." }, { status: 409 });
  }
  const existing = await db.projectShare.findUnique({ where: { projectId_userId: { projectId, userId: target.id } } });
  if (existing && !existing.revokedAt) {
    return NextResponse.json({ error: "This user already has an active share on this project." }, { status: 409 });
  }
  const share = existing
    ? await db.projectShare.update({ where: { id: existing.id }, data: { role, revokedAt: null, grantedById: user.id } })
    : await db.projectShare.create({ data: { projectId, userId: target.id, role, grantedById: user.id } });
  await db.auditEvent.create({
    data: { userId: user.id, action: "project.shared", detail: `project=${projectId} user=${target.id} role=${role}` },
  }).catch(() => undefined);
  await notify({
    userId: target.id,
    type: "project.shared",
    projectId,
    payload: { projectName: project.name, role },
    dedupKey: `project.shared:${share.id}:${user.id}`,
  });
  return NextResponse.json({ share: { id: share.id, userId: target.id, role: share.role, revokedAt: share.revokedAt } }, { status: 201 });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });
  const access = await getProjectAccess(user.id, project);
  if (access.role === "NONE") return NextResponse.json({ error: "Project not found." }, { status: 404 });
  const shares = await db.projectShare.findMany({
    where: { projectId },
    include: { user: { select: { id: true, email: true, name: true } } },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({
    shares: shares.map((s) => ({
      id: s.id, userId: s.userId, email: s.user.email, name: s.user.name,
      role: s.role, revokedAt: s.revokedAt, createdAt: s.createdAt,
    })),
    myAccess: access.role,
  });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });
  const access = await getProjectAccess(user.id, project);
  const shareId = new URL(req.url).searchParams.get("shareId");
  if (!shareId) return NextResponse.json({ error: "shareId is required." }, { status: 400 });
  const share = await db.projectShare.findFirst({ where: { id: shareId, projectId } });
  if (!share) return NextResponse.json({ error: "Share not found." }, { status: 404 });
  // Owner/admin revoke anything; editors may only revoke grants they made.
  const canRevoke = access.role === "OWNER" || access.role === "ADMIN" || share.grantedById === user.id;
  if (!canRevoke) return NextResponse.json({ error: "Project not found." }, { status: 404 });
  if (share.revokedAt) return NextResponse.json({ error: "Share is already revoked." }, { status: 409 });
  await db.projectShare.update({ where: { id: share.id }, data: { revokedAt: new Date() } });
  await db.auditEvent.create({
    data: { userId: user.id, action: "project.share.revoked", detail: `project=${projectId} share=${share.id} user=${share.userId}` },
  }).catch(() => undefined);
  return NextResponse.json({ ok: true, state: "REVOKED" });
}
