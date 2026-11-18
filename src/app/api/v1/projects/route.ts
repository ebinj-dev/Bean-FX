/**
 * M21 P2 — token-authenticated v1 project surface.
 * GET /api/v1/projects                — list caller-visible projects
 * GET /api/v1/projects/:id/canonical  — canonical export (format v1)
 * Scope: projects:read. Roles resolve server-side; a token can only see
 * what its owning user owns (M19 isolation carries over unchanged).
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiVersionGuard, verifyIntegrationToken, tokenHasScope } from "@/lib/integration-tokens";
import { sequenceToCanonical } from "@/lib/core/converters";
import type { TokenScope } from "@/lib/core/types";

export const runtime = "nodejs";

async function auth(req: NextRequest, scope: TokenScope) {
  const guard = apiVersionGuard(req.headers.get("x-beanfx-api-version"));
  if (!guard.ok) return { err: NextResponse.json({ code: guard.code, error: guard.error }, { status: guard.status }) };
  const t = await verifyIntegrationToken(req.headers.get("authorization"));
  if (!t) return { err: NextResponse.json({ code: "UNAUTHORIZED", error: "Valid integration token required." }, { status: 401 }) };
  if (!tokenHasScope(t, scope)) return { err: NextResponse.json({ code: "FORBIDDEN", error: `Scope ${scope} required.` }, { status: 403 }) };
  return { auth: t };
}

export async function GET(req: NextRequest) {
  const a = await auth(req, "projects:read");
  if ("err" in a) return a.err;
  const projects = await db.project.findMany({
    where: { userId: a.auth!.userId },
    orderBy: { updatedAt: "desc" },
    take: 100,
    select: { id: true, name: true, updatedAt: true },
  });
  return NextResponse.json({ projects });
}
