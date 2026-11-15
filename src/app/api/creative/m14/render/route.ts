/**
 * M14 API — Composition render (§8/§12).
 * POST /api/creative/m14/render  enqueue COMPOSITION_RENDER through the
 * existing durable worker (bounded resources, progress, cancellation,
 * provenance). GET returns the latest render job state for a composition.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/process-helpers";
import { enqueueCompositionRender } from "@/lib/creative/m14/render";

export const runtime = "nodejs";

const CreateSchema = z.object({ projectId: z.string().min(1).max(64), compositionId: z.string().min(1).max(64), fromFrame: z.number().int().min(0).optional(), toFrame: z.number().int().min(1).optional() });

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const url = new URL(req.url);
  const compositionId = url.searchParams.get("compositionId");
  if (!compositionId) return badRequest("compositionId is required.");
  const job = await db.job.findFirst({ where: { userId: user.id, type: "COMPOSITION_RENDER", paramsJson: { contains: compositionId } }, orderBy: { createdAt: "desc" } });
  return NextResponse.json({
    job: job ? { id: job.id, status: job.status, progress: job.progress, stage: job.stage, message: job.message, exportId: job.exportId, createdAt: job.createdAt.toISOString() } : null,
  });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const parsed = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const project = await db.project.findUnique({ where: { id: parsed.data.projectId } });
  if (!project || project.userId !== user.id) return badRequest("Project not found or not owned by the caller.");
  try {
    const { jobId, disclosure } = await enqueueCompositionRender(user.id, parsed.data.projectId, parsed.data.compositionId, parsed.data.fromFrame, parsed.data.toFrame);
    await db.automationAudit.create({ data: { userId: user.id, projectId: parsed.data.projectId, action: "M14_COMPOSITION_RENDER_QUEUED", detailJson: JSON.stringify({ compositionId: parsed.data.compositionId, jobId }) } }).catch(() => undefined);
    return NextResponse.json({ jobId, disclosure }, { status: 202 });
  } catch (err) {
    return badRequest(`Render enqueue failed honestly: ${(err as Error).message.slice(0, 320)}`);
  }
}
