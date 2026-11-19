/**
 * M27 Phase 1 — RollEdit engine tests. Frame-accurate shared-boundary edits:
 * positive/negative rolls, source min/max boundaries, adjacency, locked tracks,
 * transition conflicts, undo/redo, sequence-duration preservation, persistence
 * round-trip, invalid rejection. Integer frames only.
 */
import { describe, test, expect } from "bun:test";
import { applyCommand } from "../src/lib/editor/commands";
import type { Sequence, Clip } from "../src/lib/editor/model";
import { SequenceSchema } from "../src/lib/editor/model";

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

/** V1: A timeline [0,60) using source [10,70); B timeline [60,90) using source
 *  [20,50). Durations consistent with used ranges. A has 10 leftward source
 *  headroom; B has 20 leftward headroom. Total 90 frames preserved by roll. */
function fixture(): Sequence {
  n = 0;
  const a = clip("V1", 0, 60, 70);
  a.sourceInFrame = 10;
  const b = clip("V1", 60, 30, 50);
  b.sourceInFrame = 20;
  const raw = {
    id: "seq", name: "M27 roll", fps: { num: 30, den: 1 }, width: 1920, height: 1080, sampleRate: 48000,
    tracks: [{ id: "V1", kind: "VIDEO", name: "V1", visible: true, muted: false, solo: false, locked: false, volume: 1 }],
    clips: [a, b], transitions: [], markers: [],
  };
  return SequenceSchema.parse(raw);
}

const boundaryOf = (s: Sequence) => s.clips[0].timelineStartFrame + s.clips[0].timelineDurationFrames;

describe("M27 P1 — RollEdit", () => {
  test("positive roll (+10): boundary 70 — left extends, right trims, duration preserved", () => {
    const seq = fixture();
    const r = applyCommand(seq, { type: "RollEdit", leftClipId: seq.clips[0].id, rightClipId: seq.clips[1].id, newBoundaryFrame: 70 });
    const [a, b] = r.sequence.clips;
    expect(boundaryOf(r.sequence)).toBe(70);
    expect(a.timelineDurationFrames).toBe(70);
    expect(a.sourceOutFrame).toBe(80); // +10 timeline = +10 source at speed 1
    expect(b.timelineStartFrame).toBe(70);
    expect(b.timelineDurationFrames).toBe(20);
    expect(b.sourceInFrame).toBe(30); // 20 + 10
    expect(b.timelineStartFrame + b.timelineDurationFrames).toBe(90); // END fixed
    expect(a.timelineStartFrame + a.timelineDurationFrames + b.timelineDurationFrames).toBe(90);
  });

  test("negative roll (−10): boundary 50 — left trims, right extends within source", () => {
    const seq = fixture();
    const r = applyCommand(seq, { type: "RollEdit", leftClipId: seq.clips[0].id, rightClipId: seq.clips[1].id, newBoundaryFrame: 50 });
    const [a, b] = r.sequence.clips;
    expect(boundaryOf(r.sequence)).toBe(50);
    expect(a.sourceOutFrame).toBe(60); // 70 − 10
    expect(a.timelineDurationFrames).toBe(50);
    expect(b.sourceInFrame).toBe(10); // 20 − 10
    expect(b.timelineDurationFrames).toBe(40);
    expect(b.timelineStartFrame + b.timelineDurationFrames).toBe(90);
  });

  test("source boundary enforcement: exceeding right clip's leftward source refuses", () => {
    const seq = fixture();
    // B has 20 frames of leftward headroom; −30 exceeds it.
    expect(() => applyCommand(seq, { type: "RollEdit", leftClipId: seq.clips[0].id, rightClipId: seq.clips[1].id, newBoundaryFrame: 30 })).toThrow(/source media|source start|rounding/);
  });

  test("boundary outside either clip refuses", () => {
    const seq = fixture();
    expect(() => applyCommand(seq, { type: "RollEdit", leftClipId: seq.clips[0].id, rightClipId: seq.clips[1].id, newBoundaryFrame: 91 })).toThrow(/boundary/);
    expect(() => applyCommand(seq, { type: "RollEdit", leftClipId: seq.clips[0].id, rightClipId: seq.clips[1].id, newBoundaryFrame: 0 })).toThrow(/boundary/);
  });

  test("non-adjacent clips refused", () => {
    const seq = fixture();
    seq.clips[1].timelineStartFrame = 70; // 10-frame gap
    expect(() => applyCommand(seq, { type: "RollEdit", leftClipId: seq.clips[0].id, rightClipId: seq.clips[1].id, newBoundaryFrame: 65 })).toThrow(/adjacent/);
  });

  test("cross-track roll refused", () => {
    const seq = fixture();
    seq.tracks.push({ id: "V2", kind: "VIDEO", name: "V2", visible: true, muted: false, solo: false, locked: false, volume: 1 });
    seq.clips[1].trackId = "V2";
    expect(() => applyCommand(seq, { type: "RollEdit", leftClipId: seq.clips[0].id, rightClipId: seq.clips[1].id, newBoundaryFrame: 65 })).toThrow(/same track/);
  });

  test("locked track refused", () => {
    let seq = fixture();
    seq = applyCommand(seq, { type: "UpdateTrack", trackId: "V1", locked: true }).sequence;
    expect(() => applyCommand(seq, { type: "RollEdit", leftClipId: seq.clips[0].id, rightClipId: seq.clips[1].id, newBoundaryFrame: 65 })).toThrow(/locked/);
  });

  test("transition on either clip refused (window would desync)", () => {
    // Overlap the two clips and attach a valid transition, then attempt a roll.
    let seq = fixture();
    seq.clips[1].timelineStartFrame = 50;
    seq.clips[1].timelineDurationFrames = 40;
    seq.clips[1].sourceInFrame = 20;
    seq.clips[1].sourceOutFrame = 60;
    seq = applyCommand(seq, { type: "AddTransition", transitionId: "t1", trackId: "V1", kind: "CROSS_DISSOLVE", startFrame: 50, durationFrames: 10, params: {} }).sequence;
    // Transitions REQUIRE overlapping clips; roll requires adjacency — the
    // engine invariants make the combination impossible, so a roll attempt on
    // transition-carrying clips is refused either way (never silently applied).
    expect(() => applyCommand(seq, { type: "RollEdit", leftClipId: seq.clips[0].id, rightClipId: seq.clips[1].id, newBoundaryFrame: 65 })).toThrow(/transition|adjacent/i);
  });

  test("mixed playback speeds refused", () => {
    const seq = fixture();
    seq.clips[1].playbackSpeed = 2;
    expect(() => applyCommand(seq, { type: "RollEdit", leftClipId: seq.clips[0].id, rightClipId: seq.clips[1].id, newBoundaryFrame: 65 })).toThrow(/speed/);
  });

  test("undo/redo: inverse restores exact before-state; re-apply reproduces", () => {
    const seq = fixture();
    const r = applyCommand(seq, { type: "RollEdit", leftClipId: seq.clips[0].id, rightClipId: seq.clips[1].id, newBoundaryFrame: 72 });
    expect(boundaryOf(r.sequence)).toBe(72);
    const undone = r.inverse.reduce((s, c) => applyCommand(s, c).sequence, r.sequence);
    expect(boundaryOf(undone)).toBe(60);
    expect(undone.clips[0].sourceOutFrame).toBe(70);
    expect(undone.clips[1].sourceInFrame).toBe(20);
    const redone = applyCommand(undone, { type: "RollEdit", leftClipId: undone.clips[0].id, rightClipId: undone.clips[1].id, newBoundaryFrame: 72 }).sequence;
    expect(boundaryOf(redone)).toBe(72);
    expect(redone.clips[0].sourceOutFrame).toBe(82);
    expect(redone.clips[1].sourceInFrame).toBe(32);
  });

  test("markers and unrelated clips untouched by roll", () => {
    let seq = fixture();
    seq = applyCommand(seq, { type: "AddMarker", marker: { id: "m1", frame: 30, label: "" } }).sequence;
    seq.tracks.push({ id: "V2", kind: "VIDEO", name: "V2", visible: true, muted: false, solo: false, locked: false, volume: 1 });
    const other = clip("V2", 25, 10);
    seq.clips.push(other);
    const r = applyCommand(seq, { type: "RollEdit", leftClipId: seq.clips[0].id, rightClipId: seq.clips[1].id, newBoundaryFrame: 66 }).sequence;
    expect(r.markers[0].frame).toBe(30);
    expect(r.clips.find((c) => c.id === other.id)!.timelineStartFrame).toBe(25);
  });

  test("persistence round-trip: rolled sequence parses identically", () => {
    const seq = fixture();
    const rolled = applyCommand(seq, { type: "RollEdit", leftClipId: seq.clips[0].id, rightClipId: seq.clips[1].id, newBoundaryFrame: 68 }).sequence;
    const json = JSON.parse(JSON.stringify(rolled));
    const reparsed = SequenceSchema.parse(json);
    expect(boundaryOf(reparsed)).toBe(68);
    expect(reparsed.clips[0].sourceOutFrame).toBe(rolled.clips[0].sourceOutFrame);
    expect(reparsed.clips[1].sourceInFrame).toBe(rolled.clips[1].sourceInFrame);
  });

  test("speed-2 roll shifts source at 2× the timeline delta", () => {
    const seq = fixture();
    seq.clips[0].playbackSpeed = 2;
    seq.clips[0].sourceOutFrame = 130; // [10,130) = 120 source = 60 timeline at 2×
    seq.clips[1].playbackSpeed = 2;
    seq.clips[1].sourceOutFrame = 80; // [20,80) = 60 source = 30 timeline at 2× (consistent)
    const r = applyCommand(seq, { type: "RollEdit", leftClipId: seq.clips[0].id, rightClipId: seq.clips[1].id, newBoundaryFrame: 65 }).sequence;
    expect(r.clips[0].sourceOutFrame).toBe(140); // +5 timeline × 2 speed
    expect(r.clips[1].sourceInFrame).toBe(30); // 20 + 5×2
    expect(boundaryOf(r)).toBe(65);
  });
});
