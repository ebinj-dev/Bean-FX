/**
 * M11 API — unified multimodal analysis (§2/§10/§12).
 * GET  /api/creative/analyze/unified?projectId=…   artifacts + live staleness reasons
 * POST /api/creative/analyze/unified               enqueue durable CREATIVE_MULTIMODAL
 *      {projectId, language?, thresholds?, withTranscript?, consentVisual?}
 *
 * consentVisual gates EXTERNAL visual interpretation (media leaves the server
 * only with it). Local scene analysis (ffmpeg, deterministic) needs no consent
 * because nothing is uploaded.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/process-helpers";
import { enqueueMultimodalReview } from "@/lib/creative/multimodal-jobs";
import { getTimelineHead } from "@/lib/editor/persistence";
import { contextVersionOf } from "@/lib/creative/contracts";
import { validateSurgeryOptions } from "@/lib/creative/pause-surgery";

export const runtime = "nodejs";

const CreateSchema = z.object({
  projectId: z.string().min(1).max(64),
  language: z.enum(["en", "ta"]).default("en"),
  thresholds: z.record(z.string(), z.number()).nullable().default(null),
  withTranscript: z.boolean().default(false),
  consentVisual: z.boolean().default(false),
});

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const projectId = new URL(req.url).searchParams.get("projectId");
  if (!projectId) return badRequest("projectId is required.");
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project || project.userId !== user.id) return badRequest("Project not found or not owned by the caller.");
  const artifacts = await db.creativeAnalysisArtifact.findMany({ where: { userId: user.id, projectId }, orderBy: { updatedAt: "desc" }, take: 40 });
  // Live staleness: current timeline context version vs each artifact's deps.
  let currentVersion: string | null = null;
  try {
    const head = await getTimelineHead(projectId, user.id);
    currentVersion = contextVersionOf(head.version, head.sequence.clips.length, head.sequence.clips.reduce((m, c) => Math.max(m, c.timelineStartFrame + c.timelineDurationFrames), 0));
  } catch {
    currentVersion = null;
  }
  return NextResponse.json({
    artifacts: artifacts.map((a) => {
      let deps: { contextVersion?: string } = {};
      try {
        deps = JSON.parse(a.depsJson) as { contextVersion?: string };
      } catch {
        deps = {};
      }
      const timelineStale = currentVersion !== null && deps.contextVersion !== undefined && deps.contextVersion !== currentVersion;
      return {
        id: a.id,
        kind: a.kind,
        sourceAssetId: a.sourceAssetId,
        streamIndex: a.streamIndex,
        status: a.status,
        stale: a.status === "STALE" || timelineStale,
        staleReason: a.staleReason ?? (timelineStale ? "timeline changed since this analysis" : null),
        provider: a.provider,
        model: a.model,
        consentVisual: a.consentVisual,
        error: a.error,
        updatedAt: a.updatedAt.toISOString(),
      };
    }),
    currentContextVersion: currentVersion,
  });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const parsed = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const project = await db.project.findUnique({ where: { id: parsed.data.projectId } });
  if (!project || project.userId !== user.id) return badRequest("Project not found or not owned by the caller.");
  const thresholds = validateSurgeryOptions(parsed.data.thresholds ?? {});
  const { reviewId, jobId } = await enqueueMultimodalReview(user.id, parsed.data.projectId, parsed.data.language, thresholds, parsed.data.withTranscript, parsed.data.consentVisual);
  await db.automationAudit.create({ data: { userId: user.id, projectId: parsed.data.projectId, action: "CREATIVE_MULTIMODAL_ENQUEUED", detailJson: JSON.stringify({ reviewId, jobId, withTranscript: parsed.data.withTranscript, consentVisual: parsed.data.consentVisual, thresholds }) } }).catch(() => undefined);
  return NextResponse.json({ reviewId, jobId }, { status: 202 });
}
