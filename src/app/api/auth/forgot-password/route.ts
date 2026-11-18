/**
 * M19 §3 — password reset request. Response is ALWAYS generic (no account
 * enumeration): 200 + same body whether or not the account exists. A reset
 * link is mailed when the account exists AND SMTP is configured; the raw
 * token is single-use, hashed at rest, 30-minute TTL. Rate limited.
 */
import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { sendPasswordResetEmail, hashToken } from "@/lib/mailer";
import { clientIp, enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const limited = enforceRateLimit(req, "auth:forgot", clientIp(req), RATE_LIMITS.auth);
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as { email?: string } | null;
  const email = (body?.email ?? "").trim().toLowerCase();
  if (!email) return NextResponse.json({ error: "Email is required." }, { status: 400 });

  const user = await db.user.findUnique({ where: { email } });
  if (user && !user.deletedAt) {
    const raw = randomBytes(32).toString("hex");
    await db.passwordResetToken.create({
      data: { userId: user.id, tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + 30 * 60 * 1000) },
    });
    const mail = await sendPasswordResetEmail(user.email, raw, process.env.PUBLIC_APP_URL ?? new URL(req.url).origin);
    await audit("auth.password_reset_requested", { userId: user.id, ip: clientIp(req), detail: `delivered=${mail.delivered}` });
    // IDENTICAL body for known and unknown emails (anti-enumeration) — the
    // only behavioral difference is the mail actually being sent.
    return NextResponse.json({
      ok: true,
      delivered: false,
      notice: "If the address is registered, a reset message has been sent.",
    });
  }
  await audit("auth.password_reset_unknown_email", { ip: clientIp(req) });
  // Same response for unknown emails — anti-enumeration.
  return NextResponse.json({ ok: true, delivered: false, notice: "If the address is registered, a reset message has been sent." });
}
