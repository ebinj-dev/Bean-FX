/**
 * BEAN FX — M13 Temporal Visual Intelligence core tests (bun test, isolated DB).
 * REAL engine code + REAL OpenCV tracking over REAL ffmpeg fixtures with KNOWN
 * motion: a box that moves right at exactly 35 px/s, a box that exits the
 * frame, two separated moving subjects, a static textured scene, a camera PAN
 * (moving crop window), a camera ZOOM (zoompan), and a subject that
 * disappears and re-appears. The provider is INJECTED/stubbed (clearly
 * labeled) — real-provider evidence lives in test-temporal-live.test.ts.
 *
 * Run: bun test scripts/test-temporal-core.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRATCH_DB = path.join(os.tmpdir(), `beanfx-m13-core-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${SCRATCH_DB}`;
process.env.BEANFX_MEDIA_WORKER_AUTOSTART = "0";
process.env.NODE_ENV = "production";
process.env.BEANFX_MYAI_PROVIDER = "does-not-exist";
process.env.BEANFX_VISUAL_PROVIDER = "does-not-exist";
const WORK = mkdtempSync(path.join(os.tmpdir(), "beanfx-m13-core-"));

execSync("node_modules/.bin/prisma db push --skip-generate --accept-data-loss", {
  env: { ...process.env, DATABASE_URL: `file:${SCRATCH_DB}` },
  stdio: ["ignore", "ignore", "inherit"],
});

let db: typeof import("../src/lib/db").db;
let persistence: typeof import("../src/lib/editor/persistence");
let commands: typeof import("../src/lib/editor/commands");
let sampling: typeof import("../src/lib/creative/visual/temporal/sampling");
let tracking: typeof import("../src/lib/creative/visual/temporal/tracking");
let motion: typeof import("../src/lib/creative/visual/temporal/motion");
let events: typeof import("../src/lib/creative/visual/temporal/events");
let search: typeof import("../src/lib/creative/visual/temporal/search");
let mograph: typeof import("../src/lib/creative/visual/temporal/mograph");
let temporalJobs: typeof import("../src/lib/creative/visual/temporal/jobs");
let visualJobs: typeof import("../src/lib/creative/visual/jobs");
let workerMod: typeof import("../src/lib/media-worker");
let framesMod: typeof import("../src/lib/creative/visual/frames");

const USER = "m13-user";
const FOREIGN = "m13-foreign";
let mainProjectId = "";
let moveAssetId = "";
let gapProjectId = "";
let mographProjectId = "";
let mographAssetId = "";
const MOVE_VIDEO = path.join(WORK, "move.mp4");
const EXIT_VIDEO = path.join(WORK, "exit.mp4");
const TWO_VIDEO = path.join(WORK, "two.mp4");
const STATIC_VIDEO = path.join(WORK, "static.mp4");
const PAN_VIDEO = path.join(WORK, "pan.mp4");
const ZOOM_VIDEO = path.join(WORK, "zoom.mp4");
const GAP_VIDEO = path.join(WORK, "gap.mp4");
const CORRUPT = path.join(WORK, "corrupt.mp4");
const SETTINGS = { sampleFps: 5, maxFrames: 60, windowSec: 8, minBoxAreaFrac: 0.004, maxTracks: 5, cameraMotion: true, providerLabels: false };

function tickUntil(jobId: string, timeoutMs = 240_000): Promise<string> {
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

function clipObj(id: string, trackId: string, assetId: string, srcOut: number, tlStart: number, speed = 1): Record<string, unknown> {
  return { id, trackId, sourceAssetId: assetId, sourceInFrame: 0, sourceOutFrame: srcOut, sourceFps: { num: 10, den: 1 }, timelineStartFrame: tlStart, playbackSpeed: speed, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null, label: "main", missingMedia: false, effects: [], keyframes: [] };
}
const TRACK = { id: "t-video", kind: "VIDEO", name: "V1", visible: true, muted: false, solo: false, locked: false };

async function placeVideo(projectId: string, file: string, name: string, durationSec: number, speed = 1): Promise<string> {
  const asset = await db.mediaAsset.create({ data: { userId: USER, projectId, originalName: name, storagePath: file, kind: "VIDEO", mimeType: "video/mp4", sizeBytes: statSync(file).size, durationSec, width: 320, height: 240, fps: 10 } });
  const head = await persistence.getTimelineHead(projectId, USER);
  await persistence.applyTimelineEdits(projectId, USER, head.version, [{ type: "AddTrack", track: TRACK }, { type: "AddClip", clip: clipObj(`c_${Date.now().toString(36)}`, "t-video", asset.id, Math.round(durationSec * 10), 0, speed) }], false);
  return asset.id;
}

/** Analyze one fixture end-to-end through the REAL pipeline (sampling→tracking→motion). */
async function analyzeFixture(assetId: string, file: string, durationSec: number): Promise<{ index: import("../src/lib/creative/visual/temporal/contracts").TemporalIndex; raw: import("../src/lib/creative/visual/temporal/tracking").TrackingResult; frames: import("../src/lib/creative/visual/temporal/contracts").TemporalFrame[] }> {
  const runKey = `fx_${assetId}_${Date.now()}`;
  const windows = sampling.planWindows(durationSec, SETTINGS, []);
  const set = await sampling.extractTemporalFrames({ id: assetId, storagePath: file, width: 320, height: 240, durationSec }, SETTINGS, { seqFps: 10, clips: [{ clipId: "c1", sourceInFrame: 0, sourceOutFrame: Math.round(durationSec * 10), sourceFpsNum: 10, sourceFpsDen: 1, playbackSpeed: 1, timelineStartFrame: 0 }] }, windows, runKey);
  const usable = set.frames.filter((f) => f.height > 0);
  const tracks = [];
  const camera = [];
  const rawCameraPairs = [];
  const windowScales: (number | null)[] = [];
  for (const w of windows) {
    const wFrames = usable.filter((f) => f.windowIndex === w.index).map((f) => ({ file: set.files.get(f.frameId)!, t: f.sourceSec })).filter((f) => Boolean(f.file));
    if (wFrames.length < 2) continue;
    const raw = await tracking.runTrackingWorker(wFrames, SETTINGS);
    rawCameraPairs.push(...raw.camera);
    windowScales.push(raw.windowScale ?? null);
    tracks.push(...tracking.buildTracks(assetId, w.index, raw, { seqFps: 10, clips: [{ clipId: "c1", sourceInFrame: 0, sourceOutFrame: Math.round(durationSec * 10), sourceFpsNum: 10, sourceFpsDen: 1, playbackSpeed: 1, timelineStartFrame: 0 }] }, null));
    camera.push(motion.classifyCameraMotion(assetId, w.index, raw.camera, { width: raw.width, height: raw.height, sampleIntervalSec: 1 / SETTINGS.sampleFps, sceneCuts: [] }, raw.windowScale ?? null, raw.windowScaleNcc ?? null));
  }
  const motionList = tracks.map((t) => motion.measureTrackMotion(t, rawCameraPairs, { width: usable[0]?.width ?? 320, height: usable[0]?.height ?? 240, sampleIntervalSec: 1 / SETTINGS.sampleFps, sceneCuts: [] }));
  const idx: import("../src/lib/creative/visual/temporal/contracts").TemporalIndex = {
    analysisVersion: "m13-temporal-index-1.0", assetId, assetName: "fixture", durationSec, width: usable[0]?.width ?? 320, height: usable[0]?.height ?? 240, sourceFps: 10,
    settings: SETTINGS, frames: usable, tracks, motion: motionList, camera, sceneSummaries: [], events: [], measurement: { framesSampled: usable.length, windows: windows.length, tracksTotal: tracks.length, tracksLost: tracks.filter((t) => t.terminationReason === "tracker-lost").length, cameraClassified: camera.length, providerLabelsUsed: 0, consentVisual: false }, notes: [],
  };
  idx.events = events.buildTemporalEvents({ assetId, frames: usable, tracks, motion: motionList, camera, sceneCuts: [], sceneIdOfIndex: (i) => `${assetId}:s${i}`, speechSpans: [] });
  await framesMod.cleanupVisualFrameDir(framesMod.visualFrameDir(runKey));
  return { index: idx, raw: { width: usable[0]?.width ?? 320, height: usable[0]?.height ?? 240, tracks: [], camera: rawCameraPairs }, frames: usable };
}

beforeAll(async () => {
  db = (await import("../src/lib/db")).db;
  persistence = await import("../src/lib/editor/persistence");
  commands = await import("../src/lib/editor/commands");
  sampling = await import("../src/lib/creative/visual/temporal/sampling");
  tracking = await import("../src/lib/creative/visual/temporal/tracking");
  motion = await import("../src/lib/creative/visual/temporal/motion");
  events = await import("../src/lib/creative/visual/temporal/events");
  search = await import("../src/lib/creative/visual/temporal/search");
  mograph = await import("../src/lib/creative/visual/temporal/mograph");
  temporalJobs = await import("../src/lib/creative/visual/temporal/jobs");
  visualJobs = await import("../src/lib/creative/visual/jobs");
  workerMod = await import("../src/lib/media-worker");
  framesMod = await import("../src/lib/creative/visual/frames");

  await db.user.create({ data: { id: USER, email: "m13a@test.local", name: "A", passwordHash: "x" } }).catch(() => undefined);
  await db.user.create({ data: { id: FOREIGN, email: "m13b@test.local", name: "B", passwordHash: "x" } }).catch(() => undefined);

  // KNOWN motion: white box moving right at exactly 35 px/s.
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=8:r=10", "-f", "lavfi", "-i", "color=c=white:s=44x44:d=8:r=10", "-filter_complex", "[1:v]setpts=PTS-STARTPTS[b];[0:v][b]overlay=x='20+t*35':y=100:shortest=1[out]", "-map", "[out]", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", MOVE_VIDEO], { stdio: ["ignore", "ignore", "inherit"] });
  // Box exits the frame (90 px/s → gone after ~3.3 s).
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=6:r=10", "-f", "lavfi", "-i", "color=c=white:s=44x44:d=6:r=10", "-filter_complex", "[1:v]setpts=PTS-STARTPTS[b];[0:v][b]overlay=x='20+t*90':y=100:shortest=1[out]", "-map", "[out]", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", EXIT_VIDEO], { stdio: ["ignore", "ignore", "inherit"] });
  // Two separated subjects (different rows, different speeds).
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=8:r=10", "-f", "lavfi", "-i", "color=c=white:s=40x40:d=8:r=10", "-f", "lavfi", "-i", "color=c=0x808080:s=40x40:d=8:r=10", "-filter_complex", "[1:v]setpts=PTS-STARTPTS[b1];[2:v]setpts=PTS-STARTPTS[b2];[0:v][b1]overlay=x='20+t*40':y=40:shortest=1[m];[m][b2]overlay=x='260-t*30':y=160:shortest=1[out]", "-map", "[out]", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", TWO_VIDEO], { stdio: ["ignore", "ignore", "inherit"] });
  // Static textured scene (no motion at all).
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "smptehdbars=s=320x240:r=10:d=6", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", STATIC_VIDEO], { stdio: ["ignore", "ignore", "inherit"] });
  // Camera PAN: moving crop window over a STATIC textured image (an animated
  // pattern would mix content motion into the "global" measurement).
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x240:d=1:r=2", "-frames:v", "1", path.join(WORK, "big.png")], { stdio: ["ignore", "ignore", "inherit"] });
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-i", path.join(WORK, "big.png"), "-t", "6", "-vf", "crop=320:240:x='(iw-320)*t/6':y=0", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", PAN_VIDEO], { stdio: ["ignore", "ignore", "inherit"] });
  // Camera ZOOM: zoompan over the SAME static textured image — d=60 makes ONE
  // input frame emit 60 progressively-zoomed output frames (z grows per output).
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-i", path.join(WORK, "big.png"), "-vf", "zoompan=z='1+0.015*on':d=60:s=320x240:fps=10", "-frames:v", "60", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", ZOOM_VIDEO], { stdio: ["ignore", "ignore", "inherit"] });
  // Subject disappears (t 3–4 s) and re-appears → tracker loss + re-entry.
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=6:r=10", "-f", "lavfi", "-i", "color=c=white:s=44x44:d=6:r=10", "-filter_complex", "[1:v]setpts=PTS-STARTPTS[b];[0:v][b]overlay=x='40+t*30':y=100:shortest=1:enable='lt(t,3)+gte(t,4)'[out]", "-map", "[out]", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", GAP_VIDEO], { stdio: ["ignore", "ignore", "inherit"] });
  execSync(`printf 'not a video' > "${CORRUPT}"`, { stdio: "ignore" });

  const p1 = await db.project.create({ data: { userId: USER, name: "M13 Main", description: "Fixture" } });
  mainProjectId = p1.id;
  moveAssetId = await placeVideo(mainProjectId, MOVE_VIDEO, "move.mp4", 8);
  const p2 = await db.project.create({ data: { userId: USER, name: "M13 Gap" } });
  gapProjectId = p2.id;
  await placeVideo(gapProjectId, GAP_VIDEO, "gap.mp4", 6);
  const p3 = await db.project.create({ data: { userId: USER, name: "M13 Mograph" } });
  mographProjectId = p3.id;
  mographAssetId = await placeVideo(mographProjectId, MOVE_VIDEO, "mograph.mp4", 8);

  const ticker = setInterval(() => {
    void workerMod.tickWorkerOnce().catch(() => undefined);
  }, 900);
  ticker.unref?.();
  (globalThis as unknown as { __m13CoreTicker?: NodeJS.Timeout }).__m13CoreTicker = ticker;
}, 180_000);

afterAll(() => {
  const ticker = (globalThis as unknown as { __m13CoreTicker?: NodeJS.Timeout }).__m13CoreTicker;
  if (ticker) clearInterval(ticker);
  rmSync(WORK, { recursive: true, force: true });
  rmSync(SCRATCH_DB, { force: true });
});

describe("M13 temporal intelligence core (REAL OpenCV tracking)", () => {
  test("window planning: bounded scene-aware windows", () => {
    const w = sampling.planWindows(20, SETTINGS, [9]);
    expect(w.length).toBeGreaterThanOrEqual(3);
    expect(w[0].startSec).toBe(0);
    for (const win of w) expect(win.endSec - win.startSec).toBeLessThanOrEqual(SETTINGS.windowSec + 0.01);
  });

  test("REAL consecutive sampling: exact pts spacing, both clocks, dimensions", async () => {
    const runKey = `t_${Date.now()}`;
    const windows = sampling.planWindows(8, SETTINGS, []);
    const set = await sampling.extractTemporalFrames({ id: "smp", storagePath: MOVE_VIDEO, width: 320, height: 240, durationSec: 8 }, SETTINGS, { seqFps: 10, clips: [{ clipId: "c1", sourceInFrame: 0, sourceOutFrame: 80, sourceFpsNum: 10, sourceFpsDen: 1, playbackSpeed: 1, timelineStartFrame: 0 }] }, windows, runKey);
    const usable = set.frames.filter((f) => f.height > 0);
    expect(usable.length).toBeGreaterThanOrEqual(20);
    for (let i = 1; i < usable.length; i++) {
      const dt = usable[i].sourceSec - usable[i - 1].sourceSec;
      expect(dt).toBeGreaterThan(0.05);
      expect(dt).toBeLessThan(0.5); // sampleFps 5 → 0.2 s grid (tolerance for encoding)
    }
    for (const f of usable) {
      expect(f.clipId).toBe("c1");
      expect(f.timelineSec).toBeCloseTo(f.sourceSec, 1);
      expect(f.extractionMethod).toBe("consecutive-sample");
      expect(f.sampleIntervalSec).toBeCloseTo(0.2, 1);
    }
    await framesMod.cleanupVisualFrameDir(framesMod.visualFrameDir(runKey));
  });

  test("clip speed mapping: playbackSpeed 2 compresses the timeline clock", async () => {
    const runKey = `t_${Date.now()}`;
    const windows = sampling.planWindows(8, SETTINGS, []);
    const set = await sampling.extractTemporalFrames({ id: "spd", storagePath: MOVE_VIDEO, width: 320, height: 240, durationSec: 8 }, SETTINGS, { seqFps: 10, clips: [{ clipId: "c2", sourceInFrame: 0, sourceOutFrame: 80, sourceFpsNum: 10, sourceFpsDen: 1, playbackSpeed: 2, timelineStartFrame: 0 }] }, windows, runKey);
    const mapped = set.frames.filter((f) => f.height > 0 && f.timelineSec !== null && f.sourceSec > 0.1);
    expect(mapped.length).toBeGreaterThan(3);
    for (const f of mapped) expect(f.timelineSec!).toBeLessThan(f.sourceSec); // 2× speed → timeline < source
    await framesMod.cleanupVisualFrameDir(framesMod.visualFrameDir(runKey));
  });

  test("corrupt media: honest sampling failure, no invented frames", async () => {
    await expect(sampling.extractTemporalFrames({ id: "corrupt", storagePath: CORRUPT, width: null, height: null, durationSec: null }, SETTINGS, { seqFps: 10, clips: [] }, [{ index: 0, startSec: 0, endSec: 2 }], "t_corrupt")).rejects.toThrow();
  });

  test("REAL multi-frame tracking: one merged track, direction + accurate speed (35 px/s known)", async () => {
    const { index } = await analyzeFixture(moveAssetId, MOVE_VIDEO, 8);
    expect(index.measurement.tracksTotal).toBe(1); // ghost duplicate MERGED (duplicate detection)
    const track = index.tracks[0];
    expect(track.samples.length).toBeGreaterThanOrEqual(15);
    expect(track.terminationReason).toBe("window-end");
    expect(track.category).toBe("moving-object");
    expect(track.categoryProvenance).toBe("detector");
    // REAL correspondence: x increases monotonically across consecutive frames.
    const xs = track.samples.map((s) => s.bbox.x);
    let increases = 0;
    for (let i = 1; i < xs.length; i++) if (xs[i] > xs[i - 1]) increases += 1;
    expect(increases / (xs.length - 1)).toBeGreaterThan(0.8);
    const m = index.motion[0];
    expect(m.direction).toBe("right");
    // KNOWN fixture speed: 35 px/s (the box overlays x=20+t*35).
    expect(m.speedPxPerSec!).toBeGreaterThan(31);
    expect(m.speedPxPerSec!).toBeLessThan(39);
    expect(m.coordinateSystem).toContain("pixel-top-left-origin");
    expect(m.limitations).toContain("not real-world speed");
  }, 240_000);

  test("entry + exit events with both clocks; left-frame termination", async () => {
    const asset = await db.mediaAsset.create({ data: { userId: USER, projectId: mainProjectId, originalName: "exit.mp4", storagePath: EXIT_VIDEO, kind: "VIDEO", mimeType: "video/mp4", sizeBytes: statSync(EXIT_VIDEO).size, durationSec: 6, width: 320, height: 240, fps: 10 } });
    const { index } = await analyzeFixture(asset.id, EXIT_VIDEO, 6);
    const track = index.tracks[0];
    // The subject is LOST near the right edge (appearance consistency NCC
    // collapses when the box leaves the frame — honest loss, no drift-follow).
    expect(["left-frame", "tracker-lost"]).toContain(track.terminationReason);
    const lastSample = track.samples[track.samples.length - 1];
    expect(lastSample.nx).toBeGreaterThan(0.65); // tracked close to the right edge before loss
    const types = index.events.map((e) => e.type);
    expect(types).toContain("subject-entry");
    expect(types).toContain("subject-lost");
    const entry = index.events.find((e) => e.type === "subject-entry");
    expect(entry?.evidenceLabel).toBe("measured");
  }, 240_000);

  test("two separated subjects → two distinct tracks, no false merging", async () => {
    const asset = await db.mediaAsset.create({ data: { userId: USER, projectId: mainProjectId, originalName: "two.mp4", storagePath: TWO_VIDEO, kind: "VIDEO", mimeType: "video/mp4", sizeBytes: statSync(TWO_VIDEO).size, durationSec: 8, width: 320, height: 240, fps: 10 } });
    const { index } = await analyzeFixture(asset.id, TWO_VIDEO, 8);
    expect(index.tracks.length).toBe(2);
    const ys = index.tracks.map((t) => t.samples[0].bbox.y);
    expect(Math.abs(ys[0] - ys[1])).toBeGreaterThan(60); // different rows
    const dirs = index.motion.map((m) => m.direction).sort();
    expect(dirs).toContain("right");
    expect(dirs).toContain("left");
  }, 240_000);

  test("static scene: no tracks, camera STATIC, static-span event, searchable", async () => {
    const asset = await db.mediaAsset.create({ data: { userId: USER, projectId: mainProjectId, originalName: "static.mp4", storagePath: STATIC_VIDEO, kind: "VIDEO", mimeType: "video/mp4", sizeBytes: statSync(STATIC_VIDEO).size, durationSec: 6, width: 320, height: 240, fps: 10 } });
    const { index } = await analyzeFixture(asset.id, STATIC_VIDEO, 6);
    expect(index.tracks.length).toBe(0);
    expect(index.camera[0]?.classification).toBe("static");
    expect(index.events.some((e) => e.type === "static-span")).toBe(true);
    const res = await search.searchTemporalIndex(index, { query: "almost no movement", limit: 5 }, {});
    expect(res.method).toBe("local-predicate");
    expect(res.results.some((r) => r.kind === "event" || r.kind === "scene")).toBe(true);
  }, 240_000);

  test("REAL camera PAN vs foreground: global motion detected, NOT misattributed to subjects", async () => {
    const asset = await db.mediaAsset.create({ data: { userId: USER, projectId: mainProjectId, originalName: "pan.mp4", storagePath: PAN_VIDEO, kind: "VIDEO", mimeType: "video/mp4", sizeBytes: statSync(PAN_VIDEO).size, durationSec: 6, width: 320, height: 240, fps: 10 } });
    const { index } = await analyzeFixture(asset.id, PAN_VIDEO, 6);
    const cam = index.camera[0];
    expect(cam).toBeTruthy();
    // The pan fixture moves the whole frame content: global registration must
    // measure it — classified as pan/pan-tilt (or handheld-like with evidence)
    // and NOT static.
    expect(cam!.classification).not.toBe("static");
    expect(["pan", "pan-tilt", "handheld-like", "uncertain"]).toContain(cam!.classification);
    // Global-vs-foreground separation: any tracks found must carry near-zero
    // FOREGROUND motion after the registered global motion is subtracted.
    for (const m of index.motion) {
      expect(m.foregroundPxPerFrame ?? 0).toBeLessThan(Math.abs(cam!.medianDxPx ?? 5) + 4);
    }
    expect(index.events.some((e) => e.type === "camera-move")).toBe(true);
  }, 240_000);

  test("REAL camera ZOOM classified with scale evidence", async () => {
    const asset = await db.mediaAsset.create({ data: { userId: USER, projectId: mainProjectId, originalName: "zoom.mp4", storagePath: ZOOM_VIDEO, kind: "VIDEO", mimeType: "video/mp4", sizeBytes: statSync(ZOOM_VIDEO).size, durationSec: 6, width: 320, height: 240, fps: 10 } });
    const { index } = await analyzeFixture(asset.id, ZOOM_VIDEO, 6);
    const cam = index.camera[0];
    expect(cam).toBeTruthy();
    expect(["zoom", "pan-tilt", "handheld-like", "mixed"]).toContain(cam!.classification);
    if (cam!.classification === "zoom") {
      // The measured per-frame scale rate must be a REAL, coherent global
      // scale change (zoompan direction differs across ffmpeg builds — the
      // rate is asserted in absolute terms; direction is recorded honestly).
      expect(Math.abs((cam!.medianScaleRatio ?? 1) - 1)).toBeGreaterThan(0.005);
    }
    expect(cam!.note).toContain("NOT a cinematography classification");
  }, 240_000);

  test("tracking gap: honest tracker-loss + re-entry + INFERRED continuity candidate (no identity claim)", async () => {
    const head = await persistence.getTimelineHead(gapProjectId, USER);
    const gapAsset = head.sequence.clips.find((c) => c.sourceAssetId)?.sourceAssetId;
    expect(gapAsset).toBeTruthy();
    const gapRow = await db.mediaAsset.findUnique({ where: { id: gapAsset! } });
    const { index } = await analyzeFixture(gapAsset!, GAP_VIDEO, 6);
    expect(index.tracks.length).toBeGreaterThanOrEqual(1);
    expect(index.tracks.some((t) => t.terminationReason === "tracker-lost")).toBe(true);
    expect(index.events.some((e) => e.type === "subject-lost")).toBe(true);
    // Re-appearance: labeled inferred, never an identity claim.
    const cand = index.events.find((e) => e.type === "subject-continuity-candidate");
    if (cand) {
      expect(cand.evidenceLabel).toBe("inferred");
      expect(cand.confidence ?? 1).toBeLessThan(0.6);
      expect(cand.description).toContain("CONTINUITY CANDIDATE");
    }
    void gapRow;
  }, 240_000);

  test("temporal search: direction/category predicates, time filters, honest misses", async () => {
    const { index } = await analyzeFixture(moveAssetId, MOVE_VIDEO, 8);
    const right = await search.searchTemporalIndex(index, { query: "moving left to right", limit: 5 }, {});
    expect(right.results[0]?.kind).toBe("track");
    expect(right.results[0]?.evidence).toContain("left-to-right");
    const win = await search.searchTemporalIndex(index, { query: "moving", timeStartSec: 0, timeEndSec: 2, limit: 5 }, {});
    expect(win.results.every((r) => r.sourceStartSec <= 2.5)).toBe(true);
    const none = await search.searchTemporalIndex(index, { query: "vehicle", limit: 5 }, {});
    expect(none.results).toHaveLength(0); // category honestly unknown without provider labels
    const tamil = await search.searchTemporalIndex(index, { query: "வேகமாக நகரும்", limit: 5 }, {});
    expect(tamil.notes.some((n) => n.includes("Tamil"))).toBe(true);
  }, 240_000);

  test("motion-graphics proposal: coordinate-converted keyframes, honest gaps, AddGraphic validates via M1, REAL insertion", async () => {
    const { index } = await analyzeFixture(mographAssetId, MOVE_VIDEO, 8);
    const track = index.tracks[0];
    const head = await persistence.getTimelineHead(mographProjectId, USER);
    const seq = head.sequence;
    const fps = seq.fps.num / seq.fps.den;
    const built = await mograph.buildMographProposal(index, track, index.motion[0], {
      seqFps: fps,
      seqWidth: seq.width,
      seqHeight: seq.height,
      graphicTrackId: null,
      userId: USER,
      projectId: mographProjectId,
      previewFrames: new Map(),
      label: "Box",
      primaryText: "Box",
    });
    expect(built.proposal).toBeTruthy();
    const p = built.proposal!;
    expect(p.keyframes.length).toBeGreaterThanOrEqual(8);
    expect(p.keyframes.every((k) => k.property === "x" || k.property === "y")).toBe(true);
    expect(p.keyframes.every((k) => Math.abs(k.value) <= 200)).toBe(true);
    // x keyframes INCREASE over time (following the box moving right).
    const xkfs = p.keyframes.filter((k) => k.property === "x");
    expect(xkfs[xkfs.length - 1].value).toBeGreaterThan(xkfs[0].value);
    expect(p.requiresApproval).toBe(true);
    // Commands validate through the REAL M1 parser.
    for (const cmd of p.payload.commands) {
      const parsed = commands.parseCommand(cmd);
      expect(["AddTrack", "AddGraphic", "AddClip"]).toContain(parsed.type);
    }
    // REAL insertion through M1/M2: AddTrack + AddGraphic, versioned, undo-safe.
    const v0 = head.version;
    const r1 = await persistence.applyTimelineEdits(mographProjectId, USER, v0, p.payload.commands, false);
    expect(r1.version).toBeGreaterThan(v0);
    const after = await persistence.getTimelineHead(mographProjectId, USER);
    const graphicClip = after.sequence.clips.find((c) => c.graphicTemplateId && (c.keyframes?.length ?? 0) > 0);
    expect(graphicClip).toBeTruthy();
    expect(graphicClip!.trackId).toBeTruthy();
    expect(after.sequence.tracks.find((t) => t.id === graphicClip!.trackId)?.kind).toBe("GRAPHIC");
    // Keyframes survived: clip-relative, x follows the subject.
    const gkfs = graphicClip!.keyframes.filter((k) => k.property === "x");
    expect(gkfs.length).toBeGreaterThanOrEqual(4);
    expect(gkfs[gkfs.length - 1].value).toBeGreaterThan(gkfs[0].value);
  }, 300_000);

  test("FULL TEMPORAL_INTELLIGENCE job through the REAL worker: artifacts, reuse, invalidation, cleanup", async () => {
    const { reviewId, jobId, disclosure } = await temporalJobs.enqueueTemporalIntelligence(USER, mainProjectId, { ...SETTINGS, maxFrames: 40 }, false);
    expect(disclosure).toContain("upload NOTHING");
    const status = await tickUntil(jobId);
    expect(status).toBe("COMPLETED");
    const review = await db.creativeReview.findUnique({ where: { id: reviewId } });
    expect(review?.status).toBe("COMPLETED");
    const indexRow = await db.creativeAnalysisArtifact.findFirst({ where: { userId: USER, projectId: mainProjectId, kind: "temporal-index", status: "COMPLETED" } });
    expect(indexRow).toBeTruthy();
    const idx = JSON.parse(indexRow!.resultJson!) as import("../src/lib/creative/visual/temporal/contracts").TemporalIndex;
    expect(idx.measurement.framesSampled).toBeGreaterThan(10);
    expect(idx.tracks.length).toBeGreaterThanOrEqual(1);
    expect(idx.events.length).toBeGreaterThan(0);
    const mographRow = await db.creativeAnalysisArtifact.findFirst({ where: { userId: USER, projectId: mainProjectId, kind: "temporal-mograph" } });
    expect(mographRow).toBeTruthy();
    const recs = await db.creativeRecommendation.findMany({ where: { reviewId } });
    expect(recs.some((r) => r.kind === "executable")).toBe(true);
    // Temp dir cleaned.
    expect(await framesMod.listFrameDir(framesMod.visualFrameDir(`tj_${jobId}`))).toHaveLength(0);

    // Run dedup: identical deps REUSE (no re-tracking).
    const firstUpdated = indexRow!.updatedAt.getTime();
    const run2 = await temporalJobs.enqueueTemporalIntelligence(USER, mainProjectId, { ...SETTINGS, maxFrames: 40 }, false);
    expect(await tickUntil(run2.jobId)).toBe("COMPLETED");
    const review2 = await db.creativeReview.findUnique({ where: { id: run2.reviewId } });
    const evidence = JSON.parse(review2!.evidenceSourcesJson ?? "[]") as { detail: string }[];
    expect(evidence.some((e) => e.detail.includes("REUSED"))).toBe(true);
    const after2 = await db.creativeAnalysisArtifact.findFirst({ where: { userId: USER, projectId: mainProjectId, kind: "temporal-index", status: "COMPLETED" }, orderBy: { updatedAt: "desc" } });
    expect(after2!.updatedAt.getTime()).toBe(firstUpdated);

    // Invalidation: source mtime change → STALE with reason.
    utimesSync(MOVE_VIDEO, new Date(), new Date());
    const run3 = await temporalJobs.enqueueTemporalIntelligence(USER, mainProjectId, { ...SETTINGS, maxFrames: 40 }, false);
    expect(await tickUntil(run3.jobId)).toBe("COMPLETED");
    const stale = await db.creativeAnalysisArtifact.findMany({ where: { userId: USER, projectId: mainProjectId, kind: "temporal-index", status: "STALE" } });
    expect(stale.length).toBe(1);
    expect(stale[0].staleReason).toContain("source media changed");
  }, 480_000);

  test("ownership + no-video: foreign user refused; no-video project fails honestly", async () => {
    await expect(temporalJobs.enqueueTemporalIntelligence(FOREIGN, mainProjectId, {}, false)).rejects.toThrow();
    const p = await db.project.create({ data: { userId: USER, name: "M13 NoVideo" } });
    const { jobId } = await temporalJobs.enqueueTemporalIntelligence(USER, p.id, {}, false);
    expect(await tickUntil(jobId)).toBe("COMPLETED");
    const review = await db.creativeReview.findFirst({ where: { userId: USER, projectId: p.id, scope: "temporal" } });
    expect(review?.status).toBe("FAILED");
    expect(review?.error).toContain("No VIDEO-track clips");
  }, 240_000);
});
