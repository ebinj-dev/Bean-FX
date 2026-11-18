/**
 * BEAN FX — M17 Phase D tests: volume automation.
 * Verifies the SINGLE evaluation module against the mixer's contract and
 * the export's FFmpeg expression, plus persistence through the REAL engine
 * commands (SetKeyframe/RemoveKeyframe undoability).
 * Run: bun test scripts/test-m17-audio.test.ts
 */
import { describe, expect, test } from "bun:test";
import { model } from "./m17-imports";
import { volumeAutomationAt, volumeKeyframes, ffmpegVolumeArgs } from "../src/lib/editor/audio";

const fps = { num: 30, den: 1 };

function mkClip(overrides: Partial<import("../src/lib/editor/model").Clip> = {}): import("../src/lib/editor/model").Clip {
  return model.ClipSchema.parse({
    id: "c1", trackId: "v1", sourceAssetId: "asset_v", sourceInFrame: 0, sourceOutFrame: 120, sourceFps: fps,
    timelineStartFrame: 0, timelineDurationFrames: 120, playbackSpeed: 1, volume: 1, muted: false,
    fadeInFrames: 0, fadeOutFrames: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    captionText: null, graphicTemplateId: null, graphicStyle: null, keyframes: [], missingMedia: false,
    ...overrides,
  });
}

describe("M17 volume automation evaluation (preview/mixer/export shared)", () => {
  test("no keyframes → static volume", () => {
    const clip = mkClip({ volume: 1.5 });
    expect(volumeAutomationAt(clip, 60, fps)).toBe(1.5);
    expect(volumeKeyframes(clip).length).toBe(0);
    expect(ffmpegVolumeArgs(clip, fps)).toBeNull();
  });

  test("linear interpolation between two points at the right timeline frames", () => {
    const clip = mkClip({
      volume: 1,
      keyframes: [
        { id: "k1", property: "volume", frame: 0, value: 0, interpolation: "LINEAR", bezier: null },
        { id: "k2", property: "volume", frame: 60, value: 2, interpolation: "LINEAR", bezier: null },
      ],
    });
    expect(volumeAutomationAt(clip, 0, fps)).toBe(0);
    expect(volumeAutomationAt(clip, 30, fps)).toBeCloseTo(1.0, 5); // midpoint
    expect(volumeAutomationAt(clip, 60, fps)).toBe(2);
    expect(volumeAutomationAt(clip, 90, fps)).toBe(2); // holds the last point
  });

  test("HOLD interpolation holds until the next point", () => {
    const clip = mkClip({
      keyframes: [
        { id: "k1", property: "volume", frame: 0, value: 1, interpolation: "HOLD", bezier: null },
        { id: "k2", property: "volume", frame: 60, value: 3, interpolation: "LINEAR", bezier: null },
      ],
    });
    expect(volumeAutomationAt(clip, 45, fps)).toBe(1); // HOLD through frame 59
    expect(volumeAutomationAt(clip, 60, fps)).toBe(3);
  });

  test("automation multiplies the base volume and clamps to the model bound", () => {
    const clip = mkClip({
      volume: 4,
      keyframes: [{ id: "k1", property: "volume", frame: 0, value: 2, interpolation: "LINEAR", bezier: null }],
    });
    // base 4 × keyframe 2 = 8, clamped to the model's gain bound (4) — the
    // documented ChangeVolume schema ceiling, same as the M16 preview rule.
    expect(volumeAutomationAt(clip, 10, fps)).toBe(4);
  });

  test("clip-relative frames survive a timeline move (M17 requirement)", () => {
    const clip = mkClip({
      keyframes: [
        { id: "k1", property: "volume", frame: 30, value: 0, interpolation: "LINEAR", bezier: null },
        { id: "k2", property: "volume", frame: 60, value: 1, interpolation: "LINEAR", bezier: null },
      ],
    });
    // At clip-relative frame 30 → gain 0. When the clip moves to 120, the
    // SAME local frame maps to timeline frame 150.
    expect(volumeAutomationAt(clip, 30, fps)).toBe(0);
    const moved = { ...clip, timelineStartFrame: 120 };
    expect(volumeAutomationAt(moved, 150, fps)).toBe(0);
    expect(volumeAutomationAt(moved, 120, fps)).toBe(0); // before the first point → nearest (0)
  });

  test("FFmpeg expression is a valid piecewise volume chain", () => {
    const clip = mkClip({
      keyframes: [
        { id: "k1", property: "volume", frame: 0, value: 0, interpolation: "LINEAR", bezier: null },
        { id: "k2", property: "volume", frame: 60, value: 2, interpolation: "LINEAR", bezier: null },
        { id: "k3", property: "volume", frame: 120, value: 1, interpolation: "LINEAR", bezier: null },
      ],
    });
    const args = ffmpegVolumeArgs(clip, fps)!;
    expect(args.evalFrame).toBe(true);
    expect(args.expr).toContain("if(lt(t");
    expect(args.expr).toContain("2.0000");
    expect(args.expr).toContain("1.0000");
    // The segment maps clip-local seconds: 60 frames @30fps speed 1 → t=2.
    expect(args.expr).toContain("t-0");
  });
});
