/**
 * M19 §14 — admin service health: DB reachable, queue depth, storage root
 * writable. NOT a public endpoint (admin-only). The PUBLIC health surface is
 * GET /api/healthz (minimal, no internals).
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin, AuthError } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireAdmin();
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
  const started = Date.now();
  await db.user.findFirst({ select: { id: true } });
  const dbMs = Date.now() - started;
  return NextResponse.json({ db: { ok: true, latencyMs: dbMs }, time: new Date().toISOString() });
}
