/**
 * M16 API — timeline render (the sequence→video export path).
 * POST /api/editor/projects/[projectId]/render  → enqueue a durable
 *   RENDER_TIMELINE job (real FFmpeg graph, ffprobe-validated output).
 * GET  → the latest render jobs for this project (durable job state).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/process-helpers";
import { enqueueMediaJob, JOB_TYPE_RENDER_TIMELINE } from "@/lib/job-helpers";

export const runtime = "nodejs";

const RenderSchema = z.object({
  startFrame: z.number().int().min(0).optional(),
  endFrame: z.number().int().min(1).optional(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ projectId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { projectId } = await ctx.params;
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project || project.userId !== user.id) return badRequest("Project not found or not owned by the caller.");
  const parsed = RenderSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const version = await db.timelineVersion.findFirst({ where: { projectId }, orderBy: { versionNumber: "desc" } });
  if (!version) return badRequest("The project has no sequence to render yet.");
  const jobId = await enqueueMediaJob(user.id, JOB_TYPE_RENDER_TIMELINE, {
    projectId,
    startFrame: parsed.data.startFrame,
    endFrame: parsed.data.endFrame,
  });
  return NextResponse.json({ jobId }, { status: 202 });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ projectId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { projectId } = await ctx.params;
  const jobs = await db.job.findMany({
    where: { userId: user.id, type: "RENDER_TIMELINE", paramsJson: { contains: projectId } },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { id: true, status: true, stage: true, progress: true, message: true, createdAt: true },
  });
  const exports = await db.exportFile.findMany({
    where: { userId: user.id, kind: "TIMELINE_RENDER", paramsJson: { contains: projectId } },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { id: true, filename: true, sizeBytes: true, durationSec: true, createdAt: true },
  });
  return NextResponse.json({ jobs, exports });
}
