/**
 * M27 Phase 4 — integration reliability: the three new capabilities against
 * the existing editing systems. Determinism + reversibility everywhere.
 */
import { describe, test, expect } from "bun:test";
import { applyCommand } from "../src/lib/editor/commands";
import { compileAudioCrossfade, compileDuplicate } from "../src/lib/editor/edits";
import { SequenceSchema, type Sequence, type Clip, type Effect } from "../src/lib/editor/model";

let n = 0;
const nid = (p: string) => `${p}-${++n}`;

function clip(trackId: string, start: number, dur: number, sourceLen = dur, kind = "VIDEO"): Clip {
  return {
    id: nid("c"), trackId, sourceAssetId: "asset-src", sourceInFrame: 0, sourceOutFrame: sourceLen,
    sourceFps: { num: 30, den: 1 }, timelineStartFrame: start, timelineDurationFrames: dur,
    playbackSpeed: 1, volume: 1, muted: false, fadeInFrames: 0, fadeOutFrames: 0,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null,
    label: null, missingMedia: false, pan: 0, groupId: null, effects: [], keyframes: [],
  } as unknown as Clip;
}

function fixture(): Sequence {
  n = 0;
  const raw = {
    id: "seq", name: "M27 integration", fps: { num: 30, den: 1 }, width: 640, height: 360, sampleRate: 48000,
    tracks: [
      { id: "V1", kind: "VIDEO", name: "V1", visible: true, muted: false, solo: false, locked: false, volume: 1 },
      { id: "A1", kind: "AUDIO", name: "A1", visible: true, muted: false, solo: false, locked: false, volume: 1 },
    ],
    clips: [clip("V1", 0, 60, 70), clip("V1", 60, 30, 50), clip("A1", 0, 60), clip("A1", 60, 60)],
    transitions: [], markers: [],
  };
  const seq = SequenceSchema.parse(raw);
  seq.clips[0].sourceInFrame = 10;
  seq.clips[1].sourceInFrame = 20;
  return seq;
}

const animatedBrightness = (): Effect => ({
  id: "fx-a", type: "brightness", enabled: true, params: { value: 0.1 },
  keyframes: [
    { id: "k1", param: "value", frame: 0, value: 0, interpolation: "LINEAR" },
    { id: "k2", param: "value", frame: 30, value: 1, interpolation: "EASE_IN_OUT" },
  ],
  animatedParams: ["value"],
});

describe("M27 P4 — integrations", () => {
  test("roll editing + markers: markers unaffected, group tags preserved", () => {
    let seq = fixture();
    seq = applyCommand(seq, { type: "AddMarker", marker: { id: "m1", frame: 60, label: "cut" } }).sequence;
    seq = applyCommand(seq, { type: "GroupClips", clipIds: [seq.clips[0].id, seq.clips[2].id], groupId: "g1" }).sequence;
    const rolled = applyCommand(seq, { type: "RollEdit", leftClipId: seq.clips[0].id, rightClipId: seq.clips[1].id, newBoundaryFrame: 66 }).sequence;
    expect(rolled.markers[0].frame).toBe(60);
    expect(rolled.clips[0].groupId).toBe("g1"); // untouched by roll
    expect(rolled.clips[2].groupId).toBe("g1");
  });

  test("keyframes + duplicate: duplicated clip carries its animation", () => {
    let seq = fixture([animatedBrightness()]);
    // Duplicate clip B ([60,90)) — nothing after it, so the duplicate fits.
    seq.clips[1].effects = [animatedBrightness()];
    const dup = compileDuplicate(seq, seq.clips[1].id);
    expect(dup).toBeTruthy();
    if (!dup) return;
    const after = dup.commands.reduce((s, c) => applyCommand(s, c).sequence, seq);
    const copy = after.clips.find((c) => c.id !== seq.clips[1].id && c.effects.length === 1)!;
    expect(copy.effects[0].keyframes).toHaveLength(2);
    expect(copy.effects[0].animatedParams).toEqual(["value"]);
    expect(copy.timelineStartFrame).toBe(90); // right after B
    // Honest refusal documented: duplicating A ([0,60)) is refused — B occupies the space.
    expect(compileDuplicate(seq, seq.clips[0].id)).toBeNull();
  });

  test("keyframes + roll: rolling a clip keeps its effect keyframes (clip-relative frames survive)", () => {
    let seq = fixture([animatedBrightness()]);
    // Attach animation to the RIGHT clip; roll the boundary — the keyframes
    // are clip-relative so they MOVE with the clip start.
    seq.clips[1].effects = [animatedBrightness()];
    const before = seq.clips[1];
    const rolled = applyCommand(seq, { type: "RollEdit", leftClipId: seq.clips[0].id, rightClipId: seq.clips[1].id, newBoundaryFrame: 66 }).sequence;
    const after = rolled.clips[1];
    expect(after.timelineStartFrame).toBe(66);
    expect(after.effects[0].keyframes.map((k) => k.frame)).toEqual([0, 30]); // clip-relative: unchanged
  });

  test("crossfade + track gain: fader multiplies the automation (engine-level state intact)", () => {
    let seq = fixture();
    const [l, r] = seq.clips.filter((c) => c.trackId === "A1");
    const op = compileAudioCrossfade(seq, l.id, r.id, 15, "EQUAL_POWER");
    if ("refusal" in op) throw new Error(op.refusal);
    let s = op.commands.reduce((acc, c) => applyCommand(acc, c).sequence, seq);
    s = applyCommand(s, { type: "UpdateTrack", trackId: "A1", volume: 1.5 }).sequence;
    expect(s.tracks.find((t) => t.id === "A1")!.volume).toBe(1.5);
    const lAfter = s.clips.find((c) => c.id === l.id)!;
    const rAfter = s.clips.find((c) => c.id === r.id)!;
    expect(lAfter.keyframes.length).toBe(10); // automation untouched by fader
    expect(rAfter.keyframes.length).toBe(10);
    // Undo the fader — crossfade automation still intact.
    const undone = applyCommand(s, { type: "UpdateTrack", trackId: "A1", volume: 1 }).sequence;
    expect(undone.clips.find((c) => c.id === l.id)!.keyframes.length).toBe(10);
  });

  test("crossfade + pan: pan and automation coexist on the same clip", () => {
    let seq = fixture();
    const [l, r] = seq.clips.filter((c) => c.trackId === "A1");
    const op = compileAudioCrossfade(seq, l.id, r.id, 12, "LINEAR");
    if ("refusal" in op) throw new Error(op.refusal);
    let s = op.commands.reduce((acc, c) => applyCommand(acc, c).sequence, seq);
    s = applyCommand(s, { type: "UpdateClipProperties", clipId: l.id, pan: -0.4 }).sequence;
    const lAfter = s.clips.find((c) => c.id === l.id)!;
    expect(lAfter.pan).toBe(-0.4);
    expect(lAfter.keyframes.length).toBeGreaterThan(0);
    // Full round-trip through the canonical schema.
    const reparsed = SequenceSchema.parse(JSON.parse(JSON.stringify(s)));
    expect(reparsed.clips.find((c) => c.id === l.id)!.pan).toBe(-0.4);
    expect(reparsed.clips.find((c) => c.id === l.id)!.keyframes.length).toBe(lAfter.keyframes.length);
  });

  test("history restoration: full batch undo lands back on the exact fixture", () => {
    let seq = fixture();
    const [l, r] = seq.clips.filter((c) => c.trackId === "A1");
    const op = compileAudioCrossfade(seq, l.id, r.id, 15, "LINEAR");
    if ("refusal" in op) throw new Error(op.refusal);
    let s = seq;
    const inverses: import("../src/lib/editor/commands").Command[][] = [];
    for (const c of op.commands) {
      const res = applyCommand(s, c);
      inverses.unshift(res.inverse);
      s = res.sequence;
    }
    const flat = inverses.flat();
    const restored = flat.reduce((acc, c) => applyCommand(acc, c).sequence, s);
    expect(restored.clips[3].timelineStartFrame).toBe(60); // audio R back to its original start
    expect(restored.clips[2].keyframes).toHaveLength(0); // audio L automation removed
    expect(restored.clips[3].keyframes).toHaveLength(0);
    expect(JSON.stringify(restored.clips.map((c) => [c.id, c.timelineStartFrame, c.timelineDurationFrames]))).toBe(
      JSON.stringify(seq.clips.map((c) => [c.id, c.timelineStartFrame, c.timelineDurationFrames])),
    );
  });

  test("determinism: identical inputs produce identical command batches", () => {
    const a = compileAudioCrossfade(fixture(), "c-3", "c-4", 12, "EQUAL_POWER");
    const b = compileAudioCrossfade(fixture(), "c-3", "c-4", 12, "EQUAL_POWER");
    if ("refusal" in a || "refusal" in b) throw new Error("unexpected");
    expect(JSON.stringify(a.commands)).toBe(JSON.stringify(b.commands));
  });
});
