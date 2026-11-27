/**
 * M48-E — shared editing-knowledge tests:
 *   1. The recipe registry: 41 recipes, schema-valid (loadStyleRecipes throws otherwise),
 *      every enum value a real editor vocabulary member, unique ids, detailed fields.
 *   2. The trend feed: versioned, source-bearing entries with honest confidence labels.
 *   3. The retrieval layer: domain detection, recipe scoring, capability truth per domain,
 *      and the guarantee that capability truth never advertises unimplemented features.
 */
import { describe, test, expect } from "bun:test";
import { retrieveEditingKnowledge, recipeIds } from "../src/lib/ai/editing-knowledge";
import { loadStyleRecipes } from "../src/lib/ai/styles";
import { EffectType, KeyframeProperty, TransitionKind } from "../src/lib/editor/model";

describe("M48-E style recipe registry (target 30+, schema-valid)", () => {
  const file = loadStyleRecipes(); // throws on any invalid recipe

  test("registry has 30+ fully developed recipes", () => {
    expect(file.recipes.length).toBeGreaterThanOrEqual(30);
  });

  test("ids unique; version present", () => {
    const ids = file.recipes.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(file.version).toBeTruthy();
  });

  test("every recipe is detailed (all M48 §12.3 content fields populated)", () => {
    for (const r of file.recipes) {
      expect(r.purpose.length).toBeGreaterThan(30);
      expect(r.structure.length).toBeGreaterThan(0);
      expect(r.shotSelection.length).toBeGreaterThan(10);
      // pacing may be the documented string "inherit" (vertical-reframe);
      // object form must carry ordered ranges.
      if (typeof r.pacing === "object") {
        expect(r.pacing.avgShotSec[0] <= r.pacing.avgShotSec[1]).toBe(true);
        expect(r.pacing.shotsPerMin[0] <= r.pacing.shotsPerMin[1]).toBe(true);
      }
      expect(r.cutting.length).toBeGreaterThan(0);
      expect(r.transitions.length).toBeGreaterThan(0);
      expect(r.needs.length).toBeGreaterThan(0);
      expect(r.qualityChecks.length).toBeGreaterThanOrEqual(3);
      expect(r.notFor.length).toBeGreaterThan(0);
      expect(r.promptExample.length).toBeGreaterThan(10);
      for (const t of r.transitions) expect(TransitionKind.safeParse(t.kind).success).toBe(true);
      const motionBlocks = Object.values(r.motion ?? {});
      for (const m of motionBlocks) {
        // "playbackSpeed" is the documented M42 exception (speed ramps run
        // through ChangePlaybackSpeed commands, not property keyframes).
        if (m.param && m.param !== "playbackSpeed") expect(KeyframeProperty.safeParse(m.param).success).toBe(true);
      }
      for (const c of r.color?.effects ?? []) expect(EffectType.safeParse(c.type).success).toBe(true);
    }
  });

  test("new M48 families cover the spec categories (A-I)", () => {
    const families = new Set(file.recipes.map((r) => r.family));
    for (const f of ["cinematic", "documentary", "social", "commercial", "event", "creator", "education", "music", "motion"]) {
      expect(families.has(f)).toBe(true);
    }
  });
});

describe("M48-E editing-intelligence trend feed", () => {
  const trends = JSON.parse(require("node:fs").readFileSync("scripts/ai-editing/editing-trends.json", "utf8"));

  test("versioned feed with required fields on every entry", () => {
    expect(trends.version).toBeTruthy();
    expect(trends.entries.length).toBeGreaterThan(0);
    for (const t of trends.entries) {
      for (const field of ["id", "name", "category", "description", "firstObserved", "lastVerified", "confidence", "reviewDate", "humanReviewStatus"]) {
        expect(String(t[field]).length).toBeGreaterThan(0);
      }
      expect(t.evidenceSummary.length).toBeGreaterThan(30);
    }
  });

  test("confidence labels are honest (no unverified claims of platform support)", () => {
    const acEntries = trends.entries.filter((t: { id: string }) => t.id === "aces-pipeline-awareness");
    expect(acEntries[0].confidence).toContain("not implemented");
    const yt = trends.entries.find((t: { id: string }) => t.id === "yt-upload-spec-2026");
    expect(yt.sources[0]).toBe("https://support.google.com/youtube/answer/1722171");
    expect(yt.confidence).toContain("VERIFIED");
  });
});

describe("M48-E knowledge retrieval layer", () => {
  test("color queries return color recipes + color capability truth (incl. honest NOT IMPLEMENTED)", () => {
    const k = retrieveEditingKnowledge("match the colour of all these clips and grade it cinematic");
    expect(k.domain).toContain("color");
    expect(k.recipes.length).toBeGreaterThan(0);
    expect(k.capabilityTruth.some((c) => c.startsWith("EXECUTABLE"))).toBe(true);
    expect(k.capabilityTruth.some((c) => c.includes("NOT IMPLEMENTED") && c.includes("ACES"))).toBe(true);
  });

  test("audio/beat queries return beat-sync knowledge and GANGZII truth", () => {
    const k = retrieveEditingKnowledge("make the music quieter when someone speaks and sync cuts to the beat");
    expect(k.domain).toContain("audio");
    expect(k.grammar.some((g) => g.includes("beat"))).toBe(true);
    expect(k.capabilityTruth.some((c) => c.includes("GANGZII"))).toBe(true);
  });

  test("caption queries never advertise word-level timing or diarization", () => {
    const k = retrieveEditingKnowledge("add Tamil captions to this interview");
    expect(k.capabilityTruth.some((c) => c.includes("phrase/chunk-level"))).toBe(true);
    expect(k.capabilityTruth.some((c) => c.includes("diarization"))).toBe(true);
    expect(k.capabilityTruth.some((c) => c.includes("Tamil/Tanglish UNVERIFIED"))).toBe(true);
  });

  test("delivery queries surface the verified platform spec with its source URL", () => {
    const k = retrieveEditingKnowledge("export this for youtube shorts");
    expect(k.trends.some((t) => t.id === "yt-upload-spec-2026" && t.sources[0].includes("support.google.com"))).toBe(true);
  });

  test("recipeIds() exposes the full registry for agent discovery", () => {
    expect(recipeIds().length).toBeGreaterThanOrEqual(30);
    expect(recipeIds()).toContain("horror-suspense");
  });
});
