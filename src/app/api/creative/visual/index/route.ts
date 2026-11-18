/**
 * M12 API — Visual Intelligence index (§12).
 * GET  /api/creative/visual/index?projectId=…   latest visual artifacts (index,
 *      narration matches, continuity) + review state + live staleness
 * POST /api/creative/visual/index               enqueue durable VISUAL_INTELLIGENCE
 *      {projectId, settings?, consentVisual}
 *
 * consentVisual is REQUIRED before any frame leaves the server (§11): without
 * it the run is deterministic-only and says so honestly. Every path enforces
 * session auth + project ownership + zod validation + audit.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/process-helpers";
import { enqueueVisualIntelligence } from "@/lib/creative/visual/jobs";
import { getTimelineHead } from "@/lib/editor/persistence";
import { contextVersionOf } from "@/lib/creative/contracts";

export const runtime = "nodejs";

const CreateSchema = z.object({
  projectId: z.string().min(1).max(64),
  settings: z
    .object({
      sampleIntervalSec: z.number().min(1).max(30).optional(),
      maxFramesPerAsset: z.number().int().min(3).max(48).optional(),
      maxFrameWidth: z.number().int().min(160).max(1024).optional(),
      duplicateHashDistance: z.number().int().min(0).max(20).optional(),
      repeatShotHashDistance: z.number().int().min(0).max(30).optional(),
      visionBatchSize: z.number().int().min(1).max(4).optional(),
    })
    .nullable()
    .default(null),
  consentVisual: z.boolean().default(false),
});

function parseArtifactJson(row: { resultJson: string | null; missingEvidenceJson: string | null }): { result: unknown; missingEvidence: string[] } {
  let result: unknown = null;
  try {
    result = row.resultJson ? JSON.parse(row.resultJson) : null;
  } catch {
    result = null;
  }
  let missingEvidence: string[] = [];
  try {
    missingEvidence = row.missingEvidenceJson ? (JSON.parse(row.missingEvidenceJson) as string[]) : [];
  } catch {
    missingEvidence = [];
  }
  return { result, missingEvidence };
}

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const projectId = new URL(req.url).searchParams.get("projectId");
  if (!projectId) return badRequest("projectId is required.");
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project || project.userId !== user.id) return badRequest("Project not found or not owned by the caller.");

  const [indexRow, matchRow, continuityRow, review] = await Promise.all([
    db.creativeAnalysisArtifact.findFirst({ where: { userId: user.id, projectId, kind: "visual-index", status: { in: ["COMPLETED", "STALE"] } }, orderBy: { updatedAt: "desc" } }),
    db.creativeAnalysisArtifact.findFirst({ where: { userId: user.id, projectId, kind: "visual-match", status: { in: ["COMPLETED", "STALE"] } }, orderBy: { updatedAt: "desc" } }),
    db.creativeAnalysisArtifact.findFirst({ where: { userId: user.id, projectId, kind: "visual-continuity", status: { in: ["COMPLETED", "STALE"] } }, orderBy: { updatedAt: "desc" } }),
    db.creativeReview.findFirst({ where: { userId: user.id, projectId, scope: "visual" }, orderBy: { updatedAt: "desc" } }),
  ]);

  let currentVersion: string | null = null;
  try {
    const head = await getTimelineHead(projectId, user.id);
    currentVersion = contextVersionOf(head.version, head.sequence.clips.length, head.sequence.clips.reduce((m, c) => Math.max(m, c.timelineStartFrame + c.timelineDurationFrames), 0));
  } catch {
    currentVersion = null;
  }

  const artifactView = (row: typeof indexRow) => {
    if (!row) return null;
    let deps: { contextVersion?: string } = {};
    try {
      deps = JSON.parse(row.depsJson) as { contextVersion?: string };
    } catch {
      deps = {};
    }
    const timelineStale = currentVersion !== null && deps.contextVersion !== undefined && deps.contextVersion !== currentVersion;
    const { result, missingEvidence } = parseArtifactJson(row);
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      stale: row.status === "STALE" || timelineStale,
      staleReason: row.staleReason ?? (timelineStale ? "timeline changed since this analysis" : null),
      provider: row.provider,
      model: row.model,
      consentVisual: row.consentVisual,
      missingEvidence,
      result,
      updatedAt: row.updatedAt.toISOString(),
    };
  };

  return NextResponse.json({
    index: artifactView(indexRow),
    matches: artifactView(matchRow),
    continuity: artifactView(continuityRow),
    review: review
      ? { id: review.id, status: review.status, stage: review.stage, progress: review.progress, error: review.error, jobId: review.jobId, updatedAt: review.updatedAt.toISOString() }
      : null,
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
  const { reviewId, jobId, estimatedVisionCalls } = await enqueueVisualIntelligence(user.id, parsed.data.projectId, parsed.data.settings, parsed.data.consentVisual);
  await db.automationAudit.create({ data: { userId: user.id, projectId: parsed.data.projectId, action: "VISUAL_INTELLIGENCE_ENQUEUED", detailJson: JSON.stringify({ reviewId, jobId, consentVisual: parsed.data.consentVisual, settings: parsed.data.settings, estimatedVisionCalls }) } }).catch(() => undefined);
  return NextResponse.json({ reviewId, jobId, estimatedVisionCalls }, { status: 202 });
}
