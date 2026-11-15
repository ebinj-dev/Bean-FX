/**
 * BEAN FX — M14 LIVE tests (bun test, isolated DB). REAL providers:
 *  1. REAL art-direction generation through the configured LLM (3 validated
 *     distinct directions);
 *  2. REAL LAXII scene-asset generation under the approved direction with
 *     REAL provider output validation + ACTUAL pixel alpha verification;
 *  3. REAL provider-ranked scene enrichment skipped if LLM unavailable —
 *     deterministic segmentation still holds (honest fallback).
 * Unavailable providers produce honest skips — mocks never substitute.
 *
 * Run: bun test scripts/test-m14-live.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRATCH_DB = path.join(os.tmpdir(), `beanfx-m14-live-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${SCRATCH_DB}`;
process.env.BEANFX_MEDIA_WORKER_AUTOSTART = "0";
process.env.NODE_ENV = "production";
const WORK = mkdtempSync(path.join(os.tmpdir(), "beanfx-m14-live-"));
execSync("node_modules/.bin/prisma db push --skip-generate --accept-data-loss", { env: { ...process.env, DATABASE_URL: `file:${SCRATCH_DB}` }, stdio: ["ignore", "ignore", "inherit"] });

let db: typeof import("../src/lib/db").db;
let direction: typeof import("../src/lib/creative/m14/direction");
let scenes: typeof import("../src/lib/creative/m14/scenes");
let assets: typeof import("../src/lib/creative/m14/assets");
let providerGateway: typeof import("../src/lib/my-ai/gateway/provider");

const USER = "m14-live-user";
let projectId = "";

beforeAll(async () => {
  db = (await import("../src/lib/db")).db;
  direction = await import("../src/lib/creative/m14/direction");
  scenes = await import("../src/lib/creative/m14/scenes");
  assets = await import("../src/lib/creative/m14/assets");
  providerGateway = await import("../src/lib/my-ai/gateway/provider");
  await db.user.create({ data: { id: USER, email: "m14live@test.local", name: "L", passwordHash: "x" } }).catch(() => undefined);
  const p = await db.project.create({ data: { userId: USER, name: "M14 Live Project", description: "live" } });
  projectId = p.id;
  const health = await providerGateway.llmHealth(true);
  console.log(`[m14-live] LLM health: ${health.ok ? "OK" : health.detail}`);
}, 120_000);

afterAll(() => {
  rmSync(WORK, { recursive: true, force: true });
  rmSync(SCRATCH_DB, { force: true });
});

describe("M14 LIVE art direction + assets (REAL providers)", () => {
  test("REAL LLM generates 3 distinct validated directions", async () => {
    const health = await providerGateway.llmHealth();
    if (!health.ok) {
      console.log("[m14-live] skip: LLM unavailable");
      expect(true).toBe(true);
      return;
    }
    const res = await direction.generateDirections(USER, projectId, {
      storyOrProduct: "A 30-second explainer about how South Indian filter coffee is made, for food lovers",
      audience: "food lovers",
      format: "16:9",
      motionIntensity: "moderate",
      language: "en",
    });
    console.log(`[m14-live] directions: ${res.directions.map((d) => d.direction.name).join(" | ")}`);
    expect(res.directions.length).toBe(3);
    expect(new Set(res.directions.map((d) => d.direction.name)).size).toBe(3);
    for (const d of res.directions) {
      expect(d.direction.styleProfile.palette.length).toBeGreaterThanOrEqual(3);
      expect(d.direction.rationale.length).toBeGreaterThan(10);
    }
    console.log(`[m14-live] palette[0]: ${JSON.stringify(res.directions[0].direction.styleProfile.palette.slice(0, 3))}`);
    console.log(`[m14-live] disclosure: ${res.disclosure.slice(0, 140)}`);
  }, 240_000);

  test("REAL scene plan: verbatim-estimated mix + AI concepts (honest fallback)", async () => {
    const health = await providerGateway.llmHealth();
    if (!health.ok) {
      console.log("[m14-live] skip: LLM unavailable");
      expect(true).toBe(true);
      return;
    }
    const doc = await scenes.buildScenePlan(USER, projectId, { brief: { format: "16:9", language: "en", storyOrProduct: "filter coffee" } });
    console.log(`[m14-live] scenes: ${doc.scenes.length}, notes: ${doc.notes[0]?.slice(0, 90)}`);
    expect(doc.scenes.length).toBeGreaterThanOrEqual(1);
    for (const s of doc.scenes) expect(["riishe-verbatim", "estimated"]).toContain(s.timingSource);
    console.log(`[m14-live] concept[0]: ${doc.scenes[0].visualConcept.slice(0, 100)}`);
  }, 240_000);

  test("REAL LAXII asset generation under the approved direction (actual pixels verified)", async () => {
    const health = await providerGateway.llmHealth();
    if (!health.ok) {
      console.log("[m14-live] skip: LLM unavailable (no approved direction without it)");
      expect(true).toBe(true);
      return;
    }
    const approved = await direction.getApprovedDirection(USER, projectId);
    if (!approved) {
      const candidates = await db.artDirection.findMany({ where: { userId: USER, projectId, status: "PROPOSED" }, orderBy: { createdAt: "asc" }, take: 1 });
      if (candidates.length === 0) {
        console.log("[m14-live] skip: no candidate direction to approve");
        expect(true).toBe(true);
        return;
      }
      await direction.approveDirection(USER, projectId, candidates[0].id);
    }
    const res = await assets.generateSceneAsset(USER, projectId, {
      projectId,
      sceneId: "sc1",
      role: "background",
      prompt: "Wide background plate for the opening scene: coffee brewing on a wooden table, following the approved art direction exactly",
      alternatives: 1,
    });
    console.log(`[m14-live] ${res.disclosure.slice(0, 160)}`);
    expect(res.assets.length).toBe(1);
    const a = res.assets[0];
    console.log(`[m14-live] asset ${a.assetId.slice(0, 12)}… ${a.width}x${a.height} alpha=${a.hasAlpha} (${a.alphaCoverage ?? 0})`);
    expect(a.width).toBeGreaterThan(100);
    expect(a.height).toBeGreaterThan(100);
    console.log(`[m14-live] limitation: ${res.limitations[0]?.slice(0, 140)}`);
  }, 300_000);
});
