/** M30 — workspace detail, role changes and member removal.
 * All checks server-side (collab.ts matrix). The OWNER can never be removed
 * or demoted, and nobody can change their own role. */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { canManageWorkspace, canSetMemberRole, canRemoveMember, COLLAB_ROLES, type CollabRole } from "@/lib/collab";

async function loadContext(workspaceId: string) {
  const user = await getCurrentUser();
  if (!user) return { error: NextResponse.json({ error: "Authentication required." }, { status: 401 }) };
  const workspace = await db.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) return { error: NextResponse.json({ error: "Workspace not found." }, { status: 404 }) };
  const me = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: user.id } },
  });
  if (!me) return { error: NextResponse.json({ error: "Workspace not found." }, { status: 404 }) };
  return { user, workspace, me };
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const c = await loadContext(id);
  if (c.error) return c.error;
  const members = await db.workspaceMember.findMany({
    where: { workspaceId: id },
    include: { user: { select: { id: true, email: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
  const invitations = await db.invitation.findMany({
    where: { workspaceId: id, state: "PENDING" },
    select: { id: true, email: true, role: true, state: true, expiresAt: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({
    workspace: { id: c.workspace.id, name: c.workspace.name, createdAt: c.workspace.createdAt },
    myRole: c.me.role,
    members: members.map((m) => ({ id: m.id, role: m.role, user: m.user, createdAt: m.createdAt })),
    invitations,
  });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const c = await loadContext(id);
  if (c.error) return c.error;
  const body = await req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 120) {
    return NextResponse.json({ error: "A workspace name (1–120 chars) is required." }, { status: 400 });
  }
  if (!canManageWorkspace(c.me.role as CollabRole)) {
    return NextResponse.json({ error: "Only the workspace owner can rename the workspace." }, { status: 403 });
  }
  const updated = await db.workspace.update({ where: { id }, data: { name: name.slice(0, 120) } });
  await db.auditEvent.create({
    data: { userId: c.user.id, action: "workspace.renamed", detail: `workspace=${id}` },
  }).catch(() => undefined);
  return NextResponse.json({ workspace: { id: updated.id, name: updated.name } });
}

/** PATCH a member's role; DELETE removes the member (revocation). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const c = await loadContext(id);
  if (c.error) return c.error;
  const body = await req.json().catch(() => null);
  const action = body?.action;
  const memberId = typeof body?.memberId === "string" ? body.memberId : "";
  if (!memberId || !["SET_ROLE", "REMOVE"].includes(action)) {
    return NextResponse.json({ error: "memberId and action (SET_ROLE | REMOVE) are required." }, { status: 400 });
  }
  const target = await db.workspaceMember.findFirst({ where: { id: memberId, workspaceId: id } });
  if (!target) return NextResponse.json({ error: "Member not found." }, { status: 404 });
  const self = target.userId === c.user.id;
  if (action === "SET_ROLE") {
    const newRole = body?.role;
    if (!COLLAB_ROLES.includes(newRole)) {
      return NextResponse.json({ error: `role must be one of ${COLLAB_ROLES.join(", ")}.` }, { status: 400 });
    }
    const verdict = canSetMemberRole(c.me.role as CollabRole, target.role as CollabRole, newRole, self);
    if (!verdict.allowed) return NextResponse.json({ error: verdict.reason }, { status: 403 });
    await db.workspaceMember.update({ where: { id: target.id }, data: { role: newRole } });
    await db.auditEvent.create({
      data: { userId: c.user.id, action: "workspace.member.role_changed", detail: `workspace=${id} member=${target.userId} ${target.role}->${newRole}` },
    }).catch(() => undefined);
    return NextResponse.json({ ok: true, memberId: target.id, role: newRole });
  }
  const verdict = canRemoveMember(c.me.role as CollabRole, target.role as CollabRole, self);
  if (!verdict.allowed) return NextResponse.json({ error: verdict.reason }, { status: 403 });
  await db.workspaceMember.delete({ where: { id: target.id } });
  await db.auditEvent.create({
    data: { userId: c.user.id, action: "workspace.member.removed", detail: `workspace=${id} member=${target.userId} was=${target.role}` },
  }).catch(() => undefined);
  return NextResponse.json({ ok: true, removed: target.id });
}
