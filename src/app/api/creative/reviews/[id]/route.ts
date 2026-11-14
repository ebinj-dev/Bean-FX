/**
 * M10 API — one creative review: full payload + live staleness (§10).
 * GET    /api/creative/reviews/[id]   review + findings + recommendations + scorecard + STALE flags
 * DELETE /api/creative/reviews/[id]   cancel when queued/running
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, notFound, unauthorized } from "@/lib/process-helpers";
import { getTimelineHead } from "@/lib/editor/persistence";
import { contextVersionOf } from "@/lib/creative/contracts";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const review = await db.creativeReview.findUnique({ where: { id } });
  if (!review || review.userId !== user.id) return notFound();

  const [findings, recommendations, scorecard] = await Promise.all([
    db.creativeFinding.findMany({ where: { reviewId: id }, orderBy: { findingNo: "asc" } }),
    db.creativeRecommendation.findMany({ where: { reviewId: id }, orderBy: { recNo: "asc" } }),
    db.creativeScorecard.findUnique({ where: { reviewId: id } }),
  ]);

  // Live staleness: current head vs the version each analysis/proposal used.
  let currentVersion: string | null = null;
  let currentHeadVersion: number | null = null;
  try {
    const head = await getTimelineHead(review.projectId, user.id);
    currentHeadVersion = head.version;
    currentVersion = contextVersionOf(head.version, head.sequence.clips.length, head.sequence.clips.reduce((m, c) => Math.max(m, c.timelineStartFrame + c.timelineDurationFrames), 0));
  } catch {
    currentVersion = null;
  }
  const reviewStale = currentVersion !== null && currentVersion !== review.contextVersion;

  return NextResponse.json({
    review: {
      id: review.id,
      projectId: review.projectId,
      scope: review.scope,
      language: review.language,
      status: review.status,
      progress: review.progress,
      stage: review.stage,
      contextVersion: review.contextVersion,
      headVersion: review.headVersion,
      brief: review.briefJson ? JSON.parse(review.briefJson) : null,
      missingEvidence: review.missingEvidenceJson ? JSON.parse(review.missingEvidenceJson) : null,
      evidenceSources: review.evidenceSourcesJson ? JSON.parse(review.evidenceSourcesJson) : null,
      provider: review.provider,
      model: review.model,
      error: review.error,
      jobId: review.jobId,
      stale: reviewStale,
      currentContextVersion: currentVersion,
      createdAt: review.createdAt.toISOString(),
    },
    findings: findings.map((f) => ({
      findingNo: f.findingNo,
      category: f.category,
      startSec: f.startSec,
      endSec: f.endSec,
      severity: f.severity,
      confidence: f.confidence,
      evidenceLabel: f.evidenceLabel,
      evidence: JSON.parse(f.evidenceJson),
      explanation: f.explanation,
      suggestion: f.suggestion,
      engine: f.engine,
    })),
    recommendations: recommendations.map((r) => ({
      id: r.id,
      recNo: r.recNo,
      kind: r.kind,
      engine: r.engine,
      title: r.title,
      detail: r.detail,
      target: r.targetJson ? JSON.parse(r.targetJson) : null,
      payload: JSON.parse(r.proposalJson),
      preview: r.previewJson ? JSON.parse(r.previewJson) : null,
      requiresApproval: r.requiresApproval,
      status: r.status,
      stale: r.status === "PROPOSED" && currentHeadVersion !== null && r.timelineVersionAtProposal !== currentHeadVersion,
      timelineVersionAtProposal: r.timelineVersionAtProposal,
      executedVersion: r.executedVersion,
      result: r.resultJson ? JSON.parse(r.resultJson) : null,
    })),
    scorecard: scorecard ? { modelVersion: scorecard.modelVersion, dimensions: JSON.parse(scorecard.dimensionsJson), overallNote: scorecard.overallNote } : null,
  });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const review = await db.creativeReview.findUnique({ where: { id } });
  if (!review || review.userId !== user.id) return notFound();
  if (review.status !== "QUEUED" && review.status !== "RUNNING") return badRequest(`Review is ${review.status}; only queued/running reviews can be cancelled.`);
  if (review.jobId) {
    const { jobManager } = await import("@/lib/job-runner");
    await jobManager.cancel(review.jobId, user.id);
  }
  await db.creativeReview.updateMany({ where: { id, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "CANCELLED", stage: "Cancelled" } });
  return NextResponse.json({ ok: true });
}
