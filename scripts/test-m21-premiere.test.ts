/**
 * M21 P5 tests — Premiere UXP adapter contract: honest capability probing,
 * runtime absence = explicit failure (never simulated), supported op set,
 * snapshot recovery, metadata-only media resolution.
 * Run: bun test scripts/test-m21-premiere.test.ts
 */
import { describe, expect, test } from "bun:test";
import {
  PremiereHostAdapter, premiereCapabilities, detectPremiereRuntime,
  PREMIERE_IMPLEMENTED_FEATURES, PREMIERE_IMPLEMENTED_OPS,
} from "../src/lib/premiere/uxp-adapter";
import { sequenceToCanonical } from "../src/lib/core/converters";
import { makeOp } from "../src/lib/core/host-adapter";

function fixtureCanonical() {
  return sequenceToCanonical({
    id: "prem-1", name: "Premiere fixture", fps: { num: 25, den: 1 }, width: 1920, height: 1080,
    sampleRate: 48000,
    tracks: [{ id: "t1", kind: "VIDEO", name: "V1", visible: true, muted: false, solo: false, locked: false }],
    clips: [{
      id: "c1", trackId: "t1", sourceAssetId: "a1", sourceInFrame: 0, sourceOutFrame: 50,
      sourceFps: { num: 25, den: 1 }, timelineStartFrame: 0, timelineDurationFrames: 50,
      playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0,
      transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, opacity: 1 },
      captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null,
      label: null, missingMedia: false, effects: [], keyframes: [],
    }],
    transitions: [],
  });
}

// A fake UXP require("premierepro") — verifies the probing path ONLY.
function fakeUxpRequire(seq?: Record<string, unknown>) {
  return ((id: string) => {
    if (id !== "premierepro") return undefined;
    return {
      getActiveSequence: () => (seq ?? {
        name: "Active", width: 3840, height: 2160, frameRateRate: 29.97 * 1001 / 1000, frameRateDenominator: 1001, audioSettings: { sampleRate: 48000 },
      }),
    } as never;
  }) as unknown as ConstructorParameters<typeof PremiereHostAdapter>[0];
}

describe("Premiere adapter honesty (M21 §4/§5)", () => {
  test("outside UXP: runtime detected as absent and every host call FAILS LOUDLY", async () => {
    const adapter = new PremiereHostAdapter(); // no UXP in bun test env
    expect(adapter.runtimeAvailable).toBe(false);
    expect(adapter.capabilities.features).toEqual([]);      // no false capability claims
    expect(adapter.capabilities.timelineOps).toEqual([]);
    await expect(adapter.importProject(fixtureCanonical())).rejects.toThrow(/hostUnavailable/);
    await expect(adapter.applyOp(makeOp("MOVE_CLIP", { clipId: "c1", timelineStartFrame: 10 }, null))).rejects.toThrow(/hostUnavailable/);
    const res = await adapter.resolveMedia("beanfx-asset://a1");
    expect(res.ok).toBe(false);
  });

  test("with a UXP runtime present: capabilities list ONLY implemented features", () => {
    const adapter = new PremiereHostAdapter(fakeUxpRequire());
    expect(adapter.runtimeAvailable).toBe(true);
    expect(adapter.capabilities.features).toEqual([...PREMIERE_IMPLEMENTED_FEATURES]);
    expect(adapter.capabilities.timelineOps).toEqual([...PREMIERE_IMPLEMENTED_OPS]);
    // What Premiere UXP does NOT expose is never claimed:
    expect(adapter.capabilities.features).not.toContain("direct-timeline-write");
    expect(adapter.capabilities.features).not.toContain("gpu-effects");
    expect(adapter.capabilities.features).not.toContain("local-ai-inference");
  });

  test("import enriches canonical project with VERIFIED active-sequence metadata", async () => {
    const adapter = new PremiereHostAdapter(fakeUxpRequire({
      name: "Active", width: 3840, height: 2160, frameRateRate: 30000, frameRateDenominator: 1001, audioSettings: { sampleRate: 44100 },
    }));
    const imp = await adapter.importProject(fixtureCanonical());
    expect(imp.ok).toBe(true);
    const exp = await adapter.exportProject();
    expect(exp.ok).toBe(true);
    if (exp.ok) {
      expect(exp.project.width).toBe(3840);
      expect(exp.project.height).toBe(2160);
      expect(exp.project.fps).toEqual({ num: 30000, den: 1001 });
      expect(exp.project.sampleRate).toBe(44100);
    }
  });

  test("implemented ops apply + journal; unsupported ops REJECTED without state change", async () => {
    const adapter = new PremiereHostAdapter(fakeUxpRequire());
    await adapter.importProject(fixtureCanonical());
    const okMove = await adapter.applyOp(makeOp("MOVE_CLIP", { clipId: "c1", timelineStartFrame: 25 }, null));
    expect(okMove.ok).toBe(true);
    const exp = await adapter.exportProject();
    expect(exp.ok && exp.project.clips[0].timelineStartFrame).toBe(25);
    expect(exp.ok && exp.project.baseVersion).toBe(1);
    // unsupported op → explicit refusal, no false claim, state unchanged
    const bad = await adapter.applyOp(makeOp("SET_TRANSITION", { clipAId: "c1", clipBId: "c1", kind: "CROSS_DISSOLVE" }, null));
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.error).toContain("unsupportedOp");
    expect(bad.ok === false && bad.hostStateUnchanged).toBe(true);
    const exp2 = await adapter.exportProject();
    expect(exp2.ok && exp2.project.baseVersion).toBe(1); // unchanged
  });

  test("failed apply restores the pre-op snapshot (host state untouched)", async () => {
    const adapter = new PremiereHostAdapter(fakeUxpRequire());
    await adapter.importProject(fixtureCanonical());
    const before = await adapter.exportProject();
    const failing = makeOp("DELETE_CLIP", { clipId: "no-such-clip" }, null);
    const r = await adapter.applyOp(failing);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.hostStateUnchanged).toBe(true);
    const after = await adapter.exportProject();
    expect(after.ok && before.ok && after.project.baseVersion).toBe(before.ok ? before.project.baseVersion : -1);
    expect(after.ok && after.project.clips.length).toBe(1);
  });

  test("media resolution is metadata-only (no path guessing, no fake media)", async () => {
    const adapter = new PremiereHostAdapter(fakeUxpRequire());
    const miss = await adapter.resolveMedia("beanfx-asset://a1");
    expect(miss.ok).toBe(false);
    adapter.registerMetadata("beanfx-asset://a1", "premiere://project/a1");
    const hit = await adapter.resolveMedia("beanfx-asset://a1");
    expect(hit.ok).toBe(true);
    expect(hit.ok && hit.handle).toBe("premiere://project/a1");
  });

  test("snapshot recovery rolls the host back", async () => {
    const adapter = new PremiereHostAdapter(fakeUxpRequire());
    await adapter.importProject(fixtureCanonical());
    const op1 = await adapter.applyOp(makeOp("SET_CLIP_PROPS", { clipId: "c1", props: { label: "changed" } }, null));
    const mid = await adapter.exportProject();
    expect(mid.ok && mid.project.clips[0].label).toBe("changed");
    // Crash simulation: roll back to the state BEFORE op1 (= post-import).
    await adapter.restoreSnapshot((op1 as { snapshotId: string }).snapshotId);
    const back = await adapter.exportProject();
    expect(back.ok && back.project.clips[0].label).toBe(null);
  });

  test("capability descriptor is deterministic + versioned", () => {
    const c = premiereCapabilities(true);
    expect(c.host).toBe("premiere-pro");
    expect(c.adapterVersion).toBe("1.0.0");
    expect(c.formatVersions).toEqual(["beanfx-project-v1"]);
    const off = premiereCapabilities(false);
    expect(off.features).toEqual([]);
    expect(off.timelineOps).toEqual([]);
    expect(detectPremiereRuntime(() => undefined).available).toBe(false);
    expect(detectPremiereRuntime(() => { throw new Error("boom"); }).available).toBe(false);
  });
});
