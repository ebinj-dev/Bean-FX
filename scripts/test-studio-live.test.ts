/**
 * BEAN FX — M8.1 Social Video Studio LIVE-provider tests.
 * These run against the REAL configured providers and are clearly separated
 * from fixture tests (M8.1 §15): live LLM planning, live TTS narration
 * (registered asset + probe), live RIISHE ASR caption timing on the TTS
 * audio, live scene regeneration, and a batch topic through the REAL worker.
 *
 * Run: BEANFX_M8_REAL_PROVIDER=1 BEANFX_STUDIO_REAL_TTS=1 bun test scripts/test-studio-live.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRATCH_DB = path.join(os.tmpdir(), `beanfx-m81-live-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${SCRATCH_DB}`;
process.env.BEANFX_MEDIA_WORKER_AUTOSTART = "0";
process.env.NODE_ENV = "production";
const WORK = mkdtempSync(path.join(os.tmpdir(), "beanfx-m81-live-"));
const LIVE = process.env.BEANFX_M8_REAL_PROVIDER === "1";
const LIVE_TTS = process.env.BEANFX_STUDIO_REAL_TTS === "1";

execSync("bunx prisma db push --skip-generate --accept-data-loss", {
  env: { ...process.env, DATABASE_URL: `file:${SCRATCH_DB}` },
  stdio: ["ignore", "ignore", "inherit"],
});

let db: typeof import("../src/lib/db").db;
let briefMod: typeof import("../src/lib/studio/brief");
let plannerMod: typeof import("../src/lib/studio/planner");
let narrationMod: typeof import("../src/lib/studio/narration");
let assembleMod: typeof import("../src/lib/studio/assemble");
let assetsMod: typeof import("../src/lib/studio/assets");
let batchMod: typeof import("../src/lib/studio/batch");
let workerMod: typeof import("../src/lib/media-worker");
let persistence: typeof import("../src/lib/editor/persistence");

const USER = "studio-live-user";
let projectId = "";
let planId = "";

beforeAll(async () => {
  db = (await import("../src/lib/db")).db;
  briefMod = await import("../src/lib/studio/brief");
  plannerMod = await import("../src/lib/studio/planner");
  narrationMod = await import("../src/lib/studio/narration");
  assembleMod = await import("../src/lib/studio/assemble");
  assetsMod = await import("../src/lib/studio/assets");
  batchMod = await import("../src/lib/studio/batch");
  workerMod = await import("../src/lib/media-worker");
  persistence = await import("../src/lib/editor/persistence");
  await db.user.create({ data: { id: USER, email: "s81live@test.local", name: "L", passwordHash: "x" } }).catch(() => undefined);
  const project = await db.project.create({ data: { userId: USER, name: "Studio Live", settingsJson: JSON.stringify({ width: 1080, height: 1920, fps: { num: 30, den: 1 }, sampleRate: 48000 }) } });
  projectId = project.id;
});

afterAll(() => {
  rmSync(String(process.env.DATABASE_URL).replace("file:", ""), { force: true });
  rmSync(WORK, { recursive: true, force: true });
});

describe("Studio LIVE (§15.1/§15.6) — real LLM production plan", () => {
  test("topic → typed, schema-validated production plan by the real model", async () => {
    if (!LIVE) {
      console.log("[studio-live] skipped (set BEANFX_M8_REAL_PROVIDER=1)");
      return;
    }
    const brief = briefMod.StudioBriefSchema.parse({ topic: "Why Chennai's filter coffee culture survived instant coffee", durationSec: 45, platform: "youtube_shorts", language: "en", audience: "food-curious viewers", tone: "warm, punchy" });
    const planRow = await db.studioPlan.create({ data: { userId: USER, projectId, status: "DRAFT", briefJson: JSON.stringify(brief) } });
    planId = planRow.id;
    const outcome = await plannerMod.createStudioPlan(USER, planId, brief);
    console.log("[live-plan] mode:", outcome.mode, "scenes:", outcome.plan.scenes.length, "engines note:", outcome.note.slice(0, 90));
    expect(outcome.mode).toBe("llm");
    expect(outcome.plan.scenes.length).toBeGreaterThanOrEqual(3);
    expect(outcome.plan.hook.length).toBeGreaterThan(3);
    expect(outcome.plan.scenes.every((s) => s.narration.length > 0)).toBe(true);
    expect(outcome.plan.closingCta.length).toBeGreaterThan(3);
    expect(outcome.plan.sources).toEqual([]); // no fabricated citations
    const row = await db.studioPlan.findUnique({ where: { id: planId } });
    expect(row!.plannerMode).toBe("llm");
    expect(row!.status).toBe("SCENES_READY");
  }, 300_000);

  test("individual scene regeneration touches ONLY that scene (§15.4)", async () => {
    if (!LIVE) return;
    const scenes = await db.studioScene.findMany({ where: { planId }, orderBy: { sceneNumber: "asc" } });
    const target = scenes[1];
    const before = scenes.map((s) => s.narration);
    const r = await plannerMod.regenerateScene(USER, planId, target.id, "make it punchier, mention the drip filter");
    console.log("[live-regen]", r.mode, r.note.slice(0, 90));
    expect(r.ok).toBe(true);
    const after = await db.studioScene.findMany({ where: { planId }, orderBy: { sceneNumber: "asc" } });
    expect(after[1].narration).not.toBe(before[1]);
    expect(after[0].narration).toBe(before[0]); // others untouched
    expect(after[2].narration).toBe(before[2]);
  }, 300_000);
});

describe("Studio LIVE (§15.6) — real TTS narration + RIISHE captions", () => {
  test("TTS generates a real, probe-verified audio asset with provenance", async () => {
    if (!LIVE || !LIVE_TTS) {
      console.log("[studio-live] TTS skipped (set BEANFX_STUDIO_REAL_TTS=1)");
      return;
    }
    const scenes = await db.studioScene.findMany({ where: { planId }, orderBy: { sceneNumber: "asc" } });
    const scene = scenes[0];
    const r = await narrationMod.generateSceneNarration(USER, planId, scene.id, "tongtong", 1.0);
    console.log("[live-tts] duration:", r.durationSec, "asset:", r.assetId);
    expect(r.durationSec).toBeGreaterThan(1);
    const asset = await db.mediaAsset.findUnique({ where: { id: r.assetId } });
    expect(asset!.kind).toBe("AUDIO");
    expect(asset!.provider).toBe("zai-tts");
    expect(asset!.probeStatus).toBe("READY");
    expect(asset!.durationSec!).toBeGreaterThan(1);
    // Tamil honesty: narration for Tamil briefs is refused (documented).
    const support = narrationMod.voiceSupport("ta", "tongtong");
    expect(support.ok).toBe(false);
  }, 300_000);

  test("assembly captions the narration via RIISHE ASR (real segment timing)", async () => {
    if (!LIVE || !LIVE_TTS) return;
    // Assign the fixture-free path: generate simple color video? Use an owned
    // IMAGE? The render pipeline cannot loop stills — assign the same VIDEO
    // fixture used elsewhere is unavailable here; instead generate a tiny
    // color video asset directly with ffmpeg (user-owned, real file).
    const execFileSync = (await import("node:child_process")).execFileSync;
    const vid = path.join(WORK, "bg.mp4");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "gradients=s=540x960:d=30:speed=0.02", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", vid], { stdio: ["ignore", "ignore", "inherit"] });
    const scenes = await db.studioScene.findMany({ where: { planId }, orderBy: { sceneNumber: "asc" } });
    for (const s of scenes) {
      const asset = await db.mediaAsset.create({ data: { userId: USER, projectId, originalName: `bg-${s.sceneNumber}.mp4`, storagePath: vid, kind: "VIDEO", mimeType: "video/mp4", sizeBytes: 999999, durationSec: 30, width: 540, height: 960, fps: 30, probeStatus: "READY" } });
      await assetsMod.assignSceneAsset(USER, planId, s.id, asset.id);
    }
    const report = await assembleMod.assembleStudioTimeline(USER, planId);
    console.log("[live-assemble] captionsMode:", report.captionsMode, "notes:", report.notes.length);
    expect(report.scenes.length).toBeGreaterThanOrEqual(3);
    // The narration audio was transcribed by RIISHE — the captions mode must
    // be asr-segments (measured chunk timing) when the TTS audio exists.
    if (LIVE_TTS) expect(report.captionsMode).toBe("asr-segments");
    const head = await persistence.getTimelineHead(projectId, USER);
    const captionClips = head.sequence.clips.filter((c) => (c.captionText ?? "").length > 0);
    expect(captionClips.length).toBeGreaterThanOrEqual(1);
    // Integer-frame timing preserved.
    for (const c of head.sequence.clips) {
      expect(Number.isInteger(c.timelineStartFrame)).toBe(true);
    }
  }, 600_000);
});

describe("Studio LIVE batch — real worker topic job (§15.15)", () => {
  test("dispatched STUDIO_TOPIC job completes and produces a plan", async () => {
    if (!LIVE) return;
    const brief = briefMod.StudioBriefSchema.parse({ topic: "batch base", durationSec: 20, platform: "youtube_shorts" });
    const r = await batchMod.dispatchBatch(USER, brief, ["Five street foods to try in George Town"]);
    expect(r.dispatched).toBe(1);
    const mod = workerMod;
    // Drive the real worker loop until the job settles.
    for (let i = 0; i < 120; i++) {
      await mod.tickWorkerOnce().catch(() => undefined);
      const jobs = await db.job.findMany({ where: { userId: USER, type: "STUDIO_TOPIC" } });
      if (jobs.every((j) => ["COMPLETED", "FAILED", "CANCELLED"].includes(j.status))) break;
      await new Promise((res) => setTimeout(res, 1000));
    }
    const job = (await db.job.findMany({ where: { userId: USER, type: "STUDIO_TOPIC" } }))[0];
    console.log("[live-batch] job:", job.status, (job.message ?? "").slice(0, 120));
    expect(job.status).toBe("COMPLETED");
    const status = await batchMod.batchStatus(USER, r.batchId);
    expect(status.topics[0].planId).not.toBeNull();
    expect(status.topics[0].jobStatus).toBe("COMPLETED");
  }, 600_000);
});
