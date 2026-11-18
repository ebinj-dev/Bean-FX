/**
 * BEAN FX — M17 Phase E tests: new effects registry + transition export graph.
 * Fixture-based; the transition fixtures go through the REAL graph builder.
 * Run: bun test scripts/test-m17-effects.test.ts
 */
import { describe, expect, test } from "bun:test";
import { model, filters } from "./m17-imports";
import { buildTimelineGraph } from "../src/lib/publish/timeline-render";

const fps = { num: 30, den: 1 };
const fx = (type: string, params: Record<string, number>, enabled = true) => ({
  id: `fx_${type}_${Math.random().toString(36).slice(2, 6)}`, type, enabled, params,
});

function mkClip(id: string, trackId: string, start: number, dur: number): import("../src/lib/editor/model").Clip {
  return model.ClipSchema.parse({
    id, trackId, sourceAssetId: `asset_${trackId}`, sourceInFrame: 0, sourceOutFrame: dur, sourceFps: fps,
    timelineStartFrame: start, timelineDurationFrames: dur, playbackSpeed: 1, volume: 1, muted: false,
    fadeInFrames: 0, fadeOutFrames: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    captionText: null, graphicTemplateId: null, graphicStyle: null, keyframes: [], missingMedia: false,
  });
}

function seqWithClips(clips: import("../src/lib/editor/model").Clip[], transitions: unknown[] = []): import("../src/lib/editor/model").Sequence {
  const ids = [...new Set(clips.map((c) => c.trackId))];
  return model.SequenceSchema.parse({
    id: "m17fx", name: "M17 FX", sampleRate: 48000, width: 640, height: 360, fps,
    tracks: ids.map((id) => ({ id, name: id.toUpperCase(), kind: "VIDEO", visible: true, muted: false, solo: false, locked: false })),
    clips, transitions,
  });
}

describe("M17 new effects (whites/blacks/vignette/crop)", () => {
  test("whites/blacks map to eq brightness on BOTH paths", () => {
    const effects = [fx("whites", { value: 0.5 }), fx("blacks", { value: -0.4 })];
    const css = filters.cssEffectFilter(effects)!;
    const ff = filters.ffmpegEffectChain(effects)!;
    expect(css).toContain("brightness(");
    expect(ff).toContain("eq=");
    expect((ff.match(/eq=/g) ?? []).length).toBe(1); // merge rule holds
  });

  test("vignette emits ffmpeg vignette + a discrete-bucket SVG ref", () => {
    const effects = [fx("vignette", { amount: 0.7 })];
    expect(filters.ffmpegEffectChain(effects)).toContain("vignette=PI*0.35");
    expect(filters.cssEffectFilter(effects)).toContain("url(#beanfx-vignette-7)");
  });

  test("crop emits a proportional ffmpeg crop and a CSS inset (marked approx)", () => {
    const effects = [fx("crop", { left: 10, right: 10, top: 5, bottom: 5 })];
    expect(filters.ffmpegEffectChain(effects)).toContain("crop=iw*0.8000:ih*0.9000");
    expect(filters.cssEffectFilter(effects)).toContain("inset(5% 10% 5% 10%)");
    expect(filters.APPROXIMATE_PREVIEW).toContain("crop");
  });

  test("old sequences still parse (additive enum extension)", () => {
    const clip = mkClip("c0", "v1", 0, 60);
    const parsed = model.ClipSchema.parse({ ...clip, effects: [{ id: "fx1", type: "grayscale", enabled: true, params: {} }] });
    expect(parsed.effects[0].type).toBe("grayscale");
  });
});

describe("M17 transition export graph (real frames, honest refusals)", () => {
  const inputs = new Map([
    ["asset_v1", { index: 0, isImage: false, hasAudio: true }],
    ["asset_v2", { index: 1, isImage: false, hasAudio: true }],
  ]);

  test("adjacent pair with CROSS_DISSOLVE renders an xfade with real duration/offset", () => {
    const a = mkClip("a", "v1", 0, 60);
    const b = mkClip("b", "v1", 60, 60);
    const seq = seqWithClips([a, b], [
      { id: "t1", trackId: "v1", kind: "CROSS_DISSOLVE", startFrame: 50, endFrame: 70, durationFrames: 20, clipAId: "a", clipBId: "b", params: {} },
    ]);
    const report = { applied: [], skipped: [] };
    const g = buildTimelineGraph(seq, 0, 120, inputs, report);
    expect(g.filterComplex).toContain("xfade=transition=fade:duration=");
    expect(report.applied.length).toBe(1);
  });

  test("WIPE_LEFT maps to wipeleft; CUT renders a straight boundary", () => {
    const a = mkClip("a", "v1", 0, 60);
    const b = mkClip("b", "v1", 60, 60);
    const wipe = seqWithClips([a, b], [{ id: "t1", trackId: "v1", kind: "WIPE_LEFT", startFrame: 55, endFrame: 65, durationFrames: 10, clipAId: "a", clipBId: "b", params: {} }]);
    expect(buildTimelineGraph(wipe, 0, 120, inputs).filterComplex).toContain("xfade=transition=wipeleft");
    const cut = seqWithClips([a, b], [{ id: "t2", trackId: "v1", kind: "CUT", startFrame: 55, endFrame: 65, durationFrames: 10, clipAId: "a", clipBId: "b", params: {} }]);
    expect(buildTimelineGraph(cut, 0, 120, inputs).filterComplex).not.toContain("xfade");
  });

  test("over-long transition duration is refused honestly and counted", () => {
    const a = mkClip("a", "v1", 0, 60);
    const b = mkClip("b", "v1", 60, 60);
    const seq = seqWithClips([a, b], [{ id: "t3", trackId: "v1", kind: "CROSS_DISSOLVE", startFrame: 50, endFrame: 130, durationFrames: 80, clipAId: "a", clipBId: "b", params: {} }]);
    const report = { applied: [], skipped: [] };
    const g = buildTimelineGraph(seq, 0, 120, inputs, report);
    expect(report.applied.length).toBe(0);
    expect(report.skipped[0].reason).toContain("exceeds the shorter clip");
    // (80f > 60f — beyond both clips' windows: real frames cannot cover it)
    expect(g.filterComplex).not.toContain("xfade"); // fell back to a straight boundary — no wrong output
  });

  test("two video tracks still composite in track order with the transition chain", () => {
    const a = mkClip("a", "v1", 0, 60);
    const b = mkClip("b", "v1", 60, 60);
    const c = mkClip("c", "v2", 0, 120);
    const seq = seqWithClips([a, b, c], [
      { id: "t4", trackId: "v1", kind: "CROSS_DISSOLVE", startFrame: 50, endFrame: 70, durationFrames: 20, clipAId: "a", clipBId: "b", params: {} },
    ]);
    const g = buildTimelineGraph(seq, 0, 120, inputs);
    expect(g.filterComplex).toContain("xfade");
    expect(g.filterComplex).toContain("overlay=eof_action=pass"); // track chains overlay in order
  });
});
