/**
 * M19 §3/§10 — authenticated password change. Requires the CURRENT password
 * (re-auth), revokes every OTHER session, keeps the current one, audits.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { requireUser, verifyPassword, hashPassword, validatePassword, sessionCookieHeaders, getSessionRecord } from "@/lib/auth";
import { clientIp, enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const limited = enforceRateLimit(req, "auth:chpass", clientIp(req), RATE_LIMITS.auth);
  if (limited) return limited;
  const user = await requireUser();
  const body = (await req.json().catch(() => null)) as { currentPassword?: string; newPassword?: string } | null;
  if (!body?.currentPassword || !body.newPassword) return NextResponse.json({ error: "Both the current and the new password are required." }, { status: 400 });
  const stored = await db.user.findUnique({ where: { id: user.id } });
  if (!stored || !(await verifyPassword(body.currentPassword, stored.passwordHash))) {
    await audit("auth.password_change_failed_reauth", { userId: user.id, ip: clientIp(req) });
    return NextResponse.json({ error: "The current password is incorrect." }, { status: 403 });
  }
  const problem = validatePassword(body.newPassword);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  const passwordHash = await hashPassword(body.newPassword);
  const current = await getSessionRecord();
  await db.$transaction([
    db.user.update({ where: { id: user.id }, data: { passwordHash } }),
    ...(current ? [db.session.deleteMany({ where: { userId: user.id, id: { not: current.id } } })] : []),
  ]);
  await audit("auth.password_changed", { userId: user.id, ip: clientIp(req) });
  return NextResponse.json({ ok: true, message: "Password changed. Other sessions were signed out." });
}
