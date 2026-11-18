/**
 * M21 P2 — single job status / cancel.
 * GET    /api/v1/jobs/:id  (jobs:read)
 * DELETE /api/v1/jobs/:id  (jobs:cancel) — cancel only if PENDING/ACTIVE
 * and owned by the token's user (same ownership rule as the editor).
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiVersionGuard, verifyIntegrationToken, tokenHasScope } from "@/lib/integration-tokens";

export const runtime = "nodejs";

async function authed(req: NextRequest, scope: "jobs:read" | "jobs:cancel") {
  const g = apiVersionGuard(req.headers.get("x-beanfx-api-version"));
  if (!g.ok) return { err: NextResponse.json({ code: g.code, error: g.error }, { status: g.status }) };
  const t = await verifyIntegrationToken(req.headers.get("authorization"));
  if (!t) return { err: NextResponse.json({ code: "UNAUTHORIZED", error: "Valid integration token required." }, { status: 401 }) };
  if (!tokenHasScope(t, scope)) return { err: NextResponse.json({ code: "FORBIDDEN", error: `Scope ${scope} required.` }, { status: 403 }) };
  return { auth: t };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const a = await authed(req, "jobs:read");
  if (a.err) return a.err;
  const { id } = await ctx.params;
  const job = await db.job.findUnique({ where: { id } });
  if (!job || job.userId !== a.auth!.userId) {
    return NextResponse.json({ code: "NOT_FOUND", error: "Job not found." }, { status: 404 });
  }
  return NextResponse.json({ job: { id: job.id, kind: job.type, status: job.status, progress: job.progress, error: job.message ?? undefined, createdAt: job.createdAt } });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const a = await authed(req, "jobs:cancel");
  if (a.err) return a.err;
  const { id } = await ctx.params;
  const job = await db.job.findUnique({ where: { id } });
  if (!job || job.userId !== a.auth!.userId) {
    return NextResponse.json({ code: "NOT_FOUND", error: "Job not found." }, { status: 404 });
  }
  // Guarded terminal write (same invariant as finishJob): only QUEUED or
  // PROCESSING jobs can be cancelled; late completions never resurrect.
  const upd = await db.job.updateMany({
    where: { id, userId: a.auth!.userId, status: { in: ["QUEUED", "PROCESSING"] } },
    data: { status: "CANCELLED", stage: "Cancelled", message: "Cancelled by integration token." },
  });
  if (upd.count === 0) {
    return NextResponse.json({ code: "NOT_CANCELLABLE", error: "Job is not in a cancellable state." }, { status: 409 });
  }
  const fresh = await db.job.findUnique({ where: { id }, select: { id: true, status: true } });
  return NextResponse.json({ job: { id, status: fresh?.status ?? "CANCELLED" } });
}
