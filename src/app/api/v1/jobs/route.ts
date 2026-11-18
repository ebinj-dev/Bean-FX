/**
 * M21 P2 — token-authenticated durable job surface (§2/§4.4).
 * POST /api/v1/jobs        — submit a RENDER_TIMELINE job (SAME durable
 *                            pipeline + global render admission as the web
 *                            editor route — hosts get no private lane).
 * GET /api/v1/jobs/:id     — job status (jobs:read)
 * DELETE /api/v1/jobs/:id  — cancel (jobs:cancel)
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { apiVersionGuard, verifyIntegrationToken, tokenHasScope } from "@/lib/integration-tokens";
import { enqueueMediaJob, JOB_TYPE_RENDER_TIMELINE } from "@/lib/job-helpers";

export const runtime = "nodejs";

const SubmitSchema = z.object({
  projectId: z.string().min(1).max(64),
  startFrame: z.number().int().min(0).optional(),
  endFrame: z.number().int().min(1).optional(),
});

function guard(req: NextRequest) {
  return apiVersionGuard(req.headers.get("x-beanfx-api-version"));
}

async function auth(req: NextRequest, scope: "jobs:submit" | "jobs:read" | "jobs:cancel") {
  const t = await verifyIntegrationToken(req.headers.get("authorization"));
  if (!t) return { err: NextResponse.json({ code: "UNAUTHORIZED", error: "Valid integration token required." }, { status: 401 }) };
  if (!tokenHasScope(t, scope)) {
    return { err: NextResponse.json({ code: "FORBIDDEN", error: `Scope ${scope} required.` }, { status: 403 }) };
  }
  return { auth: t };
}

export async function POST(req: NextRequest) {
  const g = guard(req);
  if (!g.ok) return NextResponse.json({ code: g.code, error: g.error }, { status: g.status });
  const a = await auth(req, "jobs:submit");
  if (a.err) return a.err;
  const parsed = SubmitSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ code: "BAD_REQUEST", error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  }
  const project = await db.project.findUnique({ where: { id: parsed.data.projectId } });
  if (!project || project.userId !== a.auth!.userId) {
    return NextResponse.json({ code: "NOT_FOUND", error: "Project not found." }, { status: 404 });
  }
  const version = await db.timelineVersion.findFirst({ where: { projectId: parsed.data.projectId }, orderBy: { versionNumber: "desc" } });
  if (!version) return NextResponse.json({ code: "EMPTY", error: "Project has no timeline yet." }, { status: 409 });
  const jobId = await enqueueMediaJob(a.auth!.userId, JOB_TYPE_RENDER_TIMELINE, {
    projectId: parsed.data.projectId,
    startFrame: parsed.data.startFrame,
    endFrame: parsed.data.endFrame,
    createdBy: `token:${a.auth!.tokenId}`, // audit attribution (M21 §4.4)
  });
  return NextResponse.json({ job: { id: jobId, status: "QUEUED" } }, { status: 202 });
}
