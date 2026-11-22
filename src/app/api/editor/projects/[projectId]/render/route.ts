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
import { assertWithinLimit, PlanLimitError, planLimitResponse } from "@/lib/billing/entitlements";

export const runtime = "nodejs";

const RenderSchema = z.object({
  startFrame: z.number().int().min(0).optional(),
  endFrame: z.number().int().min(1).optional(),
  // M37: real output formats through the SAME durable job + FFmpeg pipeline
  // (mp4 default, byte-compatible with the previous behavior; mov/wav/mp3
  // select container+codecs — no second renderer, no new job type).
  format: z.enum(["mp4", "mov", "wav", "mp3"]).optional(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ projectId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { projectId } = await ctx.params;
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project) return badRequest("Project not found or not owned by the caller.");
  // M30: workspace/project EDITORs may render shared projects.
  { const { getProjectAccess, canEdit } = await import("@/lib/collab");
    const access = await getProjectAccess(user.id, project);
    if (!canEdit(access)) return badRequest("Project not found or not owned by the caller."); }
  const parsed = RenderSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const version = await db.timelineVersion.findFirst({ where: { projectId }, orderBy: { versionNumber: "desc" } });
  if (!version) return badRequest("The project has no sequence to render yet.");
  // M25 P2 — plan entitlements: concurrent render cap + monthly export minutes.
  try {
    const seq = JSON.parse(version.sequenceJson) as { clips?: Array<{ timelineStartFrame: number; timelineDurationFrames: number; sourceFps?: { num: number; den: number } }>; fps?: { num: number; den: number } };
    const fps = seq.fps && seq.fps.den ? seq.fps.num / seq.fps.den : 30;
    const endFrame = (seq.clips ?? []).reduce((m, c) => Math.max(m, c.timelineStartFrame + c.timelineDurationFrames), 0);
    const estMinutes = Math.max(1 / 60, endFrame / Math.max(1, fps) / 60);
    await assertWithinLimit(user.id, "maxConcurrentRenders");
    await assertWithinLimit(user.id, "monthlyExportMinutes", Math.ceil(estMinutes));
  } catch (err) {
    if (err instanceof PlanLimitError) {
      const { body: limitBody, status } = planLimitResponse(err);
      return NextResponse.json(limitBody, { status });
    }
    throw err;
  }
  const jobId = await enqueueMediaJob(user.id, JOB_TYPE_RENDER_TIMELINE, {
    projectId,
    startFrame: parsed.data.startFrame,
    endFrame: parsed.data.endFrame,
    format: parsed.data.format,
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
    select: { id: true, status: true, stage: true, progress: true, message: true, createdAt: true, paramsJson: true },
  });
  const exports = await db.exportFile.findMany({
    where: { userId: user.id, kind: "TIMELINE_RENDER", paramsJson: { contains: projectId } },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { id: true, filename: true, sizeBytes: true, durationSec: true, createdAt: true },
  });
  return NextResponse.json({
    jobs: jobs.map((j) => {
      let range: { startFrame?: number; endFrame?: number } | null = null;
      try {
        const parsed = JSON.parse(j.paramsJson ?? "{}") as { startFrame?: number; endFrame?: number };
        range = { ...(parsed.startFrame !== undefined ? { startFrame: parsed.startFrame } : {}), ...(parsed.endFrame !== undefined ? { endFrame: parsed.endFrame } : {}) };
      } catch { /* params are opaque here */ }
      return { id: j.id, status: j.status, stage: j.stage, progress: j.progress, message: j.message, createdAt: j.createdAt, range };
    }),
    exports,
  });
}
