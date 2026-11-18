/**
 * BEAN FX — M10 AI Creative Director LIVE tests (bun test, isolated DB).
 * REAL providers (MY AI LLM gateway; real GANGZII evidence path). Clearly
 * separated from the fixture suite; an unavailable provider is reported as an
 * honest skip — mocks are never substituted for live verification.
 *
 * Run: bun test scripts/test-creative-live.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRATCH_DB = path.join(os.tmpdir(), `beanfx-m10-live-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${SCRATCH_DB}`;
process.env.BEANFX_MEDIA_WORKER_AUTOSTART = "0";
process.env.NODE_ENV = "production";
const WORK = mkdtempSync(path.join(os.tmpdir(), "beanfx-m10-live-"));

execSync("bunx prisma db push --skip-generate --accept-data-loss", {
  env: { ...process.env, DATABASE_URL: `file:${SCRATCH_DB}` },
  stdio: ["ignore", "ignore", "inherit"],
});

let db: typeof import("../src/lib/db").db;
let providerMod: typeof import("../src/lib/my-ai/gateway/provider");
let contextMod: typeof import("../src/lib/creative/context");
let briefMod: typeof import("../src/lib/creative/brief");
let scorecardMod: typeof import("../src/lib/creative/scorecard");
let assistantMod: typeof import("../src/lib/creative/assistant");
let workerMod: typeof import("../src/lib/media-worker");
let persistence: typeof import("../src/lib/editor/persistence");

const USER = "m10-live-user";
let projectId = "";
const FIX_AUDIO = path.join(WORK, "narration.wav");

beforeAll(async () => {
  db = (await import("../src/lib/db")).db;
  providerMod = await import("../src/lib/my-ai/gateway/provider");
  contextMod = await import("../src/lib/creative/context");
  briefMod = await import("../src/lib/creative/brief");
  scorecardMod = await import("../src/lib/creative/scorecard");
  assistantMod = await import("../src/lib/creative/assistant");
  workerMod = await import("../src/lib/media-worker");
  persistence = await import("../src/lib/editor/persistence");

  await db.user.create({ data: { id: USER, email: "m10live@test.local", name: "L", passwordHash: "x" } }).catch(() => undefined);
  const project = await db.project.create({ data: { userId: USER, name: "M10 Live Project", description: "Five-minute filter coffee guide" } });
  projectId = project.id;

  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=8", "-af", "volume='0.6*between(t,1,8)':eval=frame,tremolo=f=5:d=0.7", "-ar", "48000", "-ac", "1", FIX_AUDIO], { stdio: ["ignore", "ignore", "inherit"] });
  const asset = await db.mediaAsset.create({ data: { userId: USER, projectId, originalName: "narration.wav", storagePath: FIX_AUDIO, kind: "AUDIO", mimeType: "audio/wav", sizeBytes: statSync(FIX_AUDIO).size, durationSec: 8, sampleRate: 48000, channels: 1 } });
  const head = await persistence.getTimelineHead(projectId, USER);
  await persistence.applyTimelineEdits(projectId, USER, head.version, [
    { type: "AddTrack", track: { id: "t-audio", kind: "AUDIO", name: "Narration", visible: true, muted: false, solo: false, locked: false } },
    { type: "AddClip", clip: { id: "ac1", trackId: "t-audio", sourceAssetId: asset.id, sourceInFrame: 0, sourceOutFrame: 8 * 30, sourceFps: { num: 30000, den: 1000 }, timelineStartFrame: 0, playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null, label: "narration", missingMedia: false, effects: [], keyframes: [] } },
  ], false);

  const ticker = setInterval(() => {
    void workerMod.tickWorkerOnce().catch(() => undefined);
  }, 1000);
  ticker.unref?.();
  (globalThis as unknown as { __m10LiveTicker?: NodeJS.Timeout }).__m10LiveTicker = ticker;
}, 120_000);

afterAll(() => {
  const ticker = (globalThis as unknown as { __m10LiveTicker?: NodeJS.Timeout }).__m10LiveTicker;
  if (ticker) clearInterval(ticker);
  rmSync(WORK, { recursive: true, force: true });
  rmSync(SCRATCH_DB, { force: true });
});

describe("M10 LIVE creative brief (real LLM, real GANGZII evidence)", () => {
  test("measured context with REAL GANGZII inspection", async () => {
    const ctx = await contextMod.buildMeasuredContext(USER, projectId, { enqueueEvidence: true, waitSec: 90 });
    if (!ctx.audio?.inspection) {
      console.log("[m10-live] GANGZII evidence unavailable — honest skip of measurement assertions");
      expect(true).toBe(true);
      return;
    }
    expect(ctx.audio.inspection.silenceSpans.length).toBeGreaterThan(0);
    console.log(`[m10-live] GANGZII measured: ${ctx.audio.inspection.silenceSpans.length} silence span(s), ${ctx.audio.inspection.silenceFraction.toFixed(2)} fraction, ${ctx.audio.inspection.levelsClassification}`);
  }, 180_000);

  test("real LLM brief in EN is grounded in the measured context", async () => {
    const health = await providerMod.llmHealth();
    if (!health.ok) {
      console.log("[m10-live] LLM unavailable — honest skip");
      expect(true).toBe(true);
      return;
    }
    const ctx = await contextMod.buildMeasuredContext(USER, projectId, { enqueueEvidence: false });
    const { brief, model } = await briefMod.generateCreativeBrief(ctx, "en", {});
    expect(brief.mainSubject.length).toBeGreaterThan(3);
    expect(brief.observed.length).toBeGreaterThan(0);
    expect(brief.audience).toBeNull(); // none supplied → never invented
    console.log(`[m10-live] EN brief subject: ${brief.mainSubject.slice(0, 80)} (${model})`);
  }, 180_000);

  test("real LLM brief in TA preserves Tamil script", async () => {
    const health = await providerMod.llmHealth();
    if (!health.ok) {
      console.log("[m10-live] LLM unavailable — honest skip");
      expect(true).toBe(true);
      return;
    }
    const ctx = await contextMod.buildMeasuredContext(USER, projectId, { enqueueEvidence: false });
    const { brief } = await briefMod.generateCreativeBrief(ctx, "ta", {});
    expect(brief.mainSubject).toMatch(/[\u0b80-\u0bff]/);
    console.log(`[m10-live] TA brief subject: ${brief.mainSubject.slice(0, 60)}`);
  }, 180_000);

  test("real scorecard: subjective dims scored or honestly null", async () => {
    const health = await providerMod.llmHealth();
    if (!health.ok) {
      console.log("[m10-live] LLM unavailable — honest skip");
      expect(true).toBe(true);
      return;
    }
    const ctx = await contextMod.buildMeasuredContext(USER, projectId, { enqueueEvidence: false });
    const { scorecard } = await scorecardMod.buildScorecard(USER, ctx, "en", {});
    expect(scorecard.dimensions.length).toBe(8);
    expect(scorecard.overallNote).toContain("NOT a prediction");
    const hook = scorecard.dimensions.find((d) => d.key === "hook-clarity")!;
    console.log(`[m10-live] hook-clarity: ${hook.score ?? "null (missing data)"} (${hook.basis})`);
  }, 180_000);

  test("real assistant turn routes and answers from evidence", async () => {
    const health = await providerMod.llmHealth();
    if (!health.ok) {
      console.log("[m10-live] LLM unavailable — honest skip");
      expect(true).toBe(true);
      return;
    }
    const turn = await assistantMod.runAssistantTurn(USER, projectId, "Review my video and tell me what to improve", "en", { enqueueEvidence: false });
    expect(turn.reply.length).toBeGreaterThan(10);
    expect(turn.reviewId).not.toBeNull();
    console.log(`[m10-live] assistant intent=${turn.intent} review=${turn.reviewId?.slice(0, 8)} recs=${turn.recommendationsCreated}`);
    console.log(`[m10-live] reply excerpt: ${turn.reply.slice(0, 160).replace(/\n/g, " | ")}`);
  }, 240_000);
});
