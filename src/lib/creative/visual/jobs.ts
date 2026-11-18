/**
 * M12 — Visual intelligence jobs (§10) on the EXISTING M3 worker (no new
 * queue).
 *
 * VISUAL_INTELLIGENCE phases:
 *   1. stale invalidation (artifact fingerprints with reasons) + settings hash
 *   2. measured context + primary video asset resolution
 *   3. JAZMII local scene analysis (deterministic, dedup'd via M11 artifact)
 *   4. frame extraction (temp dir, aHash dedup, budgeted, both clocks)
 *   5. semantic frame analysis — ONLY with explicit consent (frames leave the
 *      server to the configured vision provider; usage recorded per call)
 *   6. scene index build + representative frame registration (IMAGE assets)
 *   7. narration-to-visual matching (approved transcript × scenes)
 *   8. continuity findings + b-roll recommendations (M10 contracts)
 *   9. artifact persistence (visual-index / visual-match / visual-continuity)
 *      with dependency fingerprints → identical deps = REUSED, changed deps =
 *      STALE with reasons; temp frames ALWAYS cleaned (finally).
 */
import { db } from "@/lib/db";
import { jobManager } from "@/lib/job-runner";
import { PermanentJobError } from "@/lib/job-helpers";
import { buildMeasuredContext } from "../context";
import { persistRecommendations } from "../recommendations";
import { contextVersionOf, type Finding, type Recommendation } from "../contracts";
import { getTimelineHead } from "@/lib/editor/persistence";
import { runLocalSceneAnalysis, type SceneAnalysisResult } from "../crossmodal";
import { assetFingerprint, depsHashOf } from "../multimodal";
import { assertOwnedReview, jobInterrupted } from "../jobs";
import { recordUsage } from "@/lib/my-ai/gateway/usage";
import { extractFrames, setFrameHeights, cleanupVisualFrameDir, visualFrameDir } from "./frames";
import { analyzeFramesSemantic } from "./vision-analysis";
import { buildScenes, registerRepresentativeFrames, assembleIndex } from "./scenes";
import { matchNarrationToVisuals } from "./matching";
import { buildBrollRecommendations } from "./broll";
import { analyzeVisualContinuity } from "./continuity";
import { VISUAL_SETTINGS_VERSION, VisualSettingsSchema, type VisualIndex, type VisualSettings } from "./contracts";

interface HandlerJob {
  id: string;
  userId: string;
  attempts: number;
  maxAttempts: number;
  paramsJson: string | null;
}

interface VisualDeps {
  kind?: string;
  assetFingerprint?: string;
  contextVersion: string;
  settingsHash: string;
  providerModel?: string;
  analysisVersion: string;
}

/** Mark project visual artifacts whose dependencies changed as STALE (with reasons). */
async function invalidateStaleVisualArtifacts(userId: string, projectId: string, currentDeps: VisualDeps): Promise<number> {
  const rows = await db.creativeAnalysisArtifact.findMany({ where: { userId, projectId, kind: { in: ["visual-index", "visual-match", "visual-continuity", "scene"] }, status: { in: ["COMPLETED", "RUNNING", "QUEUED"] } } });
  let n = 0;
  for (const row of rows) {
    let deps: Partial<VisualDeps> = {};
    try {
      deps = JSON.parse(row.depsJson) as Partial<VisualDeps>;
    } catch {
      continue;
    }
    const reasons: string[] = [];
    if (deps.contextVersion && deps.contextVersion !== currentDeps.contextVersion) reasons.push(`timeline changed (${deps.contextVersion} → ${currentDeps.contextVersion})`);
    if (deps.assetFingerprint && currentDeps.assetFingerprint && deps.assetFingerprint !== currentDeps.assetFingerprint) reasons.push("source media changed (size/mtime)");
    if (deps.settingsHash && deps.settingsHash !== currentDeps.settingsHash) reasons.push("visual sampling/settings changed");
    if (deps.providerModel && currentDeps.providerModel && deps.providerModel !== currentDeps.providerModel) reasons.push(`vision provider/model changed (${deps.providerModel} → ${currentDeps.providerModel})`);
    if (reasons.length > 0) {
      await db.creativeAnalysisArtifact.update({ where: { id: row.id }, data: { status: "STALE", staleReason: reasons.join("; ") } });
      n += 1;
    }
  }
  return n;
}

async function findReusableVisualArtifact(userId: string, projectId: string, kind: string, depsHashValue: string) {
  return db.creativeAnalysisArtifact.findFirst({ where: { userId, projectId, kind, depsHash: depsHashValue, status: "COMPLETED" }, orderBy: { updatedAt: "desc" } });
}

async function recordVisualArtifact(userId: string, projectId: string, kind: string, sourceAssetId: string | null, deps: VisualDeps, resultJson: string | null, missingEvidence: string[], opts: { provider?: string | null; model?: string | null; consentVisual?: boolean; error?: string | null }) {
  const hash = depsHashOf(deps as unknown as Record<string, unknown>);
  const data = {
    status: "COMPLETED" as const,
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
  return db.creativeAnalysisArtifact.create({ data: { userId, projectId, kind, sourceAssetId: sourceAssetId ?? undefined, ...data } });
}

async function persistFindings(reviewId: string, findings: Finding[], startIndex: number): Promise<number> {
  let n = 0;
  for (const f of findings) {
    n += 1;
    await db.creativeFinding.create({
      data: {
        reviewId,
        findingNo: startIndex + n,
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
  return n;
}

export function validateVisualSettings(input: unknown): VisualSettings {
  const parsed = VisualSettingsSchema.safeParse(input ?? {});
  if (!parsed.success) throw new PermanentJobError(`Visual settings invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const raw = parsed.data;
  // Clamp into the documented ranges (settings NEVER widen the caps).
  return {
    sampleIntervalSec: Math.min(30, Math.max(1, raw.sampleIntervalSec)),
    maxFramesPerAsset: Math.min(48, Math.max(3, Math.round(raw.maxFramesPerAsset))),
    maxFrameWidth: Math.min(1024, Math.max(160, Math.round(raw.maxFrameWidth))),
    duplicateHashDistance: Math.min(20, Math.max(0, Math.round(raw.duplicateHashDistance))),
    repeatShotHashDistance: Math.min(30, Math.max(0, Math.round(raw.repeatShotHashDistance))),
    visionBatchSize: Math.min(4, Math.max(1, Math.round(raw.visionBatchSize))),
  };
}

/** VISUAL_INTELLIGENCE — the visual indexing + matching pipeline (§10). */
export async function runVisualIntelligenceJob(job: HandlerJob): Promise<void> {
  const params = JSON.parse(job.paramsJson ?? "{}") as { reviewId?: string; settings?: unknown; consentVisual?: boolean };
  if (!params.reviewId) throw new PermanentJobError("VISUAL_INTELLIGENCE missing reviewId");
  const review = await assertOwnedReview(job.userId, params.reviewId);
  if (review.status === "COMPLETED") return; // idempotent recovery

  const settings = validateVisualSettings(params.settings);
  const consentVisual = Boolean(params.consentVisual);
  const providerModel = consentVisual ? `${process.env.BEANFX_VISUAL_PROVIDER ?? "zai"}/${process.env.BEANFX_VISUAL_MODEL ?? "glm-4.5v"}` : "no-consent";
  const settingsHash = depsHashOf({ ...settings, settingsVersion: VISUAL_SETTINGS_VERSION });
  const runKey = `j_${job.id}`;
  const frameDir = visualFrameDir(runKey);

  await db.creativeReview.update({ where: { id: review.id }, data: { status: "RUNNING", stage: "Invalidating stale visual artifacts", progress: 3, error: null } });

  try {
    const head = await getTimelineHead(review.projectId, job.userId);
    const seq = head.sequence;
    const fps = Math.round((seq.fps.num / seq.fps.den) * 1000) / 1000;
    const contextVersion = contextVersionOf(head.version, seq.clips.length, seq.clips.reduce((m, c) => Math.max(m, c.timelineStartFrame + c.timelineDurationFrames), 0));
    if (contextVersion !== review.contextVersion) {
      await db.creativeReview.update({ where: { id: review.id }, data: { status: "FAILED", stage: "Stale", error: `Timeline changed since enqueue (created for ${review.contextVersion}, now ${contextVersion}).` } });
      return;
    }

    const missingEvidence: string[] = [];
    const evidenceSources: { engine: string; detail: string }[] = [];

    // ── phase 1: resolve primary video asset ──
    const videoTrackIds = new Set(seq.tracks.filter((t) => t.kind === "VIDEO").map((t) => t.id));
    const videoClips = seq.clips.filter((c) => videoTrackIds.has(c.trackId) && c.sourceAssetId);
    if (videoClips.length === 0) {
      await db.creativeReview.update({
        where: { id: review.id },
        data: { status: "FAILED", stage: "No video", error: "No VIDEO-track clips on the timeline — visual intelligence has no footage to analyze (recorded honestly)." },
      });
      await jobManager.complete(job.id, null, "No VIDEO-track clips — nothing to index (honest failure).");
      return;
    }
    const totals = new Map<string, number>();
    for (const c of videoClips) totals.set(c.sourceAssetId, (totals.get(c.sourceAssetId) ?? 0) + c.timelineDurationFrames);
    const primaryAssetId = [...totals.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const asset = await db.mediaAsset.findFirst({ where: { id: primaryAssetId, userId: job.userId } });
    if (!asset?.storagePath) throw new PermanentJobError("Primary video asset missing or not owned.");
    const skippedAssets = [...totals.keys()].filter((id) => id !== primaryAssetId);
    const fingerprint = assetFingerprint(asset);
    const deps: VisualDeps = { assetFingerprint: fingerprint, contextVersion, settingsHash, providerModel, analysisVersion: "m12-visual-index-1.0" };

    const invalidated = await invalidateStaleVisualArtifacts(job.userId, review.projectId, deps);
    if (invalidated > 0) missingEvidence.push(`${invalidated} prior visual artifact(s) marked STALE with reasons — affected stages recomputed, unaffected reused.`);
    if (skippedAssets.length > 0) missingEvidence.push(`${skippedAssets.length} secondary video asset(s) not indexed this run (one primary asset per run — re-run to index others; recorded honestly).`);

    // ── phase 2: whole-run dedup (identical deps ⇒ reuse stored index) ──
    const indexHash = depsHashOf({ kind: "visual-index", ...deps });
    const reusable = await findReusableVisualArtifact(job.userId, review.projectId, "visual-index", indexHash);
    let index: VisualIndex | null = null;
    let scene: SceneAnalysisResult | null = null;
    if (reusable?.resultJson) {
      index = JSON.parse(reusable.resultJson) as VisualIndex;
      evidenceSources.push({ engine: "JAZMII", detail: `visual index REUSED (artifact ${reusable.id}) — no re-extraction, no provider calls` });
      const sceneRow = await db.creativeAnalysisArtifact.findFirst({ where: { userId: job.userId, projectId: review.projectId, kind: "scene", sourceAssetId: asset.id, status: "COMPLETED" }, orderBy: { updatedAt: "desc" } });
      scene = sceneRow?.resultJson ? (JSON.parse(sceneRow.resultJson) as SceneAnalysisResult) : null;
      await jobManager.setProgress(job.id, 55, "Visual index reused (identical dependencies)");
    } else {
      // ── phase 3: deterministic local scene analysis (cuts/black/freeze) ──
      await jobManager.setProgress(job.id, 12, "Local scene analysis (deterministic ffmpeg)");
      const sceneDeps: VisualDeps = { kind: "scene", assetFingerprint: fingerprint, contextVersion, settingsHash, analysisVersion: "m11-scene-1.0" };
      const sceneHash = depsHashOf(sceneDeps as unknown as Record<string, unknown>);
      const reusableScene = await findReusableVisualArtifact(job.userId, review.projectId, "scene", sceneHash);
      if (reusableScene?.resultJson) {
        scene = JSON.parse(reusableScene.resultJson) as SceneAnalysisResult;
        evidenceSources.push({ engine: "JAZMII", detail: `local scene analysis REUSED (artifact ${reusableScene.id})` });
      } else {
        scene = await runLocalSceneAnalysis(asset.storagePath, asset.id, null);
        await recordVisualArtifact(job.userId, review.projectId, "scene", asset.id, sceneDeps, JSON.stringify(scene), [], { provider: "ffmpeg-local", model: "scene-heuristic" });
        evidenceSources.push({ engine: "JAZMII", detail: "local scene analysis (deterministic ffmpeg, no upload)" });
      }

      if (await jobInterrupted(job.id)) {
        await db.creativeReview.updateMany({ where: { id: review.id, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "CANCELLED", stage: "Cancelled" } });
        return;
      }

      // ── phase 4: frame extraction (temp, dedup'd, budgeted) ──
      await jobManager.setProgress(job.id, 25, `Extracting frames (≤${settings.maxFramesPerAsset}, ≤${settings.maxFrameWidth}px)`);
      const clipCtx = videoClips
        .filter((c) => c.sourceAssetId === asset.id)
        .map((c) => ({ clipId: c.id, sourceInFrame: c.sourceInFrame, sourceOutFrame: c.sourceOutFrame, sourceFpsNum: c.sourceFps.num, sourceFpsDen: c.sourceFps.den, playbackSpeed: c.playbackSpeed, timelineStartFrame: c.timelineStartFrame }));
      const { frames, files, framesDeduped } = await extractFrames({ id: asset.id, storagePath: asset.storagePath, width: asset.width, height: asset.height, durationSec: asset.durationSec }, settings, { seqFps: fps, clips: clipCtx }, scene?.sceneChangesSec ?? [], runKey);
      await setFrameHeights(frames, files);

      // ── phase 5: semantic analysis — consent-gated ──
      let providerId: string | null = null;
      let modelId: string | null = null;
      if (consentVisual) {
        await jobManager.setProgress(job.id, 40, `Semantic frame analysis (${frames.filter((f) => f.status === "extracted").length} frame(s) sent to the vision provider with consent)`);
        const vision = await analyzeFramesSemantic(frames, files, settings, {
          signal: undefined,
          onUsage: (r) => {
            void recordUsage(job.userId, { provider: r.provider, model: r.model, usage: r.usage, latencyMs: 0, content: "" }, "visual-frame-analysis").catch(() => undefined);
          },
        });
        providerId = vision.providerId;
        modelId = vision.model;
        evidenceSources.push({ engine: "MYAI", detail: `semantic frame analysis via ${providerId}/${modelId}: ${vision.analyzedCount} analyzed, ${vision.failedCount} failed` });
        for (const e of vision.errors.slice(0, 3)) missingEvidence.push(`vision batch failed honestly: ${e}`);
      } else {
        // Frames STAY "extracted" without consent: deterministic indexing
        // (dedup, scene grouping, representative registration) still runs on
        // the local files; only semantic analysis is skipped (honest note).
        missingEvidence.push("Semantic frame analysis SKIPPED: external frame transmission requires explicit consent (deterministic indexing only).");
        evidenceSources.push({ engine: "MYAI", detail: "no consent — frames stayed local; no semantic descriptions" });
      }

      // ── phase 6: scene index + representative registration ──
      await jobManager.setProgress(job.id, 60, "Building scene index");
      const scenes = buildScenes(frames, asset.id, asset.durationSec ?? 0, scene?.sceneChangesSec ?? [], settings, { seqFps: fps, clips: clipCtx });
      const registered = await registerRepresentativeFrames(scenes, frames, files, { userId: job.userId, projectId: review.projectId, assetId: asset.id, assetName: asset.originalName, analysisVersion: "m12-visual-index-1.0", seqFps: fps });
      evidenceSources.push({ engine: "JAZMII", detail: `${registered.size} representative frame(s) registered as IMAGE assets` });
      index = assembleIndex({
        assetId: asset.id,
        assetName: asset.originalName,
        durationSec: asset.durationSec,
        width: asset.width,
        height: asset.height,
        fps: asset.fps,
        settings,
        frames,
        scenes,
        consentVisual,
        notes: [framesDeduped > 0 ? `${framesDeduped} near-duplicate frame(s) skipped (aHash ≤ ${settings.duplicateHashDistance}).` : "", consentVisual ? "" : "Heuristic-only index — no semantic descriptions without consent."].filter((s) => s.length > 0),
      });
      await recordVisualArtifact(job.userId, review.projectId, "visual-index", asset.id, { kind: "visual-index", ...deps }, JSON.stringify(index), missingEvidence, { provider: providerId, model: modelId, consentVisual });
      await jobManager.setProgress(job.id, 70, `${index.scenes.length} scene(s) indexed`);
    }

    if (await jobInterrupted(job.id)) {
      await db.creativeReview.updateMany({ where: { id: review.id, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "CANCELLED", stage: "Cancelled" } });
      return;
    }

    // ── phase 7: narration matching (approved transcript × scenes) ──
    const ctx = await buildMeasuredContext(job.userId, review.projectId, { enqueueEvidence: false });
    let matchNotes: string[] = [];
    let matchProvider: string | null = null;
    let matchModel: string | null = null;
    let matchesJson: string | null = null;
    if (index) {
      const matchDeps: VisualDeps = { ...deps, analysisVersion: "m12-visual-match-1.0" };
      const matchHash = depsHashOf({ kind: "visual-match", ...matchDeps });
      const reusableMatch = await findReusableVisualArtifact(job.userId, review.projectId, "visual-match", matchHash);
      if (reusableMatch?.resultJson) {
        matchesJson = reusableMatch.resultJson;
        evidenceSources.push({ engine: "MYAI", detail: "narration matching REUSED (artifact)" });
        matchNotes = JSON.parse(reusableMatch.missingEvidenceJson ?? "[]") as string[];
      } else {
        await jobManager.setProgress(job.id, 80, "Narration-to-visual matching");
        const match = await matchNarrationToVisuals(job.userId, review.projectId, ctx, index, {
          consentVisual,
          signal: undefined,
          onUsage: (r) => {
            void recordUsage(job.userId, { provider: r.provider, model: r.model, usage: r.usage, latencyMs: 0, content: "" }, "visual-narration-match").catch(() => undefined);
          },
        });
        matchNotes = match.notes;
        matchProvider = match.provider;
        matchModel = match.model;
        matchesJson = JSON.stringify({ matches: match.matches, notes: match.notes, transcriptVersionId: match.transcriptVersionId, transcriptVersionNo: match.transcriptVersionNo });
        await recordVisualArtifact(job.userId, review.projectId, "visual-match", asset.id, { kind: "visual-match", ...matchDeps }, matchesJson, match.notes, { provider: match.provider, model: match.model, consentVisual });
      }
      missingEvidence.push(...matchNotes.slice(0, 4));
    }

    // ── phase 8: continuity findings + b-roll recommendations ──
    await jobManager.setProgress(job.id, 88, "Continuity analysis + recommendations");
    const continuity = analyzeVisualContinuity({
      index,
      sceneChangesSec: scene?.sceneChangesSec ?? [],
      staticSectionsSec: scene?.staticSectionsSec ?? [],
      blackSectionsSec: scene?.blackSectionsSec ?? [],
      videoPlacements: ctx.videoTimelineSpans.map((v) => ({ ...v, width: null, height: null })),
    });
    await persistFindings(review.id, continuity.findings, 0);
    missingEvidence.push(...continuity.notes.slice(0, 2));

    const recs: Recommendation[] = continuity.findings.filter((f) => f.category === "visual-repetition" && f.suggestion).map((f) => ({
      recNo: 0,
      kind: "informational" as const,
      engine: "MYAI" as const,
      title: "Repeated shots detected — review the Scene Browser",
      detail: f.explanation.slice(0, 1100),
      target: { clipId: null, trackId: null, startSec: f.startSec, endSec: f.endSec },
      payload: { kind: "informational" as const, note: f.explanation.slice(0, 900) },
      preview: null,
      requiresApproval: false,
      rationale: "Deterministic aHash similarity on analyzed frames.",
    }));
    if (index) {
      const videoTrackId = [...videoTrackIds][0] ?? null;
      const matchData = matchesJson ? (JSON.parse(matchesJson) as { matches: Parameters<typeof buildBrollRecommendations>[2] }) : { matches: [] };
      const broll = await buildBrollRecommendations(job.userId, review.projectId, matchData.matches, index, { fps, videoTrackId, placedAssetIds: new Set(videoClips.map((c) => c.sourceAssetId)) });
      recs.push(...broll.recommendations);
      missingEvidence.push(...broll.notes.slice(0, 3));
    }
    recs.forEach((r, i) => (r.recNo = i + 1));
    await db.creativeRecommendation.deleteMany({ where: { reviewId: review.id, status: "PROPOSED" } });
    await persistRecommendations(job.userId, review.projectId, review.id, review.headVersion, recs);

    const continuityDeps: VisualDeps = { kind: "visual-continuity", ...deps, analysisVersion: "m12-visual-continuity-1.0" };
    await recordVisualArtifact(job.userId, review.projectId, "visual-continuity", asset.id, continuityDeps, JSON.stringify({ findings: continuity.findings }), continuity.notes, { consentVisual });

    await db.creativeReview.update({
      where: { id: review.id },
      data: {
        status: "COMPLETED",
        progress: 100,
        stage: "Completed",
        missingEvidenceJson: JSON.stringify({ items: missingEvidence, retentionDisclaimer: null }),
        evidenceSourcesJson: JSON.stringify(evidenceSources),
        provider: matchProvider,
        model: matchModel,
      },
    });
    await jobManager.complete(job.id, null, `Visual intelligence complete: ${index?.scenes.length ?? 0} scene(s), ${index?.measurement.framesAnalyzed ?? 0} analyzed frame(s), ${continuity.findings.length} finding(s), ${recs.length} recommendation(s).`);
  } finally {
    await cleanupVisualFrameDir(frameDir);
  }
}

/** Enqueue a visual-intelligence run (review scope "visual" + durable job). */
export async function enqueueVisualIntelligence(userId: string, projectId: string, settings: unknown, consentVisual: boolean): Promise<{ reviewId: string; jobId: string; estimatedVisionCalls: string }> {
  const parsed = VisualSettingsSchema.safeParse(settings ?? {});
  if (!parsed.success) throw new PermanentJobError(`Visual settings invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const head = await getTimelineHead(projectId, userId);
  const seq = head.sequence;
  const contextVersion = contextVersionOf(head.version, seq.clips.length, seq.clips.reduce((m, c) => Math.max(m, c.timelineStartFrame + c.timelineDurationFrames), 0));
  const review = await db.creativeReview.create({ data: { userId, projectId, scope: "visual", language: "en", status: "QUEUED", stage: "Queued", contextVersion, headVersion: head.version } });
  const jobId = await jobManager.createJob(userId, "VISUAL_INTELLIGENCE", { reviewId: review.id, settings: parsed.data, consentVisual });
  await db.creativeReview.update({ where: { id: review.id }, data: { jobId } });
  const estFrames = parsed.data.maxFramesPerAsset;
  const estCalls = Math.ceil(estFrames / parsed.data.visionBatchSize);
  return {
    reviewId: review.id,
    jobId,
    estimatedVisionCalls: consentVisual ? `≈${estCalls} vision request(s) for ≤${estFrames} frame(s) at ≤${parsed.data.maxFrameWidth}px (token usage recorded; no $ estimate — no verified pricing)` : "0 — no consent, frames stay local",
  };
}
