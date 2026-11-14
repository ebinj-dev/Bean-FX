/**
 * M13 — Temporal intelligence jobs (§9/§11) on the EXISTING M3 worker.
 *
 * TEMPORAL_INTELLIGENCE phases:
 *   1. stale invalidation (fingerprints: asset mtime, timeline version,
 *      settings hash, tracking model) + whole-run dedup (identical deps ⇒
 *      the stored temporal index is REUSED — no re-sampling, no re-tracking);
 *   2. M12 reuse: deterministic scene cuts (M11 artifact) + M12 scene
 *      summaries for search context (unaffected results reused where safe);
 *   3. temporal sampling (consecutive windows, exact pts);
 *   4. REAL tracking (local OpenCV CSRT — nothing uploaded, no consent
 *      required) + camera-motion classification + motion measurements;
 *   5. OPTIONAL provider subject-category labeling (consent-gated: tracked
 *      CROPS leave the server only then; usage recorded per call);
 *   6. temporal events (tracks × motion × camera × M12 scenes × M11 speech);
 *   7. motion-graphics proposals (top tracks) as executable M1 AddGraphic
 *      recommendations + a temporal-mograph artifact for the UI;
 *   8. artifact persistence (temporal-index) + cleanup in `finally`.
 */
import { db } from "@/lib/db";
import { jobManager } from "@/lib/job-runner";
import { PermanentJobError } from "@/lib/job-helpers";
import { buildMeasuredContext } from "../../context";
import { persistRecommendations } from "../../recommendations";
import { contextVersionOf, type Recommendation } from "../../contracts";
import { getTimelineHead } from "@/lib/editor/persistence";
import { runLocalSceneAnalysis, type SceneAnalysisResult } from "../../crossmodal";
import { assetFingerprint, depsHashOf } from "../../multimodal";
import { assertOwnedReview, jobInterrupted } from "../../jobs";
import { recordUsage } from "@/lib/my-ai/gateway/usage";
import { mapSilenceToTimeline } from "../../embedded-audio";
import { visionProvider } from "@/lib/my-ai/gateway/vision";
import { VisionTrackLabelSchema, type CameraMotion, type MographProposal, type Track } from "./contracts";
import { extractJson } from "@/lib/my-ai/gateway/structured";
import { extractTemporalFrames, planWindows, type TemporalWindow } from "./sampling";
import { buildTracks, runTrackingWorker, type RawCameraPair } from "./tracking";
import { classifyCameraMotion, measureTrackMotion } from "./motion";
import { buildTemporalEvents } from "./events";
import { buildMographProposal } from "./mograph";
import { TEMPORAL_INDEX_VERSION, TEMPORAL_SETTINGS_VERSION, TemporalSettingsSchema, type TemporalIndex, type TemporalSettings } from "./contracts";
import type { VisualIndex as M12VisualIndex } from "../contracts";
import { cleanupVisualFrameDir, visualFrameDir } from "../frames";

interface HandlerJob {
  id: string;
  userId: string;
  attempts: number;
  maxAttempts: number;
  paramsJson: string | null;
}

interface TemporalDeps {
  kind?: string;
  assetFingerprint?: string;
  contextVersion: string;
  settingsHash: string;
  trackingModel: string;
  analysisVersion: string;
}

function clampSettings(input: unknown): TemporalSettings {
  const parsed = TemporalSettingsSchema.safeParse(input ?? {});
  if (!parsed.success) throw new PermanentJobError(`Temporal settings invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const r = parsed.data;
  return {
    sampleFps: Math.min(15, Math.max(1, r.sampleFps)),
    maxFrames: Math.min(300, Math.max(6, Math.round(r.maxFrames))),
    windowSec: Math.min(30, Math.max(2, r.windowSec)),
    minBoxAreaFrac: Math.min(0.5, Math.max(0.0001, r.minBoxAreaFrac)),
    maxTracks: Math.min(10, Math.max(1, Math.round(r.maxTracks))),
    cameraMotion: r.cameraMotion,
    providerLabels: r.providerLabels,
  };
}

async function invalidateStaleTemporalArtifacts(userId: string, projectId: string, deps: TemporalDeps): Promise<number> {
  const rows = await db.creativeAnalysisArtifact.findMany({ where: { userId, projectId, kind: { in: ["temporal-index", "temporal-mograph"] }, status: { in: ["COMPLETED", "RUNNING", "QUEUED"] } } });
  let n = 0;
  for (const row of rows) {
    let old: Partial<TemporalDeps> = {};
    try {
      old = JSON.parse(row.depsJson) as Partial<TemporalDeps>;
    } catch {
      continue;
    }
    const reasons: string[] = [];
    if (old.contextVersion && old.contextVersion !== deps.contextVersion) reasons.push(`timeline changed (${old.contextVersion} → ${deps.contextVersion})`);
    if (old.assetFingerprint && deps.assetFingerprint && old.assetFingerprint !== deps.assetFingerprint) reasons.push("source media changed (size/mtime)");
    if (old.settingsHash && old.settingsHash !== deps.settingsHash) reasons.push("temporal sampling settings changed");
    if (old.trackingModel && old.trackingModel !== deps.trackingModel) reasons.push(`tracking model changed (${old.trackingModel} → ${deps.trackingModel})`);
    if (reasons.length > 0) {
      await db.creativeAnalysisArtifact.update({ where: { id: row.id }, data: { status: "STALE", staleReason: reasons.join("; ") } });
      n += 1;
    }
  }
  return n;
}

/** TEMPORAL_INTELLIGENCE — sampling → tracking → motion → events → proposals. */
export async function runTemporalIntelligenceJob(job: HandlerJob): Promise<void> {
  const params = JSON.parse(job.paramsJson ?? "{}") as { reviewId?: string; settings?: unknown; consentVisual?: boolean };
  if (!params.reviewId) throw new PermanentJobError("TEMPORAL_INTELLIGENCE missing reviewId");
  const review = await assertOwnedReview(job.userId, params.reviewId);
  if (review.status === "COMPLETED") return;

  const settings = clampSettings(params.settings);
  const consentVisual = Boolean(params.consentVisual);
  const trackingModel = "opencv-4.13.0-csrt";
  const settingsHash = depsHashOf({ ...settings, settingsVersion: TEMPORAL_SETTINGS_VERSION });
  const runKey = `tj_${job.id}`;
  const frameDir = visualFrameDir(runKey);
  const missingEvidence: string[] = [];
  const evidenceSources: { engine: string; detail: string }[] = [];

  await db.creativeReview.update({ where: { id: review.id }, data: { status: "RUNNING", stage: "Preparing temporal analysis", progress: 3, error: null } });

  try {
    const head = await getTimelineHead(review.projectId, job.userId);
    const seq = head.sequence;
    const fps = Math.round((seq.fps.num / seq.fps.den) * 1000) / 1000;
    const contextVersion = contextVersionOf(head.version, seq.clips.length, seq.clips.reduce((m, c) => Math.max(m, c.timelineStartFrame + c.timelineDurationFrames), 0));
    if (contextVersion !== review.contextVersion) {
      await db.creativeReview.update({ where: { id: review.id }, data: { status: "FAILED", stage: "Stale", error: `Timeline changed since enqueue (${review.contextVersion} → ${contextVersion}).` } });
      return;
    }

    const videoTrackIds = new Set(seq.tracks.filter((t) => t.kind === "VIDEO").map((t) => t.id));
    const videoClips = seq.clips.filter((c) => videoTrackIds.has(c.trackId) && c.sourceAssetId);
    if (videoClips.length === 0) {
      await db.creativeReview.update({ where: { id: review.id }, data: { status: "FAILED", stage: "No video", error: "No VIDEO-track clips on the timeline — temporal intelligence has no footage to analyze (recorded honestly)." } });
      await jobManager.complete(job.id, null, "No VIDEO-track clips — nothing to track (honest failure).");
      return;
    }
    const totals = new Map<string, number>();
    for (const c of videoClips) totals.set(c.sourceAssetId, (totals.get(c.sourceAssetId) ?? 0) + c.timelineDurationFrames);
    const primaryAssetId = [...totals.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const asset = await db.mediaAsset.findFirst({ where: { id: primaryAssetId, userId: job.userId } });
    if (!asset?.storagePath) throw new PermanentJobError("Primary video asset missing or not owned.");
    if ([...totals.keys()].length > 1) missingEvidence.push("Secondary video asset(s) not tracked this run (one primary asset per run — re-run to track others).");

    const clipCtx = videoClips
      .filter((c) => c.sourceAssetId === asset.id)
      .map((c) => ({ clipId: c.id, sourceInFrame: c.sourceInFrame, sourceOutFrame: c.sourceOutFrame, sourceFpsNum: c.sourceFps.num, sourceFpsDen: c.sourceFps.den, playbackSpeed: c.playbackSpeed, timelineStartFrame: c.timelineStartFrame }));
    const deps: TemporalDeps = { kind: "temporal-index", assetFingerprint: assetFingerprint(asset), contextVersion, settingsHash, trackingModel, analysisVersion: TEMPORAL_INDEX_VERSION };

    const invalidated = await invalidateStaleTemporalArtifacts(job.userId, review.projectId, deps);
    if (invalidated > 0) missingEvidence.push(`${invalidated} prior temporal artifact(s) marked STALE with reasons.`);

    // ── whole-run dedup ──
    const depsHash = depsHashOf(deps as unknown as Record<string, unknown>);
    const reusable = await db.creativeAnalysisArtifact.findFirst({ where: { userId: job.userId, projectId: review.projectId, kind: "temporal-index", depsHash, status: "COMPLETED" }, orderBy: { updatedAt: "desc" } });
    let index: TemporalIndex | null = null;
    let scene: SceneAnalysisResult | null = null;
    let windows: TemporalWindow[] = [];
    let frameFiles: Map<string, string> = new Map();

    if (reusable?.resultJson) {
      index = JSON.parse(reusable.resultJson) as TemporalIndex;
      evidenceSources.push({ engine: "JAZMII", detail: `temporal index REUSED (artifact ${reusable.id}) — no re-sampling, no re-tracking` });
      const sceneRow = await db.creativeAnalysisArtifact.findFirst({ where: { userId: job.userId, projectId: review.projectId, kind: "scene", sourceAssetId: asset.id, status: "COMPLETED" }, orderBy: { updatedAt: "desc" } });
      scene = sceneRow?.resultJson ? (JSON.parse(sceneRow.resultJson) as SceneAnalysisResult) : null;
      await jobManager.setProgress(job.id, 60, "Temporal index reused (identical dependencies)");
    } else {
      // ── scene cuts (M12/M11 deterministic artifact) ──
      const sceneDeps = { kind: "scene", assetFingerprint: deps.assetFingerprint, contextVersion, settingsHash, trackingModel, analysisVersion: "m11-scene-1.0" };
      const sceneHash = depsHashOf(sceneDeps);
      const reusableScene = await db.creativeAnalysisArtifact.findFirst({ where: { userId: job.userId, projectId: review.projectId, kind: "scene", depsHash: sceneHash, status: "COMPLETED" }, orderBy: { updatedAt: "desc" } });
      if (reusableScene?.resultJson) {
        scene = JSON.parse(reusableScene.resultJson) as SceneAnalysisResult;
        evidenceSources.push({ engine: "JAZMII", detail: "scene analysis REUSED (artifact)" });
      } else {
        scene = await runLocalSceneAnalysis(asset.storagePath, asset.id, null);
        const hash = depsHashOf(sceneDeps);
        await recordArtifact(job.userId, review.projectId, "scene", asset.id, { ...sceneDeps, kind: "scene" }, JSON.stringify(scene), [], { provider: "ffmpeg-local", model: "scene-heuristic" }, hash);
        evidenceSources.push({ engine: "JAZMII", detail: "scene analysis (deterministic ffmpeg, no upload)" });
      }
      const sceneCuts = scene?.sceneChangesSec ?? [];

      if (await jobInterrupted(job.id)) {
        await db.creativeReview.updateMany({ where: { id: review.id, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "CANCELLED", stage: "Cancelled" } });
        return;
      }

      // ── temporal sampling ──
      await jobManager.setProgress(job.id, 15, `Temporal sampling (${settings.sampleFps} fps, windows ≤${settings.windowSec}s)`);
      windows = planWindows(asset.durationSec ?? 0, settings, sceneCuts);
      const sampled = await extractTemporalFrames({ id: asset.id, storagePath: asset.storagePath, width: asset.width, height: asset.height, durationSec: asset.durationSec }, settings, { seqFps: fps, clips: clipCtx }, windows, runKey);
      frameFiles = sampled.files;
      const usableFrames = sampled.frames.filter((f) => f.height > 0);
      if (usableFrames.length < 2) {
        await db.creativeReview.update({ where: { id: review.id }, data: { status: "FAILED", stage: "Sampling failed", error: "Fewer than 2 frames could be sampled from the source (corrupt or unseekable media) — no temporal analysis without real frames." } });
        await jobManager.complete(job.id, null, "Sampling produced no usable frames (honest failure).");
        return;
      }
      evidenceSources.push({ engine: "JAZMII", detail: `${usableFrames.length} consecutive frames sampled across ${windows.length} window(s) at ${settings.sampleFps} fps` });

      // ── REAL tracking per window (local; no upload) ──
      await jobManager.setProgress(job.id, 35, "Object tracking (OpenCV CSRT, consecutive frames)");
      const tracks: Track[] = [];
      const camera: CameraMotion[] = [];
      const rawCameraPairs: RawCameraPair[] = [];
      for (const w of windows) {
        const wFrames = usableFrames
          .filter((f) => f.windowIndex === w.index)
          .map((f) => ({ file: frameFiles.get(f.frameId)!, t: f.sourceSec }))
          .filter((f) => Boolean(f.file));
        if (wFrames.length < 2) continue;
        let raw;
        try {
          raw = await runTrackingWorker(wFrames, settings);
        } catch (err) {
          missingEvidence.push(`Tracking worker failed for window ${w.index}: ${(err as Error).message.slice(0, 180)}`);
          continue;
        }
        rawCameraPairs.push(...raw.camera);
        tracks.push(...buildTracks(asset.id, w.index, raw, { seqFps: fps, clips: clipCtx }, null));
        if (settings.cameraMotion) camera.push(classifyCameraMotion(asset.id, w.index, raw.camera, { width: raw.width, height: raw.height, sampleIntervalSec: 1 / settings.sampleFps, sceneCuts }, raw.windowScale ?? null, raw.windowScaleNcc ?? null));
      }
      evidenceSources.push({ engine: "JAZMII", detail: `${tracks.length} track(s) from real CSRT multi-frame tracking; ${camera.length} window(s) camera-classified` });
      if (tracks.length === 0) missingEvidence.push("No trackable moving subjects were detected (detection requires initial motion in the sampled windows) — temporal search will answer with honest insufficient evidence.");

      // ── motion measurements (foreground = track motion − registered global) ──
      const motion = tracks.map((t) =>
        measureTrackMotion(t, rawCameraPairs, {
          width: usableFrames[0]?.width ?? asset.width,
          height: usableFrames[0]?.height ?? asset.height,
          sampleIntervalSec: 1 / settings.sampleFps,
          sceneCuts,
        }),
      );

      // ── consent-gated provider subject labeling ──
      let providerLabels = 0;
      if (consentVisual && settings.providerLabels && tracks.length > 0) {
        try {
          await jobManager.setProgress(job.id, 62, "Provider subject labeling (consented crops)");
          const provider = visionProvider();
          const images: { mimeType: "image/jpeg"; base64: string }[] = [];
          const labeledTracks = tracks.slice(0, 4);
          const { readFile } = await import("fs/promises");
          for (const t of labeledTracks) {
            const s = t.samples[Math.floor(t.samples.length / 2)];
            // Look up the crop by NEAREST sampled frame (the track sample's
            // synthetic frameId is not the extraction map's key space).
            const nearest = usableFrames.reduce((best, f) => (Math.abs(f.sourceSec - s.sourceSec) < Math.abs(best.sourceSec - s.sourceSec) ? f : best));
            const file = frameFiles.get(nearest.frameId);
            if (!file) continue;
            images.push({ mimeType: "image/jpeg", base64: (await readFile(file)).toString("base64") });
          }
          if (images.length > 0) {
            const listing = labeledTracks.map((t, i) => `IMAGE ${i + 1} = track ${t.trackId}`).join("; ");
            const res = await provider.analyze(
              `These are tracked subject crops from video. For EACH image return ONE category from: person, vehicle, animal, object, other. Respond ONLY as JSON: {"labels":[{"trackId":"...","category":"...","confidence":0.0}]}`,
              images,
              { timeoutMs: 120_000, purpose: "temporal-track-label", instruction: listing },
            );
            void recordUsage(job.userId, { provider: provider.id, model: res.model, usage: res.usage, latencyMs: res.latencyMs, content: "" }, "temporal-track-label").catch(() => undefined);
            const parsed = VisionTrackLabelSchema.parse(extractJson(res.content));
            for (const l of parsed.labels) {
              const t = tracks.find((tt) => tt.trackId === l.trackId);
              if (t) {
                t.category = l.category;
                t.categoryProvenance = "provider";
                t.provider = provider.id;
                t.model2 = provider.model;
                providerLabels += 1;
              }
            }
            evidenceSources.push({ engine: "MYAI", detail: `provider labeled ${providerLabels} track(s) from ${images.length} consented crop(s) (${provider.id}/${provider.model})` });
          }
        } catch (err) {
          missingEvidence.push(`Provider subject labeling failed honestly (tracks keep detector-generic categories): ${(err as Error).message.slice(0, 180)}`);
        }
      } else if (settings.providerLabels && !consentVisual && tracks.length > 0) {
        missingEvidence.push("Subject-category labeling SKIPPED: sending tracked crops to the provider requires explicit consent (tracks stay detector-generic).");
      }

      // ── speech spans (M11) for speech-over-motion events ──
      const ctx = await buildMeasuredContext(job.userId, review.projectId, { enqueueEvidence: false });
      let speechSpans: { start: number; end: number }[] = [];
      const audioAssetId = ctx.audio?.sourceAssetId ?? null;
      if (ctx.transcript?.available && ctx.transcript.segments.length > 0 && audioAssetId) {
        try {
          speechSpans = (await mapSilenceToTimeline(job.userId, review.projectId, audioAssetId, ctx.transcript.segments.slice(0, 30).map((s) => ({ start: s.start, end: s.end })), fps)).map((s) => ({ start: s.start, end: s.end }));
        } catch (err) {
          missingEvidence.push(`Speech→timeline mapping failed: ${(err as Error).message.slice(0, 160)}`);
        }
      }

      // ── events ──
      const events = buildTemporalEvents({
        assetId: asset.id,
        frames: usableFrames,
        tracks,
        motion,
        camera,
        sceneCuts,
        sceneIdOfIndex: (i) => `${asset.id}:s${i}`,
        speechSpans,
      });

      // ── M12 scene summaries reuse ──
      const m12 = await db.creativeAnalysisArtifact.findFirst({ where: { userId: job.userId, projectId: review.projectId, kind: "visual-index", status: "COMPLETED" }, orderBy: { updatedAt: "desc" } });
      const sceneSummaries = m12?.resultJson
        ? (JSON.parse(m12.resultJson) as M12VisualIndex).scenes.map((s) => ({ sceneId: s.sceneId, sourceStartSec: s.sourceStartSec, sourceEndSec: s.sourceEndSec, timelineStartSec: s.timelinePlacements[0]?.timelineStartSec ?? null, description: s.description, representativeAssetId: s.representativeAssetId })).slice(0, 80)
        : [];
      if (!m12) missingEvidence.push("No M12 visual index — scene descriptions unavailable for temporal search context (run Visual Intelligence for that layer).");

      index = {
        analysisVersion: TEMPORAL_INDEX_VERSION,
        assetId: asset.id,
        assetName: asset.originalName.slice(0, 200),
        durationSec: asset.durationSec,
        width: usableFrames[0]?.width ?? asset.width,
        height: usableFrames[0]?.height ?? asset.height,
        sourceFps: asset.fps,
        settings,
        frames: usableFrames.slice(0, 400),
        tracks: tracks.slice(0, 40),
        motion,
        camera,
        sceneSummaries,
        events,
        measurement: {
          framesSampled: usableFrames.length,
          windows: windows.length,
          tracksTotal: tracks.length,
          tracksLost: tracks.filter((t) => t.terminationReason === "tracker-lost").length,
          cameraClassified: camera.length,
          providerLabelsUsed: providerLabels,
          consentVisual,
        },
        notes: [
          "Tracking = OpenCV CSRT across consecutive sampled frames (real correspondence, not per-frame descriptions).",
          "Detection requires initial motion in a window; subjects static from frame 0 are not auto-detected.",
          "Pixel speeds are NOT real-world speeds (no calibrated scene geometry).",
        ].slice(0, 12),
      };
      await recordArtifact(job.userId, review.projectId, "temporal-index", asset.id, deps as unknown as Record<string, unknown>, JSON.stringify(index), missingEvidence, { provider: consentVisual && providerLabels > 0 ? "zai" : null, model: null, consentVisual }, depsHash);
      await jobManager.setProgress(job.id, 78, `${tracks.length} track(s), ${events.length} temporal event(s)`);
    }

    if (await jobInterrupted(job.id)) {
      await db.creativeReview.updateMany({ where: { id: review.id, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "CANCELLED", stage: "Cancelled" } });
      return;
    }

    // ── motion-graphics proposals (§8) + recommendations (§9) ──
    await jobManager.setProgress(job.id, 88, "Motion-graphics proposals + recommendations");
    const graphicTrack = seq.tracks.find((t) => t.kind === "GRAPHIC" && !t.locked);
    const recs: Recommendation[] = [];
    const topTracks = [...(index?.tracks ?? [])].sort((a, b) => (b.confidence ?? 0) * b.samples.length - (a.confidence ?? 0) * a.samples.length).slice(0, 3);
    const proposals: MographProposal[] = [];
    for (const t of topTracks) {
      const m = index?.motion.find((mm) => mm.trackId === t.trackId) ?? null;
      const built = await buildMographProposal(index!, t, m, {
        seqFps: fps,
        seqWidth: index?.width ?? null,
        seqHeight: index?.height ?? null,
        graphicTrackId: graphicTrack?.id ?? null,
        userId: job.userId,
        projectId: review.projectId,
        previewFrames: frameFiles,
        label: t.category === "person" ? "Person" : t.category ?? "Subject",
      });
      if (built.proposal) {
        proposals.push(built.proposal);
        recs.push({
          recNo: 0,
          kind: "executable",
          engine: "NIIKI",
          title: built.proposal.label,
          detail: `${built.note} ${built.proposal.warnings.join(" ")}`.slice(0, 1100),
          target: { clipId: null, trackId: graphicTrack?.id ?? "t-graphics-m13", startSec: (built.proposal.clipStartTimelineFrame / fps) || 0, endSec: ((built.proposal.clipStartTimelineFrame + built.proposal.durationFrames) / fps) || 0 },
          payload: built.proposal.payload,
          preview: { note: `${built.proposal.keyframes.length} keyframes; gaps: ${built.proposal.gaps.length}; previews: ${built.proposal.previewAssetIds.length}`, proposalId: built.proposal.proposalId },
          requiresApproval: true,
          rationale: `Validated track ${t.trackId} (${t.samples.length} samples, confidence ${t.confidence}). Applied via the M6 AddGraphic command through the approval flow.`,
        });
      } else {
        missingEvidence.push(built.note);
      }
    }
    await recordArtifact(job.userId, review.projectId, "temporal-mograph", asset.id, { kind: "temporal-mograph", assetFingerprint: deps.assetFingerprint, contextVersion, settingsHash, trackingModel, analysisVersion: "m13-mograph-1.0" }, JSON.stringify({ proposals }), [], { consentVisual }, depsHashOf({ kind: "temporal-mograph", assetFingerprint: deps.assetFingerprint, contextVersion, settingsHash, trackingModel, analysisVersion: "m13-mograph-1.0" }));

    // Deterministic §9 recommendations from temporal evidence.
    for (const cam of index?.camera ?? []) {
      if (cam.classification === "static" && (index?.events ?? []).some((e) => e.type === "static-span")) {
        recs.push({
          recNo: 0,
          kind: "informational",
          engine: "JAZMII",
          title: "Long static interval — consider trimming or coverage",
          detail: "The analyzed windows register a STATIC camera with no tracked foreground motion (measured). If this footage is meant to be dynamic, consider trimming the dead span or adding motion coverage; if it is an intentional hold, no change is needed.",
          target: { clipId: null, trackId: null, startSec: index?.frames[0]?.timelineSec ?? null, endSec: null },
          payload: { kind: "informational", note: "static interval" },
          preview: null,
          requiresApproval: false,
          rationale: "Deterministic static-span evidence.",
        });
        break;
      }
    }
    for (const e of index?.events ?? []) {
      if (e.type === "sudden-position-change" && e.timelineStartSec !== null) {
        recs.push({
          recNo: 0,
          kind: "informational",
          engine: "JAZMII",
          title: `Sudden subject position change at ${e.timelineStartSec.toFixed(1)}s`,
          detail: e.description,
          target: { clipId: null, trackId: null, startSec: e.timelineStartSec, endSec: e.timelineEndSec },
          payload: { kind: "informational", note: "sudden change" },
          preview: null,
          requiresApproval: false,
          rationale: "Measured foreground jump after camera compensation — review whether a cut lands awkwardly during subject movement.",
        });
        break;
      }
    }
    recs.forEach((r, i) => (r.recNo = i + 1));
    await db.creativeRecommendation.deleteMany({ where: { reviewId: review.id, status: "PROPOSED" } });
    await persistRecommendations(job.userId, review.projectId, review.id, review.headVersion, recs);

    await db.creativeReview.update({
      where: { id: review.id },
      data: {
        status: "COMPLETED",
        progress: 100,
        stage: "Completed",
        missingEvidenceJson: JSON.stringify({ items: missingEvidence.slice(0, 8), retentionDisclaimer: null }),
        evidenceSourcesJson: JSON.stringify(evidenceSources),
        provider: index?.measurement.providerLabelsUsed ? "zai" : null,
        model: null,
      },
    });
    await jobManager.complete(job.id, null, `Temporal intelligence complete: ${index?.measurement.framesSampled ?? 0} frame(s), ${index?.tracks.length ?? 0} track(s), ${index?.events.length ?? 0} event(s), ${proposals.length} motion-graphics proposal(s).`);
  } finally {
    await cleanupVisualFrameDir(frameDir);
  }
}

async function recordArtifact(userId: string, projectId: string, kind: string, sourceAssetId: string | null, deps: Record<string, unknown>, resultJson: string | null, missingEvidence: string[], opts: { provider?: string | null; model?: string | null; consentVisual?: boolean; error?: string | null }, depsHash: string) {
  const data = {
    status: "COMPLETED" as const,
    depsHash,
    depsJson: JSON.stringify(deps),
    resultJson,
    missingEvidenceJson: JSON.stringify(missingEvidence),
    provider: opts.provider ?? null,
    model: opts.model ?? null,
    consentVisual: Boolean(opts.consentVisual),
    error: opts.error ?? null,
  };
  const existing = await db.creativeAnalysisArtifact.findFirst({ where: { userId, projectId, kind, depsHash, status: { in: ["COMPLETED", "FAILED"] } } });
  if (existing) return db.creativeAnalysisArtifact.update({ where: { id: existing.id }, data });
  return db.creativeAnalysisArtifact.create({ data: { userId, projectId, kind, sourceAssetId: sourceAssetId ?? undefined, ...data } });
}

/** Enqueue a temporal-intelligence run (review scope "temporal" + durable job). */
export async function enqueueTemporalIntelligence(userId: string, projectId: string, settings: unknown, consentVisual: boolean): Promise<{ reviewId: string; jobId: string; disclosure: string }> {
  const parsed = TemporalSettingsSchema.safeParse(settings ?? {});
  if (!parsed.success) throw new PermanentJobError(`Temporal settings invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const head = await getTimelineHead(projectId, userId);
  const seq = head.sequence;
  const contextVersion = contextVersionOf(head.version, seq.clips.length, seq.clips.reduce((m, c) => Math.max(m, c.timelineStartFrame + c.timelineDurationFrames), 0));
  const review = await db.creativeReview.create({ data: { userId, projectId, scope: "temporal", language: "en", status: "QUEUED", stage: "Queued", contextVersion, headVersion: head.version } });
  const jobId = await jobManager.createJob(userId, "TEMPORAL_INTELLIGENCE", { reviewId: review.id, settings: parsed.data, consentVisual });
  await db.creativeReview.update({ where: { id: review.id }, data: { jobId } });
  return {
    reviewId: review.id,
    jobId,
    disclosure: consentVisual
      ? `Local tracking uploads NOTHING; consented provider labeling sends ≤6 small subject crops to ${process.env.BEANFX_VISUAL_MODEL ?? "glm-4.5v"} (usage recorded, no $ estimate)`
      : "Fully local: OpenCV tracking and camera registration upload NOTHING; no consent given, no provider calls",
  };
}
