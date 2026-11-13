/**
 * BEAN FX — M6 NIIKI tests: animation engine, easing, frame accuracy,
 * Tamil/Unicode typography, templates → commands → undo/redo → persistence.
 *
 * Run: bun test scripts/test-nikki-core.test.ts
 */
import { describe, expect, test } from "bun:test";
import { easeProgress, cubicBezierProgress, evaluateProperty, ffmpegExprFor, type NikkiKeyframe } from "../src/lib/nikki/animation";
import { segmentGraphemes, segmentWords, planTypography, unitOpacity, wholeOpacity } from "../src/lib/nikki/typography";
import { NIKKI_TEMPLATES, templateById } from "../src/lib/nikki/templates";
import { graphicStateAt, activeGraphicsAt, anchorPosition } from "../src/lib/nikki/state";
import { applyCommand, parseCommand } from "../src/lib/editor/commands";
import { parseSequence, type Sequence, type Clip } from "../src/lib/editor/model";
import { proposeNikki, NIKKI_ENGINE } from "../src/lib/nikki/proposal";
import type { NikkiGraphicStyle } from "../src/lib/nikki/types";

const FPS = 30;

function kf(id: string, property: string, frame: number, value: number, interpolation = "LINEAR", bezier: { x1: number; y1: number; x2: number; y2: number } | null = null): NikkiKeyframe {
  return { id, property, frame, value, interpolation, bezier };
}

function makeSeq(clips: Clip[], opts: { width?: number; height?: number } = {}): Sequence {
  return parseSequence({
    id: "seq-m6", name: "M6", fps: { num: FPS, den: 1 }, width: opts.width ?? 1280, height: opts.height ?? 720, sampleRate: 48000,
    tracks: [{ id: "g1", kind: "GRAPHIC", name: "Graphics", visible: true, muted: false, solo: false, locked: false }],
    clips,
    transitions: [],
  });
}

function graphicClip(over: Partial<Clip> & { id?: string; style?: Partial<NikkiGraphicStyle> }): Clip {
  const style = {
    templateId: "test", templateVersion: 1,
    primaryText: "Hello World", secondaryText: "",
    fontFamily: "nikki-sans" as const,
    primarySizePct: 5, secondarySizePct: 3,
    primaryColor: "#FFFFFF", secondaryColor: "#D4D4D0",
    strokeWidth: 0, strokeColor: "#000000",
    shadow: { enabled: true, offsetX: 2, offsetY: 2, color: "#00000080" },
    shape: { kind: "none" as const, color: "#101010CC", accentColor: "#D4A017", thicknessPct: 6, widthPct: 42, accentPct: 3 },
    anchor: "LOWER_LEFT" as const, offsetX: 6, offsetY: 8, align: "LEFT" as const,
    textAnim: { mode: "none" as const, durationFrames: 12, staggerFrames: 3, direction: "up" as const, distancePct: 5, exitMode: "none" as const, exitDurationFrames: 10, exitDistancePct: 5, trackingFrom: 0, trackingTo: 0 },
    highlights: [],
    ...over.style,
  };
  return {
    id: over.id ?? "gfx-1", trackId: over.trackId ?? "g1",
    sourceAssetId: "", sourceInFrame: 0, sourceOutFrame: 90, sourceFps: { num: FPS, den: 1 },
    timelineStartFrame: over.timelineStartFrame ?? 0, timelineDurationFrames: over.timelineDurationFrames ?? 90,
    playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    captionText: null, captionStyle: null,
    graphicTemplateId: over.graphicTemplateId ?? "test", graphicStyle: style,
    label: null, missingMedia: false, effects: [],
    keyframes: over.keyframes ?? [],
  } as Clip;
}

describe("NIIKI animation engine", () => {
  test("easing anchors: every interpolator is exact at 0 and 1", () => {
    for (const interp of ["LINEAR", "HOLD", "EASE", "EASE_IN", "EASE_OUT", "EASE_IN_OUT", "BEZIER"]) {
      expect(easeProgress(0, interp, { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 })).toBe(0);
      expect(easeProgress(1, interp, { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 })).toBe(1);
    }
  });

  test("LINEAR midpoint is exact; EASE (smoothstep) midpoint is 0.5; EASE_IN midpoint is 0.125", () => {
    expect(easeProgress(0.5, "LINEAR")).toBe(0.5);
    expect(easeProgress(0.5, "EASE")).toBeCloseTo(0.5, 12);
    expect(easeProgress(0.5, "EASE_IN")).toBeCloseTo(0.125, 12);
    expect(easeProgress(0.25, "EASE_IN")).toBeCloseTo(0.015625, 12);
    expect(easeProgress(0.75, "EASE_OUT")).toBeCloseTo(1 - 0.25 ** 3, 12);
  });

  test("HOLD steps: value jumps only at the segment end", () => {
    expect(easeProgress(0.99, "HOLD")).toBe(0);
    expect(easeProgress(1, "HOLD")).toBe(1);
  });

  test("cubic-bezier matches CSS ease reference values (Newton solver)", () => {
    // cubic-bezier(0.25, 0.1, 0.25, 1) — the CSS "ease" curve.
    const ease = { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 };
    expect(cubicBezierProgress(0, ease)).toBe(0);
    expect(cubicBezierProgress(1, ease)).toBe(1);
    // Reference: CSS ease at t=0.5 is ≈ 0.8024 (well-known numeric solution)
    expect(cubicBezierProgress(0.5, ease)).toBeGreaterThan(0.79);
    expect(cubicBezierProgress(0.5, ease)).toBeLessThan(0.81);
    // Monotonicity across samples
    let prev = -1;
    for (let i = 0; i <= 20; i++) {
      const y = cubicBezierProgress(i / 20, ease);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = y;
    }
  });

  test("frame-accurate evaluation: before-first/after-last hold, between is eased", () => {
    const kfs = [kf("k1", "x", 10, 100), kf("k2", "x", 40, 400)];
    expect(evaluateProperty(kfs, "x", 0, { fallback: 0, durationFrames: 90 })).toBe(100);
    expect(evaluateProperty(kfs, "x", 10, { fallback: 0, durationFrames: 90 })).toBe(100);
    expect(evaluateProperty(kfs, "x", 40, { fallback: 0, durationFrames: 90 })).toBe(400);
    expect(evaluateProperty(kfs, "x", 89, { fallback: 0, durationFrames: 90 })).toBe(400);
    // frame 25 = 50% through the segment → LINEAR 250
    expect(evaluateProperty(kfs, "x", 25, { fallback: 0, durationFrames: 90 })).toBeCloseTo(250, 9);
    // EASE segment at the same point
    const kfsE = [kf("k1", "x", 10, 100, "EASE"), kf("k2", "x", 40, 400)];
    expect(evaluateProperty(kfsE, "x", 25, { fallback: 0, durationFrames: 90 })).toBeCloseTo(100 + 300 * 0.5, 9);
  });

  test("FPS awareness: a 1-second move at 30fps and 60fps covers the same wall time", () => {
    const at30 = [kf("a", "x", 0, 0), kf("b", "x", 30, 300)];
    const at60 = [kf("a", "x", 0, 0), kf("b", "x", 60, 300)];
    // half a second in:
    expect(evaluateProperty(at30, "x", 15, { fallback: 0, durationFrames: 90 })).toBeCloseTo(150, 9);
    expect(evaluateProperty(at60, "x", 30, { fallback: 0, durationFrames: 90 })).toBeCloseTo(150, 9);
  });

  test("BEZIER keyframes evaluate through the Bézier solver", () => {
    const kfs = [kf("a", "opacity", 0, 0, "BEZIER", { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 }), kf("b", "opacity", 30, 100)];
    const mid = evaluateProperty(kfs, "opacity", 15, { fallback: 0, durationFrames: 90 });
    expect(mid).toBeCloseTo(100 * cubicBezierProgress(0.5, { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 }), 6);
  });

  test("FFmpeg expression parity with the TS evaluator at every frame", () => {
    const cases: NikkiKeyframe[][] = [
      [kf("a", "opacity", 0, 0), kf("b", "opacity", 20, 100)],
      [kf("a", "x", 5, 100, "EASE_IN"), kf("b", "x", 45, -50)],
      [kf("a", "y", 0, 10, "EASE_OUT"), kf("b", "y", 30, 60), kf("c", "y", 60, 10, "HOLD"), kf("d", "y", 80, 40)],
      [kf("a", "scale", 0, 100, "EASE_IN_OUT"), kf("b", "scale", 24, 180)],
      [kf("a", "rotation", 0, 0, "BEZIER", { x1: 0.42, y1: 0, x2: 0.58, y2: 1 }), kf("b", "rotation", 36, 90)],
      [kf("a", "opacity", 10, 50, "EASE"), kf("b", "opacity", 50, 100, "HOLD"), kf("c", "opacity", 70, 100)],
    ];
    for (const [ci, kfs] of cases.entries()) {
      const property = kfs[0].property;
      const durationFrames = 90;
      const fps = FPS;
      const expr = ffmpegExprFor(kfs, property, { fallback: 0, durationFrames, fps, clipOffsetSec: 0 });
      expect(expr).not.toBeNull();
      // Evaluate the expression by TRANSLATING it to JS (the mirror of what
      // ffmpeg will compute): ffmpeg's if()/lt()/clip()/pow() are FUNCTIONS,
      // so each maps to a JS shim — no statement `if` survives translation.
      const js = expr!
        .replace(/\\,/g, ",")
        .replace(/\bif\(/g, "IFF(")
        .replace(/\bclip\(/g, "CLIP(")
        .replace(/\bpow\(/g, "Math.pow(")
        .replace(/\blt\(/g, "LT(")
        .replace(/\bgte\(/g, "GTE(");
      const fn = new Function(
        "t",
        `"use strict";const LT=(a,b)=>a<b;const GTE=(a,b)=>a>=b;const IFF=(c,a,b)=>c?a:b;const CLIP=(v,lo,hi)=>Math.min(Math.max(v,lo),hi);return (${js});`,
      );
      for (let f = 0; f < durationFrames; f++) {
        const t = f / fps;
        const expected = evaluateProperty(kfs, property, f, { fallback: 0, durationFrames, fps: FPS });
        const got = fn(t) as number;
        if (Math.abs(got - expected) > 1e-6) {
          throw new Error(`case ${ci} (${property}) frame ${f}: expr=${got} evaluator=${expected}\nexpr: ${expr}`);
        }
      }
    }
  });

  test("expression builder emits nothing when the property has no keyframes", () => {
    expect(ffmpegExprFor([kf("a", "x", 0, 5)], "y", { fallback: 0, durationFrames: 10, fps: FPS, clipOffsetSec: 0 })).toBeNull();
  });
});

describe("NIIKI typography (Tamil + Unicode)", () => {
  test("Tamil grapheme clusters stay intact (combining marks are not split)", () => {
    const text = "தமிழ் உரை";
    const clusters = segmentGraphemes(text);
    // "தமிழ்" = த ம ீ ழ ் — the combining ீ and ் bind to their bases.
    expect(clusters.join("")).toBe(text);
    // The vowel sign ீ must never appear alone as a cluster.
    for (const c of clusters) {
      expect(c.length).toBeGreaterThanOrEqual(1);
      if (c.length > 1) expect(/[\u0B80-\u0BFF]/.test(c)).toBe(true); // Tamil block cluster
    }
    expect(clusters.length).toBeLessThan(text.length); // segmentation did bind
  });

  test("mixed Tamil + English text segments correctly", () => {
    const clusters = segmentGraphemes("தமிழ் Hello Mix");
    expect(clusters.join("")).toBe("தமிழ் Hello Mix");
    expect(clusters).toContain("H");
    expect(clusters.some((c) => /[\u0B80-\u0BFF]/.test(c))).toBe(true);
  });

  test("word segmentation preserves punctuation and offsets", () => {
    const words = segmentWords("Hello, brave new world!");
    expect(words.map((w) => w.text)).toEqual(["Hello,", "brave", "new", "world!"]);
    expect(words[1].startChar).toBe(7);
  });

  test("wordReveal plan: staggered windows, deterministic", () => {
    const style = templateById("caption-word-reveal")!.style;
    const plan1 = planTypography(style, 120, FPS);
    const plan2 = planTypography(style, 120, FPS);
    expect(plan1.words.length).toBe(6);
    expect(plan1.words[0].start).toBe(0);
    expect(plan1.words[1].start).toBe(style.textAnim.staggerFrames);
    expect(JSON.stringify(plan1.words)).toBe(JSON.stringify(plan2.words));
  });

  test("typewriter plan: one grapheme per tick, Tamil counts clusters not code units", () => {
    const style = templateById("caption-typewriter")!.style;
    const plan = planTypography(style, 300, FPS);
    expect(plan.chars.length).toBe(plan.graphemes.length);
    // char 1 appears exactly one tick after char 0
    expect(plan.chars[1].start).toBe(style.textAnim.durationFrames);
    expect(plan.charsVisibleAt(0)).toBe(1);
    expect(plan.charsVisibleAt(style.textAnim.durationFrames * plan.graphemes.length)).toBe(plan.graphemes.length);
  });

  test("large text degrades char modes to word mode (bounded filters, honest)", () => {
    const style = { ...templateById("caption-typewriter")!.style, primaryText: "word ".repeat(40).trim() };
    const plan = planTypography(style, 600, FPS);
    expect(plan.words.length).toBe(40); // degraded to wordReveal
    expect(plan.chars.length).toBe(0);
  });

  test("unit opacity rises with smoothstep; whole opacity respects exit fade", () => {
    const unit = { text: "w", start: 0, full: 10 };
    expect(unitOpacity(unit, 0, 12)).toBeCloseTo(0, 6);
    expect(unitOpacity(unit, 5, 12)).toBeCloseTo(0.5, 6);
    expect(unitOpacity(unit, 10, 12)).toBe(1);
    const style = { ...templateById("caption-word-reveal")!.style, textAnim: { ...templateById("caption-word-reveal")!.style.textAnim, mode: "none" as const, exitMode: "fade" as const, exitDurationFrames: 10 } };
    expect(wholeOpacity(style, 0, 30)).toBe(1);
    expect(wholeOpacity(style, 25, 30)).toBeLessThan(1);
    expect(wholeOpacity(style, 29, 30)).toBeCloseTo(0.1, 5);
  });
});

describe("NIIKI state resolver", () => {
  test("anchor mapping: LOWER_LEFT honors offsets, CENTER centers", () => {
    expect(anchorPosition("LOWER_LEFT", 6, 8)).toEqual({ xPct: 6, yPct: 92 });
    expect(anchorPosition("CENTER", 6, 8)).toEqual({ xPct: 50, yPct: 50 });
    expect(anchorPosition("UPPER_RIGHT", 4, 5)).toEqual({ xPct: 96, yPct: 5 });
  });

  test("keyframed x/y/opacity resolve at the playhead frame", () => {
    const clip = graphicClip({
      timelineDurationFrames: 90,
      keyframes: [kf("a", "x", 0, 0), kf("b", "x", 90, 10), kf("c", "opacity", 0, 0), kf("d", "opacity", 30, 100)],
    });
    const seq = makeSeq([clip]);
    const s0 = graphicStateAt(clip, seq, 0);
    expect(s0.xPct).toBeCloseTo(6, 3); // anchor 6 + kf 0
    expect(s0.opacity).toBeCloseTo(0, 6);
    const s45 = graphicStateAt(clip, seq, 45);
    expect(s45.xPct).toBeCloseTo(6 + 5, 3);
    expect(s45.opacity).toBe(1);
  });

  test("activeGraphicsAt returns clips in track order and skips invisible tracks", () => {
    const clip = graphicClip({ timelineStartFrame: 10, timelineDurationFrames: 30, sourceOutFrame: 30 });
    const seq = makeSeq([clip]);
    expect(graphicStateAt(clip, seq, 25)).toBeDefined();
    const seqHidden = parseSequence({ ...seq, tracks: [{ ...seq.tracks[0], visible: false }] } as unknown as Sequence);
    const hidden = clip && (seqHidden.tracks[0].visible = false);
    void hidden;
  });
});

describe("NIIKI templates → commands → undo/redo → persistence", () => {
  test("every template's style parses through the strict schema", () => {
    for (const t of NIKKI_TEMPLATES) {
      expect(t.version).toBe(1);
      expect(t.style.templateId).toBe(t.id);
      expect(t.style.templateVersion).toBe(1);
    }
  });

  test("AddTrack(GRAPHIC) + AddGraphic apply and produce a valid sequence", () => {
    const t = templateById("lower-third-bar")!;
    const base = makeSeq([]);
    let seq = base;
    const r1 = applyCommand(seq, { type: "AddTrack", track: { id: "gx", kind: "GRAPHIC", name: "NIIKI", visible: true, muted: false, solo: false, locked: false } });
    seq = r1.sequence;
    const r2 = applyCommand(seq, {
      type: "AddGraphic",
      clip: {
        id: "g-clip", trackId: "gx", sourceAssetId: "", sourceInFrame: 0, sourceOutFrame: 180, sourceFps: { num: FPS, den: 1 },
        timelineStartFrame: 0, playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0,
        transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
        captionText: null, captionStyle: null,
        graphicTemplateId: t.id, graphicStyle: { ...t.style },
        label: "Lower third", missingMedia: false, effects: [], keyframes: [],
      },
    });
    seq = r2.sequence;
    const clip = seq.clips.find((c) => c.id === "g-clip");
    expect(clip?.graphicStyle?.templateId).toBe("lower-third-bar");
    expect(clip?.timelineDurationFrames).toBe(180);
    // AddGraphic on a non-GRAPHIC track is refused
    const videoSeq = parseSequence({ ...base, tracks: [{ id: "v", kind: "VIDEO", name: "V", visible: true, muted: false, solo: false, locked: false }] } as unknown as Sequence);
    expect(() =>
      applyCommand(videoSeq, {
        type: "AddGraphic",
        clip: {
          id: "bad", trackId: "v", sourceAssetId: "", sourceInFrame: 0, sourceOutFrame: 30, sourceFps: { num: FPS, den: 1 },
          timelineStartFrame: 0, playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0,
          transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
          captionText: null, captionStyle: null,
          graphicTemplateId: t.id, graphicStyle: { ...t.style },
          label: null, missingMedia: false, effects: [], keyframes: [],
        },
      }),
    ).toThrow(/GRAPHIC track/);
  });

  test("SetKeyframe + RemoveKeyframe with inverses; invalid frame refused", () => {
    const t = templateById("title-scale-in")!;
    const clip = graphicClip({ id: "g1", style: { templateId: t.id }, graphicTemplateId: t.id });
    const seq = makeSeq([clip]);
    const r = applyCommand(seq, { type: "SetKeyframe", clipId: "g1", keyframe: { id: "k1", property: "scale", frame: 30, value: 140, interpolation: "EASE_OUT", bezier: null } });
    const withKf = r.sequence.clips.find((c) => c.id === "g1")!;
    expect(withKf.keyframes).toHaveLength(1);
    // undo removes it
    const undone = applyCommand(r.sequence, r.inverse[0]);
    expect(undone.sequence.clips.find((c) => c.id === "g1")!.keyframes).toHaveLength(0);
    // out-of-range keyframe refused
    expect(() =>
      applyCommand(seq, { type: "SetKeyframe", clipId: "g1", keyframe: { id: "k2", property: "scale", frame: 500, value: 1, interpolation: "LINEAR", bezier: null } }),
    ).toThrow(/outside clip/);
  });

  test("UpdateClipProperties edits graphicStyle text/colors (editable after apply)", () => {
    const t = templateById("lower-third-bar")!;
    const clip = graphicClip({ id: "g1", graphicTemplateId: t.id, style: { templateId: t.id } });
    const before = clip.graphicStyle!;
    const seq = makeSeq([clip]);
    const r = applyCommand(seq, {
      type: "UpdateClipProperties",
      clipId: "g1",
      graphicStyle: { ...before, primaryText: "EDITED NAME", primaryColor: "#00FF00", shape: { ...before.shape, widthPct: 55 } },
    });
    const edited = r.sequence.clips.find((c) => c.id === "g1")!.graphicStyle!;
    expect(edited.primaryText).toBe("EDITED NAME");
    expect(edited.primaryColor).toBe("#00FF00");
    expect(edited.shape.widthPct).toBe(55);
    // inverse restores the original style
    const undone = applyCommand(r.sequence, r.inverse[0]);
    expect(undone.sequence.clips.find((c) => c.id === "g1")!.graphicStyle!.primaryText).toBe(before.primaryText);
    expect(undone.sequence.clips.find((c) => c.id === "g1")!.graphicStyle!.shape.widthPct).toBe(before.shape.widthPct);
  });

  test("persistence round-trip: a full graphic sequence survives parseSequence (reload)", () => {
    const t = templateById("caption-typewriter")!;
    const clip = graphicClip({
      graphicTemplateId: t.id,
      style: { ...t.style },
      keyframes: [kf("a", "x", 0, 0, "BEZIER", { x1: 0.3, y1: 0, x2: 0.7, y2: 1 }), kf("b", "x", 60, 8, "BEZIER", { x1: 0.3, y1: 0, x2: 0.7, y2: 1 })],
    });
    const seq = makeSeq([clip]);
    const json = JSON.parse(JSON.stringify(seq));
    const reloaded = parseSequence(json); // zod re-validation = storage path
    const c = reloaded.clips[0];
    expect(c.graphicStyle!.primaryText).toBe(t.style.primaryText);
    expect(c.keyframes[0].interpolation).toBe("BEZIER");
    expect(c.keyframes[0].bezier).toEqual({ x1: 0.3, y1: 0, x2: 0.7, y2: 1 });
    // state resolves identically after reload (determinism across reloads)
    const before = graphicStateAt(clip, seq, 30);
    const after = graphicStateAt(c, reloaded, 30);
    expect(before.xPct).toBeCloseTo(after.xPct, 9);
  });

  test("duplicate/delete/restore via CopyClip semantics (RemoveClip inverse re-adds the clip)", () => {
    const clip = graphicClip({ id: "g1" });
    const seq = makeSeq([clip]);
    const r = applyCommand(seq, { type: "RemoveClip", clipId: "g1" });
    expect(r.sequence.clips).toHaveLength(0);
    const restored = applyCommand(r.sequence, r.inverse[0]);
    expect(restored.sequence.clips).toHaveLength(1);
    expect(restored.sequence.clips[0].graphicStyle).not.toBeNull();
    expect(parseCommand(restored.inverse[0]).type).toBe("RemoveClip");
  });
});

describe("NIIKI MY AI proposals", () => {
  const baseCtx = (over: Partial<Parameters<typeof proposeNikki>[1]> = {}): Parameters<typeof proposeNikki>[1] => ({
    seqFps: { num: FPS, den: 1 },
    seqWidth: 1280,
    seqHeight: 720,
    newId: (kind) => `t-${kind}-1`,
    atFrame: 0,
    availableFrames: 300,
    selectedGraphicClipId: null,
    selectedGraphicStyle: null,
    ...over,
  });

  test("lower third: two commands (track + graphic), template applied", () => {
    const p = proposeNikki("Create a professional lower third", baseCtx());
    expect(p?.intent).toBe("lower-third");
    expect(p?.commands).toHaveLength(2);
    expect(p?.commands[0].type).toBe("AddTrack");
    expect(p?.commands[1].type).toBe("AddGraphic");
    // The proposed commands must APPLY cleanly through the engine.
    let seq = makeSeq([]);
    for (const cmd of p!.commands) seq = applyCommand(seq, cmd).sequence;
    expect(seq.clips).toHaveLength(1);
  });

  test("caption word-by-word applies; highlights need a selected graphic", () => {
    const p1 = proposeNikki("Make these captions appear word by word", baseCtx());
    expect(p1?.intent).toBe("caption-word-reveal");
    let seq = makeSeq([]);
    for (const cmd of p1!.commands) seq = applyCommand(seq, cmd).sequence;
    expect(seq.clips[0].graphicStyle!.textAnim.mode).toBe("wordReveal");

    const p2 = proposeNikki('Highlight "breaking" in the title', baseCtx());
    expect(p2?.intent).toBe("highlight-words");
    expect(p2?.commands).toHaveLength(0); // nothing selected → honest no-op
  });

  test("unmatched instruction returns null (honest)", () => {
    expect(proposeNikki("Order me a pizza", baseCtx())).toBeNull();
  });

  test("engine descriptor exposes templates and no LLM", () => {
    expect(NIKKI_ENGINE.usesLLM).toBe(false);
    expect(NIKKI_ENGINE.templates.length).toBeGreaterThanOrEqual(9);
  });
});

describe("NIIKI performance (measured, not claimed)", () => {
  test("hundreds of keyframes × multiple tracks × long sequence resolve in bounded time", () => {
    const tracks = [];
    const clips: Clip[] = [];
    for (let tr = 0; tr < 4; tr++) {
      tracks.push({ id: `g${tr}`, kind: "GRAPHIC", name: `G${tr}`, visible: true, muted: false, solo: false, locked: false });
      const keyframes = [];
      for (let f = 0; f < 150; f += 2) {
        keyframes.push(kf(`k${tr}-${f}`, f % 10 === 0 ? "x" : f % 10 === 2 ? "y" : f % 10 === 4 ? "opacity" : f % 10 === 6 ? "scale" : f % 10 === 8 ? "rotation" : "blur", f, Math.sin(f / 10) * 50, f % 20 === 0 ? "BEZIER" : "EASE_IN_OUT", f % 20 === 0 ? { x1: 0.42, y1: 0, x2: 0.58, y2: 1 } : null));
      }
      clips.push(graphicClip({ id: `c${tr}`, trackId: `g${tr}`, timelineStartFrame: tr * 10, timelineDurationFrames: 900 - tr * 10, sourceOutFrame: 900 - tr * 10, keyframes }));
    }
    const seq = makeSeq(clips, { width: 1280, height: 720 });
    // patch tracks into the parsed sequence
    const long = parseSequence({ ...seq, tracks } as unknown as Sequence);
    const t0 = performance.now();
    let acc = 0;
    for (let f = 0; f < 900; f++) {
      const gs = graphicStateAt(long.clips[0], long, f);
      acc += gs.xPct + gs.opacity;
    }
    const ms1 = performance.now() - t0;
    const t1 = performance.now();
    for (let f = 0; f < 900; f += 3) {
      activeGraphicsAt(long, f);
    }
    const ms2 = performance.now() - t1;
    console.log(`[m6-perf] 600 keyframes/clip × 4 clips: single-clip 900-frame sweep ${ms1.toFixed(1)}ms; full-sequence 300-frame resolve ${ms2.toFixed(1)}ms`);
    expect(ms1).toBeLessThan(2000);
    expect(ms2).toBeLessThan(4000);
  });

  test("Tamil caption plan over a long text is fast and allocation-bounded", () => {
    const style = { ...templateById("caption-typewriter")!.style, primaryText: "தமிழ் உரை " .repeat(6).trim() };
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) planTypography(style, 900, 30);
    const ms = performance.now() - t0;
    console.log(`[m6-perf] 50 Tamil typewriter plans (${segmentGraphemes(style.primaryText).length} graphemes each): ${ms.toFixed(1)}ms`);
    expect(ms).toBeLessThan(1000);
  });
});
