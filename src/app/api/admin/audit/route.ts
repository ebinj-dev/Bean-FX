/**
 * M25 P7 — admin audit-event feed (server-gated by requireAdmin; every read
 * is itself audited). SAFE fields only — no tokens, no hashes, IP shown as
 * a coarse indicator.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit";
import { badRequest } from "@/lib/process-helpers";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const admin = await requireAdmin();
    await audit("admin.audit_listed", { userId: admin.id, ip: clientIp(req) });
    const url = new URL(req.url);
    const take = Math.min(100, Math.max(1, Number(url.searchParams.get("take") ?? "40")));
    const events = await db.auditEvent.findMany({
      orderBy: { createdAt: "desc" },
      take,
      select: { id: true, action: true, detail: true, createdAt: true },
    });
    return NextResponse.json({ events });
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : "audit feed failed");
  }
}
