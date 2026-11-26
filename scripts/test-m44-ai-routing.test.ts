/**
 * M44 — AI command routing (pure layer, no DB).
 *
 * Covers: direct-command intent classification (anchored so builds like
 * "create a montage" never get swallowed), canonical command parsing against
 * REAL sequence state (fps/track ids), honest failures for under-specified
 * requests, and schema-valid one-step APPLY_COMMANDS plans from the parse
 * result. Run: bun test scripts/test-m44-ai-routing.test.ts
 */
import { describe, expect, test } from "bun:test";
import { classifyIntent, isDirectCommandPhrase, parseDirectCommand } from "../src/lib/ai/riishe";
import { AIPlanSchema } from "../src/lib/my-ai/planner/schema";
import { newId } from "../src/lib/my-ai/ids";

const FPS = 30;
const TRACKS = [
  { id: "trk_v1", kind: "VIDEO", name: "Video 1" },
  { id: "trk_v2", kind: "VIDEO", name: "Video 2" },
  { id: "trk_a1", kind: "AUDIO", name: "Audio 1" },
  { id: "trk_a2", kind: "AUDIO", name: "Audio 2" },
];

describe("M44 routing: intent classification", () => {
  test("routes direct marker commands to command-op", () => {
    expect(classifyIntent("Add a marker named AI Demo at frame 150")).toBe("command-op");
    expect(classifyIntent("add a marker at 5s")).toBe("command-op");
    expect(classifyIntent("create a marker named Intro at frame 20")).toBe("command-op");
    expect(classifyIntent("mute audio 2")).toBe("command-op");
    expect(classifyIntent("solo the audio track")).toBe("command-op");
  });

  test("does NOT swallow build/style requests that merely mention markers", () => {
    expect(classifyIntent("create a montage with markers on the beat")).toBe("build");
    expect(classifyIntent("turn this footage into a trailer")).toBe("build");
    expect(classifyIntent("show me three style options")).toBe("style-compare");
  });

  test("isDirectCommandPhrase is anchored to the sentence start", () => {
    expect(isDirectCommandPhrase("add a marker at frame 10")).toBe(true);
    expect(isDirectCommandPhrase("please mute audio 1")).toBe(true);
    expect(isDirectCommandPhrase("I want you to add a marker")).toBe(false);
  });
});

describe("M44 routing: parseDirectCommand — markers", () => {
  test("parses named markers at an explicit frame", () => {
    const parsed = parseDirectCommand("add a marker named AI Demo at frame 150", FPS, TRACKS);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.commands[0].type).toBe("AddMarker");
    if (parsed.commands[0].type !== "AddMarker") return;
    expect(parsed.commands[0].marker.frame).toBe(150);
    expect(parsed.commands[0].marker.label).toBe("AI Demo");
    expect(parsed.expectedChanges[0]).toContain("frame 150");
  });

  test("converts seconds to frames with the real sequence fps", () => {
    const parsed = parseDirectCommand("add a marker at 5s", FPS, TRACKS);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    if (parsed.commands[0].type !== "AddMarker") return;
    expect(parsed.commands[0].marker.frame).toBe(150);
    expect(parsed.summary).toContain("from seconds");
  });

  test("labels may be quoted and marked unnamed markers default to empty label", () => {
    const parsed = parseDirectCommand('add a marker named "ch.2 intro" at frame 45', FPS, TRACKS);
    if (!parsed.ok) throw new Error("expected ok");
    if (parsed.commands[0].type !== "AddMarker") throw new Error("wrong type");
    expect(parsed.commands[0].marker.label).toBe("ch.2 intro");
    const bare = parseDirectCommand("add a marker at frame 0", FPS, TRACKS);
    if (!bare.ok) throw new Error("expected ok");
    if (bare.commands[0].type !== "AddMarker") throw new Error("wrong type");
    expect(bare.commands[0].marker.label).toBe("");
    expect(bare.commands[0].marker.frame).toBe(0);
  });

  test("missing frame position asks honestly instead of guessing", () => {
    const parsed = parseDirectCommand("add a marker named Intro", FPS, TRACKS);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reply).toMatch(/frame|5s/i);
  });
});

describe("M44 routing: parseDirectCommand — track mute/solo", () => {
  test("mute audio 2 resolves the REAL audio track id", () => {
    const parsed = parseDirectCommand("mute audio 2", FPS, TRACKS);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.commands[0]).toEqual({ type: "UpdateTrack", trackId: "trk_a2", muted: true });
  });

  test("unmute/solo map to the correct UpdateTrack patches", () => {
    const unmute = parseDirectCommand("unmute the audio track", FPS, TRACKS);
    if (!unmute.ok) throw new Error("expected ok");
    expect(unmute.commands[0]).toEqual({ type: "UpdateTrack", trackId: "trk_a1", muted: false });
    const solo = parseDirectCommand("solo video 2", FPS, TRACKS);
    if (!solo.ok) throw new Error("expected ok");
    expect(solo.commands[0]).toEqual({ type: "UpdateTrack", trackId: "trk_v2", solo: true });
  });

  test("missing or out-of-range tracks answer with the REAL track list", () => {
    const missing = parseDirectCommand("mute audio 9", FPS, TRACKS);
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.reply).toContain("Audio 1");
    const unknown = parseDirectCommand("mute something", FPS, TRACKS);
    expect(unknown.ok).toBe(false);
  });
});

describe("M44 routing: parse results become schema-valid plans", () => {
  test("one-step APPLY_COMMANDS plan validates against AIPlanSchema", () => {
    const parsed = parseDirectCommand("add a marker named AI Demo at frame 150", FPS, TRACKS);
    if (!parsed.ok) throw new Error("expected ok");
    const plan = AIPlanSchema.parse({
      schemaVersion: 1,
      planId: newId("plan"),
      projectId: "proj_test",
      requestSummary: "add a marker named AI Demo at frame 150",
      engines: ["RIISHE"],
      steps: [{
        id: "s1",
        operation: "APPLY_COMMANDS",
        engine: "RIISHE",
        dependsOn: [],
        args: { commands: parsed.commands },
        title: parsed.summary,
        description: "Single canonical editing command parsed from your request (M44 command routing)",
        readsAssetIds: [],
        writesAssetIds: [],
        affectedRange: null,
        risk: "timeline",
      }],
      expectedChanges: parsed.expectedChanges,
      warnings: ["Executes only after your approval — fully undoable via the editor history."],
      estimatedUsage: { llmCalls: 0, generationCalls: 0, note: "Deterministic command routing — no model inference." },
      contextVersion: "v:1:4:240",
      idempotencyKey: `cmd-test-${newId("k")}`,
    });
    expect(plan.steps.length).toBe(1);
    expect(plan.steps[0].operation).toBe("APPLY_COMMANDS");
    expect(plan.idempotencyKey.length).toBeGreaterThanOrEqual(6);
  });
});
