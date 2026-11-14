/**
 * M10 — durable creative jobs (§9) on the EXISTING M3 worker.
 *
 * CREATIVE_REVIEW: one recoverable analysis run (scope: full | retention |
 * scorecard | brief). Phases: measured context (optional bounded evidence
 * wait) → deterministic findings → recommendations → (provider permitting)
 * brief + subjective scorecard. Progress is real; cancellation between
 * phases is honored; every phase outcome lands on the review row. Stale
 * results are detectable via contextVersion.
 *
 * CREATIVE_VARIANTS: typed text-variant generation (A/B Studio) via MY AI.
 *
 * Both reuse the claim/heartbeat/retry/timeout machinery — no new queue.
 */
import { db } from "@/lib/db";
import { jobManager } from "@/lib/job-runner";
import { PermanentJobError, finishJob } from "@/lib/job-helpers";
import { buildMeasuredContext } from "./context";
import { analyzeRetention } from "./retention";
import { generateCreativeBrief } from "./brief";
import { buildScorecard } from "./scorecard";
import { buildRecommendations, persistRecommendations } from "./recommendations";
import { generateTextVariants, persistVariants } from "./variants";
import { contextVersionOf } from "./contracts";
import { getTimelineHead } from "@/lib/editor/persistence";

interface HandlerJob {
  id: string;
  userId: string;
  attempts: number;
  maxAttempts: number;
  paramsJson: string | null;
}

async function assertOwnedReview(userId: string, reviewId: string) {
  const review = await db.creativeReview.findUnique({ where: { id: reviewId } });
  if (!review || review.userId !== userId) throw new PermanentJobError("Creative review not found or not owned by the caller.");
  return review;
}

/** True when the job was cancelled/failed mid-run (checked between phases). */
async function jobInterrupted(jobId: string): Promise<boolean> {
  const row = await db.job.findUnique({ where: { id: jobId }, select: { status: true } }).catch(() => null);
  return !row || row.status === "CANCELLED" || row.status === "FAILED";
}

export async function runCreativeReviewJob(job: HandlerJob): Promise<void> {
  const params = JSON.parse(job.paramsJson ?? "{}") as { reviewId?: string; enqueueEvidence?: boolean };
  if (!params.reviewId) throw new PermanentJobError("CREATIVE_REVIEW missing reviewId");
  const review = await assertOwnedReview(job.userId, params.reviewId);
  if (review.status === "COMPLETED") return; // idempotent recovery

  await db.creativeReview.update({ where: { id: review.id }, data: { status: "RUNNING", stage: "Gathering measured context", progress: 5, error: null } });

  // ── phase 1: measured context (+ bounded GANGZII evidence wait) ──
  let ctx;
  try {
    ctx = await buildMeasuredContext(job.userId, review.projectId, { enqueueEvidence: params.enqueueEvidence ?? true });
  } catch (err) {
    await db.creativeReview.update({ where: { id: review.id }, data: { status: "FAILED", stage: "Failed", error: (err instanceof Error ? err.message : "context failed").slice(0, 500) } });
    throw err;
  }
  await jobManager.setProgress(job.id, 30, `Measured context ready (${ctx.evidenceSources.length} evidence source(s))`);
  if (await jobInterrupted(job.id)) {
    await db.creativeReview.updateMany({ where: { id: review.id, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "CANCELLED", stage: "Cancelled" } });
    return;
  }

  // Stale guard: the head must still match what the review was created for.
  const head = await getTimelineHead(review.projectId, job.userId);
  const currentVersion = contextVersionOf(head.version, head.sequence.clips.length, head.sequence.clips.reduce((m, c) => Math.max(m, c.timelineStartFrame + c.timelineDurationFrames), 0));
  if (currentVersion !== review.contextVersion) {
    await db.creativeReview.update({
      where: { id: review.id },
      data: { status: "FAILED", stage: "Stale", error: `Timeline changed since enqueue (created for ${review.contextVersion}, now ${currentVersion}) — enqueue a fresh review.`, missingEvidenceJson: JSON.stringify(ctx.missingEvidence), evidenceSourcesJson: JSON.stringify(ctx.evidenceSources) },
    });
    await finishJob(job.id, { status: "COMPLETED", progress: 100, stage: "Completed", message: "Review marked stale before analysis — nothing persisted." });
    return;
  }

  // ── phase 2: deterministic findings (always) ──
  const { findings, disclaimer } = analyzeRetention(ctx);
  await db.creativeFinding.deleteMany({ where: { reviewId: review.id } });
  let n = 0;
  for (const f of findings) {
    n += 1;
    await db.creativeFinding.create({
      data: {
        reviewId: review.id,
        findingNo: f.findingNo,
        category: f.category,
        startSec: f.startSec,
        endSec: f.endSec,
        severity: f.severity,
        confidence: f.confidence,
        evidenceLabel: f.evidenceLabel,
        evidenceJson: JSON.stringify(f.evidence),
        explanation: f.explanation,
        suggestion: f.suggestion,
        engine: f.engine,
      },
    });
  }
  await jobManager.setProgress(job.id, 55, `${findings.length} evidence-based findings`);
  if (await jobInterrupted(job.id)) {
    await db.creativeReview.updateMany({ where: { id: review.id, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "CANCELLED", stage: "Cancelled" } });
    return;
  }

  // ── phase 3: recommendations (typed, approval-gated) ──
  const recs = buildRecommendations(ctx, findings);
  await db.creativeRecommendation.deleteMany({ where: { reviewId: review.id, status: "PROPOSED" } });
  await persistRecommendations(job.userId, review.projectId, review.id, review.headVersion, recs);
  await jobManager.setProgress(job.id, 70, `${recs.length} recommendation(s) proposed`);

  // ── phase 4: brief + subjective scorecard (MY AI; honest degradation) ──
  let briefJson: string | null = null;
  let provider: string | null = null;
  let model: string | null = null;
  let scorecardJson: string | null = null;
  let interpretiveError: string | null = null;
  const needsLlm = review.scope === "full" || review.scope === "brief" || review.scope === "scorecard";
  if (needsLlm) {
    // Each interpretive piece degrades INDEPENDENTLY — a brief failure must
    // not take the scorecard down with it.
    if (review.scope !== "scorecard") {
      try {
        const brief = await generateCreativeBrief(ctx, review.language as "en" | "ta");
        briefJson = JSON.stringify(brief.brief);
        model = brief.model;
        provider = "configured-gateway";
        await db.aIUsage.create({ data: { userId: job.userId, provider: provider, model: brief.model, purpose: "creative-brief", promptTokens: 0, completionTokens: 0, totalTokens: 0 } }).catch(() => undefined);
        await jobManager.setProgress(job.id, 80, "Brief generated");
      } catch (err) {
        interpretiveError = `Brief unavailable: ${(err instanceof Error ? err.message : "provider failure").slice(0, 250)}`;
      }
    }
    if (review.scope !== "brief") {
      try {
        const sc = await buildScorecard(job.userId, ctx, review.language as "en" | "ta", {});
        scorecardJson = JSON.stringify(sc.scorecard);
        await db.creativeScorecard.upsert({
          where: { reviewId: review.id },
          create: { reviewId: review.id, modelVersion: sc.scorecard.modelVersion, dimensionsJson: scorecardJson, overallNote: sc.scorecard.overallNote },
          update: { modelVersion: sc.scorecard.modelVersion, dimensionsJson: scorecardJson, overallNote: sc.scorecard.overallNote },
        });
        if (sc.model) model = sc.model;
      } catch (err) {
        interpretiveError = `${interpretiveError ?? ""} Scorecard unavailable: ${(err instanceof Error ? err.message : "provider failure").slice(0, 250)}`.trim();
      }
    }
  } else {
    // deterministic-only scope: subjective dims recorded as unscored.
    const sc = await buildScorecard(job.userId, ctx, review.language as "en" | "ta", { scorecardUnavailable: true });
    scorecardJson = JSON.stringify(sc.scorecard);
    await db.creativeScorecard.upsert({
      where: { reviewId: review.id },
      create: { reviewId: review.id, modelVersion: sc.scorecard.modelVersion, dimensionsJson: scorecardJson, overallNote: sc.scorecard.overallNote },
      update: { modelVersion: sc.scorecard.modelVersion, dimensionsJson: scorecardJson, overallNote: sc.scorecard.overallNote },
    });
  }

  await db.creativeReview.update({
    where: { id: review.id },
    data: {
      status: "COMPLETED",
      progress: 100,
      stage: "Completed",
      briefJson,
      missingEvidenceJson: JSON.stringify({ items: ctx.missingEvidence, retentionDisclaimer: disclaimer }),
      evidenceSourcesJson: JSON.stringify(ctx.evidenceSources),
      provider,
      model,
      error: interpretiveError,
    },
  });
  await jobManager.complete(job.id, null, `Creative review complete: ${findings.length} findings, ${recs.length} recommendations${briefJson ? ", brief" : ""}${scorecardJson ? ", scorecard" : ""}.`);
}

export async function runCreativeVariantsJob(job: HandlerJob): Promise<void> {
  const params = JSON.parse(job.paramsJson ?? "{}") as { projectId?: string; reviewId?: string | null; kind?: string; instruction?: string; language?: string };
  if (!params.projectId) throw new PermanentJobError("CREATIVE_VARIANTS missing projectId");
  const kind = (params.kind ?? "hook") as "hook" | "title" | "description" | "cta" | "narration-section";
  if (!["hook", "title", "description", "cta", "narration-section"].includes(kind)) throw new PermanentJobError(`Unsupported variant kind: ${kind}`);
  const language = (params.language ?? "en") as "en" | "ta";

  const ctx = await buildMeasuredContext(job.userId, params.projectId, { enqueueEvidence: false });
  await jobManager.setProgress(job.id, 30, "Context ready — generating alternatives");
  const { LLMError } = await import("@/lib/my-ai/gateway/provider");
  try {
    const { variants, model } = await generateTextVariants(job.userId, ctx, kind, language, { instruction: params.instruction });
    await jobManager.setProgress(job.id, 80, `${variants.length} alternatives generated (${model})`);
    const ids = await persistVariants(job.userId, params.projectId, params.reviewId ?? null, variants);
    await jobManager.complete(job.id, null, `${ids.length} ${kind} variant(s) stored for A/B evaluation (model ${model}).`);
  } catch (err) {
    // Deterministic provider failures never benefit from retries.
    if (err instanceof LLMError && (err.code === "NOT_CONFIGURED" || err.code === "AUTH_FAILED")) {
      throw new PermanentJobError(`Variant generation unavailable: ${err.message}`);
    }
    throw err;
  }
}
