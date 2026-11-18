/**
 * M27 Phase 2 — per-effect parameter keyframes: evaluator math (all 5
 * interpolation modes), commands (add/update/delete/toggle + undo/redo +
 * validation), persistence/legacy compatibility, expression generation and
 * export-chain sampling parity.
 */
import { describe, test, expect } from "bun:test";
import { applyCommand } from "../src/lib/editor/commands";
import { SequenceSchema, type Sequence, type Clip, type Effect } from "../src/lib/editor/model";
import { effectParamAt, evaluatedEffectParams, ffmpegEffectChainAnimated, segmentSplitFrames, cssEffectFilterAt } from "../src/lib/editor/filters";

let n = 0;
const nid = (p: string) => `${p}-${++n}`;

function clip(trackId: string, start: number, dur: number, effects: Effect[] = []): Clip {
  return {
    id: nid("c"), trackId, sourceAssetId: "asset-src", sourceInFrame: 0, sourceOutFrame: dur,
    sourceFps: { num: 30, den: 1 }, timelineStartFrame: start, timelineDurationFrames: dur,
    playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null,
    label: null, missingMedia: false, pan: 0, groupId: null, effects, keyframes: [],
  } as unknown as Clip;
}

function fixture(effects: Effect[] = []): Sequence {
  n = 0;
  const raw = {
    id: "seq", name: "M27 kf", fps: { num: 30, den: 1 }, width: 640, height: 360, sampleRate: 48000,
    tracks: [{ id: "V1", kind: "VIDEO", name: "V1", visible: true, muted: false, solo: false, locked: false, volume: 1 }],
    clips: [clip("V1", 0, 60, effects)], transitions: [], markers: [],
  };
  return SequenceSchema.parse(raw);
}

const brightnessEffect = (): Effect => ({
  id: "fx-b", type: "brightness", enabled: true,
  params: { value: 0 }, keyframes: [], animatedParams: [],
});

describe("M27 P2 — evaluator math", () => {
  test("LINEAR interpolation exact at midpoints; clamped outside keyframe range", () => {
    const e = brightnessEffect();
    e.animatedParams = ["value"];
    e.keyframes = [
      { id: "k1", param: "value", frame: 10, value: 0, interpolation: "LINEAR" },
      { id: "k2", param: "value", frame: 30, value: 1, interpolation: "LINEAR" },
    ];
    expect(effectParamAt(e, "value", 10)).toBe(0);
    expect(effectParamAt(e, "value", 20)).toBeCloseTo(0.5, 10);
    expect(effectParamAt(e, "value", 30)).toBe(1);
    expect(effectParamAt(e, "value", 0)).toBe(0); // before first
    expect(effectParamAt(e, "value", 59)).toBe(1); // after last
    expect(effectParamAt(e, "value", 15)).toBeCloseTo(0.25, 10);
  });

  test("HOLD keeps the previous value across the span", () => {
    const e = brightnessEffect();
    e.animatedParams = ["value"];
    e.keyframes = [
      { id: "k1", param: "value", frame: 0, value: 0.2, interpolation: "HOLD" },
      { id: "k2", param: "value", frame: 20, value: 0.8, interpolation: "LINEAR" },
    ];
    expect(effectParamAt(e, "value", 19)).toBe(0.2);
    expect(effectParamAt(e, "value", 20)).toBe(0.8);
  });

  test("EASE_IN / EASE_OUT / EASE_IN_OUT are mathematically correct curves", () => {
    const mk = (interp: "EASE_IN" | "EASE_OUT" | "EASE_IN_OUT") => {
      const e = brightnessEffect();
      e.animatedParams = ["value"];
      e.keyframes = [
        { id: "k1", param: "value", frame: 0, value: 0, interpolation: interp },
        { id: "k2", param: "value", frame: 10, value: 1, interpolation: "LINEAR" },
      ];
      return e;
    };
    const t = 0.5; // midpoint frame 5 of span 10
    expect(effectParamAt(mk("EASE_IN"), "value", 5)).toBeCloseTo(0.25, 10); // t²
    expect(effectParamAt(mk("EASE_OUT"), "value", 5)).toBeCloseTo(0.75, 10); // 1-(1-t)²
    expect(effectParamAt(mk("EASE_IN_OUT"), "value", 5)).toBeCloseTo(0.5, 10); // smoothstep(0.5)=0.5
    // smoothstep endpoints exact
    expect(effectParamAt(mk("EASE_IN_OUT"), "value", 2)).toBeCloseTo(0.104, 3); // 3t²-2t³ at t=0.2
  });

  test("non-animated params return null (static value applies); single kf = constant", () => {
    const e = brightnessEffect();
    e.params = { value: 0.3 };
    expect(effectParamAt(e, "value", 10)).toBeNull();
    e.animatedParams = ["value"];
    e.keyframes = [{ id: "k1", param: "value", frame: 5, value: 0.7, interpolation: "LINEAR" }];
    expect(effectParamAt(e, "value", 59)).toBe(0.7);
    expect(evaluatedEffectParams(e, 10).value).toBe(0.7);
  });

  test("multiple params and multiple effects evaluate independently", () => {
    const b = brightnessEffect();
    b.animatedParams = ["value"];
    b.keyframes = [
      { id: "k1", param: "value", frame: 0, value: 0, interpolation: "LINEAR" },
      { id: "k2", param: "value", frame: 60, value: 1, interpolation: "LINEAR" },
    ];
    const sat: Effect = { id: "fx-s", type: "saturation", enabled: true, params: { value: 1 }, keyframes: [], animatedParams: [] };
    sat.animatedParams = ["value"];
    sat.keyframes = [
      { id: "k1", param: "value", frame: 0, value: 2, interpolation: "LINEAR" },
      { id: "k2", param: "value", frame: 60, value: 0, interpolation: "LINEAR" },
    ];
    const seq = fixture([b, sat]);
    const clip0 = seq.clips[0];
    void clip0;
    expect(evaluatedEffectParams(b, 30).value).toBeCloseTo(0.5, 10);
    expect(evaluatedEffectParams(sat, 30).value).toBeCloseTo(1, 10);
  });
});

describe("M27 P2 — commands", () => {
  test("SetEffectKeyframe adds, auto-enables the param, and is reversible", () => {
    const seq = fixture([brightnessEffect()]);
    const fx = seq.clips[0].effects[0];
    const r = applyCommand(seq, { type: "SetEffectKeyframe", clipId: seq.clips[0].id, effectId: fx.id, keyframe: { id: "k1", param: "value", frame: 12, value: 0.4, interpolation: "LINEAR" } });
    const eff = r.sequence.clips[0].effects[0];
    expect(eff.keyframes).toHaveLength(1);
    expect(eff.animatedParams).toContain("value");
    const undone = r.inverse.reduce((s, c) => applyCommand(s, c).sequence, r.sequence);
    const effU = undone.clips[0].effects[0];
    expect(effU.keyframes).toHaveLength(0);
    expect(effU.animatedParams).not.toContain("value");
  });

  test("SetEffectKeyframe upserts by (param, frame)", () => {
    const seq = fixture([brightnessEffect()]);
    const fx = seq.clips[0].effects[0];
    let s = applyCommand(seq, { type: "SetEffectKeyframe", clipId: seq.clips[0].id, effectId: fx.id, keyframe: { id: "k1", param: "value", frame: 12, value: 0.4, interpolation: "LINEAR" } }).sequence;
    s = applyCommand(s, { type: "SetEffectKeyframe", clipId: seq.clips[0].id, effectId: fx.id, keyframe: { id: "k2", param: "value", frame: 12, value: 0.9, interpolation: "HOLD" } }).sequence;
    const eff = s.clips[0].effects[0];
    expect(eff.keyframes).toHaveLength(1);
    expect(eff.keyframes[0].value).toBe(0.9);
    expect(eff.keyframes[0].id).toBe("k2");
  });

  test("unknown param refused; volume effect refused; frame beyond clip refused", () => {
    const seq = fixture([brightnessEffect()]);
    const fx = seq.clips[0].effects[0];
    expect(() => applyCommand(seq, { type: "SetEffectKeyframe", clipId: seq.clips[0].id, effectId: fx.id, keyframe: { id: "k1", param: "radius", frame: 0, value: 1, interpolation: "LINEAR" } })).toThrow(/not part of/);
    const vol: Effect = { id: "fx-v", type: "volume", enabled: true, params: { value: 1 }, keyframes: [], animatedParams: [] };
    let s2 = fixture([vol]);
    expect(() => applyCommand(s2, { type: "SetEffectKeyframe", clipId: s2.clips[0].id, effectId: "fx-v", keyframe: { id: "k1", param: "value", frame: 0, value: 1, interpolation: "LINEAR" } })).toThrow(/automation strip/);
    expect(() => applyCommand(seq, { type: "SetEffectKeyframe", clipId: seq.clips[0].id, effectId: fx.id, keyframe: { id: "k1", param: "value", frame: 60, value: 1, interpolation: "LINEAR" } })).toThrow(/beyond the clip/);
  });

  test("RemoveEffectKeyframe reversible; ToggleEffectParamAnimation is non-destructive", () => {
    const seq = fixture([brightnessEffect()]);
    const fx = seq.clips[0].effects[0];
    let s = applyCommand(seq, { type: "SetEffectKeyframe", clipId: seq.clips[0].id, effectId: fx.id, keyframe: { id: "k1", param: "value", frame: 12, value: 0.4, interpolation: "LINEAR" } }).sequence;
    s = applyCommand(s, { type: "RemoveEffectKeyframe", clipId: seq.clips[0].id, effectId: fx.id, keyframeId: "k1" }).sequence;
    expect(s.clips[0].effects[0].keyframes).toHaveLength(0);
    expect(s.clips[0].effects[0].animatedParams).toContain("value"); // still enabled
    // Toggle off → keyframes kept; toggle on → animation resumes.
    s = applyCommand(s, { type: "ToggleEffectParamAnimation", clipId: seq.clips[0].id, effectId: fx.id, param: "value", enabled: false }).sequence;
    expect(s.clips[0].effects[0].animatedParams).not.toContain("value");
    s = applyCommand(s, { type: "ToggleEffectParamAnimation", clipId: seq.clips[0].id, effectId: fx.id, param: "value", enabled: true }).sequence;
    expect(s.clips[0].effects[0].animatedParams).toContain("value");
  });

  test("full undo/redo chain across keyframe ops", () => {
    const seq = fixture([brightnessEffect()]);
    const fx = seq.clips[0].effects[0];
    const a1 = applyCommand(seq, { type: "SetEffectKeyframe", clipId: seq.clips[0].id, effectId: fx.id, keyframe: { id: "k1", param: "value", frame: 5, value: 0.1, interpolation: "LINEAR" } });
    const a2 = applyCommand(a1.sequence, { type: "SetEffectKeyframe", clipId: seq.clips[0].id, effectId: fx.id, keyframe: { id: "k2", param: "value", frame: 25, value: 0.9, interpolation: "EASE_IN" } });
    const a3 = applyCommand(a2.sequence, { type: "SetEffectKeyframe", clipId: seq.clips[0].id, effectId: fx.id, keyframe: { id: "k2", param: "value", frame: 30, value: 0.9, interpolation: "EASE_IN" } }); // move
    expect(a3.sequence.clips[0].effects[0].keyframes.map((k) => k.frame)).toEqual([5, 30]);
    const undone = a3.inverse.reduce((s, c) => applyCommand(s, c).sequence, a3.sequence);
    expect(undone.clips[0].effects[0].keyframes.map((k) => k.frame)).toEqual([5, 25]);
    const undone2 = a2.inverse.reduce((s, c) => applyCommand(s, c).sequence, a2.sequence);
    expect(undone2.clips[0].effects[0].keyframes.map((k) => k.frame)).toEqual([5]);
  });
});

describe("M27 P2 — persistence and compatibility", () => {
  test("keyframes survive a JSON round-trip through the canonical schema", () => {
    const seq = fixture([brightnessEffect()]);
    const fx = seq.clips[0].effects[0];
    const s = applyCommand(seq, { type: "SetEffectKeyframe", clipId: seq.clips[0].id, effectId: fx.id, keyframe: { id: "k1", param: "value", frame: 15, value: 0.5, interpolation: "EASE_IN_OUT" } }).sequence;
    const reparsed = SequenceSchema.parse(JSON.parse(JSON.stringify(s)));
    expect(reparsed.clips[0].effects[0].keyframes).toHaveLength(1);
    expect(reparsed.clips[0].effects[0].keyframes[0].interpolation).toBe("EASE_IN_OUT");
  });

  test("legacy M1-M26 effects (no keyframes/animatedParams) parse with safe defaults", () => {
    const legacy = {
      id: "seq", name: "legacy", fps: { num: 30, den: 1 }, width: 640, height: 360, sampleRate: 48000,
      tracks: [{ id: "V1", kind: "VIDEO", name: "V1", visible: true, muted: false, solo: false, locked: false, volume: 1 }],
      clips: [{
        id: "c1", trackId: "V1", sourceAssetId: "a", sourceInFrame: 0, sourceOutFrame: 30,
        sourceFps: { num: 30, den: 1 }, timelineStartFrame: 0, timelineDurationFrames: 30,
        effects: [{ id: "fx", type: "brightness", enabled: true, params: { value: 0.2 } }],
      }],
      transitions: [],
    };
    const parsed = SequenceSchema.parse(legacy);
    expect(parsed.clips[0].effects[0].keyframes).toEqual([]);
    expect(parsed.clips[0].effects[0].animatedParams).toEqual([]);
  });

  test("malformed keyframe data is rejected by the schema (never corrupts)", () => {
    const bad = {
      id: "seq", name: "bad", fps: { num: 30, den: 1 }, width: 640, height: 360, sampleRate: 48000,
      tracks: [{ id: "V1", kind: "VIDEO", name: "V1", visible: true, muted: false, solo: false, locked: false, volume: 1 }],
      clips: [{
        id: "c1", trackId: "V1", sourceAssetId: "a", sourceInFrame: 0, sourceOutFrame: 30,
        sourceFps: { num: 30, den: 1 }, timelineStartFrame: 0, timelineDurationFrames: 30,
        effects: [{ id: "fx", type: "brightness", enabled: true, params: {}, keyframes: [{ id: "k", param: "value", frame: -5, value: 0.1 }], animatedParams: ["value"] }],
      }],
      transitions: [],
    };
    expect(() => SequenceSchema.parse(bad)).toThrow();
  });
});

describe("M27 P2 — export chain generation", () => {
  test("eq-family params animate through sampled piecewise-constant segments", () => {
    const e = brightnessEffect();
    e.animatedParams = ["value"];
    e.keyframes = [
      { id: "k1", param: "value", frame: 0, value: 0, interpolation: "LINEAR" },
      { id: "k2", param: "value", frame: 30, value: 1, interpolation: "LINEAR" },
    ];
    // This ffmpeg (7.1.5) evaluates eq expressions ONCE (measured with
    // signalstats) — animation renders as sampled piecewise-constant
    // sub-segments with exact evaluated constants.
    expect(segmentSplitFrames([e], 60).length).toBeGreaterThan(2);
    const chain = ffmpegEffectChainAnimated([e], 0, { num: 30, den: 1 });
    expect(chain).toContain("eq=");
    expect(chain).toContain("brightness=0.0000");
  });

  test("non-expr params (blur) produce split frames and sampled constants", () => {
    const blur: Effect = { id: "fx-b", type: "blur", enabled: true, params: { radius: 0 }, keyframes: [], animatedParams: [] };
    blur.animatedParams = ["radius"];
    blur.keyframes = [
      { id: "k1", param: "radius", frame: 10, value: 2, interpolation: "LINEAR" },
      { id: "k2", param: "radius", frame: 50, value: 12, interpolation: "LINEAR" },
    ];
    const splits = segmentSplitFrames([blur], 60);
    expect(splits).toContain(10);
    expect(splits).toContain(50);
    expect(splits.length).toBeGreaterThan(2);
    // Segment starting AT the keyframe samples that keyframe's value.
    const chain = ffmpegEffectChainAnimated([blur], 10, { num: 30, den: 1 });
    expect(chain).toContain("gblur=sigma=2");
    const chainMid = ffmpegEffectChainAnimated([blur], 30, { num: 30, den: 1 });
    expect(chainMid).toContain("gblur=sigma=7"); // sampled (piecewise-constant, documented)
  });

  test("mixed animated effects: expr param exact + non-expr param sampled in one chain", () => {
    const e = brightnessEffect();
    e.animatedParams = ["value"];
    e.keyframes = [
      { id: "k1", param: "value", frame: 0, value: 0.1, interpolation: "LINEAR" },
      { id: "k2", param: "value", frame: 60, value: 0.9, interpolation: "LINEAR" },
    ];
    const blur: Effect = { id: "fx-b2", type: "blur", enabled: true, params: { radius: 4 }, keyframes: [], animatedParams: ["radius"] };
    blur.keyframes = [{ id: "k1", param: "radius", frame: 20, value: 8, interpolation: "LINEAR" }];
    const splits = segmentSplitFrames([e, blur], 60);
    expect(splits).toContain(20);
    const chain = ffmpegEffectChainAnimated([e, blur], 0, { num: 30, den: 1 });
    expect(chain).toContain("brightness=0.1000"); // exact sampled value at segment start
    expect(chain).toContain("gblur=sigma=8"); // pre-first-kf clamps to the first keyframe value (documented semantics)
  });

  test("preview parity: CSS evaluation uses the same evaluator (same values)", () => {
    const e = brightnessEffect();
    e.animatedParams = ["value"];
    e.keyframes = [
      { id: "k1", param: "value", frame: 0, value: 0, interpolation: "LINEAR" },
      { id: "k2", param: "value", frame: 30, value: 1, interpolation: "LINEAR" },
    ];
    const cssMid = cssEffectFilterAt([e], 15);
    expect(cssMid).toBe("brightness(1.5000)");
    const cssStart = cssEffectFilterAt([e], 0);
    expect(cssStart).toBe("brightness(1.0000)");
  });
});
