/**
 * M19 §3 — email verification. POST accepts the raw token from the emailed
 * link (or, when no mail provider is configured, a dev-only fallback: the
 * token is returned in the API response of /auth/register ONLY when the
 * deployment has no SMTP — honest surfacing, never a fake "sent").
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { hashToken } from "@/lib/mailer";
import { clientIp, enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const limited = enforceRateLimit(req, "auth:verify", clientIp(req), RATE_LIMITS.auth);
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as { token?: string } | null;
  if (!body?.token) return NextResponse.json({ error: "A verification token is required." }, { status: 400 });
  const rec = await db.emailVerificationToken.findUnique({ where: { tokenHash: hashToken(body.token) } });
  if (!rec || rec.expiresAt.getTime() < Date.now()) {
    return NextResponse.json({ error: "This verification link is invalid or has expired." }, { status: 400 });
  }
  await db.$transaction([
    db.user.update({ where: { id: rec.userId }, data: { emailVerified: true } }),
    db.emailVerificationToken.delete({ where: { id: rec.id } }),
  ]);
  await audit("auth.email_verified", { userId: rec.userId, ip: clientIp(req) });
  return NextResponse.json({ ok: true, message: "Your email address is verified." });
}
