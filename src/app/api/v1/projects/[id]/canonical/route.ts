/**
 * M21 P2/P3 — GET /api/v1/projects/:id/canonical
 * Canonical export of a project's current sequence in beanfx-project-v1
 * format (M21 §1/§3). Read-only, scope projects:read, baseVersion = the
 * project's latest timeline version number (optimistic concurrency §11).
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiVersionGuard, verifyIntegrationToken, tokenHasScope } from "@/lib/integration-tokens";
import { sequenceToCanonical } from "@/lib/core/converters";

export const runtime = "nodejs";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = apiVersionGuard(req.headers.get("x-beanfx-api-version"));
  if (!guard.ok) return NextResponse.json({ code: guard.code, error: guard.error }, { status: guard.status });
  const t = await verifyIntegrationToken(req.headers.get("authorization"));
  if (!t) return NextResponse.json({ code: "UNAUTHORIZED", error: "Valid integration token required." }, { status: 401 });
  if (!tokenHasScope(t, "projects:read")) {
    return NextResponse.json({ code: "FORBIDDEN", error: "Scope projects:read required." }, { status: 403 });
  }
  const { id } = await ctx.params;
  const project = await db.project.findUnique({ where: { id } });
  if (!project || project.userId !== t.userId) {
    return NextResponse.json({ code: "NOT_FOUND", error: "Project not found." }, { status: 404 });
  }
  const version = await db.timelineVersion.findFirst({
    where: { projectId: id },
    orderBy: { versionNumber: "desc" },
  });
  if (!version) return NextResponse.json({ code: "EMPTY", error: "Project has no timeline yet." }, { status: 409 });
  try {
    const sequence = JSON.parse(version.sequenceJson) as unknown;
    const canonical = sequenceToCanonical(sequence, { projectId: id, baseVersion: version.versionNumber });
    return NextResponse.json({ project: canonical });
  } catch (e) {
    return NextResponse.json({ code: "CONVERSION_FAILED", error: e instanceof Error ? e.message : "conversion failed" }, { status: 422 });
  }
}
