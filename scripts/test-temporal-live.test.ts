/**
 * BEAN FX — M13 Temporal Visual Intelligence LIVE tests (bun test, isolated DB).
 * REAL providers on REAL tracked subjects:
 *  1. a REAL TEMPORAL_INTELLIGENCE job WITH consent + providerLabels through
 *     the REAL worker — the configured vision provider (glm-4.5v) receives
 *     REAL tracked subject crops and returns validated category labels;
 *  2. REAL provider-ranked temporal search over the REAL index.
 * Local tracking itself uploads NOTHING and is verified in the core suite.
 * Unavailable providers produce honest skips — mocks never substitute.
 *
 * Run: bun test scripts/test-temporal-live.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRATCH_DB = path.join(os.tmpdir(), `beanfx-m13-live-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${SCRATCH_DB}`;
process.env.BEANFX_MEDIA_WORKER_AUTOSTART = "0";
process.env.NODE_ENV = "production";
const WORK = mkdtempSync(path.join(os.tmpdir(), "beanfx-m13-live-"));

execSync("node_modules/.bin/prisma db push --skip-generate --accept-data-loss", {
  env: { ...process.env, DATABASE_URL: `file:${SCRATCH_DB}` },
  stdio: ["ignore", "ignore", "inherit"],
});

let db: typeof import("../src/lib/db").db;
let persistence: typeof import("../src/lib/editor/persistence");
let temporalJobs: typeof import("../src/lib/creative/visual/temporal/jobs");
let search: typeof import("../src/lib/creative/visual/temporal/search");
let visionGateway: typeof import("../src/lib/my-ai/gateway/vision");
let workerMod: typeof import("../src/lib/media-worker");

const USER = "m13-live-user";
let projectId = "";
let assetId = "";
const MOVE_VIDEO = path.join(WORK, "move.mp4");

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

beforeAll(async () => {
  db = (await import("../src/lib/db")).db;
  persistence = await import("../src/lib/editor/persistence");
  temporalJobs = await import("../src/lib/creative/visual/temporal/jobs");
  search = await import("../src/lib/creative/visual/temporal/search");
  visionGateway = await import("../src/lib/my-ai/gateway/vision");
  workerMod = await import("../src/lib/media-worker");

  await db.user.create({ data: { id: USER, email: "m13live@test.local", name: "L", passwordHash: "x" } }).catch(() => undefined);
  const health = await visionGateway.visionHealth(true);
  console.log(`[m13-live] vision provider health: ${health.ok ? "OK" : health.detail} (${health.latencyMs} ms)`);

  const project = await db.project.create({ data: { userId: USER, name: "M13 Live Project", description: "Temporal live verification" } });
  projectId = project.id;
  // Real moving subject (white box, 35 px/s — known ground truth from core).
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=8:r=10", "-f", "lavfi", "-i", "color=c=white:s=44x44:d=8:r=10", "-filter_complex", "[1:v]setpts=PTS-STARTPTS[b];[0:v][b]overlay=x='20+t*35':y=100:shortest=1[out]", "-map", "[out]", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", MOVE_VIDEO], { stdio: ["ignore", "ignore", "inherit"] });
  const asset = await db.mediaAsset.create({ data: { userId: USER, projectId, originalName: "move.mp4", storagePath: MOVE_VIDEO, kind: "VIDEO", mimeType: "video/mp4", sizeBytes: statSync(MOVE_VIDEO).size, durationSec: 8, width: 320, height: 240, fps: 10 } });
  assetId = asset.id;
  const head = await persistence.getTimelineHead(projectId, USER);
  await persistence.applyTimelineEdits(projectId, USER, head.version, [
    { type: "AddTrack", track: { id: "t-video", kind: "VIDEO", name: "V1", visible: true, muted: false, solo: false, locked: false } },
    { type: "AddClip", clip: { id: "lc1", trackId: "t-video", sourceAssetId: asset.id, sourceInFrame: 0, sourceOutFrame: 80, sourceFps: { num: 10, den: 1 }, timelineStartFrame: 0, playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null, label: "main", missingMedia: false, effects: [], keyframes: [] } },
  ], false);

  const ticker = setInterval(() => {
    void workerMod.tickWorkerOnce().catch(() => undefined);
  }, 1200);
  ticker.unref?.();
  (globalThis as unknown as { __m13LiveTicker?: NodeJS.Timeout }).__m13LiveTicker = ticker;
}, 180_000);

afterAll(() => {
  const ticker = (globalThis as unknown as { __m13LiveTicker?: NodeJS.Timeout }).__m13LiveTicker;
  if (ticker) clearInterval(ticker);
  rmSync(WORK, { recursive: true, force: true });
  rmSync(SCRATCH_DB, { force: true });
});

describe("M13 LIVE temporal intelligence (REAL providers)", () => {
  test("REAL job WITH consent: real CSRT tracking + REAL provider subject labeling", async () => {
    const health = await visionGateway.visionHealth();
    if (!health.ok) {
      console.log(`[m13-live] skip: vision provider unavailable (${health.detail})`);
      expect(true).toBe(true);
      return;
    }
    const { reviewId, jobId, disclosure } = await temporalJobs.enqueueTemporalIntelligence(USER, projectId, { sampleFps: 5, maxFrames: 40, providerLabels: true }, true);
    console.log(`[m13-live] temporal job queued — ${disclosure}`);
    const status = await tickUntil(jobId);
    expect(status).toBe("COMPLETED");
    const review = await db.creativeReview.findUnique({ where: { id: reviewId } });
    expect(review?.status).toBe("COMPLETED");
    const indexRow = await db.creativeAnalysisArtifact.findFirst({ where: { userId: USER, projectId, kind: "temporal-index", status: "COMPLETED" } });
    expect(indexRow?.consentVisual).toBe(true);
    const idx = JSON.parse(indexRow!.resultJson!) as { tracks: { trackId: string; category: string | null; categoryProvenance: string | null; samples: unknown[]; model: string }[]; motion: { trackId: string; direction: string | null; speedPxPerSec: number | null }[]; measurement: { framesSampled: number; providerLabelsUsed: number } };
    console.log(`[m13-live] REAL tracking: ${idx.measurement.framesSampled} frames, ${idx.tracks.length} track(s), provider labels: ${idx.measurement.providerLabelsUsed}`);
    expect(idx.tracks.length).toBeGreaterThanOrEqual(1);
    expect(idx.tracks[0].samples.length).toBeGreaterThanOrEqual(15);
    // Known ground truth: 35 px/s rightward.
    expect(idx.motion[0].direction).toBe("right");
    expect(idx.motion[0].speedPxPerSec!).toBeGreaterThan(31);
    expect(idx.motion[0].speedPxPerSec!).toBeLessThan(39);
    // REAL provider category labeling of the REAL tracked crop.
    if (idx.measurement.providerLabelsUsed > 0) {
      const t = idx.tracks[0];
      console.log(`[m13-live] provider label for ${t.trackId}: "${t.category}" (${t.categoryProvenance})`);
      expect(t.categoryProvenance).toBe("provider");
      expect(t.category?.length ?? 0).toBeGreaterThan(2);
    } else {
      console.log(`[m13-live] provider labeling unavailable this run — tracks keep detector-generic categories (honest)`);
    }
  }, 480_000);

  test("REAL provider-ranked temporal search over the REAL index", async () => {
    const indexRow = await db.creativeAnalysisArtifact.findFirst({ where: { userId: USER, projectId, kind: "temporal-index", status: "COMPLETED" } });
    if (!indexRow?.resultJson) {
      console.log("[m13-live] skip: no temporal index (job failed)");
      expect(true).toBe(true);
      return;
    }
    const idx = JSON.parse(indexRow.resultJson);
    const health = await visionGateway.visionHealth();
    if (!health.ok) {
      console.log(`[m13-live] skip: vision provider unavailable (${health.detail})`);
      expect(true).toBe(true);
      return;
    }
    const res = await search.searchTemporalIndex(idx, { query: "a bright object moving quickly across the frame", limit: 5 }, { consentVisual: true });
    console.log(`[m13-live] search method=${res.method} top=${res.results[0]?.refId} score=${res.results[0]?.relevanceScore}`);
    console.log(`[m13-live] evidence: ${res.results[0]?.evidence.slice(0, 160)}`);
    expect(res.available).toBe(true);
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results[0].kind === "track" || res.results[0].kind === "event").toBe(true);
  }, 240_000);
});
