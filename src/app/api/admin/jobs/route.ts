/**
 * M19 §14 — operational admin: recent job/queue health (failed renders, AI
 * generation failures, queue depth). Admin-only, audited.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin, AuthError } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const admin = await requireAdmin();
    await audit("admin.jobs_reviewed", { userId: admin.id, ip: clientIp(req) });
    const [failed, processing, queued, recent] = await Promise.all([
      db.job.count({ where: { status: "FAILED" } }),
      db.job.count({ where: { status: "PROCESSING" } }),
      db.job.count({ where: { status: "QUEUED" } }),
      db.job.findMany({ orderBy: { createdAt: "desc" }, take: 30, select: { id: true, type: true, status: true, progress: true, stage: true, message: true, createdAt: true, userId: true } }),
    ]);
    return NextResponse.json({ queue: { failed, processing, queued }, recent });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
