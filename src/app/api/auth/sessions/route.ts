/**
 * M19 §10 — session management. GET lists this account's sessions (current
 * one flagged). DELETE with ?id=<sessionId> revokes ONE session owned by the
 * caller; DELETE without id revokes every OTHER session (logout-everywhere).
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { requireUser, getSessionRecord, AuthError } from "@/lib/auth";
import { clientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function GET() {
  try {
    const user = await requireUser();
    const current = await getSessionRecord();
    const rows = await db.session.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      select: { id: true, createdAt: true, expiresAt: true, token: true },
    });
    return NextResponse.json({
      sessions: rows.map((r) => ({
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
        current: current?.token === r.token,
      })),
    });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}

export async function DELETE(req: Request) {
  try {
    const user = await requireUser();
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    const current = await getSessionRecord();
    if (id) {
      const rec = await db.session.findUnique({ where: { id } });
      if (!rec || rec.userId !== user.id) return NextResponse.json({ error: "Session not found." }, { status: 404 });
      await db.session.delete({ where: { id } });
      await audit("auth.session_revoked", { userId: user.id, ip: clientIp(req), detail: `session=${id}` });
      return NextResponse.json({ ok: true, revokedCurrent: current?.id === id });
    }
    if (current) await db.session.deleteMany({ where: { userId: user.id, id: { not: current.id } } });
    await audit("auth.sessions_revoked_others", { userId: user.id, ip: clientIp(req) });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
