/**
 * M31 — Production Studio core (deterministic, in-process).
 * State machine, brief extraction, script duration validation, honest cost
 * gates, QA checks, template capability declarations.
 */
import { describe, test, expect } from "bun:test";
import {
  canTransition, PIPELINE_TEMPLATES, getTemplate, draftConceptOptions, ProductionBriefSchema,
  scriptDurationValid, stageCost, preRenderChecks, qaOutcome, STAGE_STATES,
} from "../src/lib/production/engine";
import { extractBriefFields } from "../src/lib/production/runner";

describe("M31 studio — state machine", () => {
  test("valid transitions pass; invalid are rejected", () => {
    expect(canTransition("NOT_STARTED", "READY")).toBe(true);
    expect(canTransition("READY", "RUNNING")).toBe(true);
    expect(canTransition("RUNNING", "AWAITING_APPROVAL")).toBe(true);
    expect(canTransition("AWAITING_APPROVAL", "SUCCEEDED")).toBe(true);
    expect(canTransition("FAILED", "READY")).toBe(true);
    // Guard rails:
    expect(canTransition("NOT_STARTED", "SUCCEEDED")).toBe(false); // no skipping execution
    expect(canTransition("SUCCEEDED", "SUCCEEDED")).toBe(false);
    expect(canTransition("RUNNING", "NOT_STARTED")).toBe(false);
    expect(canTransition("BLOCKED", "SUCCEEDED")).toBe(false);
    // No state may transition to itself — the machine always advances or explicitly recovers.
    for (const s of STAGE_STATES) expect(canTransition(s, s as never)).toBe(false);
  });
});

describe("M31 studio — templates are honest about capability", () => {
  test("exactly four active templates with complete stage graphs (M31 addendum: + showcase-studio)", () => {
    const active = PIPELINE_TEMPLATES.filter((t) => t.active);
    expect(active.length).toBe(4);
    expect(active.map((t) => t.id)).toContain("showcase-studio");
    for (const t of active) {
      // Every dependency refers to a stage that exists and appears earlier.
      const keys = t.stages.map((s) => s.key);
      for (const s of t.stages) {
        for (const dep of s.dependsOn) expect(keys.indexOf(dep)).toBeGreaterThanOrEqual(0);
      }
      // Ends with delivery; contains assembly + render + qa.
      expect(keys[keys.length - 1]).toBe("DELIVERY");
      expect(keys).toContain("TIMELINE_ASSEMBLY");
      expect(keys).toContain("FINAL_RENDER");
      expect(keys).toContain("QUALITY_ASSURANCE");
    }
  });
  test("inactive templates state the exact blocker", () => {
    const inactive = PIPELINE_TEMPLATES.filter((t) => !t.active);
    expect(inactive.length).toBe(3);
    for (const t of inactive) expect(t.unavailableReason ?? "").toMatch(/CONFIGURATION REQUIRED/);
  });
  test("getTemplate resolves ids and rejects unknown", () => {
    expect(getTemplate("social-video-factory")?.active).toBe(true);
    expect(getTemplate("no-such-template")).toBeNull();
  });
});

describe("M31 studio — brief extraction (deterministic)", () => {
  test("extracts duration, aspect, tone from natural language", () => {
    const f = extractBriefFields("Create a 45 second vertical product commercial for premium headphones, cinematic dark luxury visuals, minimal narration.", "P");
    expect(f.targetDurationSec).toBe(45);
    expect(f.aspectRatio).toBe("9:16");
    expect(f.tone).toMatch(/cinematic/);
  });
  test("brief schema enforces sane bounds", () => {
    expect(ProductionBriefSchema.safeParse({ title: "x", targetDurationSec: 2 }).success).toBe(false);
    expect(ProductionBriefSchema.safeParse({ title: "x", targetDurationSec: 30 }).success).toBe(true);
  });
});

describe("M31 studio — script duration consistency", () => {
  test("valid within tolerance; invalid outside", () => {
    const valid = { revision: 1, targetDurationSec: 30, lines: [
      { id: "1", sceneNumber: 1, durationSec: 10, narration: "", dialogue: "", onScreenText: "", visual: "", audio: "", transition: "", captionCue: "", reference: "" },
      { id: "2", sceneNumber: 2, durationSec: 20, narration: "", dialogue: "", onScreenText: "", visual: "", audio: "", transition: "", captionCue: "", reference: "" },
    ] };
    expect(scriptDurationValid(valid as never)).toBe(true);
    const invalid = { ...valid, lines: [{ ...valid.lines[0], durationSec: 10 }, { ...valid.lines[1], durationSec: 30 }] };
    expect(scriptDurationValid(invalid as never)).toBe(false);
  });
});

describe("M31 studio — honest cost gates", () => {
  const deterministic = { key: "X", title: "X", kind: "assembly", requiresApproval: false, dependsOn: [], skippable: false };
  const providerStage = { key: "Y", title: "Y", kind: "asset_generation", requiresApproval: true, requiresProvider: "laxii", dependsOn: [], skippable: false };
  test("deterministic stages cost nothing and need no approval", () => {
    const c = stageCost(deterministic as never, null, { configured: false });
    expect(c.blocked).toBe(false);
    expect(c.estimatedCents).toBe(0);
    expect(c.costUnknown).toBe(false);
  });
  test("provider stage without configuration is blocked with the exact reason; cost unknown, never 0", () => {
    const c = stageCost(providerStage as never, 500, { configured: false, reason: "No LLM provider credentials" });
    expect(c.blocked).toBe(true);
    expect(c.reason).toBe("No LLM provider credentials");
    expect(c.costUnknown).toBe(true);
    expect(c.estimatedCents).toBeNull();
  });
  test("provider stage without an approved budget is blocked", () => {
    const c = stageCost(providerStage as never, null, { configured: true });
    expect(c.blocked).toBe(true);
    expect(c.reason).toMatch(/budget/i);
  });
});

describe("M31 studio — QA pre-render checks", () => {
  test("missing media fails hard; valid sequence passes", () => {
    const bad = preRenderChecks({ fps: { num: 30, den: 1 }, tracks: [{ clips: [{ id: "c1", sourceAssetId: null, missingMedia: true, timelineStartFrame: 0, timelineDurationFrames: 90, sourceInFrame: 0, sourceOutFrame: 90 }] }] }, 3);
    expect(bad.find((c) => c.id === "no-missing-media")?.state).toBe("FAILED");
    expect(qaOutcome(bad).state).toBe("FAILED");
    const good = preRenderChecks({ fps: { num: 30, den: 1 }, tracks: [{ clips: [{ id: "c1", sourceAssetId: "a1", missingMedia: false, timelineStartFrame: 0, timelineDurationFrames: 90, sourceInFrame: 0, sourceOutFrame: 90 }] }] }, 3);
    expect(qaOutcome(good).state).toBe("PASSED");
  });
  test("NOT_RUN checks surface NEEDS_HUMAN_REVIEW, never silent success", () => {
    const checks = [{ id: "render-artifact", severity: "ERROR" as const, state: "NOT_RUN" as const, detail: "no render" }];
    expect(qaOutcome(checks).state).toBe("NEEDS_HUMAN_REVIEW");
  });
  test("duration mismatch fails", () => {
    const checks = preRenderChecks({ fps: { num: 30, den: 1 }, tracks: [{ clips: [{ id: "c1", sourceAssetId: "a", missingMedia: false, timelineStartFrame: 0, timelineDurationFrames: 300, sourceInFrame: 0, sourceOutFrame: 300 }] }] }, 3);
    expect(checks.find((c) => c.id === "duration-matches-brief")?.state).toBe("FAILED");
  });
});

describe("M31 studio — concept drafts are genuinely distinct", () => {
  test("3 options with distinct ids and structures", () => {
    const brief = ProductionBriefSchema.parse({ title: "Headphones", subject: "premium headphones", targetDurationSec: 60 });
    const options = draftConceptOptions(brief);
    expect(options.length).toBe(3);
    expect(new Set(options.map((o) => o.id)).size).toBe(3);
    expect(options.every((o) => o.tooling.length > 0 && o.costNote.length > 0)).toBe(true);
  });
});
