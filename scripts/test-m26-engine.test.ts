/**
 * M26 P1/P2 engine tests — markers, grouping, gap removal, alignment, clip
 * pan, per-track volume. Every operation verified + undo verified.
 * Frame math is integer; rational FPS preserved.
 */
import { describe, test, expect } from "bun:test";
import { applyCommand } from "../src/lib/editor/commands";
import type { Sequence, Clip } from "../src/lib/editor/model";
import { SequenceSchema } from "../src/lib/editor/model";

let n = 0;
const nid = (p: string) => `${p}-${++n}`;

function clip(trackId: string, start: number, dur: number): Clip {
  return {
    id: nid("c"), trackId, sourceAssetId: "asset-src", sourceInFrame: 0, sourceOutFrame: dur,
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
    id: "seq", name: "M26 fixture", fps: { num: 30, den: 1 }, width: 1920, height: 1080, sampleRate: 48000,
    tracks: [
      { id: "V1", kind: "VIDEO", name: "V1", visible: true, muted: false, solo: false, locked: false, volume: 1 },
      { id: "A1", kind: "AUDIO", name: "A1", visible: true, muted: false, solo: false, locked: false, volume: 1 },
    ],
    clips: [clip("V1", 0, 30), clip("V1", 90, 30), clip("A1", 0, 60)],
    transitions: [], markers: [],
  };
  return SequenceSchema.parse(raw);
}

describe("M26 P1 — markers", () => {
  test("add + update + remove marker, all reversible", () => {
    const seq = fixture();
    const a = applyCommand(seq, { type: "AddMarker", marker: { id: "m1", frame: 45, label: "hook" } });
    expect(a.sequence.markers).toHaveLength(1);
    expect(a.sequence.markers[0].frame).toBe(45);
    // duplicate id refused
    expect(() => applyCommand(a.sequence, { type: "AddMarker", marker: { id: "m1", frame: 10, label: "" } })).toThrow();
    const u = applyCommand(a.sequence, { type: "UpdateMarker", markerId: "m1", newFrame: 60, newLabel: "hook v2" });
    expect(u.sequence.markers[0].frame).toBe(60);
    expect(u.sequence.markers[0].label).toBe("hook v2");
    // undo update
    const undone = u.inverse.reduce((s, c) => applyCommand(s, c).sequence, u.sequence);
    expect(undone.markers[0].frame).toBe(45);
    // remove + undo restore
    const r = applyCommand(u.sequence, { type: "RemoveMarker", markerId: "m1" });
    expect(r.sequence.markers).toHaveLength(0);
    const restored = r.inverse.reduce((s, c) => applyCommand(s, c).sequence, r.sequence);
    expect(restored.markers).toHaveLength(1);
    expect(restored.markers[0].label).toBe("hook v2");
  });

  test("markers keep sorted order", () => {
    const seq = fixture();
    let s = applyCommand(seq, { type: "AddMarker", marker: { id: "mB", frame: 90, label: "b" } }).sequence;
    s = applyCommand(s, { type: "AddMarker", marker: { id: "mA", frame: 15, label: "a" } }).sequence;
    expect(s.markers.map((m) => m.id)).toEqual(["mA", "mB"]);
  });
});

describe("M26 P1 — grouping", () => {
  test("group tags clips; ungroup clears; both reversible via SetClipGroup inverses", () => {
    const seq = fixture();
    const ids = seq.clips.slice(0, 2).map((c) => c.id);
    const g = applyCommand(seq, { type: "GroupClips", clipIds: ids, groupId: "grp1" });
    expect(g.sequence.clips.filter((c) => ids.includes(c.id)).every((c) => c.groupId === "grp1")).toBe(true);
    const un = applyCommand(g.sequence, { type: "UngroupClips", clipIds: ids });
    expect(un.sequence.clips.every((c) => c.groupId === null)).toBe(true);
    // undo ungroup → grouped again
    const undone = un.inverse.reduce((s, c) => applyCommand(s, c).sequence, un.sequence);
    expect(undone.clips.filter((c) => ids.includes(c.id)).every((c) => c.groupId === "grp1")).toBe(true);
    // undo group → original nulls
    const undone2 = g.inverse.reduce((s, c) => applyCommand(s, c).sequence, g.sequence);
    expect(undone2.clips.every((c) => c.groupId === null)).toBe(true);
  });

  test("SetClipGroup low-level is self-reversible", () => {
    const seq = fixture();
    const id = seq.clips[0].id;
    const r = applyCommand(seq, { type: "SetClipGroup", clipId: id, groupId: "g" });
    expect(r.sequence.clips[0].groupId).toBe("g");
    const back = r.inverse.reduce((s, c) => applyCommand(s, c).sequence, r.sequence);
    expect(back.clips[0].groupId).toBeNull();
  });
});

describe("M26 P1 — gap removal", () => {
  test("closes inter-clip gaps preserving first-clip position; reversible", () => {
    const seq = fixture(); // V1: [0,30) + [90,120) → gap 30 frames
    const r = applyCommand(seq, { type: "CloseGaps", trackIds: ["V1"] });
    const v1 = r.sequence.clips.filter((c) => c.trackId === "V1").sort((a, b) => a.timelineStartFrame - b.timelineStartFrame);
    expect(v1[0].timelineStartFrame).toBe(0);
    expect(v1[1].timelineStartFrame).toBe(30); // closed
    // A1 untouched
    expect(r.sequence.clips.filter((c) => c.trackId === "A1")[0].timelineStartFrame).toBe(0);
    // undo restores the gap
    const undone = r.inverse.reduce((s, c) => applyCommand(s, c).sequence, r.sequence);
    const v1u = undone.clips.filter((c) => c.trackId === "V1").sort((a, b) => a.timelineStartFrame - b.timelineStartFrame);
    expect(v1u[1].timelineStartFrame).toBe(90);
  });

  test("refuses tracks with transitions (no silent rewrite)", () => {
    // Overlapping clips make a valid transition window on V1.
    let seq = fixture();
    const b = seq.clips[1];
    b.timelineStartFrame = 20;
    b.timelineDurationFrames = 30;
    b.sourceOutFrame = 30;
    seq = applyCommand(seq, { type: "AddTransition", transitionId: "t1", trackId: "V1", kind: "CROSS_DISSOLVE", startFrame: 20, durationFrames: 10, params: {} }).sequence;
    expect(() => applyCommand(seq, { type: "CloseGaps" })).toThrow(/transitions/);
  });

  test("locked tracks refused", () => {
    let seq = fixture();
    seq = applyCommand(seq, { type: "UpdateTrack", trackId: "V1", locked: true }).sequence;
    expect(() => applyCommand(seq, { type: "CloseGaps", trackIds: ["V1"] })).toThrow(/locked/);
  });
});

describe("M26 P1 — alignment", () => {
  test("aligns listed clip starts to one frame; reversible", () => {
    const seq = fixture();
    const ids = seq.clips.map((c) => c.id);
    const r = applyCommand(seq, { type: "AlignClipsToPlayhead", clipIds: ids, frame: 120 });
    expect(r.sequence.clips.every((c) => c.timelineStartFrame === 120)).toBe(true);
    const undone = r.inverse.reduce((s, c) => applyCommand(s, c).sequence, r.sequence);
    expect(undone.clips[0].timelineStartFrame).toBe(0);
    expect(undone.clips[1].timelineStartFrame).toBe(90);
  });
});

describe("M26 P2 — pan and track volume", () => {
  test("clip pan via UpdateClipProperties, range-enforced, reversible", () => {
    const seq = fixture();
    const id = seq.clips[0].id;
    const r = applyCommand(seq, { type: "UpdateClipProperties", clipId: id, pan: -0.5 });
    expect(r.sequence.clips[0].pan).toBe(-0.5);
    expect(() => applyCommand(r.sequence, { type: "UpdateClipProperties", clipId: id, pan: 1.5 })).toThrow();
    const undone = r.inverse.reduce((s, c) => applyCommand(s, c).sequence, r.sequence);
    expect(undone.clips[0].pan).toBe(0);
  });

  test("track volume via UpdateTrack, range-enforced, reversible", () => {
    const seq = fixture();
    const r = applyCommand(seq, { type: "UpdateTrack", trackId: "A1", volume: 1.75 });
    expect(r.sequence.tracks.find((t) => t.id === "A1")!.volume).toBe(1.75);
    expect(() => applyCommand(r.sequence, { type: "UpdateTrack", trackId: "A1", volume: 5 })).toThrow();
    const undone = r.inverse.reduce((s, c) => applyCommand(s, c).sequence, r.sequence);
    expect(undone.tracks.find((t) => t.id === "A1")!.volume).toBe(1);
  });

  test("legacy sequences (no pan/groupId/markers/volume) still parse with defaults", () => {
    const legacy = {
      id: "seq", name: "legacy", fps: { num: 30, den: 1 }, width: 640, height: 360, sampleRate: 48000,
      tracks: [{ id: "V1", kind: "VIDEO", name: "V1", visible: true, muted: false, solo: false, locked: false }],
      clips: [], transitions: [],
    };
    const parsed = SequenceSchema.parse(legacy);
    expect(parsed.tracks[0].volume).toBe(1);
    expect(parsed.markers).toEqual([]);
  });
});
