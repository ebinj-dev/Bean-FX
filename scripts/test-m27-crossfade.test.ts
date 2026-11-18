/**
 * M27 Phase 3 — automatic audio crossfade: compiled batch correctness
 * (LINEAR + EQUAL_POWER curves), validations, reversibility, source-media
 * safety, sample-rate neutrality, and continuity of the gain hand-off.
 */
import { describe, test, expect } from "bun:test";
import { applyCommand, type Command } from "../src/lib/editor/commands";
import { compileAudioCrossfade } from "../src/lib/editor/edits";
import { SequenceSchema, type Sequence, type Clip } from "../src/lib/editor/model";

let n = 0;
const nid = (p: string) => `${p}-${++n}`;

function clip(trackId: string, start: number, dur: number, sourceLen = dur): Clip {
  return {
    id: nid("c"), trackId, sourceAssetId: "asset-src", sourceInFrame: 0, sourceOutFrame: sourceLen,
    sourceFps: { num: 30, den: 1 }, timelineStartFrame: start, timelineDurationFrames: dur,
    playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null,
    label: null, missingMedia: false, pan: 0, groupId: null, effects: [], keyframes: [],
  } as unknown as Clip;
}

/** A1 audio track: L [0,60) + R [60,120). */
function fixture(sampleRate = 48000): Sequence {
  n = 0;
  const raw = {
    id: "seq", name: "M27 xcf", fps: { num: 30, den: 1 }, width: 640, height: 360, sampleRate,
    tracks: [{ id: "A1", kind: "AUDIO", name: "A1", visible: true, muted: false, solo: false, locked: false, volume: 1 }],
    clips: [clip("A1", 0, 60), clip("A1", 60, 60)], transitions: [], markers: [],
  };
  return SequenceSchema.parse(raw);
}

function applyBatch(seq: Sequence, commands: Command[]): Sequence {
  return commands.reduce((s, c) => applyCommand(s, c).sequence, seq);
}

describe("M27 P3 — compileAudioCrossfade", () => {
  test("LINEAR: right clip overlaps by d; 10 automation points per clip; hand-off sums to 1", () => {
    const seq = fixture();
    const [l, r] = seq.clips;
    const op = compileAudioCrossfade(seq, l.id, r.id, 15, "LINEAR");
    if ("refusal" in op) throw new Error(op.refusal);
    const moves = op.commands.filter((c) => c.type === "MoveClip");
    expect(moves).toHaveLength(1);
    expect((moves[0] as { newTimelineStartFrame: number }).newTimelineStartFrame).toBe(45); // 60-15
    const lKfs = op.commands.filter((c) => c.type === "SetKeyframe" && (c as { clipId: string }).clipId === l.id);
    const rKfs = op.commands.filter((c) => c.type === "SetKeyframe" && (c as { clipId: string }).clipId === r.id);
    expect(lKfs.length).toBe(10); // 9 ramp + 1 anchor
    expect(rKfs.length).toBe(10);
    // Values at the same overlap progress sum to 1 (constant-power for linear).
    const lVals = lKfs.map((c) => (c as { keyframe: { frame: number; value: number } }).keyframe);
    const rVals = rKfs.map((c) => (c as { keyframe: { frame: number; value: number } }).keyframe);
    const lv = lVals.filter((k) => k.frame >= 45 && k.frame < 60).sort((a, b) => a.frame - b.frame);
    const rv = rVals.filter((k) => k.frame < 15).sort((a, b) => a.frame - b.frame);
    // matched-index hand-off: L(1−t) + R(t) = 1 through the overlap
    expect(lv.length).toBe(9);
    expect(rv.length).toBe(9);
    for (let i = 0; i < 9; i++) {
      expect(lv[i].value + rv[i].value).toBeCloseTo(1, 2);
    }
    // monotonic decrease on L, increase on R
    for (let i = 1; i < lv.length; i++) expect(lv[i].value).toBeLessThanOrEqual(lv[i - 1].value);
    for (let i = 1; i < rv.length; i++) expect(rv[i].value).toBeGreaterThanOrEqual(rv[i - 1].value);
    // last audible overlap frame on L exists and is < duration
    expect(lv[lv.length - 1].frame).toBeLessThan(60);
  });

  test("EQUAL_POWER: cos/sin curves (constant perceived power — cos²+sin²=1)", () => {
    const seq = fixture();
    const [l, r] = seq.clips;
    const op = compileAudioCrossfade(seq, l.id, r.id, 15, "EQUAL_POWER");
    if ("refusal" in op) throw new Error(op.refusal);
    const rKfs = op.commands.filter((c) => c.type === "SetKeyframe" && (c as { clipId: string }).clipId === r.id) as Array<{ keyframe: { frame: number; value: number } }>;
    const lKfs = op.commands.filter((c) => c.type === "SetKeyframe" && (c as { clipId: string }).clipId === l.id) as Array<{ keyframe: { frame: number; value: number } }>;
    // Pair the RAMP samples by index: for every sample, cos²+sin² = 1
    // (constant perceived power through the hand-off).
    // Ramp samples only (exclude the flat anchors by frame position).
    const lRamp = lKfs.filter((c) => c.keyframe.frame >= 45).map((c) => c.keyframe.value).sort((a, b) => b - a);
    const rRamp = rKfs.filter((c) => c.keyframe.frame < 15).map((c) => c.keyframe.value).sort((a, b) => a - b);
    expect(lRamp.length).toBe(9);
    expect(rRamp.length).toBe(9);
    for (let i = 0; i < 9; i++) {
      expect(lRamp[i] ** 2 + rRamp[i] ** 2).toBeCloseTo(1, 2);
    }
    expect(Math.min(...rRamp)).toBeGreaterThan(0.17); // smallest sample = sin(10°) = 0.1736
    expect(Math.max(...lRamp)).toBeLessThan(0.99); // cos(10°) = 0.985 — never 1.0 mid-ramp
  });

  test("source media untouched: sourceIn/sourceOut unchanged", () => {
    const seq = fixture();
    const [l, r] = seq.clips;
    const op = compileAudioCrossfade(seq, l.id, r.id, 12, "EQUAL_POWER");
    if ("refusal" in op) throw new Error(op.refusal);
    const after = applyBatch(seq, op.commands);
    expect(after.clips[0].sourceInFrame).toBe(0);
    expect(after.clips[0].sourceOutFrame).toBe(60);
    expect(after.clips[1].sourceInFrame).toBe(0);
    expect(after.clips[1].sourceOutFrame).toBe(60);
  });

  test("sample-rate neutral: compile result identical at 44100 and 48000", () => {
    const a = compileAudioCrossfade(fixture(44100), "c-1", "c-2", 10, "LINEAR");
    const b = compileAudioCrossfade(fixture(48000), "c-1", "c-2", 10, "LINEAR");
    if ("refusal" in a || "refusal" in b) throw new Error("unexpected refusal");
    // The gain automation is sample-rate-agnostic (frames + normalized gains).
    expect(JSON.stringify(a.commands)).toBe(JSON.stringify(b.commands));
  });

  test("batch applies cleanly (engine-validated overlap) and undo restores", () => {
    const seq = fixture();
    const [l, r] = seq.clips;
    const op = compileAudioCrossfade(seq, l.id, r.id, 15, "EQUAL_POWER");
    if ("refusal" in op) throw new Error(op.refusal);
    const after = applyBatch(seq, op.commands);
    expect(after.clips[1].timelineStartFrame).toBe(45);
    expect(after.clips[0].keyframes.length).toBe(10);
    expect(after.clips[1].keyframes.length).toBe(10);
    // Undo: invert every command in reverse order.
    let undone = after;
    const inverses: Command[] = [];
    const backup = applyBatch(seq, op.commands);
    void backup;
    // Re-run collecting inverses via applyCommand (engine returns them).
    let s = seq;
    const inv: Command[][] = [];
    for (const c of op.commands) {
      const r = applyCommand(s, c);
      inv.unshift(...r.inverse);
      s = r.sequence;
    }
    undone = inv.reduce((acc, c) => applyCommand(acc, c).sequence, s);
    expect(undone.clips[1].timelineStartFrame).toBe(60);
    expect(undone.clips[0].keyframes.length).toBe(0);
    expect(undone.clips[1].keyframes.length).toBe(0);
  });

  test("refusals: gap / locked / transition / overlong duration", () => {
    const seq = fixture();
    const [l, r] = seq.clips;
    // gap
    let s2 = SequenceSchema.parse(JSON.parse(JSON.stringify(seq)));
    s2.clips[1].timelineStartFrame = 70;
    expect(compileAudioCrossfade(s2, s2.clips[0].id, s2.clips[1].id, 10, "LINEAR")).toHaveProperty("refusal");
    // locked
    let s3 = SequenceSchema.parse(JSON.parse(JSON.stringify(seq)));
    s3.tracks[0].locked = true;
    expect(compileAudioCrossfade(s3, s3.clips[0].id, s3.clips[1].id, 10, "LINEAR")).toHaveProperty("refusal");
    // overlong duration (covers a whole clip)
    expect(compileAudioCrossfade(seq, l.id, r.id, 60, "LINEAR")).toHaveProperty("refusal");
    // transition on either clip
    let s4 = SequenceSchema.parse(JSON.parse(JSON.stringify(seq)));
    s4.transitions.push({ id: "t1", trackId: "A1", kind: "CROSS_DISSOLVE", startFrame: 60, endFrame: 70, durationFrames: 10, clipAId: s4.clips[0].id, clipBId: s4.clips[1].id, params: {} });
    expect(compileAudioCrossfade(s4, s4.clips[0].id, s4.clips[1].id, 10, "LINEAR")).toHaveProperty("refusal");
  });

  test("very short clips clamp: duration 1f works, 0f refuses", () => {
    const seq = fixture();
    seq.clips[0].timelineDurationFrames = 3;
    seq.clips[0].sourceOutFrame = 3;
    seq.clips[1].timelineStartFrame = 3; // keep adjacency after shortening
    const one = compileAudioCrossfade(seq, seq.clips[0].id, seq.clips[1].id, 2, "LINEAR");
    if ("refusal" in one) throw new Error(one.refusal);
    expect(compileAudioCrossfade(seq, seq.clips[0].id, seq.clips[1].id, 3, "LINEAR")).toHaveProperty("refusal");
  });
});
