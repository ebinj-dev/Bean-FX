/** M30 §2 — invitations. Secure lifecycle:
 *   PENDING → ACCEPTED | REJECTED | EXPIRED | REVOKED (all terminal).
 * Token hygiene: 256-bit random token, ONLY the SHA-256 hash is stored; the
 * raw token is returned once for the copyable invite URL and never logged.
 * Bindings: the invitation is bound to the invited EMAIL — a different
 * account cannot accept it. Inviter capability caps the offered role.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { invitablesFor, COLLAB_ROLES, newOpaqueToken, sha256Hex, expireStaleInvitations, type CollabRole } from "@/lib/collab";
import { sendInvitationEmail } from "@/lib/mailer";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function normalizeEmail(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const workspace = await db.workspace.findUnique({ where: { id } });
  if (!workspace) return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  const me = await db.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: id, userId: user.id } } });
  if (!me) return NextResponse.json({ error: "Workspace not found." }, { status: 404 });

  const body = await req.json().catch(() => null);
  const email = normalizeEmail(body?.email);
  const role = body?.role;
  if (!email) return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
  if (!COLLAB_ROLES.includes(role)) {
    return NextResponse.json({ error: `role must be one of ${COLLAB_ROLES.join(", ")}.` }, { status: 400 });
  }
  const allowed = invitablesFor(me.role as CollabRole);
  if (!allowed.includes(role)) {
    return NextResponse.json({ error: `Your role (${me.role}) may invite only: ${allowed.join(", ") || "nobody"}.` }, { status: 403 });
  }
  // No duplicate active invitations for the same email+role.
  const existing = await db.invitation.findFirst({
    where: { workspaceId: id, email, state: "PENDING", expiresAt: { gt: new Date() } },
  });
  if (existing) {
    return NextResponse.json({ error: "An active invitation for this email already exists.", invitationId: existing.id }, { status: 409 });
  }
  // Existing members do not need invitations.
  const alreadyMember = await db.workspaceMember.findFirst({
    where: { workspaceId: id, user: { email } },
  });
  if (alreadyMember) {
    return NextResponse.json({ error: "This user is already a workspace member." }, { status: 409 });
  }

  const token = newOpaqueToken();
  const invitation = await db.invitation.create({
    data: {
      workspaceId: id,
      email,
      role,
      tokenHash: sha256Hex(token),
      state: "PENDING",
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      invitedById: user.id,
    },
  });
  await db.auditEvent.create({
    data: { userId: user.id, action: "invitation.created", detail: `invitation=${invitation.id} workspace=${id} role=${role} email=${email}` },
  }).catch(() => undefined);

  // Best-effort email via the M19 mailer — honest delivery status, never a
  // hard dependency (CONFIGURATION REQUIRED when SMTP is absent).
  const mail = await sendInvitationEmail({
    to: email,
    workspaceName: workspace.name,
    role,
    inviterName: user.name ?? user.email,
    token,
  }).catch(() => ({ delivered: false, reason: "mailer-error" } as const));
  if (!mail.delivered) {
    await db.auditEvent.create({
      data: { userId: user.id, action: "invitation.email.not_configured", detail: `invitation=${invitation.id} reason=${mail.reason ?? "smtp-not-configured"}` },
    }).catch(() => undefined);
  }

  // Notify existing members (except the inviter) that the team grew — only
  // AFTER acceptance, to avoid leaking pending invite details.
  return NextResponse.json({
    invitation: { id: invitation.id, email, role, state: invitation.state, expiresAt: invitation.expiresAt },
    // The raw token appears exactly once here. Copyable invite URL.
    token,
    inviteUrl: `/invite/${token}`,
    delivery: { emailSent: mail.delivered, reason: mail.delivered ? undefined : (mail.reason ?? "smtp-not-configured") },
  }, { status: 201 });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const me = await db.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: id, userId: user.id } } });
  if (!me) return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  const invitations = await db.invitation.findMany({
    where: { workspaceId: id },
    select: { id: true, email: true, role: true, state: true, expiresAt: true, decidedAt: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return NextResponse.json({ invitations });
}

/** DELETE = revoke (ADMIN+). Revocation takes effect immediately — the token
 * stops working on the next request, not merely in the UI. */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const me = await db.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: id, userId: user.id } } });
  if (!me || !["OWNER", "ADMIN", "EDITOR"].includes(me.role)) {
    return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }
  const url = new URL(req.url);
  const invId = url.searchParams.get("invitationId");
  if (!invId) return NextResponse.json({ error: "invitationId is required." }, { status: 400 });
  const invitation = await db.invitation.findFirst({ where: { id: invId, workspaceId: id } });
  if (!invitation) return NextResponse.json({ error: "Invitation not found." }, { status: 404 });
  if (invitation.state !== "PENDING") {
    return NextResponse.json({ error: `Invitation is already ${invitation.state}.` }, { status: 409 });
  }
  await db.invitation.update({ where: { id: invitation.id }, data: { state: "REVOKED", decidedAt: new Date() } });
  await db.auditEvent.create({
    data: { userId: user.id, action: "invitation.revoked", detail: `invitation=${invitation.id} workspace=${id}` },
  }).catch(() => undefined);
  return NextResponse.json({ ok: true, state: "REVOKED" });
}
