/** M30 §2 — invitation accept / reject / preview. The raw token is the
 * capability; it is hashed on every lookup and never stored or logged.
 * Acceptance requires: PENDING + unexpired + authenticated account whose
 * email MATCHES the invitation (identity binding). Membership is created at
 * the invited role — never above what the inviter was allowed to grant. */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { sha256Hex, expireStaleInvitations } from "@/lib/collab";
import { notify, notifyMany } from "@/lib/notify";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  const action = body?.action === "reject" ? "reject" : "accept";
  if (!token) return NextResponse.json({ error: "token is required." }, { status: 400 });

  await expireStaleInvitations().catch(() => undefined);
  const invitation = await db.invitation.findUnique({
    where: { tokenHash: sha256Hex(token) },
    include: { workspace: { select: { id: true, name: true, ownerUserId: true } } },
  });
  // Same generic error for unknown/used/expired/revoked tokens (no state leak).
  if (!invitation || invitation.state !== "PENDING" || invitation.expiresAt <= new Date()) {
    return NextResponse.json({ error: "This invitation is no longer valid." }, { status: 410 });
  }

  if (action === "reject") {
    // Rejection requires the bound account (so a stranger cannot burn a
    // leaked token): authenticated + email match, or the token alone would
    // allow drive-by rejection of pending invites.
    const user = await getCurrentUser();
    if (!user || user.email.toLowerCase() !== invitation.email) {
      return NextResponse.json({ error: "This invitation is no longer valid." }, { status: 410 });
    }
    await db.invitation.update({ where: { id: invitation.id }, data: { state: "REJECTED", decidedAt: new Date(), acceptedById: user.id } });
    await db.auditEvent.create({
      data: { userId: user.id, action: "invitation.rejected", detail: `invitation=${invitation.id} workspace=${invitation.workspaceId}` },
    }).catch(() => undefined);
    await notify({
      userId: invitation.invitedById,
      type: "invitation.rejected",
      projectId: null,
      payload: { workspaceId: invitation.workspaceId, workspaceName: invitation.workspace.name, email: invitation.email },
      dedupKey: `invitation.rejected:${invitation.id}`,
    });
    return NextResponse.json({ ok: true, state: "REJECTED" });
  }

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  if (user.email.toLowerCase() !== invitation.email) {
    // Bound to the invited identity — a different account cannot accept.
    return NextResponse.json({ error: "This invitation was issued for a different email address." }, { status: 403 });
  }
  const alreadyMember = await db.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: invitation.workspaceId, userId: user.id } },
  });
  if (alreadyMember) {
    // Idempotent accept: mark consumed, keep the existing membership.
    await db.invitation.update({ where: { id: invitation.id }, data: { state: "ACCEPTED", decidedAt: new Date(), acceptedById: user.id } });
    return NextResponse.json({ ok: true, alreadyMember: true, workspace: invitation.workspace });
  }
  await db.$transaction([
    db.workspaceMember.create({
      data: { workspaceId: invitation.workspaceId, userId: user.id, role: invitation.role, createdById: invitation.invitedById },
    }),
    db.invitation.update({ where: { id: invitation.id }, data: { state: "ACCEPTED", decidedAt: new Date(), acceptedById: user.id } }),
  ]);
  await db.auditEvent.create({
    data: { userId: user.id, action: "invitation.accepted", detail: `invitation=${invitation.id} workspace=${invitation.workspaceId} role=${invitation.role}` },
  }).catch(() => undefined);
  await notify({
    userId: invitation.invitedById,
    type: "invitation.accepted",
    projectId: null,
    payload: { workspaceId: invitation.workspaceId, workspaceName: invitation.workspace.name, memberEmail: invitation.email },
    dedupKey: `invitation.accepted:${invitation.id}`,
  });
  // Tell other members someone joined (no private details in payloads).
  const members = await db.workspaceMember.findMany({ where: { workspaceId: invitation.workspaceId, userId: { not: user.id } }, select: { userId: true } });
  await notifyMany(members.map((m) => m.userId), {
    type: "workspace.member_joined",
    projectId: null,
    payload: { workspaceId: invitation.workspaceId, workspaceName: invitation.workspace.name },
    dedupKey: `workspace.member_joined:${invitation.id}:${user.id}`,
  });
  return NextResponse.json({ ok: true, workspace: { id: invitation.workspace.id, name: invitation.workspace.name }, role: invitation.role }, { status: 201 });
}

/** Preview: what would the token-holder be joining? Token-only capability,
 * but bounded info (name + role + inviter first name) — never member lists. */
export async function GET(req: NextRequest) {
  const token = new URL(req.url).searchParams.get("token")?.trim() ?? "";
  if (!token) return NextResponse.json({ error: "token is required." }, { status: 400 });
  await expireStaleInvitations().catch(() => undefined);
  const invitation = await db.invitation.findUnique({
    where: { tokenHash: sha256Hex(token) },
    include: { workspace: { select: { name: true } }, inviter: { select: { name: true, email: true } } },
  });
  if (!invitation || invitation.state !== "PENDING" || invitation.expiresAt <= new Date()) {
    return NextResponse.json({ error: "This invitation is no longer valid." }, { status: 410 });
  }
  return NextResponse.json({
    invitation: {
      workspaceName: invitation.workspace.name,
      role: invitation.role,
      inviterName: invitation.inviter.name ?? invitation.inviter.email,
      email: invitation.email,
      expiresAt: invitation.expiresAt,
    },
  });
}
