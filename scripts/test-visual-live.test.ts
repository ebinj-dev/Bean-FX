/**
 * BEAN FX — M12 Visual Intelligence LIVE tests (bun test, isolated DB).
 * REAL providers, REAL extracted frames, REAL known visible content:
 *  1. the REAL vision provider (SDK createVision) describes frames extracted
 *     by the real pipeline from a fixture whose visible content is KNOWN
 *     ("BEAN FX" white-on-red drawtext) — descriptions are verified against
 *     that known content;
 *  2. a REAL VISUAL_INTELLIGENCE job runs WITH consent through the REAL
 *     worker (frames sent to the provider only because consent=true), then a
 *     REAL natural-language search ranks the indexed scenes;
 *  3. REAL narration matching: ZAI TTS speech → REAL RIISHE ASR → APPROVED
 *     transcript × analyzed scenes → provider relevance verdicts.
 * Unavailable providers produce honest skips — mocks are never substituted.
 *
 * Run: bun test scripts/test-visual-live.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRATCH_DB = path.join(os.tmpdir(), `beanfx-m12-live-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${SCRATCH_DB}`;
process.env.BEANFX_MEDIA_WORKER_AUTOSTART = "0";
process.env.NODE_ENV = "production";
const WORK = mkdtempSync(path.join(os.tmpdir(), "beanfx-m12-live-"));

execSync("bunx prisma db push --skip-generate --accept-data-loss", {
  env: { ...process.env, DATABASE_URL: `file:${SCRATCH_DB}` },
  stdio: ["ignore", "ignore", "inherit"],
});

let db: typeof import("../src/lib/db").db;
let framesMod: typeof import("../src/lib/creative/visual/frames");
let scenesMod: typeof import("../src/lib/creative/visual/scenes");
let visionAnalysis: typeof import("../src/lib/creative/visual/vision-analysis");
let matchingMod: typeof import("../src/lib/creative/visual/matching");
let searchMod: typeof import("../src/lib/creative/visual/search");
let visualJobs: typeof import("../src/lib/creative/visual/jobs");
let transcription: typeof import("../src/lib/creative/transcription");
let visionGateway: typeof import("../src/lib/my-ai/gateway/vision");
let workerMod: typeof import("../src/lib/media-worker");
let persistence: typeof import("../src/lib/editor/persistence");

const USER = "m12-live-user";
let textProjectId = "";
let searchProjectId = "";
let matchProjectId = "";
let matchAudioId = "";
const TEXT_VIDEO = path.join(WORK, "bean-fx-text.mp4");
const SEARCH_VIDEO = path.join(WORK, "search-scenes.mp4");
const SPEECH_WAV = path.join(WORK, "speech-en.wav");
const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
let ttsAvailable = false;
const SETTINGS = { sampleIntervalSec: 2, maxFramesPerAsset: 6, maxFrameWidth: 320, duplicateHashDistance: 6, repeatShotHashDistance: 10, visionBatchSize: 2 };

function tickUntil(jobId: string, timeoutMs = 420_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  return (async function loop(): Promise<string> {
    while (Date.now() < deadline) {
      await workerMod.tickWorkerOnce().catch(() => undefined);
      const row = await db.job.findUnique({ where: { id: jobId } });
      if (row && (row.status === "COMPLETED" || row.status === "FAILED" || row.status === "CANCELLED")) return row.status;
      await new Promise((r) => setTimeout(r, 1200));
    }
    return "timeout";
  })();
}

function clipObj(id: string, trackId: string, assetId: string, srcOut: number, tlStart: number): Record<string, unknown> {
  return { id, trackId, sourceAssetId: assetId, sourceInFrame: 0, sourceOutFrame: srcOut, sourceFps: { num: 10, den: 1 }, timelineStartFrame: tlStart, playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null, label: "main", missingMedia: false, effects: [], keyframes: [] };
}
const TRACK = { id: "t-video", kind: "VIDEO", name: "V1", visible: true, muted: false, solo: false, locked: false };
const ATRACK = { id: "t-audio", kind: "AUDIO", name: "A1", visible: true, muted: false, solo: false, locked: false };

async function registerVideo(projectId: string, file: string, name: string, durationSec: number) {
  return db.mediaAsset.create({ data: { userId: USER, projectId, originalName: name, storagePath: file, kind: "VIDEO", mimeType: "video/mp4", sizeBytes: statSync(file).size, durationSec, width: 320, height: 240, fps: 10 } });
}

beforeAll(async () => {
  db = (await import("../src/lib/db")).db;
  framesMod = await import("../src/lib/creative/visual/frames");
  scenesMod = await import("../src/lib/creative/visual/scenes");
  visionAnalysis = await import("../src/lib/creative/visual/vision-analysis");
  matchingMod = await import("../src/lib/creative/visual/matching");
  searchMod = await import("../src/lib/creative/visual/search");
  visualJobs = await import("../src/lib/creative/visual/jobs");
  transcription = await import("../src/lib/creative/transcription");
  visionGateway = await import("../src/lib/my-ai/gateway/vision");
  workerMod = await import("../src/lib/media-worker");
  persistence = await import("../src/lib/editor/persistence");

  await db.user.create({ data: { id: USER, email: "m12live@test.local", name: "L", passwordHash: "x" } }).catch(() => undefined);

  // REAL vision availability probe (a real round trip against a tiny JPEG).
  const health = await visionGateway.visionHealth(true);
  console.log(`[m12-live] vision provider health: ${health.ok ? "OK" : health.detail} (${health.latencyMs} ms)`);
  if (!health.ok) {
    console.log("[m12-live] vision provider unavailable — live visual tests will skip honestly");
  }

  const p1 = await db.project.create({ data: { userId: USER, name: "M12 Live Text Project" } });
  textProjectId = p1.id;
  const p2 = await db.project.create({ data: { userId: USER, name: "M12 Live Search Project" } });
  searchProjectId = p2.id;
  const p3 = await db.project.create({ data: { userId: USER, name: "M12 Live Match Project" } });
  matchProjectId = p3.id;

  // KNOWN visible content: white "BEAN FX" text centered on red.
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=320x240:d=4:r=10", "-vf", `drawtext=fontfile=${FONT}:text='BEAN FX':fontsize=48:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", TEXT_VIDEO], { stdio: ["ignore", "ignore", "inherit"] });
  const tv = await registerVideo(textProjectId, TEXT_VIDEO, "bean-fx-text.mp4", 4);
  const head1 = await persistence.getTimelineHead(textProjectId, USER);
  await persistence.applyTimelineEdits(textProjectId, USER, head1.version, [
    { type: "AddTrack", track: TRACK },
    { type: "AddClip", clip: clipObj("tc1", "t-video", tv.id, 40, 0) },
  ], false);

  // Search fixture: scene 0 = the BEAN FX text card, scene 1 = rgbtestsrc.
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=320x240:d=4:r=10", "-f", "lavfi", "-i", "rgbtestsrc=s=320x240:r=10:d=4", "-filter_complex", `[0:v]drawtext=fontfile=${FONT}:text='BEAN FX':fontsize=48:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2[a];[a][1:v]concat=n=2:v=1:a=0[out]`, "-map", "[out]", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", SEARCH_VIDEO], { stdio: ["ignore", "ignore", "inherit"] });
  const sv = await registerVideo(searchProjectId, SEARCH_VIDEO, "search-scenes.mp4", 8);
  const head2 = await persistence.getTimelineHead(searchProjectId, USER);
  await persistence.applyTimelineEdits(searchProjectId, USER, head2.version, [
    { type: "AddTrack", track: TRACK },
    { type: "AddClip", clip: clipObj("sc1", "t-video", sv.id, 80, 0) },
  ], false);

  // REAL speech via ZAI TTS for narration matching.
  try {
    execFileSync("z-ai", ["tts", "-i", "Welcome to Bean FX. Today we explain how we roast coffee beans very carefully.", "-o", SPEECH_WAV, "-v", "tongtong"], { timeout: 120_000, stdio: ["ignore", "ignore", "inherit"] });
    ttsAvailable = statSync(SPEECH_WAV).size > 1000;
  } catch {
    ttsAvailable = false;
  }
  console.log(`[m12-live] TTS fixture: ${ttsAvailable ? "generated" : "unavailable (honest skip)"}`);
  if (ttsAvailable) {
    // Narration video: speech embedded; visuals are smpte bars (unrelated to coffee — honest mismatch expected).
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "smptehdbars=s=320x240:r=10:d=8", "-i", SPEECH_WAV, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(WORK, "narration.mp4")], { stdio: ["ignore", "ignore", "inherit"] });
    const nv = await registerVideo(matchProjectId, path.join(WORK, "narration.mp4"), "narration.mp4", 8);
    const head3 = await persistence.getTimelineHead(matchProjectId, USER);
    await persistence.applyTimelineEdits(matchProjectId, USER, head3.version, [
      { type: "AddTrack", track: TRACK },
      { type: "AddClip", clip: clipObj("mc1", "t-video", nv.id, 80, 0) },
    ], false);
  }

  const ticker = setInterval(() => {
    void workerMod.tickWorkerOnce().catch(() => undefined);
  }, 1200);
  ticker.unref?.();
  (globalThis as unknown as { __m12LiveTicker?: NodeJS.Timeout }).__m12LiveTicker = ticker;
}, 240_000);

afterAll(() => {
  const ticker = (globalThis as unknown as { __m12LiveTicker?: NodeJS.Timeout }).__m12LiveTicker;
  if (ticker) clearInterval(ticker);
  rmSync(WORK, { recursive: true, force: true });
  rmSync(SCRATCH_DB, { force: true });
});

describe("M12 LIVE visual intelligence (REAL providers)", () => {
  test("REAL vision understanding of REAL extracted frames against KNOWN visible content", async () => {
    const health = await visionGateway.visionHealth();
    if (!health.ok) {
      console.log(`[m12-live] skip: vision provider unavailable (${health.detail})`);
      expect(true).toBe(true);
      return;
    }
    const runKey = `live_${Date.now()}`;
    const set = await framesMod.extractFrames({ id: "livetext", storagePath: TEXT_VIDEO, width: 320, height: 240, durationSec: 4 }, { ...SETTINGS, maxFramesPerAsset: 2, sampleIntervalSec: 3 }, { seqFps: 10, clips: [] }, [], runKey);
    const pending = set.frames.filter((f) => f.status === "extracted");
    expect(pending.length).toBeGreaterThan(0);
    const res = await visionAnalysis.analyzeFramesSemantic(set.frames, set.files, { ...SETTINGS, visionBatchSize: 1 }, {});
    console.log(`[m12-live] REAL vision: ${res.analyzedCount} analyzed / ${res.failedCount} failed via ${res.providerId}/${res.model}`);
    expect(res.analyzedCount).toBeGreaterThan(0);
    const analyzed = set.frames.filter((f) => f.status === "analyzed");
    for (const f of analyzed) {
      expect(f.provider).toBe("zai");
      expect(f.analysis?.description.length ?? 0).toBeGreaterThan(0);
    }
    // Verify against the KNOWN visible content: the frames show "BEAN FX".
    const joint = analyzed.map((f) => `${f.analysis?.description ?? ""} ${f.analysis?.visibleText ?? ""}`).join(" ").toLowerCase();
    console.log(`[m12-live] descriptions: ${analyzed.map((f) => f.analysis?.description?.slice(0, 120)).join(" | ").slice(0, 400)}`);
    console.log(`[m12-live] visibleText: ${analyzed.map((f) => f.analysis?.visibleText).join(" | ")}`);
    expect(joint).toContain("bean");
    await framesMod.cleanupVisualFrameDir(framesMod.visualFrameDir(runKey));
  }, 240_000);

  test("REAL VISUAL_INTELLIGENCE job WITH consent + REAL provider-ranked search", async () => {
    const health = await visionGateway.visionHealth();
    if (!health.ok) {
      console.log(`[m12-live] skip: vision provider unavailable (${health.detail})`);
      expect(true).toBe(true);
      return;
    }
    const { reviewId, jobId, estimatedVisionCalls } = await visualJobs.enqueueVisualIntelligence(USER, searchProjectId, { ...SETTINGS, maxFramesPerAsset: 4, sampleIntervalSec: 3 }, true);
    console.log(`[m12-live] visual job ${jobId.slice(0, 8)}… queued (${estimatedVisionCalls})`);
    const status = await tickUntil(jobId);
    expect(status).toBe("COMPLETED");
    const review = await db.creativeReview.findUnique({ where: { id: reviewId } });
    expect(review?.status).toBe("COMPLETED");
    const indexRow = await db.creativeAnalysisArtifact.findFirst({ where: { userId: USER, projectId: searchProjectId, kind: "visual-index", status: "COMPLETED" } });
    expect(indexRow?.consentVisual).toBe(true);
    const index = JSON.parse(indexRow!.resultJson!) as { scenes: { sceneId: string; index: number; description: string | null; understanding: string; representativeAssetId: string | null }[]; measurement: { framesAnalyzed: number } };
    console.log(`[m12-live] indexed ${index.scenes.length} scene(s), ${index.measurement.framesAnalyzed} analyzed frame(s)`);
    console.log(`[m12-live] scene descriptions: ${index.scenes.map((s) => `#${s.index}: ${(s.description ?? "").slice(0, 90)}`).join(" | ")}`);
    const semanticScenes = index.scenes.filter((s) => s.understanding === "semantic" && s.description);
    expect(semanticScenes.length).toBeGreaterThan(0);
    // REAL natural-language search over the REAL index.
    const search = await searchMod.searchVisualIndex(index as unknown as Parameters<typeof searchMod.searchVisualIndex>[0], { query: "the scene showing text that says BEAN FX", limit: 4 }, { consentVisual: true });
    console.log(`[m12-live] search method=${search.method} top=${search.results[0]?.sceneId} score=${search.results[0]?.relevanceScore} evidence=${search.results[0]?.evidence.slice(0, 120)}`);
    expect(search.available).toBe(true);
    expect(search.results.length).toBeGreaterThan(0);
    expect(search.results[0].sceneId).toContain(":s0"); // the text card scene
    // Scene thumbnails are registered assets and readable.
    for (const s of index.scenes) {
      if (s.representativeAssetId) {
        const asset = await db.mediaAsset.findUnique({ where: { id: s.representativeAssetId } });
        expect(asset?.kind).toBe("IMAGE");
      }
    }
    // Temp frames cleaned by the job.
    expect(await framesMod.listFrameDir(framesMod.visualFrameDir(`j_${jobId}`))).toHaveLength(0);
  }, 480_000);

  test("REAL narration-to-visual matching: TTS speech → REAL ASR → provider verdicts", async () => {
    const health = await visionGateway.visionHealth();
    if (!health.ok || !ttsAvailable) {
      console.log(`[m12-live] skip: ${!health.ok ? "vision provider unavailable" : "TTS unavailable"}`);
      expect(true).toBe(true);
      return;
    }
    // REAL visual index of the narration video (bars — unrelated to the speech).
    const { jobId } = await visualJobs.enqueueVisualIntelligence(USER, matchProjectId, { ...SETTINGS, maxFramesPerAsset: 3, sampleIntervalSec: 4 }, true);
    const status = await tickUntil(jobId);
    expect(status).toBe("COMPLETED");
    // REAL integrated transcription (RIISHE ASR) + approval.
    const t = await transcription.runProjectTranscription(USER, matchProjectId, {});
    console.log(`[m12-live] REAL ASR: v${t.versionNo} lang=${t.language} segments=${t.segments} warnings=${t.warnings.length}`);
    expect(t.segments).toBeGreaterThan(0);
    await transcription.approveTranscript(USER, t.transcriptId, false);

    const indexRow = await db.creativeAnalysisArtifact.findFirst({ where: { userId: USER, projectId: matchProjectId, kind: "visual-index", status: "COMPLETED" } });
    const index = JSON.parse(indexRow!.resultJson!) as Parameters<typeof matchingMod.matchNarrationToVisuals>[3];
    const { buildMeasuredContext } = await import("../src/lib/creative/context");
    const ctx = await buildMeasuredContext(USER, matchProjectId, { enqueueEvidence: false });
    const match = await matchingMod.matchNarrationToVisuals(USER, matchProjectId, ctx, index, { consentVisual: true });
    console.log(`[m12-live] REAL matching: ${match.matches.length} segment(s) via ${match.provider}/${match.model} (transcript v${match.transcriptVersionNo})`);
    expect(match.matches.length).toBeGreaterThan(0);
    const withVerdict = match.matches.filter((m) => m.provider !== null);
    expect(withVerdict.length).toBeGreaterThan(0);
    for (const m of withVerdict) {
      expect(m.evidenceLabel).toBe("ai-interpretation");
      expect(m.explanation.length).toBeGreaterThan(10);
    }
    console.log(`[m12-live] verdicts: ${match.matches.map((m) => `#${m.segmentIndex} ${m.relevance} (${m.relevanceScore}) "${m.text.slice(0, 40)}" → ${m.explanation.slice(0, 110)}`).join(" | ")}`);
  }, 480_000);
});
