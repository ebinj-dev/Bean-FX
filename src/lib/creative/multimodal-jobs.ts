/**
 * M11 — multimodal analysis + integrated transcription jobs (§2/§3/§5/§6/§10)
 * on the EXISTING M3 worker (no new queue).
 *
 * CREATIVE_MULTIMODAL: stale invalidation → measured context → embedded audio
 * evidence (GANGZII on video/audio sources, dedup'd, bounded wait) → local
 * scene analysis (deterministic ffmpeg, nothing uploaded) → retention +
 * cross-modal findings → multi-clip pause-surgery plan (validated dry-run) →
 * recommendations → unified observation artifact → optional integrated
 * transcript → scorecard/brief (per scope, honest degradation). Findings and
 * recommendations persist through the EXISTING M10 models.
 *
 * TRANSCRIBE_PROJECT: integrated RIISHE transcription (§4) → TranscriptVersion
 * PENDING_REVIEW + stale marking of older versions.
 */
import { db } from "@/lib/db";
import { jobManager } from "@/lib/job-runner";
import { PermanentJobError } from "@/lib/job-helpers";
import { buildMeasuredContext } from "./context";
import { analyzeRetention } from "./retention";
import { generateCreativeBrief } from "./brief";
import { buildScorecard } from "./scorecard";
import { buildRecommendations, persistRecommendations } from "./recommendations";
import { buildCrossModalRecommendations } from "./crossmodal-recommendations";
import { contextVersionOf, type Finding } from "./contracts";
import { getTimelineHead } from "@/lib/editor/persistence";
import { analyzeCrossModal, runLocalSceneAnalysis, type SceneAnalysisResult } from "./crossmodal";
import { ensureEmbeddedAudioEvidence, mapSilenceToTimeline } from "./embedded-audio";
import { planPauseSurgery, validateSurgeryPlan, validateSurgeryOptions } from "./pause-surgery";
import { runProjectTranscription, markStaleTranscripts } from "./transcription";
import { assetFingerprint, depsHashOf, buildObservations } from "./multimodal";
import { assertOwnedReview, jobInterrupted } from "./jobs";

interface HandlerJob {
  id: string;
  userId: string;
  attempts: number;
  maxAttempts: number;
  paramsJson: string | null;
}

interface ArtifactDeps {
  assetFingerprint?: string;
  contextVersion: string;
  thresholdsHash: string;
  providerModel?: string;
}

/** Mark project artifacts whose dependencies changed as STALE (with reasons). */
async function invalidateStaleArtifacts(userId: string, projectId: string, currentDeps: ArtifactDeps): Promise<number> {
  const rows = await db.creativeAnalysisArtifact.findMany({ where: { userId, projectId, status: { in: ["COMPLETED", "RUNNING", "QUEUED"] } } });
  let n = 0;
  for (const row of rows) {
    let deps: Partial<ArtifactDeps> = {};
    try {
      deps = JSON.parse(row.depsJson) as Partial<ArtifactDeps>;
    } catch {
      continue;
    }
    const reasons: string[] = [];
    if (deps.contextVersion && deps.contextVersion !== currentDeps.contextVersion) reasons.push(`timeline changed (${deps.contextVersion} → ${currentDeps.contextVersion})`);
    if (deps.assetFingerprint && currentDeps.assetFingerprint && deps.assetFingerprint !== currentDeps.assetFingerprint) reasons.push("source media changed (size/mtime)");
    if (deps.thresholdsHash && deps.thresholdsHash !== currentDeps.thresholdsHash) reasons.push("analysis thresholds/settings changed");
    if (deps.providerModel && currentDeps.providerModel && deps.providerModel !== currentDeps.providerModel) reasons.push(`provider/model changed (${deps.providerModel} → ${currentDeps.providerModel})`);
    if (reasons.length > 0) {
      await db.creativeAnalysisArtifact.update({ where: { id: row.id }, data: { status: "STALE", staleReason: reasons.join("; ") } });
      n += 1;
    }
  }
  return n;
}

/** Reuse a COMPLETED artifact with identical dependencies (no duplicate work). */
async function findReusableArtifact(userId: string, projectId: string, kind: string, depsHashValue: string) {
  return db.creativeAnalysisArtifact.findFirst({ where: { userId, projectId, kind, depsHash: depsHashValue, status: "COMPLETED" }, orderBy: { updatedAt: "desc" } });
}

async function recordArtifact(userId: string, projectId: string, kind: string, sourceAssetId: string | null, streamIndex: number | null, deps: ArtifactDeps, resultJson: string | null, missingEvidence: string[], opts: { provider?: string | null; model?: string | null; consentVisual?: boolean; error?: string | null; status?: string }) {
  const hash = depsHashOf(deps as unknown as Record<string, unknown>);
  const data = {
    status: opts.status ?? "COMPLETED",
    depsHash: hash,
    depsJson: JSON.stringify(deps),
    resultJson,
    missingEvidenceJson: JSON.stringify(missingEvidence),
    provider: opts.provider ?? null,
    model: opts.model ?? null,
    consentVisual: Boolean(opts.consentVisual),
    error: opts.error ?? null,
  };
  const existing = await db.creativeAnalysisArtifact.findFirst({ where: { userId, projectId, kind, depsHash: hash, status: { in: ["COMPLETED", "FAILED"] } } });
  if (existing) return db.creativeAnalysisArtifact.update({ where: { id: existing.id }, data });
  return db.creativeAnalysisArtifact.create({ data: { userId, projectId, kind, sourceAssetId: sourceAssetId ?? undefined, streamIndex: streamIndex ?? undefined, ...data } });
}

async function persistFindings(reviewId: string, findings: Finding[]): Promise<void> {
  await db.creativeFinding.deleteMany({ where: { reviewId } });
  let n = 0;
  for (const f of findings) {
    n += 1;
    await db.creativeFinding.create({
      data: {
        reviewId,
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
}

/** CREATIVE_MULTIMODAL — the unified pipeline (§2/§3/§5/§6/§10). */
export async function runCreativeMultimodalJob(job: HandlerJob): Promise<void> {
  const params = JSON.parse(job.paramsJson ?? "{}") as { reviewId?: string; thresholds?: unknown; withTranscript?: boolean; consentVisual?: boolean };
  if (!params.reviewId) throw new PermanentJobError("CREATIVE_MULTIMODAL missing reviewId");
  const review = await assertOwnedReview(job.userId, params.reviewId);
  if (review.status === "COMPLETED") return;

  const thresholds = validateSurgeryOptions(params.thresholds ?? {});
  const thresholdsHash = depsHashOf(thresholds as unknown as Record<string, unknown>);
  await db.creativeReview.update({ where: { id: review.id }, data: { status: "RUNNING", stage: "Invalidating stale artifacts", progress: 5, error: null } });

  const head = await getTimelineHead(review.projectId, job.userId);
  const seq = head.sequence;
  const contextVersion = contextVersionOf(head.version, seq.clips.length, seq.clips.reduce((m, c) => Math.max(m, c.timelineStartFrame + c.timelineDurationFrames), 0));
  if (contextVersion !== review.contextVersion) {
    await db.creativeReview.update({ where: { id: review.id }, data: { status: "FAILED", stage: "Stale", error: `Timeline changed since enqueue (created for ${review.contextVersion}, now ${contextVersion}).` } });
    return;
  }
  const invalidated = await invalidateStaleArtifacts(job.userId, review.projectId, { contextVersion, thresholdsHash });

  const missingEvidence: string[] = [];
  const evidenceSources: { engine: string; detail: string }[] = [];
  if (invalidated > 0) missingEvidence.push(`${invalidated} prior analysis artifact(s) marked STALE with reasons — affected stages recomputed, unaffected stages reused.`);

  // ── phase 1: measured context + embedded audio evidence ──
  let ctx = await buildMeasuredContext(job.userId, review.projectId, { enqueueEvidence: false });
  await jobManager.setProgress(job.id, 15, "Measured context ready");

  const primaryVideoAssetId = ctx.videoTimelineSpans.map((v) => v.assetId).filter((v): v is string => Boolean(v))[0] ?? null;

  const embedded = await ensureEmbeddedAudioEvidence(job.userId, review.projectId, { waitSec: 200 });
  evidenceSources.push({ engine: "GANGZII", detail: embedded.inspection ? `embedded/external audio inspection ${embedded.inspectionProcessId}` : "no audio inspection available" });
  missingEvidence.push(...embedded.observationsNote);
  await jobManager.setProgress(job.id, 40, embedded.inspection ? "Audio evidence measured (embedded/external)" : "Audio evidence unavailable (recorded honestly)");

  if (embedded.inspection && embedded.primary) {
    const spans = embedded.inspection.silence.spans.slice(0, 200);
    ctx = {
      ...ctx,
      audio: {
        sourceAssetId: embedded.primary.assetId,
        sourceName: embedded.primary.originalName,
        inspection: {
          durationSec: embedded.inspection.durationSec,
          silenceSpans: spans,
          silenceTotalSec: embedded.inspection.silence.totalSec,
          silenceFraction: embedded.inspection.silence.fraction,
          integratedLufs: embedded.inspection.loudness.integratedLufs,
          lraLu: embedded.inspection.loudness.lraLu,
          levelsClassification: embedded.inspection.levels.classification,
          channelImbalanceDb: embedded.inspection.channelImbalanceDb,
          clippingSuspected: embedded.inspection.clipping.suspected,
          noiseFloorDbfs: embedded.inspection.noiseFloorDbfs,
          shortTermMaxLufs: embedded.inspection.loudness.shortTerm.length ? Math.max(...embedded.inspection.loudness.shortTerm.map((x) => x.lufs)) : null,
        },
        inspectionProcessId: embedded.inspectionProcessId,
      },
    };
  }

  if (await jobInterrupted(job.id)) {
    await db.creativeReview.updateMany({ where: { id: review.id, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "CANCELLED", stage: "Cancelled" } });
    return;
  }

  // ── phase 2: local scene analysis (REAL frames, deterministic, consent-free) ──
  let scene: SceneAnalysisResult | null = null;
  let sceneAssetId: string | null = null;
  let sceneFingerprint: string | undefined;
  if (primaryVideoAssetId) {
    const asset = await db.mediaAsset.findFirst({ where: { id: primaryVideoAssetId, userId: job.userId } });
    if (asset?.storagePath) {
      sceneAssetId = asset.id;
      sceneFingerprint = assetFingerprint(asset);
      const sceneDeps = { assetFingerprint: sceneFingerprint, contextVersion, thresholdsHash };
      const hash = depsHashOf({ kind: "scene", ...sceneDeps });
      const reusable = await findReusableArtifact(job.userId, review.projectId, "scene", hash);
      if (reusable?.resultJson) {
        scene = JSON.parse(reusable.resultJson) as SceneAnalysisResult;
        evidenceSources.push({ engine: "JAZMII", detail: `scene analysis REUSED (artifact ${reusable.id})` });
      } else {
        scene = await runLocalSceneAnalysis(asset.storagePath, asset.id, embedded.inspection?.durationSec ?? null);
        await recordArtifact(job.userId, review.projectId, "scene", asset.id, null, sceneDeps, JSON.stringify(scene), [], { provider: "ffmpeg-local", model: "scene-heuristic" });
        evidenceSources.push({ engine: "JAZMII", detail: "local scene analysis (deterministic ffmpeg, no upload)" });
      }
    }
  } else {
    missingEvidence.push("No VIDEO assets on the timeline — visual cross-modal findings are unavailable (recorded honestly).");
  }
  await jobManager.setProgress(job.id, 55, scene?.available ? `Scene analysis: ${scene.sceneChangesSec.length} cut(s), ${scene.staticSectionsSec.length} static section(s)` : "Scene analysis unavailable");

  if (await jobInterrupted(job.id)) {
    await db.creativeReview.updateMany({ where: { id: review.id, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "CANCELLED", stage: "Cancelled" } });
    return;
  }

  // ── phase 3: findings — retention (M10 engine) + cross-modal (M11) ──
  const { findings: retentionFindings, disclaimer } = analyzeRetention(ctx);
  const { findings: crossFindings, notes: crossNotes } = analyzeCrossModal(ctx, scene);
  missingEvidence.push(...crossNotes);
  const baseNo = retentionFindings.length;
  const findings = [...retentionFindings, ...crossFindings.map((f, i) => ({ ...f, findingNo: baseNo + 1 + i }))];
  await persistFindings(review.id, findings);
  await jobManager.setProgress(job.id, 65, `${findings.length} multimodal findings`);

  // ── phase 4: recommendations — M10 routing + multi-clip surgery plan + cross-modal ──
  const recs = buildRecommendations(ctx, findings);
  if (embedded.inspection && embedded.primary) {
    const timelineSpans = await mapSilenceToTimeline(job.userId, review.projectId, embedded.primary.assetId, embedded.inspection.silence.spans, ctx.fps);
    const plan = planPauseSurgery(seq, timelineSpans, thresholds, null);
    const validation = validateSurgeryPlan(seq, plan);
    if (plan.removals.length > 0 && validation.ok) {
      const commands = plan.removals.flatMap((r) => r.commands) as unknown as Record<string, unknown>[];
      recs.push({
        recNo: findings.length + 1,
        engine: "RIISHE",
        kind: "executable",
        title: `Multi-clip pause plan: remove ${plan.removals.length} pause(s)`,
        detail: `${(plan.totalRemovedFrames / ctx.fps).toFixed(2)} s of measured silence across ${plan.removals.length} location(s) (${plan.removals.map((r) => r.kind).join(", ")}). Validated dry-run on the current head; ${plan.skipped.length} span(s) skipped with reasons. Requires explicit approval; applied as ONE versioned batch (undo intact).`,
        target: { clipId: plan.removals[0]?.affectedClipIds[0] ?? null, trackId: plan.trackId, startSec: plan.removals[0]?.spanSec.start ?? null, endSec: plan.removals[plan.removals.length - 1]?.spanSec.end ?? null },
        payload: { kind: "timeline-commands", commands },
        preview: {
          plan: { removals: plan.removals.map((r) => ({ span: r.spanSec, kind: r.kind, affectedClips: r.affectedClipIds, removedFrames: r.removedTimelineFrames })), skipped: plan.skipped },
          note: "Dry-run validated — use the Preview action for the full before/after simulation.",
        },
        requiresApproval: true,
        rationale: `Measured silence (GANGZII) mapped to the timeline; thresholds minPause=${thresholds.minPauseSec}s retainedGap=${thresholds.minRetainedGapSec}s.`,
      });
    } else if (plan.skipped.length > 0) {
      missingEvidence.push(`Pause surgery skipped ${plan.skipped.length} span(s): ${plan.skipped.slice(0, 3).map((sk) => sk.reason).join(" | ")}`);
    }
    void validation;
  }
  recs.push(...buildCrossModalRecommendations(ctx, findings));
  await db.creativeRecommendation.deleteMany({ where: { reviewId: review.id, status: "PROPOSED" } });
  await persistRecommendations(job.userId, review.projectId, review.id, review.headVersion, recs);
  await jobManager.setProgress(job.id, 75, `${recs.length} recommendation(s)`);

  // ── phase 5: unified observation snapshot + optional integrated transcript ──
  const observations = buildObservations(ctx);
  const unifiedDeps = { contextVersion, thresholdsHash, assetFingerprint: sceneFingerprint };
  await recordArtifact(job.userId, review.projectId, "unified", sceneAssetId, null, unifiedDeps, JSON.stringify({ observations: observations.slice(0, 400), observationCount: observations.length }), missingEvidence, { provider: null, model: null, consentVisual: Boolean(params.consentVisual) });

  if (params.withTranscript) {
    try {
      const t = await runProjectTranscription(job.userId, review.projectId, {});
      await db.transcriptVersion.update({ where: { id: t.transcriptId }, data: { jobId: job.id } });
      missingEvidence.push(`Integrated transcription produced transcript v${t.versionNo} (${t.language}, ${t.segments} segment(s), PENDING_REVIEW — approve it in the panel to generate captions).`);
    } catch (err) {
      missingEvidence.push(`Integrated transcription failed honestly: ${(err as Error).message.slice(0, 200)}`);
    }
  }

  // ── phase 6: scorecard + brief (scope-dependent, honest degradation) ──
  let briefJson: string | null = null;
  let scorecardJson: string | null = null;
  let provider: string | null = null;
  let model: string | null = null;
  let interpretiveError: string | null = null;
  if (review.scope === "multimodal" || review.scope === "full" || review.scope === "brief") {
    try {
      const brief = await generateCreativeBrief(ctx, review.language as "en" | "ta");
      briefJson = JSON.stringify(brief.brief);
      model = brief.model;
      provider = "configured-gateway";
    } catch (err) {
      interpretiveError = `Brief unavailable: ${(err as Error).message.slice(0, 250)}`;
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
      interpretiveError = `${interpretiveError ?? ""} Scorecard unavailable: ${(err as Error).message.slice(0, 250)}`.trim();
    }
  }

  await db.creativeReview.update({
    where: { id: review.id },
    data: {
      status: "COMPLETED",
      progress: 100,
      stage: "Completed",
      briefJson,
      missingEvidenceJson: JSON.stringify({ items: missingEvidence, retentionDisclaimer: disclaimer }),
      evidenceSourcesJson: JSON.stringify(evidenceSources),
      provider,
      model,
      error: interpretiveError,
    },
  });
  await jobManager.complete(job.id, null, `Multimodal review complete: ${findings.length} findings, ${recs.length} recommendations, ${observations.length} observations.`);
}

/** TRANSCRIBE_PROJECT — integrated transcription (§4) as a durable job. */
export async function runTranscribeProjectJob(job: HandlerJob): Promise<void> {
  const params = JSON.parse(job.paramsJson ?? "{}") as { projectId?: string };
  if (!params.projectId) throw new PermanentJobError("TRANSCRIBE_PROJECT missing projectId");
  await jobManager.setProgress(job.id, 20, "Extracting source audio + running RIISHE ASR");
  const t = await runProjectTranscription(job.userId, params.projectId, {});
  await db.transcriptVersion.update({ where: { id: t.transcriptId }, data: { jobId: job.id } });
  await markStaleTranscripts(job.userId, params.projectId);
  await jobManager.complete(job.id, null, `Transcript v${t.versionNo} (${t.language}, ${t.segments} segment(s)) stored as PENDING_REVIEW. Warnings: ${t.warnings.slice(0, 2).join(" | ") || "none"}`);
}

/** Enqueue a multimodal review with thresholds + options. */
export async function enqueueMultimodalReview(userId: string, projectId: string, language: "en" | "ta", thresholds: unknown, withTranscript: boolean, consentVisual: boolean): Promise<{ reviewId: string; jobId: string }> {
  const head = await getTimelineHead(projectId, userId);
  const seq = head.sequence;
  const contextVersion = contextVersionOf(head.version, seq.clips.length, seq.clips.reduce((m, c) => Math.max(m, c.timelineStartFrame + c.timelineDurationFrames), 0));
  const review = await db.creativeReview.create({ data: { userId, projectId, scope: "multimodal", language, status: "QUEUED", stage: "Queued", contextVersion, headVersion: head.version } });
  const jobId = await jobManager.createJob(userId, "CREATIVE_MULTIMODAL", { reviewId: review.id, thresholds, withTranscript, consentVisual });
  await db.creativeReview.update({ where: { id: review.id }, data: { jobId } });
  return { reviewId: review.id, jobId };
}

export async function enqueueTranscribeProject(userId: string, projectId: string): Promise<{ jobId: string }> {
  const jobId = await jobManager.createJob(userId, "TRANSCRIBE_PROJECT", { projectId });
  return { jobId };
}
