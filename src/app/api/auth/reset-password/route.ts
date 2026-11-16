/**
 * M19 §3 — consume a reset token, set the new password, revoke ALL sessions
 * (fixation hygiene), audit. Rate limited per IP.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { verifyPassword, hashPassword, validatePassword, clearSessionCookieHeaders } from "@/lib/auth";
import { hashToken } from "@/lib/mailer";
import { clientIp, enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const limited = enforceRateLimit(req, "auth:reset", clientIp(req), RATE_LIMITS.auth);
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as { token?: string; password?: string } | null;
  const problem = validatePassword(body?.password ?? "");
  if (!body?.token || problem) return NextResponse.json({ error: problem ?? "A valid token is required." }, { status: 400 });

  const rec = await db.passwordResetToken.findUnique({ where: { tokenHash: hashToken(body.token) } });
  if (!rec || rec.usedAt || rec.expiresAt.getTime() < Date.now()) {
    return NextResponse.json({ error: "This reset link is invalid or has expired." }, { status: 400 });
  }
  const user = await db.user.findUnique({ where: { id: rec.userId } });
  if (!user || user.deletedAt) return NextResponse.json({ error: "This reset link is invalid or has expired." }, { status: 400 });

  const passwordHash = await hashPassword(body.password!);
  await db.$transaction([
    db.user.update({ where: { id: user.id }, data: { passwordHash } }),
    db.passwordResetToken.update({ where: { id: rec.id }, data: { usedAt: new Date() } }),
    db.session.deleteMany({ where: { userId: user.id } }),
  ]);
  await audit("auth.password_reset_completed", { userId: user.id, ip: clientIp(req) });
  const res = NextResponse.json({ ok: true, message: "Password updated. All sessions were signed out — please sign in again." });
  for (const h of clearSessionCookieHeaders()) res.headers.append("Set-Cookie", h);
  return res;
}
