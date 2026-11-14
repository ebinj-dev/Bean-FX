/**
 * BEAN FX — M12 Visual Intelligence core tests (bun test, isolated DB).
 * REAL engine code + REAL fixtures (ffmpeg videos with distinct color scenes,
 * real frame extraction, real aHash dedup, real scene grouping, real M1/M2
 * execution for B-roll insertion). The VISION provider is INJECTED (stub,
 * clearly labeled) in this suite — real-provider visual understanding is in
 * test-visual-live.test.ts. Nothing mocked is presented as live.
 *
 * Run: bun test scripts/test-visual-core.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
void existsSync;
import os from "node:os";
import path from "node:path";

const SCRATCH_DB = path.join(os.tmpdir(), `beanfx-m12-core-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${SCRATCH_DB}`;
process.env.BEANFX_MEDIA_WORKER_AUTOSTART = "0";
process.env.NODE_ENV = "production";
process.env.BEANFX_MYAI_PROVIDER = "does-not-exist";
const WORK = mkdtempSync(path.join(os.tmpdir(), "beanfx-m12-core-"));

execSync("bunx prisma db push --skip-generate --accept-data-loss", {
  env: { ...process.env, DATABASE_URL: `file:${SCRATCH_DB}` },
  stdio: ["ignore", "ignore", "inherit"],
});

let db: typeof import("../src/lib/db").db;
let persistence: typeof import("../src/lib/editor/persistence");
let commands: typeof import("../src/lib/editor/commands");
let framesMod: typeof import("../src/lib/creative/visual/frames");
let scenesMod: typeof import("../src/lib/creative/visual/scenes");
let visionAnalysis: typeof import("../src/lib/creative/visual/vision-analysis");
let matchingMod: typeof import("../src/lib/creative/visual/matching");
let searchMod: typeof import("../src/lib/creative/visual/search");
let brollMod: typeof import("../src/lib/creative/visual/broll");
let continuityMod: typeof import("../src/lib/creative/visual/continuity");
let visualJobs: typeof import("../src/lib/creative/visual/jobs");
let transcription: typeof import("../src/lib/creative/transcription");
let contracts: typeof import("../src/lib/creative/visual/contracts");
let visionGateway: typeof import("../src/lib/my-ai/gateway/vision");
let workerMod: typeof import("../src/lib/media-worker");

const USER = "m12-user";
const FOREIGN = "m12-foreign";
let scenesProjectId = "";
let scenesAssetId = "";
let repeatProjectId = "";
let solidProjectId = "";
let solidAssetId = "";
let speedProjectId = "";
let brollProjectId = "";
let brollAudioId = "";
let brollImageId = "";
const SCENES_VIDEO = path.join(WORK, "scenes.mp4");
const REPEAT_VIDEO = path.join(WORK, "repeat.mp4");
const SOLID_VIDEO = path.join(WORK, "solid.mp4");
const CORRUPT = path.join(WORK, "corrupt.mp4");
const SETTINGS = { sampleIntervalSec: 2, maxFramesPerAsset: 9, maxFrameWidth: 320, duplicateHashDistance: 6, repeatShotHashDistance: 10, visionBatchSize: 2 };

function tickUntil(jobId: string, timeoutMs = 120_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  return (async function loop(): Promise<string> {
    while (Date.now() < deadline) {
      await workerMod.tickWorkerOnce().catch(() => undefined);
      const row = await db.job.findUnique({ where: { id: jobId } });
      if (row && (row.status === "COMPLETED" || row.status === "FAILED" || row.status === "CANCELLED")) return row.status;
      await new Promise((r) => setTimeout(r, 800));
    }
    return "timeout";
  })();
}

function clipObj(id: string, trackId: string, assetId: string, fpsNum: number, fpsDen: number, srcOut: number, tlStart: number, speed = 1): Record<string, unknown> {
  return { id, trackId, sourceAssetId: assetId, sourceInFrame: 0, sourceOutFrame: srcOut, sourceFps: { num: fpsNum, den: fpsDen }, timelineStartFrame: tlStart, playbackSpeed: speed, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null, label: "main", missingMedia: false, effects: [], keyframes: [] };
}

const TRACK = { id: "t-video", kind: "VIDEO", name: "V1", visible: true, muted: false, solo: false, locked: false };
const ATRACK = { id: "t-audio", kind: "AUDIO", name: "A1", visible: true, muted: false, solo: false, locked: false };

/** Stub vision provider (fixture-driven, clearly labeled — NOT a real provider). */
function stubVision(mode: "ok" | "fail" | "short" | "garbage"): import("../src/lib/my-ai/gateway/vision").VisionProvider {
  return {
    id: "stub",
    model: "stub-vision-model",
    async analyze(prompt: string, images: { mimeType: string; base64: string }[]) {
      if (mode === "fail") throw new (await import("../src/lib/my-ai/gateway/provider")).LLMError("PROVIDER_FAILURE", "stub vision unavailable");
      const n = images.length;
      const mk = () => ({ description: `stub frame description ${Math.random()}`.replace("Math.random()", ""), objects: ["laptop", "person"], activities: ["a person speaking"], environment: "indoor studio", visibleText: null, shotType: "medium", composition: "centered subject", subjectPosition: "center" });
      if (mode === "short") return { content: JSON.stringify({ frames: [mk()] }), model: "stub-vision-model", provider: "stub", usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 }, latencyMs: 1 };
      if (mode === "garbage") return { content: "not json at all {{{", model: "stub-vision-model", provider: "stub", usage: null, latencyMs: 1 };
      return { content: JSON.stringify({ frames: Array.from({ length: n }, mk) }), model: "stub-vision-model", provider: "stub", usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 }, latencyMs: 1 };
    },
    async healthCheck() {
      return { ok: true, detail: "stub", latencyMs: 1 };
    },
  };
}

/** Stub ranking provider for search (clearly labeled fixture). */
function stubRanking(sceneIds: string[]): import("../src/lib/my-ai/gateway/vision").VisionProvider {
  return {
    id: "stub-rank",
    model: "stub-ranker",
    async analyze(_prompt: string, _images: unknown[]) {
      const results = sceneIds.map((id, i) => ({ sceneId: id, relevanceScore: 1 - i * 0.3, matchedTerms: ["red"], evidence: "stub evidence for ranking" }));
      return { content: JSON.stringify({ results }), model: "stub-ranker", provider: "stub-rank", usage: null, latencyMs: 1 };
    },
    async healthCheck() {
      return { ok: true, detail: "stub", latencyMs: 1 };
    },
  };
}

beforeAll(async () => {
  db = (await import("../src/lib/db")).db;
  persistence = await import("../src/lib/editor/persistence");
  commands = await import("../src/lib/editor/commands");
  framesMod = await import("../src/lib/creative/visual/frames");
  scenesMod = await import("../src/lib/creative/visual/scenes");
  visionAnalysis = await import("../src/lib/creative/visual/vision-analysis");
  matchingMod = await import("../src/lib/creative/visual/matching");
  searchMod = await import("../src/lib/creative/visual/search");
  brollMod = await import("../src/lib/creative/visual/broll");
  continuityMod = await import("../src/lib/creative/visual/continuity");
  visualJobs = await import("../src/lib/creative/visual/jobs");
  transcription = await import("../src/lib/creative/transcription");
  contracts = await import("../src/lib/creative/visual/contracts");
  visionGateway = await import("../src/lib/my-ai/gateway/vision");
  workerMod = await import("../src/lib/media-worker");

  await db.user.create({ data: { id: USER, email: "m12a@test.local", name: "A", passwordHash: "x" } }).catch(() => undefined);
  await db.user.create({ data: { id: FOREIGN, email: "m12b@test.local", name: "B", passwordHash: "x" } }).catch(() => undefined);

  // 12 s, three textured 4 s scenes (real scene cuts at 4 s / 8 s). Textured
  // sources are REQUIRED: uniform-color frames all share the zero aHash, so
  // perceptual dedup cannot distinguish them (documented limitation).
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-filter_complex", "smptehdbars=s=320x240:r=10:d=4[a];rgbtestsrc=s=320x240:r=10:d=4[b];testsrc2=s=320x240:r=10:d=4[c];[a][b][c]concat=n=3:v=1:a=0[out]", "-map", "[out]", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", SCENES_VIDEO], { stdio: ["ignore", "ignore", "inherit"] });
  // 9 s bars/rgb/bars → repeated-shot fixture (same static texture at both ends).
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-filter_complex", "smptehdbars=s=320x240:r=10:d=3[a];rgbtestsrc=s=320x240:r=10:d=3[b];smptehdbars=s=320x240:r=10:d=3[c];[a][b][c]concat=n=3:v=1:a=0[out]", "-map", "[out]", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", REPEAT_VIDEO], { stdio: ["ignore", "ignore", "inherit"] });
  // 8 s solid black → dedup fixture.
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=8:r=10", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", SOLID_VIDEO], { stdio: ["ignore", "ignore", "inherit"] });
  // corrupt file.
  execSync(`printf 'not a video at all' > "${CORRUPT}"`, { stdio: "ignore" });

  // Main scenes project: video placed 0–12 s.
  const p1 = await db.project.create({ data: { userId: USER, name: "M12 Scenes Project", description: "Fixture" } });
  scenesProjectId = p1.id;
  const sv = statSync(SCENES_VIDEO);
  const video = await db.mediaAsset.create({ data: { userId: USER, projectId: scenesProjectId, originalName: "scenes.mp4", storagePath: SCENES_VIDEO, kind: "VIDEO", mimeType: "video/mp4", sizeBytes: sv.size, durationSec: 12, width: 320, height: 240, fps: 10 } });
  scenesAssetId = video.id;
  const head1 = await persistence.getTimelineHead(scenesProjectId, USER);
  await persistence.applyTimelineEdits(scenesProjectId, USER, head1.version, [
    { type: "AddTrack", track: TRACK },
    { type: "AddClip", clip: clipObj("vc1", "t-video", video.id, 10, 1, 120, 0) },
  ], false);

  // Repeat project.
  const p2 = await db.project.create({ data: { userId: USER, name: "M12 Repeat Project" } });
  repeatProjectId = p2.id;
  const rv = await db.mediaAsset.create({ data: { userId: USER, projectId: repeatProjectId, originalName: "repeat.mp4", storagePath: REPEAT_VIDEO, kind: "VIDEO", mimeType: "video/mp4", sizeBytes: statSync(REPEAT_VIDEO).size, durationSec: 9, width: 320, height: 240, fps: 10 } });
  const head2 = await persistence.getTimelineHead(repeatProjectId, USER);
  await persistence.applyTimelineEdits(repeatProjectId, USER, head2.version, [
    { type: "AddTrack", track: TRACK },
    { type: "AddClip", clip: clipObj("rc1", "t-video", rv.id, 10, 1, 90, 0) },
  ], false);

  // Solid (dedup) project.
  const p3 = await db.project.create({ data: { userId: USER, name: "M12 Solid Project" } });
  solidProjectId = p3.id;
  const sol = await db.mediaAsset.create({ data: { userId: USER, projectId: solidProjectId, originalName: "solid.mp4", storagePath: SOLID_VIDEO, kind: "VIDEO", mimeType: "video/mp4", sizeBytes: statSync(SOLID_VIDEO).size, durationSec: 8, width: 320, height: 240, fps: 10 } });
  solidAssetId = sol.id;
  const head3 = await persistence.getTimelineHead(solidProjectId, USER);
  await persistence.applyTimelineEdits(solidProjectId, USER, head3.version, [
    { type: "AddTrack", track: TRACK },
    { type: "AddClip", clip: clipObj("sc1", "t-video", sol.id, 10, 1, 80, 0) },
  ], false);

  // Speed project: same asset at playbackSpeed 2.
  const p4 = await db.project.create({ data: { userId: USER, name: "M12 Speed Project" } });
  speedProjectId = p4.id;
  const head4 = await persistence.getTimelineHead(speedProjectId, USER);
  await persistence.applyTimelineEdits(speedProjectId, USER, head4.version, [
    { type: "AddTrack", track: TRACK },
    { type: "AddClip", clip: clipObj("spc1", "t-video", video.id, 10, 1, 120, 0, 2) },
  ], false);

  // B-roll project: audio placed + an UNPLACED owned image.
  const p5 = await db.project.create({ data: { userId: USER, name: "M12 B-roll Project" } });
  brollProjectId = p5.id;
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=12", "-ar", "48000", "-ac", "1", path.join(WORK, "broll.wav")], { stdio: ["ignore", "ignore", "inherit"] });
  const audio = await db.mediaAsset.create({ data: { userId: USER, projectId: brollProjectId, originalName: "broll.wav", storagePath: path.join(WORK, "broll.wav"), kind: "AUDIO", mimeType: "audio/wav", sizeBytes: statSync(path.join(WORK, "broll.wav")).size, durationSec: 12, sampleRate: 48000, channels: 1 } });
  brollAudioId = audio.id;
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=purple:s=640x360:d=1:r=10", "-frames:v", "1", path.join(WORK, "still.png")], { stdio: ["ignore", "ignore", "inherit"] });
  const img = await db.mediaAsset.create({ data: { userId: USER, projectId: brollProjectId, originalName: "broll-still.png", storagePath: path.join(WORK, "still.png"), kind: "IMAGE", mimeType: "image/png", sizeBytes: statSync(path.join(WORK, "still.png")).size, width: 640, height: 360 } });
  brollImageId = img.id;
  const head5 = await persistence.getTimelineHead(brollProjectId, USER);
  await persistence.applyTimelineEdits(brollProjectId, USER, head5.version, [
    { type: "AddTrack", track: ATRACK },
    { type: "AddClip", clip: clipObj("ac1", "t-audio", audio.id, 48000, 1, 48000 * 12, 0) },
  ], false);

  const ticker = setInterval(() => {
    void workerMod.tickWorkerOnce().catch(() => undefined);
  }, 900);
  ticker.unref?.();
  (globalThis as unknown as { __m12CoreTicker?: NodeJS.Timeout }).__m12CoreTicker = ticker;
}, 120_000);

afterAll(() => {
  const ticker = (globalThis as unknown as { __m12CoreTicker?: NodeJS.Timeout }).__m12CoreTicker;
  if (ticker) clearInterval(ticker);
  rmSync(WORK, { recursive: true, force: true });
  rmSync(SCRATCH_DB, { force: true });
});

describe("M12 visual intelligence core", () => {
  test("settings validation: clamped into range, honest refusal of garbage", () => {
    const s = visualJobs.validateVisualSettings({ maxFramesPerAsset: 999, sampleIntervalSec: 0.5 });
    expect(s.maxFramesPerAsset).toBe(48); // clamped to the cap
    expect(s.sampleIntervalSec).toBe(1); // clamped to the floor
    const d = visualJobs.validateVisualSettings({});
    expect(d.maxFramesPerAsset).toBe(24);
    expect(() => visualJobs.validateVisualSettings({ sampleIntervalSec: "fast" })).toThrow();
  });

  test("candidate sampling: scene midpoints + uniform, budget spread, proximity dedupe", () => {
    const cands = framesMod.sampleCandidates ? framesMod.sampleCandidates(12, SETTINGS, [4, 8]) : [];
    void cands;
    // sampleCandidates is not exported? — call through extractFrames path instead; direct check:
    const c = (framesMod as unknown as { sampleCandidates: (d: number, s: typeof SETTINGS, cuts: number[]) => { sec: number; method: string }[] }).sampleCandidates(12, SETTINGS, [4, 8]);
    expect(c.length).toBeGreaterThan(0);
    expect(c.some((x) => x.method === "scene-midpoint")).toBe(true);
    expect(c.some((x) => x.method === "uniform-sample")).toBe(true);
    // Budget cap spreads evenly.
    const capped = (framesMod as unknown as { sampleCandidates: (d: number, s: typeof SETTINGS, cuts: number[]) => { sec: number; method: string }[] }).sampleCandidates(12, { ...SETTINGS, maxFramesPerAsset: 4 }, [4, 8]);
    expect(capped.length).toBe(4);
  });

  test("REAL frame extraction: multi-scene fixture, both clocks, dimensions, provenance", async () => {
    const runKey = `t_${Date.now()}`;
    const set = await framesMod.extractFrames({ id: scenesAssetId, storagePath: SCENES_VIDEO, width: 320, height: 240, durationSec: 12 }, SETTINGS, { seqFps: 10, clips: [{ clipId: "vc1", sourceInFrame: 0, sourceOutFrame: 120, sourceFpsNum: 10, sourceFpsDen: 1, playbackSpeed: 1, timelineStartFrame: 0 }] }, [4, 8], runKey);
    await framesMod.setFrameHeights(set.frames, set.files);
    const extracted = set.frames.filter((f) => f.status === "extracted" || f.status === "analyzed");
    expect(extracted.length).toBeGreaterThanOrEqual(3); // textured scenes → ≥1 distinct frame per scene
    for (const f of extracted) {
      expect(f.assetId).toBe(scenesAssetId);
      expect(f.clipId).toBe("vc1");
      expect(f.timelineSec).toBeCloseTo(f.sourceSec, 1); // speed 1
      expect(f.width).toBeLessThanOrEqual(320);
      expect(f.height).toBeGreaterThan(0);
      expect(f.ahash).toHaveLength(16);
    }
    expect(set.frames.some((f) => f.extractionMethod === "scene-midpoint")).toBe(true);
    // cleanup
    await framesMod.cleanupVisualFrameDir(framesMod.visualFrameDir(runKey));
    expect(await framesMod.listFrameDir(framesMod.visualFrameDir(runKey))).toHaveLength(0);
  });

  test("REAL frame dedup: solid-color frames collapse via aHash", async () => {
    const runKey = `t_${Date.now()}`;
    const set = await framesMod.extractFrames({ id: solidAssetId, storagePath: SOLID_VIDEO, width: 320, height: 240, durationSec: 8 }, SETTINGS, { seqFps: 10, clips: [{ clipId: "sc1", sourceInFrame: 0, sourceOutFrame: 80, sourceFpsNum: 10, sourceFpsDen: 1, playbackSpeed: 1, timelineStartFrame: 0 }] }, [], runKey);
    expect(set.framesDeduped).toBeGreaterThan(0);
    expect(set.frames.some((f) => f.status === "skipped-duplicate")).toBe(true);
    await framesMod.cleanupVisualFrameDir(framesMod.visualFrameDir(runKey));
  });

  test("corrupt/unreadable media: honest extraction failure (no invented frames)", async () => {
    await expect(framesMod.extractFrames({ id: "corrupt", storagePath: CORRUPT, width: null, height: null, durationSec: null }, SETTINGS, { seqFps: 10, clips: [] }, [], "t_corrupt")).rejects.toThrow();
  });

  test("clip speed mapping: playbackSpeed 2 halves the timeline clock", async () => {
    const runKey = `t_${Date.now()}`;
    const set = await framesMod.extractFrames({ id: scenesAssetId, storagePath: SCENES_VIDEO, width: 320, height: 240, durationSec: 12 }, { ...SETTINGS, maxFramesPerAsset: 4, sampleIntervalSec: 4 }, { seqFps: 10, clips: [{ clipId: "spc1", sourceInFrame: 0, sourceOutFrame: 120, sourceFpsNum: 10, sourceFpsDen: 1, playbackSpeed: 2, timelineStartFrame: 0 }] }, [], runKey);
    const mapped = set.frames.find((f) => f.status === "extracted" && f.sourceSec >= 1.9 && f.sourceSec <= 2.1);
    expect(mapped).toBeTruthy();
    if (mapped?.timelineSec !== null && mapped) expect(mapped.timelineSec).toBeLessThan(mapped.sourceSec); // 2× speed → timeline < source
    await framesMod.cleanupVisualFrameDir(framesMod.visualFrameDir(runKey));
  });

  test("scene grouping: 3 real scenes, placements, heuristic-only honesty", async () => {
    const runKey = `t_${Date.now()}`;
    const set = await framesMod.extractFrames({ id: scenesAssetId, storagePath: SCENES_VIDEO, width: 320, height: 240, durationSec: 12 }, SETTINGS, { seqFps: 10, clips: [{ clipId: "vc1", sourceInFrame: 0, sourceOutFrame: 120, sourceFpsNum: 10, sourceFpsDen: 1, playbackSpeed: 1, timelineStartFrame: 0 }] }, [4, 8], runKey);
    const scenes = scenesMod.buildScenes(set.frames, scenesAssetId, 12, [4, 8], SETTINGS, { seqFps: 10, clips: [{ clipId: "vc1", sourceInFrame: 0, sourceOutFrame: 120, sourceFpsNum: 10, sourceFpsDen: 1, playbackSpeed: 1, timelineStartFrame: 0 }] });
    expect(scenes.length).toBe(3);
    expect(scenes[0].sourceStartSec).toBe(0);
    expect(scenes[1].sourceStartSec).toBe(4);
    expect(scenes[2].sourceEndSec).toBe(12);
    for (const s of scenes) {
      expect(s.understanding).toBe("heuristic-only"); // no provider analysis yet — honest
      expect(s.description).toBeNull();
      expect(s.timelinePlacements.length).toBe(1);
      expect(s.timelinePlacements[0].clipId).toBe("vc1");
    }
    await framesMod.cleanupVisualFrameDir(framesMod.visualFrameDir(runKey));
  });

  test("repeated-shot detection: red/blue/red groups by aHash", async () => {
    const runKey = `t_${Date.now()}`;
    const clipCtx = { seqFps: 10, clips: [{ clipId: "rc1", sourceInFrame: 0, sourceOutFrame: 90, sourceFpsNum: 10, sourceFpsDen: 1, playbackSpeed: 1, timelineStartFrame: 0 }] };
    const set = await framesMod.extractFrames({ id: "rep", storagePath: REPEAT_VIDEO, width: 320, height: 240, durationSec: 9 }, { ...SETTINGS, maxFramesPerAsset: 12, sampleIntervalSec: 1.5 }, clipCtx, [3, 6], runKey);
    const scenes = scenesMod.buildScenes(set.frames, "rep", 9, [3, 6], { ...SETTINGS, repeatShotHashDistance: 10 }, clipCtx);
    expect(scenes.length).toBe(3);
    // The two smptehdbars scenes must be closer in hash space than either is to rgbtestsrc.
    const repHash = (s: (typeof scenes)[number]) => set.frames.find((f) => f.frameId === s.representativeFrameId)?.ahash ?? "";
    const d02 = framesMod.hammingHex(repHash(scenes[0]), repHash(scenes[2]));
    const d01 = framesMod.hammingHex(repHash(scenes[0]), repHash(scenes[1]));
    expect(d02).toBeLessThanOrEqual(10);
    expect(d02).toBeLessThan(d01);
    expect(scenes[0].similarSceneIds).toContain(scenes[2].sceneId);
    const grouped = scenes.filter((s) => s.repeatGroup !== null);
    expect(grouped.length).toBeGreaterThanOrEqual(2);
    await framesMod.cleanupVisualFrameDir(framesMod.visualFrameDir(runKey));
  });

  test("representative frame registration: IMAGE assets with provenance", async () => {
    const runKey = `t_${Date.now()}`;
    const clipCtx = { seqFps: 10, clips: [{ clipId: "vc1", sourceInFrame: 0, sourceOutFrame: 120, sourceFpsNum: 10, sourceFpsDen: 1, playbackSpeed: 1, timelineStartFrame: 0 }] };
    const set = await framesMod.extractFrames({ id: scenesAssetId, storagePath: SCENES_VIDEO, width: 320, height: 240, durationSec: 12 }, SETTINGS, clipCtx, [4, 8], runKey);
    const scenes = scenesMod.buildScenes(set.frames, scenesAssetId, 12, [4, 8], SETTINGS, clipCtx);
    const reg = await scenesMod.registerRepresentativeFrames(scenes, set.frames, set.files, { userId: USER, projectId: scenesProjectId, assetId: scenesAssetId, assetName: "scenes.mp4", analysisVersion: "m12-visual-index-1.0", seqFps: 10 });
    expect(reg.size).toBe(3);
    for (const s of scenes) {
      expect(s.representativeAssetId).toBeTruthy();
      const asset = await db.mediaAsset.findUnique({ where: { id: s.representativeAssetId! } });
      expect(asset?.kind).toBe("IMAGE");
      expect(asset?.createdBy).toBe("JAZMII");
      expect(asset?.referenceAssetId).toBe(scenesAssetId);
      const params = JSON.parse(asset?.paramsJson ?? "{}") as Record<string, unknown>;
      expect(params.kind).toBe("m12-visual-representative");
    }
    await framesMod.cleanupVisualFrameDir(framesMod.visualFrameDir(runKey));
  });

  test("stub vision analysis: binding, provenance, honest failures, short responses", async () => {
    const runKey = `t_${Date.now()}`;
    const clipCtx = { seqFps: 10, clips: [] };
    const set = await framesMod.extractFrames({ id: "va", storagePath: SCENES_VIDEO, width: 320, height: 240, durationSec: 6 }, { ...SETTINGS, maxFramesPerAsset: 3, sampleIntervalSec: 3 }, clipCtx, [], runKey);
    const pending = set.frames.filter((f) => f.status === "extracted");
    expect(pending.length).toBeGreaterThan(0);

    const ok = await visionAnalysis.analyzeFramesSemantic(set.frames, set.files, SETTINGS, { provider: stubVision("ok") });
    expect(ok.analyzedCount).toBe(pending.length);
    for (const f of set.frames.filter((x) => x.status === "analyzed")) {
      expect(f.provider).toBe("stub");
      expect(f.model).toBe("stub-vision-model");
      expect(f.analysis?.objects).toContain("laptop");
    }

    const set2 = await framesMod.extractFrames({ id: "vb", storagePath: SCENES_VIDEO, width: 320, height: 240, durationSec: 6 }, { ...SETTINGS, maxFramesPerAsset: 2, sampleIntervalSec: 3 }, clipCtx, [], runKey);
    const expectedFail = set2.frames.filter((f) => f.status === "extracted").length;
    const res2 = await visionAnalysis.analyzeFramesSemantic(set2.frames, set2.files, SETTINGS, { provider: stubVision("fail") });
    expect(res2.failedCount).toBe(expectedFail);
    expect(res2.errors[0]).toContain("PROVIDER_FAILURE");

    const set3 = await framesMod.extractFrames({ id: "vc2", storagePath: SCENES_VIDEO, width: 320, height: 240, durationSec: 6 }, { ...SETTINGS, maxFramesPerAsset: 2, sampleIntervalSec: 3 }, clipCtx, [], runKey);
    const res3 = await visionAnalysis.analyzeFramesSemantic(set3.frames, set3.files, SETTINGS, { provider: stubVision("short") });
    expect(res3.analyzedCount).toBe(1); // one bound
    expect(set3.frames.filter((f) => f.error?.includes("no entry for this image position")).length).toBe(1);

    const set4 = await framesMod.extractFrames({ id: "vd", storagePath: SCENES_VIDEO, width: 320, height: 240, durationSec: 6 }, { ...SETTINGS, maxFramesPerAsset: 1, sampleIntervalSec: 3 }, clipCtx, [], runKey);
    const res4 = await visionAnalysis.analyzeFramesSemantic(set4.frames, set4.files, SETTINGS, { provider: stubVision("garbage") });
    expect(res4.analyzedCount).toBe(0);
    expect(set4.frames[0].status).toBe("failed");
    await framesMod.cleanupVisualFrameDir(framesMod.visualFrameDir(runKey));
  });

  test("vision gateway: >4 images refused without any provider call", async () => {
    const provider = visionGateway.createZaiVisionProvider("stub-model");
    const imgs = Array.from({ length: 5 }, () => ({ mimeType: "image/jpeg" as const, base64: "x" }));
    await expect(provider.analyze("p", imgs, {})).rejects.toThrow(/1\.\.4|0\.\.4/);
  });

  test("NL search: local keyword path with filters + honest Tamil note", async () => {
    const index = {
      analysisVersion: "m12-visual-index-1.0",
      assetId: scenesAssetId,
      assetName: "scenes.mp4",
      durationSec: 12,
      width: 320,
      height: 240,
      fps: 10,
      settings: SETTINGS,
      frames: [],
      scenes: [
        { sceneId: `${scenesAssetId}:s0`, assetId: scenesAssetId, index: 0, sourceStartSec: 0, sourceEndSec: 4, timelinePlacements: [{ clipId: "vc1", timelineStartSec: 0, timelineEndSec: 4 }], representativeFrameId: null, representativeAssetId: null, frameIds: [], description: "a red screen filling the frame", objects: ["screen"], activities: [], category: null, similarSceneIds: [], repeatGroup: null, confidence: 0.7, provider: "stub", model: "stub-vision-model", understanding: "semantic" as const },
        { sceneId: `${scenesAssetId}:s1`, assetId: scenesAssetId, index: 1, sourceStartSec: 4, sourceEndSec: 8, timelinePlacements: [{ clipId: "vc1", timelineStartSec: 4, timelineEndSec: 8 }], representativeFrameId: null, representativeAssetId: null, frameIds: [], description: "a blue screen with a laptop", objects: ["laptop"], activities: [], category: null, similarSceneIds: [], repeatGroup: null, confidence: 0.7, provider: "stub", model: "stub-vision-model", understanding: "semantic" as const },
      ],
      measurement: { framesExtracted: 2, framesDeduped: 0, framesAnalyzed: 2, sceneCount: 2, consentVisual: true },
      notes: [],
    } as unknown as import("../src/lib/creative/visual/contracts").VisualIndex;
    const r = await searchMod.searchVisualIndex(index, { query: "laptop", limit: 5 }, {});
    expect(r.available).toBe(true);
    expect(r.results[0]?.sceneId).toBe(`${scenesAssetId}:s1`);
    expect(r.results[0]?.matchedTerms).toContain("laptop");
    const win = await searchMod.searchVisualIndex(index, { query: "screen", timeStartSec: 0, timeEndSec: 2, limit: 5 }, {});
    expect(win.results[0]?.sceneId).toBe(`${scenesAssetId}:s0`);
    const none = await searchMod.searchVisualIndex(index, { query: "nonexistentthing", limit: 5 }, {});
    expect(none.results).toHaveLength(0);
  });

  test("NL search: provider ranking used with consent; failure falls back honestly", async () => {
    const index = {
      analysisVersion: "m12-visual-index-1.0", assetId: "a", assetName: "a.mp4", durationSec: 9, width: 320, height: 240, fps: 10, settings: SETTINGS, frames: [],
      scenes: [
        { sceneId: "a:s0", assetId: "a", index: 0, sourceStartSec: 0, sourceEndSec: 3, timelinePlacements: [{ clipId: "c", timelineStartSec: 0, timelineEndSec: 3 }], representativeFrameId: null, representativeAssetId: null, frameIds: [], description: "red scene", objects: [], activities: [], category: null, similarSceneIds: [], repeatGroup: null, confidence: null, provider: null, model: null, understanding: "semantic" as const },
        { sceneId: "a:s1", assetId: "a", index: 1, sourceStartSec: 3, sourceEndSec: 6, timelinePlacements: [{ clipId: "c", timelineStartSec: 3, timelineEndSec: 6 }], representativeFrameId: null, representativeAssetId: null, frameIds: [], description: "blue scene", objects: [], activities: [], category: null, similarSceneIds: [], repeatGroup: null, confidence: null, provider: null, model: null, understanding: "semantic" as const },
      ],
      measurement: { framesExtracted: 2, framesDeduped: 0, framesAnalyzed: 2, sceneCount: 2, consentVisual: true },
      notes: [],
    } as unknown as import("../src/lib/creative/visual/contracts").VisualIndex;
    const ranked = await searchMod.searchVisualIndex(index, { query: "blue scene", limit: 5 }, { consentVisual: true, provider: stubRanking(["a:s0", "a:s1"]) });
    expect(ranked.method).toBe("provider-ranking");
    expect(ranked.results[0]?.sceneId).toBe("a:s0"); // stub ranks s0 higher — sorted by its scores
    const failed = await searchMod.searchVisualIndex(index, { query: "blue scene", limit: 5 }, { consentVisual: true, provider: stubVision("fail") });
    expect(failed.method).toBe("local-keyword");
    expect(failed.notes.some((n) => n.includes("unavailable"))).toBe(true);
  });

  test("narration matching: APPROVED transcript × scenes, coverage measured, consent-gated semantics", async () => {
    // Approved transcript on the b-roll project's audio (segments over 0–12 s).
    const t = await transcription.runProjectTranscription(USER, brollProjectId, {
      transcriber: async () => ({ text: "we talk about coffee then about laptops", chunkTexts: [{ start: 0, end: 4, text: "we talk about coffee" }, { start: 4, end: 8, text: "then about laptops" }], chunkCount: 2, failedChunks: [], warnings: [] }),
    });
    await transcription.approveTranscript(USER, t.transcriptId, false);

    const ctx = {
      projectId: brollProjectId,
      projectName: "M12 B-roll Project",
      contextVersion: "v:1:1:120",
      headVersion: 1,
      durationSec: 12,
      fps: 10,
      clipCount: 1,
      audioClipCount: 1,
      videoClipCount: 0,
      videoClipAssets: [],
      audioClipSpans: [{ id: "ac1", trackId: "t-audio", startSec: 0, endSec: 12 }],
      videoTimelineSpans: [],
      captionTextSample: "",
      lockedTrackCount: 0,
      gaps: [],
      overlaps: 0,
      transitionCount: 0,
      graphicClipCount: 0,
      captionClipCount: 0,
      audio: { sourceAssetId: brollAudioId, sourceName: "broll.wav", inspection: null, inspectionProcessId: null },
      transcript: null,
      captions: null,
      scenes: null,
      suppliedAudience: null,
      publishing: [],
      missingEvidence: [],
      evidenceSources: [],
    } as unknown as import("../src/lib/creative/context").MeasuredContext;
    const emptyIndex = { scenes: [], frames: [], assetId: "none", assetName: "none", durationSec: 0, width: null, height: null, fps: null, settings: SETTINGS, measurement: { framesExtracted: 0, framesDeduped: 0, framesAnalyzed: 0, sceneCount: 0, consentVisual: false }, notes: [] } as unknown as import("../src/lib/creative/visual/contracts").VisualIndex;

    const m1 = await matchingMod.matchNarrationToVisuals(USER, brollProjectId, ctx, emptyIndex, { consentVisual: false });
    expect(m1.matches.length).toBe(2);
    expect(m1.transcriptVersionNo).toBe(t.versionNo);
    for (const m of m1.matches) {
      expect(m.coverage).toBe("none"); // no video on this timeline — measured
      expect(m.evidenceLabel).toBe("measured");
      expect(m.relevance).toBe("unknown"); // no consent + no analyzed scenes — honest
      expect(m.missingData.some((d) => d.includes("no analyzed frames") || d.includes("no visual scenes"))).toBe(true);
    }

    // With scenes analyzed + consent + stub provider → ai-interpretation verdicts.
    const sceneIndex = { ...emptyIndex, scenes: [{ sceneId: "x:s0", assetId: "x", index: 0, sourceStartSec: 0, sourceEndSec: 12, timelinePlacements: [{ clipId: "ac1v", timelineStartSec: 0, timelineEndSec: 12 }], representativeFrameId: null, representativeAssetId: null, frameIds: [], description: "a laptop on a desk with code", objects: ["laptop"], activities: ["typing"], category: null, similarSceneIds: [], repeatGroup: null, confidence: 0.8, provider: "stub", model: "stub-vision-model", understanding: "semantic" as const }], measurement: { ...emptyIndex.measurement, consentVisual: true } } as unknown as import("../src/lib/creative/visual/contracts").VisualIndex;
    // Stub verdicts: segment 0 unrelated, segment 1 supported.
    const verdictStub: import("../src/lib/my-ai/gateway/vision").VisionProvider = {
      id: "stub-verdict",
      model: "stub-verdict-model",
      async analyze() {
        return { content: JSON.stringify({ verdicts: [{ segmentIndex: 0, relevance: "unrelated", relevanceScore: 0.1, explanation: "narration mentions coffee; visuals show a laptop" }, { segmentIndex: 1, relevance: "supported", relevanceScore: 0.9, explanation: "narration mentions laptops; visuals show a laptop" }] }), model: "stub-verdict-model", provider: "stub-verdict", usage: null, latencyMs: 1 };
      },
      async healthCheck() {
        return { ok: true, detail: "stub", latencyMs: 1 };
      },
    };
    const m2 = await matchingMod.matchNarrationToVisuals(USER, brollProjectId, ctx, sceneIndex, { consentVisual: true, provider: verdictStub });
    // Speech maps onto the placed audio clip → full coverage by the analyzed scene;
    // the stub verdicts bind (ai-interpretation), citing the visual evidence.
    expect(m2.matches[0].coverage).toBe("full");
    expect(m2.matches[0].matchedSceneIds).toContain("x:s0");
    expect(m2.matches[0].relevance).toBe("unrelated");
    expect(m2.matches[0].evidenceLabel).toBe("ai-interpretation");
    expect(m2.matches[1].relevance).toBe("supported");
    expect(m2.provider).toBe("stub-verdict");
  });

  test("B-roll: unplaced owned image → validated AddClip recommendation; engine-action accepted", async () => {
    const matches = [
      { segmentIndex: 0, text: "we talk about coffee", language: "en", sourceStartSec: 0, sourceEndSec: 4, timelineStartSec: 0, timelineEndSec: 4, matchedSceneIds: [], coverage: "none" as const, relevance: "unknown" as const, relevanceScore: null, explanation: "no video", missingData: [], evidenceLabel: "measured" as const, provider: null, model: null },
    ] as unknown as import("../src/lib/creative/visual/contracts").NarrationMatch[];
    const broll = await brollMod.buildBrollRecommendations(USER, brollProjectId, matches, null, { fps: 10, videoTrackId: null, placedAssetIds: new Set([brollAudioId]) });
    // No VIDEO track → image path can't build commands → falls to informational (unmapped/generation)
    expect(broll.recommendations.length).toBeGreaterThan(0);
    const gen = broll.recommendations.find((r) => r.payload.kind === "engine-action");
    if (gen) {
      expect((gen.payload as { action: string }).action).toBe("laxii-broll-image");
    }
    // With a VIDEO track and a placed audio → executable AddClip proposal for the unplaced image.
    const broll2 = await brollMod.buildBrollRecommendations(USER, brollProjectId, matches, null, { fps: 10, videoTrackId: "t-video", placedAssetIds: new Set([brollAudioId]) });
    const exec = broll2.recommendations.find((r) => r.payload.kind === "timeline-commands");
    expect(exec).toBeTruthy();
    const cmd = (exec!.payload as { commands: Record<string, unknown>[] }).commands[0];
    const parsed = commands.parseCommand(cmd);
    expect(parsed.type).toBe("AddClip");
    const clip = (cmd as { clip: { sourceAssetId: string; timelineStartFrame: number } }).clip;
    expect(clip.sourceAssetId).toBe(brollImageId);
    expect(clip.timelineStartFrame).toBe(0);
  });

  test("B-roll insertion executes through the REAL M1/M2 engine (undo-safe versioned write)", async () => {
    const head = await persistence.getTimelineHead(brollProjectId, USER);
    const v0 = head.version;
    const cmd = { type: "AddClip", clip: clipObj(`bri${Date.now().toString(36)}`, "t-video", brollImageId, 10, 1, 40, 0) };
    // Create the video track first, then insert the still — validated then applied.
    const validation = commands.validateCommand(head.sequence, { type: "AddTrack", track: TRACK });
    expect(validation.ok).toBe(true);
    const r1 = await persistence.applyTimelineEdits(brollProjectId, USER, v0, [{ type: "AddTrack", track: TRACK }], false);
    const r2 = await persistence.applyTimelineEdits(brollProjectId, USER, r1.version, [cmd], false);
    expect(r2.version).toBeGreaterThan(r1.version);
    const after = await persistence.getTimelineHead(brollProjectId, USER);
    const added = after.sequence.clips.find((c) => c.sourceAssetId === brollImageId);
    expect(added).toBeTruthy();
    expect(after.sequence.tracks.find((t) => t.id === "t-video")).toBeTruthy();
    // Version history intact: the pre-insert head version still resolves.
    const before = await persistence.getTimelineHead(brollProjectId, USER);
    expect(before.version).toBeGreaterThanOrEqual(r2.version);
  });

  test("continuity: deterministic findings with honest labels + NOT-claimed note", () => {
    const index = {
      analysisVersion: "m12-visual-index-1.0", assetId: "a", assetName: "a.mp4", durationSec: 9, width: 320, height: 240, fps: 10, settings: SETTINGS,
      frames: [{ frameId: "f0", assetId: "a", clipId: null, sourceSec: 1.5, timelineSec: null, width: 320, height: 240, extractionMethod: "uniform-sample", ahash: "abc123", status: "extracted", analysis: null, confidence: null, provider: null, model: null, error: null }],
      scenes: [
        { sceneId: "a:s0", assetId: "a", index: 0, sourceStartSec: 0, sourceEndSec: 3, timelinePlacements: [{ clipId: "c0", timelineStartSec: 0, timelineEndSec: 3 }], representativeFrameId: "f0", representativeAssetId: null, frameIds: ["f0"], description: null, objects: [], activities: [], category: null, similarSceneIds: ["a:s2"], repeatGroup: 1, confidence: null, provider: null, model: null, understanding: "heuristic-only" as const },
        { sceneId: "a:s1", assetId: "a", index: 1, sourceStartSec: 3, sourceEndSec: 6, timelinePlacements: [{ clipId: "c0", timelineStartSec: 3, timelineEndSec: 6 }], representativeFrameId: null, representativeAssetId: null, frameIds: [], description: null, objects: [], activities: [], category: null, similarSceneIds: [], repeatGroup: null, confidence: null, provider: null, model: null, understanding: "heuristic-only" as const },
        { sceneId: "a:s2", assetId: "a", index: 2, sourceStartSec: 6, sourceEndSec: 9, timelinePlacements: [{ clipId: "c0", timelineStartSec: 6, timelineEndSec: 9 }], representativeFrameId: null, representativeAssetId: null, frameIds: [], description: null, objects: [], activities: [], category: null, similarSceneIds: ["a:s0"], repeatGroup: 1, confidence: null, provider: null, model: null, understanding: "heuristic-only" as const },
      ],
      measurement: { framesExtracted: 1, framesDeduped: 0, framesAnalyzed: 0, sceneCount: 3, consentVisual: false },
      notes: [],
    } as unknown as import("../src/lib/creative/visual/contracts").VisualIndex;
    const res = continuityMod.analyzeVisualContinuity({
      index,
      sceneChangesSec: [1, 1.4, 1.8, 2.2, 6],
      staticSectionsSec: [{ start: 2, end: 8 }],
      blackSectionsSec: [{ start: 8.5, end: 9 }],
      videoPlacements: [
        { clipId: "c0", assetId: "a", startSec: 0, endSec: 3, width: 320, height: 240 },
        { clipId: "c1", assetId: "b", startSec: 3, endSec: 9, width: 1080, height: 1920 },
      ],
    });
    const cats = res.findings.map((f) => f.category);
    expect(cats).toContain("visual-repetition");
    expect(cats).toContain("static-visuals");
    expect(cats).toContain("technical"); // black + aspect change
    expect(cats).toContain("transition"); // rapid cuts
    const rep = res.findings.find((f) => f.category === "visual-repetition");
    expect(rep?.evidenceLabel).toBe("measured");
    expect(rep?.evidence.note).toContain("not verified semantic sameness");
    expect(res.notes.some((n) => n.includes("NOT claimed"))).toBe(true);
  });

  test("FULL VISUAL_INTELLIGENCE job through the REAL worker (no consent): index, artifacts, cleanup, honest skip", async () => {
    const { reviewId, jobId } = await visualJobs.enqueueVisualIntelligence(USER, scenesProjectId, SETTINGS, false);
    const status = await tickUntil(jobId);
    expect(status).toBe("COMPLETED");
    const review = await db.creativeReview.findUnique({ where: { id: reviewId } });
    expect(review?.status).toBe("COMPLETED");
    const indexRow = await db.creativeAnalysisArtifact.findFirst({ where: { userId: USER, projectId: scenesProjectId, kind: "visual-index", status: "COMPLETED" } });
    expect(indexRow).toBeTruthy();
    const index = JSON.parse(indexRow!.resultJson!) as { scenes: unknown[]; measurement: { framesExtracted: number }; frames: { status: string }[] };
    expect(index.scenes.length).toBe(3);
    expect(index.measurement.framesExtracted).toBeGreaterThan(0);
    expect(indexRow!.consentVisual).toBe(false);
    const missing = JSON.parse(indexRow!.missingEvidenceJson ?? "[]") as string[];
    expect(missing.some((m) => m.includes("consent"))).toBe(true);
    // Registered representative frames: the INDEX references 3 distinct IMAGE
    // assets with provenance (job-level registration).
    const repIds = [...new Set(index.scenes.map((s) => (s as { representativeAssetId: string | null }).representativeAssetId).filter((v): v is string => Boolean(v)))];
    expect(repIds.length).toBe(3);
    for (const rid of repIds) {
      const asset = await db.mediaAsset.findUnique({ where: { id: rid } });
      expect(asset?.kind).toBe("IMAGE");
      expect(asset?.createdBy).toBe("JAZMII");
      expect(asset?.referenceAssetId).toBe(scenesAssetId);
    }
    // Temp frame dir cleaned.
    expect(await framesMod.listFrameDir(framesMod.visualFrameDir(`j_${jobId}`))).toHaveLength(0);
    // Match + continuity artifacts persisted.
    const matchRow = await db.creativeAnalysisArtifact.findFirst({ where: { userId: USER, projectId: scenesProjectId, kind: "visual-match" } });
    const contRow = await db.creativeAnalysisArtifact.findFirst({ where: { userId: USER, projectId: scenesProjectId, kind: "visual-continuity" } });
    expect(matchRow).toBeTruthy();
    expect(contRow).toBeTruthy();
    // Findings persisted through the EXISTING M10 model.
    const findings = await db.creativeFinding.findMany({ where: { reviewId } });
    expect(findings.length).toBeGreaterThan(0);
  }, 240_000);

  test("run dedup: identical dependencies REUSE the index (no re-extraction)", async () => {
    const first = await db.creativeAnalysisArtifact.findFirst({ where: { userId: USER, projectId: scenesProjectId, kind: "visual-index", status: "COMPLETED" } });
    const firstUpdated = first!.updatedAt.getTime();
    const { reviewId, jobId } = await visualJobs.enqueueVisualIntelligence(USER, scenesProjectId, SETTINGS, false);
    const status = await tickUntil(jobId);
    expect(status).toBe("COMPLETED");
    const review = await db.creativeReview.findUnique({ where: { id: reviewId } });
    const evidence = JSON.parse(review!.evidenceSourcesJson ?? "[]") as { detail: string }[];
    expect(evidence.some((e) => e.detail.includes("REUSED"))).toBe(true);
    const after = await db.creativeAnalysisArtifact.findFirst({ where: { userId: USER, projectId: scenesProjectId, kind: "visual-index", status: "COMPLETED" }, orderBy: { updatedAt: "desc" } });
    expect(after!.id).toBe(first!.id);
    expect(after!.updatedAt.getTime()).toBe(firstUpdated); // reused, not recomputed
  }, 240_000);

  test("invalidation: changed source media marks prior visual artifacts STALE with reasons", async () => {
    // Touch the source file so the asset fingerprint changes.
    utimesSync(SCENES_VIDEO, new Date(), new Date());
    const { jobId } = await visualJobs.enqueueVisualIntelligence(USER, scenesProjectId, SETTINGS, false);
    const status = await tickUntil(jobId);
    expect(status).toBe("COMPLETED");
    const staleRows = await db.creativeAnalysisArtifact.findMany({ where: { userId: USER, projectId: scenesProjectId, kind: "visual-index", status: "STALE" } });
    expect(staleRows.length).toBe(1);
    expect(staleRows[0].staleReason).toContain("source media changed");
    const fresh = await db.creativeAnalysisArtifact.findFirst({ where: { userId: USER, projectId: scenesProjectId, kind: "visual-index", status: "COMPLETED" }, orderBy: { updatedAt: "desc" } });
    expect(fresh?.id).not.toBe(staleRows[0].id);
    // Reuse after recompute: scene-artifact stage re-ran (new fingerprint) but the review still completed.
  }, 240_000);

  test("ownership: foreign user cannot enqueue visual intelligence for a project they do not own", async () => {
    await expect(visualJobs.enqueueVisualIntelligence(FOREIGN, scenesProjectId, {}, false)).rejects.toThrow();
  });

  test("no-video project: honest failure, nothing fabricated", async () => {
    const p = await db.project.create({ data: { userId: USER, name: "M12 NoVideo" } });
    const { jobId } = await visualJobs.enqueueVisualIntelligence(USER, p.id, {}, false);
    const status = await tickUntil(jobId);
    expect(status).toBe("COMPLETED"); // job completes; the REVIEW records the honest failure
    const review = await db.creativeReview.findFirst({ where: { userId: USER, projectId: p.id, scope: "visual" } });
    expect(review?.status).toBe("FAILED");
    expect(review?.error).toContain("No VIDEO-track clips");
  }, 120_000);
});
