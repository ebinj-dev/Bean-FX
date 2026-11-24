/**
 * BEAN FX — M37 tests: clip transform engine end-to-end + export formats +
 * transition parity + dead-effect registration.
 *
 * Contract under test: ONE shared transform evaluator
 * (src/lib/editor/transform.ts) drives the CSS preview, the composition
 * canvas and the FFmpeg export graph, so the three cannot disagree. Identity
 * transforms must leave the export graph BYTE-IDENTICAL to the pre-M37
 * builder (regression guard for every existing sequence).
 *
 * Run: bun test scripts/test-m37-transform.test.ts
 */
import { describe, expect, test } from "bun:test";
import { model } from "./m17-imports";
import type { Clip, Sequence } from "../src/lib/editor/model";
import {
  clipHasTransform,
  clipHasTransformAnimation,
  cssTransformStyle,
  overlayPositionExprs,
  segmentTransformFilters,
  transformAt,
  transformBoundaryFrames,
  transformIsIdentity,
  transformNeedsSegments,
  transformSplitFrames,
} from "../src/lib/editor/transform";
import { buildTimelineGraph, renderOutputSpec, RENDER_OUTPUT_FORMATS } from "../src/lib/publish/timeline-render";
import { filterSpec, ffmpegEffectChain, cssEffectFilter } from "../src/lib/editor/filters";

const fps = { num: 30, den: 1 };

function mkClip(overrides: Partial<Record<string, unknown>> = {}): Clip {
  return model.ClipSchema.parse({
    id: "c1", trackId: "V1", sourceAssetId: "a1", sourceInFrame: 0, sourceOutFrame: 90, sourceFps: fps,
    timelineStartFrame: 0, timelineDurationFrames: 90, playbackSpeed: 1, volume: 1, muted: false,
    fadeInFrames: 0, fadeOutFrames: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null, label: null,
    missingMedia: false, pan: 0, groupId: null, effects: [], keyframes: [],
    ...overrides,
  });
}

function seqWith(clips: Clip[], transitions: unknown[] = []): Sequence {
  return model.SequenceSchema.parse({
    id: "seq", name: "M37", fps, width: 640, height: 360, sampleRate: 48000,
    tracks: [{ id: "V1", kind: "VIDEO", name: "V1", visible: true, muted: false, solo: false, locked: false, volume: 1 }],
    clips, transitions, markers: [],
  });
}

const INPUTS = new Map([["a1", { index: 0, isImage: false, hasAudio: true }]]);

const kf = (property: string, frame: number, value: number, interpolation = "LINEAR") => ({
  id: `k_${property}_${frame}`, property, frame, value, interpolation, bezier: null,
});

describe("M37 transform evaluator", () => {
  test("identity transform is detected and emits nothing", () => {
    const clip = mkClip();
    expect(transformIsIdentity(transformAt(clip, 0))).toBe(true);
    expect(clipHasTransform(clip)).toBe(false);
    expect(clipHasTransformAnimation(clip)).toBe(false);
    expect(transformNeedsSegments(clip)).toBe(false);
    expect(segmentTransformFilters(clip, seqWith([clip]), 0, { exactRotation: true, tOffsetSec: 0 })).toEqual([]);
  });

  test("static transform resolves through transformAt (composition-pixel convention)", () => {
    const clip = mkClip({ transform: { x: 100, y: -40, scale: 1.5, rotation: 12, opacity: 0.5 } });
    const t = transformAt(clip, 45);
    expect(t.x).toBe(100);
    expect(t.y).toBe(-40);
    expect(t.scale).toBe(1.5);
    expect(t.rotation).toBe(12);
    expect(t.opacity).toBe(0.5);
    expect(clipHasTransform(clip)).toBe(true);
  });

  test("keyframed properties evaluate through the shared NIIKI evaluator (parity math)", () => {
    const clip = mkClip({ keyframes: [kf("scale", 0, 1), kf("scale", 90, 2)] });
    expect(transformAt(clip, 0).scale).toBe(1);
    expect(transformAt(clip, 45).scale).toBeCloseTo(1.5, 10);
    expect(transformAt(clip, 90).scale).toBe(2);
    // beyond the last keyframe: hold last value (standard NLE semantics)
    expect(transformAt(clip, 500).scale).toBe(2);
  });

  test("HOLD holds the previous keyframe; EASE_IN_OUT follows the smoothstep shape", () => {
    const hold = mkClip({ keyframes: [kf("x", 0, 0, "HOLD"), kf("x", 30, 100, "HOLD")] });
    expect(transformAt(hold, 29).x).toBe(0);
    expect(transformAt(hold, 30).x).toBe(100);
    const ease = mkClip({ keyframes: [kf("y", 0, 0, "EASE_IN_OUT"), kf("y", 40, 100, "EASE_IN_OUT")] });
    // EASE_IN_OUT = the NIIKI evaluator's symmetric cubic (4u³ before the
    // midpoint) — ONE interpolation contract shared with the graphics engine.
    expect(transformAt(ease, 20).y).toBeCloseTo(50, 6); // u=0.5 → 0.5
    expect(transformAt(ease, 10).y).toBeCloseTo(100 * 4 * Math.pow(0.25, 3), 6); // 4·0.25³ → 6.25
  });

  test("BEZIER interpolation is exact at segment endpoints", () => {
    const clip = mkClip({ keyframes: [kf("opacity", 0, 1, "BEZIER"), kf("opacity", 60, 0, "BEZIER")] });
    expect(transformAt(clip, 0).opacity).toBe(1);
    expect(transformAt(clip, 60).opacity).toBe(0);
  });

  test("split machinery: scale/opacity force segments; x/y/rotation alone animate exactly", () => {
    const xyOnly = mkClip({ keyframes: [kf("x", 10, 50), kf("y", 20, 60), kf("rotation", 30, 45)] });
    expect(transformNeedsSegments(xyOnly)).toBe(false);
    const scaleKf = mkClip({ keyframes: [kf("scale", 10, 2)] });
    expect(transformNeedsSegments(scaleKf)).toBe(true);
    const frames = transformSplitFrames(scaleKf, 90);
    expect(frames).toEqual([10]); // a single keyframe samples exactly at itself
    const two = transformSplitFrames(mkClip({ keyframes: [kf("scale", 10, 1), kf("scale", 50, 3)] }), 90);
    expect(two).toEqual([10, 20, 30, 40, 50]); // sampled every 10 frames between first/last
    expect(transformBoundaryFrames(scaleKf, 90)).toEqual(frames); // no extra props
    expect(transformBoundaryFrames(xyOnly, 90)).toEqual([10, 20, 30]); // exact props add their keyframes
  });
});

describe("M37 preview (CSS) style generation", () => {
  test("identity → null styles (no style churn)", () => {
    expect(cssTransformStyle(transformAt(mkClip(), 0), 1)).toEqual({ transform: null, opacity: null });
  });

  test("static transform → translate/scale/rotate with the display factor applied to x/y", () => {
    const clip = mkClip({ transform: { x: 100, y: -50, scale: 2, rotation: -30, opacity: 0.75 } });
    const s = cssTransformStyle(transformAt(clip, 0), 0.5);
    expect(s.transform).toBe("translate(50.00px, -25.00px) scale(2.0000) rotate(-30.000deg)");
    expect(s.opacity).toBe("0.7500");
  });

  test("opacity ≥ 1 emits no opacity style", () => {
    const clip = mkClip({ transform: { x: 10, y: 0, scale: 1, rotation: 0, opacity: 1 } });
    expect(cssTransformStyle(transformAt(clip, 0), 1).opacity).toBe(null);
  });
});

describe("M37 export graph — identity sequences stay byte-identical", () => {
  test("no transform filters appear for an untouched sequence", () => {
    const seq = seqWith([mkClip()]);
    const g = buildTimelineGraph(seq, 0, 90, INPUTS);
    expect(g.filterComplex).not.toContain("rotate=");
    expect(g.filterComplex).not.toContain("colorchannelmixer");
    expect(g.filterComplex).not.toContain("color=c=black@0.0");
    expect(g.filterComplex).not.toContain("overlay=x=");
  });
});

describe("M37 export graph — static transform", () => {
  const clip = mkClip({ transform: { x: 80, y: 40, scale: 0.5, rotation: 0, opacity: 1 } });
  const seq = seqWith([clip]);
  const g = buildTimelineGraph(seq, 0, 90, INPUTS);

  test("segment carries the geometry chain (rotate/scale in segment, position on canvas overlay)", () => {
    expect(g.filterComplex).toContain("scale=320:180"); // 640×0.5, 360×0.5
    expect(g.filterComplex).toContain("color=c=black@0.0:s=640x360"); // transparent positioning canvas
    expect(g.filterComplex).toContain("overlay="); // positioned overlay
    // centering compensation: x = W·(1−s)/2 + x = 160+80 = 240; y = 90+40 = 130
    expect(g.filterComplex).toContain("x='240'");
    expect(g.filterComplex).toContain("y='130'");
  });

  test("opacity rides the alpha mixer before compositing", () => {
    const clip2 = mkClip({ transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 0.4 } });
    const g2 = buildTimelineGraph(seqWith([clip2]), 0, 90, INPUTS);
    expect(g2.filterComplex).toContain("colorchannelmixer=aa=0.4");
  });

  test("static rotation emits radians with transparent fill", () => {
    const clip3 = mkClip({ transform: { x: 0, y: 0, scale: 1, rotation: 90, opacity: 1 } });
    const g3 = buildTimelineGraph(seqWith([clip3]), 0, 90, INPUTS);
    expect(g3.filterComplex).toContain("rotate=a=1.5708:fillcolor=black@0");
  });

  test("animated rotation alone stays EXACT (per-frame expression, no split)", () => {
    const clip4 = mkClip({ keyframes: [kf("rotation", 0, 0), kf("rotation", 90, 90)] });
    const g4 = buildTimelineGraph(seqWith([clip4]), 0, 90, INPUTS);
    expect(g4.filterComplex).toContain("rotate=a='");
    expect(g4.filterComplex).not.toContain("concat="); // no sampled sub-segments
  });

  test("animated scale forces the sampled split path with per-segment constants", () => {
    const clip5 = mkClip({ keyframes: [kf("scale", 0, 1), kf("scale", 90, 2)] });
    const g5 = buildTimelineGraph(seqWith([clip5]), 0, 90, INPUTS);
    expect(g5.filterComplex).toContain("split=");
    expect(g5.filterComplex).toContain("concat=");
    expect(g5.filterComplex).toContain("scale=640:360"); // sample at t=0 → scale 1
    expect(g5.filterComplex).toContain("scale=1209:680"); // last sampled segment (t=80 → 1.8889×, rounded)
    // split-path segments are re-fitted to the sequence dims (center crop for
    // s>1, transparent pad for s<1) so concat sees uniform sizes — the scaled
    // content is pre-centered, so the position expr carries NO centering term
    expect(g5.filterComplex).toContain("crop=640:360:(iw-640)/2:(ih-360)/2");
    expect(g5.filterComplex).toContain("overlay=eof_action=pass[tpos0]"); // no x= term — pre-centered
  });
});

describe("M37 export graph — transforms inside transition runs", () => {
  function twoClipSeq(clipATransform: unknown, clipBTransform: unknown, kind = "CROSS_DISSOLVE"): Sequence {
    const a = mkClip({ id: "ca", timelineStartFrame: 0, sourceOutFrame: 45, timelineDurationFrames: 45 });
    const b = mkClip({ id: "cb", timelineStartFrame: 45, sourceOutFrame: 45, timelineDurationFrames: 45 });
    const tr = {
      id: "t1", trackId: "V1", kind, startFrame: 45, endFrame: 45 + 10, durationFrames: 10, clipAId: "ca", clipBId: "cb", params: {},
    };
    if (clipATransform) (a as unknown as { transform: unknown }).transform = clipATransform;
    if (clipBTransform) (b as unknown as { transform: unknown }).transform = clipBTransform;
    return seqWith([a, b], [tr]);
  }

  test("per-clip transparent canvases + xfade; every run segment carries alpha", () => {
    const seq = twoClipSeq({ x: 50, y: 0, scale: 1, rotation: 0, opacity: 1 }, { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 });
    const g = buildTimelineGraph(seq, 0, 90, INPUTS);
    expect(g.filterComplex).toContain("xfade=transition=fade");
    expect(g.filterComplex).toContain("color=c=black@0.0:s=640x360");
    expect(g.filterComplex).toContain("format=yuva420p"); // alpha normalization for xfade consistency
    expect(g.filterComplex).toContain("overlay=x=");
  });

  test("ZOOM_IN exports as the real zoomin xfade; ZOOM_OUT stays an honest skip", () => {
    const zoomIn = twoClipSeq(null, null, "ZOOM_IN");
    expect(buildTimelineGraph(zoomIn, 0, 90, INPUTS).filterComplex).toContain("xfade=transition=zoomin");
    const zoomOut = twoClipSeq(null, null, "ZOOM_OUT");
    const g = buildTimelineGraph(zoomOut, 0, 90, INPUTS);
    expect(g.filterComplex).not.toContain("xfade=transition=zoomout"); // no such xfade — never faked
    const report = { applied: [], skipped: [] };
    buildTimelineGraph(zoomOut, 0, 90, INPUTS, report);
    expect(report.applied).toEqual([]);
  });

  test("FADE_FROM_BLACK maps to the through-black xfade (parity with FADE_TO_BLACK)", () => {
    const seq = twoClipSeq(null, null, "FADE_FROM_BLACK");
    expect(buildTimelineGraph(seq, 0, 90, INPUTS).filterComplex).toContain("xfade=transition=fadeblack");
  });
});

describe("M37 export formats", () => {
  test("format registry covers mp4/mov/wav/mp3 with correct containers", () => {
    expect([...RENDER_OUTPUT_FORMATS]).toEqual(["mp4", "mov", "wav", "mp3"]);
    expect(renderOutputSpec("mp4")).toMatchObject({ extension: "mp4", audioOnly: false });
    expect(renderOutputSpec("mov")).toMatchObject({ extension: "mov", audioOnly: false });
    expect(renderOutputSpec("wav")).toMatchObject({ extension: "wav", audioOnly: true });
    expect(renderOutputSpec("mp3")).toMatchObject({ extension: "mp3", audioOnly: true });
  });

  test("video formats keep the bounded-memory encoder caps; audio formats drop video", () => {
    for (const f of ["mp4", "mov"] as const) {
      const spec = renderOutputSpec(f);
      expect(spec.encoderArgs).toContain("-c:v");
      expect(spec.encoderArgs).toContain("libx264");
      expect(spec.encoderArgs).toContain("-threads");
      expect(spec.encoderArgs).toContain("2");
    }
    expect(renderOutputSpec("wav").encoderArgs).toEqual(["-vn", "-c:a", "pcm_s16le"]);
    expect(renderOutputSpec("mp3").encoderArgs).toContain("libmp3lame");
  });
});

describe("M37 dead effects are now real", () => {
  test("flipH/flipV map to hflip/vflip (FFmpeg) and scaleX/scaleY (CSS)", () => {
    expect(filterSpec("flipH")?.ffmpeg({})).toBe("hflip");
    expect(filterSpec("flipH")?.css({})).toBe("scaleX(-1)");
    expect(filterSpec("flipV")?.ffmpeg({})).toBe("vflip");
    expect(filterSpec("flipV")?.css({})).toBe("scaleY(-1)");
    const effects = [{ id: "f", type: "flipH" as const, enabled: true, params: {}, keyframes: [], animatedParams: [] }];
    expect(ffmpegEffectChain(effects)).toBe("hflip");
    expect(cssEffectFilter(effects)).toBe("scaleX(-1)");
  });

  test("opacity effect scales alpha on both paths", () => {
    expect(filterSpec("opacity")?.ffmpeg({ value: 0.3 })).toBe("format=yuva420p,colorchannelmixer=aa=0.3000");
    expect(filterSpec("opacity")?.css({ value: 0.3 })).toBe("opacity(0.3000)");
  });

  test("every EffectType has a registry mapping (no silent no-ops remain)", () => {
    for (const type of model.EffectType.options) {
      if (type === "volume") continue; // audio-only by design
      expect(filterSpec(type)).not.toBeNull();
    }
  });
});

describe("M41 — SAR normalization before concat (real render regression)", () => {
  test("animated-scale chains re-assert setsar AFTER format=yuva420p (M41 -22 defect)", () => {
    // The piecewise (animated) transform path concatenates sub-segments. The
    // alpha pixel-format conversion (format=yuva420p) re-derives SAR from the
    // decoded source metadata, so a chain that ends on the format change can
    // present a non-1:1 SAR to the concat while its siblings carry 1:1 —
    // ffmpeg then fails the whole graph with -22 (observed live in the M41
    // E2E journey: 1920x1080 SAR 4364:4365 vs 1:1; mp4/mov renders died while
    // wav/mp3 passed, because the audio-only paths never hit the video concat).
    const c = mkClip({
      sourceOutFrame: 240,
      timelineDurationFrames: 240,
      keyframes: [kf("scale", 0, 1), kf("scale", 239, 1.25)],
    });
    const g = buildTimelineGraph(seqWith([c]), 0, 240, INPUTS);
    expect(g.filterComplex).toContain("concat=");
    expect(g.filterComplex).toContain("format=yuva420p");
    // No chain may END on the pixel-format change right at a label: SAR must
    // be re-asserted after it (format=yuva420p,setsar=1).
    expect(g.filterComplex).not.toMatch(/format=yuva420p\[/);
    expect(g.filterComplex).toContain("format=yuva420p,setsar=1");
  });
});
