/**
 * M13 API — Temporal Intelligence index (§13).
 * GET  /api/creative/temporal/index?projectId=…   temporal artifacts (index,
 *      motion-graphics proposals) + review state + live staleness
 * POST /api/creative/temporal/index               enqueue durable TEMPORAL_INTELLIGENCE
 *      {projectId, settings?, consentVisual}
 *
 * consentVisual gates ONLY provider subject-labeling (small tracked crops to
 * the configured vision provider). Local OpenCV tracking and camera
 * registration upload NOTHING and run without consent — stated in the
 * disclosure. Every path: session auth + project ownership + zod + audit.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/process-helpers";
import { enqueueTemporalIntelligence } from "@/lib/creative/visual/temporal/jobs";
import { getTimelineHead } from "@/lib/editor/persistence";
import { contextVersionOf } from "@/lib/creative/contracts";

export const runtime = "nodejs";

const CreateSchema = z.object({
  projectId: z.string().min(1).max(64),
  settings: z
    .object({
      sampleFps: z.number().min(1).max(15).optional(),
      maxFrames: z.number().min(6).max(300).optional(),
      windowSec: z.number().min(2).max(30).optional(),
      minBoxAreaFrac: z.number().min(0.0001).max(0.5).optional(),
      maxTracks: z.number().min(1).max(10).optional(),
      cameraMotion: z.boolean().optional(),
      providerLabels: z.boolean().optional(),
    })
    .nullable()
    .default(null),
  consentVisual: z.boolean().default(false),
});

function artifactView(row: { id: string; kind: string; status: string; staleReason: string | null; provider: string | null; model: string | null; consentVisual: boolean; depsJson: string; resultJson: string | null; missingEvidenceJson: string | null; updatedAt: Date } | null, currentVersion: string | null) {
  if (!row) return null;
  let deps: { contextVersion?: string } = {};
  try {
    deps = JSON.parse(row.depsJson) as { contextVersion?: string };
  } catch {
    deps = {};
  }
  const timelineStale = currentVersion !== null && deps.contextVersion !== undefined && deps.contextVersion !== currentVersion;
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
}

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const projectId = new URL(req.url).searchParams.get("projectId");
  if (!projectId) return badRequest("projectId is required.");
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project || project.userId !== user.id) return badRequest("Project not found or not owned by the caller.");

  const [indexRow, mographRow, review] = await Promise.all([
    db.creativeAnalysisArtifact.findFirst({ where: { userId: user.id, projectId, kind: "temporal-index", status: { in: ["COMPLETED", "STALE"] } }, orderBy: { updatedAt: "desc" } }),
    db.creativeAnalysisArtifact.findFirst({ where: { userId: user.id, projectId, kind: "temporal-mograph", status: { in: ["COMPLETED", "STALE"] } }, orderBy: { updatedAt: "desc" } }),
    db.creativeReview.findFirst({ where: { userId: user.id, projectId, scope: "temporal" }, orderBy: { updatedAt: "desc" } }),
  ]);

  let currentVersion: string | null = null;
  try {
    const head = await getTimelineHead(projectId, user.id);
    currentVersion = contextVersionOf(head.version, head.sequence.clips.length, head.sequence.clips.reduce((m, c) => Math.max(m, c.timelineStartFrame + c.timelineDurationFrames), 0));
  } catch {
    currentVersion = null;
  }

  return NextResponse.json({
    index: artifactView(indexRow, currentVersion),
    mograph: artifactView(mographRow, currentVersion),
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
  const { reviewId, jobId, disclosure } = await enqueueTemporalIntelligence(user.id, parsed.data.projectId, parsed.data.settings, parsed.data.consentVisual);
  await db.automationAudit.create({ data: { userId: user.id, projectId: parsed.data.projectId, action: "TEMPORAL_INTELLIGENCE_ENQUEUED", detailJson: JSON.stringify({ reviewId, jobId, consentVisual: parsed.data.consentVisual, settings: parsed.data.settings, disclosure }) } }).catch(() => undefined);
  return NextResponse.json({ reviewId, jobId, disclosure }, { status: 202 });
}
