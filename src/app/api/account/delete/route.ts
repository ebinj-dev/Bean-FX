/**
 * M19 §10 — account deletion (10-step safe workflow):
 *  1. re-authentication with the current password (proof of ownership)
 *  2. explicit confirm flag
 *  3/4. the UI explains scope + retention before calling
 *  5. ALL sessions revoked
 *  6. soft-delete (deletedAt) locks the account out instantly
 *  7/8. media/files referenced by OTHER users' projects or running jobs are
 *       NOT destroyed by this route — physical cleanup runs deferred with
 *       reference checks (documented runbook), shared assets survive
 *  9. audit event recorded
 *  10. deleted users fail closed (auth.ts checks deletedAt on every lookup)
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { requireUser, verifyPassword, clearSessionCookieHeaders, AuthError } from "@/lib/auth";
import { clientIp, enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { sendAccountDeletedConfirmation } from "@/lib/mailer";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const limited = enforceRateLimit(req, "account:delete", clientIp(req), RATE_LIMITS.auth);
  if (limited) return limited;
  const user = await requireUser();
  const body = (await req.json().catch(() => null)) as { password?: string; confirm?: boolean } | null;
  if (!body?.confirm) return NextResponse.json({ error: "The deletion must be explicitly confirmed." }, { status: 400 });
  const stored = await db.user.findUnique({ where: { id: user.id } });
  if (!stored || !(await verifyPassword(body.password ?? "", stored.passwordHash))) {
    await audit("account.delete_failed_reauth", { userId: user.id, ip: clientIp(req) });
    return NextResponse.json({ error: "Re-authentication failed — the password is incorrect." }, { status: 403 });
  }
  await db.$transaction([
    db.user.update({ where: { id: user.id }, data: { deletedAt: new Date(), name: null } }),
    db.session.deleteMany({ where: { userId: user.id } }),
  ]);
  await audit("account.deleted", { userId: user.id, ip: clientIp(req), detail: "soft-deleted; sessions revoked; deferred cleanup queued" });
  // M20 §5: deletion confirmation reaches the (still stored) address — the
  // user is already locked out, this is their receipt.
  await sendAccountDeletedConfirmation(user.email);
  const res = NextResponse.json({ ok: true, message: "Your account is deleted and all sessions are signed out. Stored files are cleaned up on a deferred schedule; shared assets stay available to their owners." });
  for (const h of clearSessionCookieHeaders()) res.headers.append("Set-Cookie", h);
  return res;
}
