/**
 * M19 §10 — account settings. GET returns the profile + verification state.
 * PATCH updates the display name (email is the login identity; changing it
 * requires a verified flow — not offered here).
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser, AuthError } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function GET() {
  try {
    const user = await requireUser();
    return NextResponse.json({
      profile: { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt, emailVerified: user.emailVerified, role: user.role },
    });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}

export async function PATCH(req: Request) {
  try {
    const user = await requireUser();
    const body = (await req.json().catch(() => null)) as { name?: string } | null;
    if (!body || typeof body.name !== "string") return NextResponse.json({ error: "A name is required." }, { status: 400 });
    const name = body.name.trim().slice(0, 80);
    await db.user.update({ where: { id: user.id }, data: { name } });
    await audit("account.profile_updated", { userId: user.id, ip: clientIp(req) });
    return NextResponse.json({ ok: true, profile: { name } });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
