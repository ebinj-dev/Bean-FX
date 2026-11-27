/**
 * M48-C — engine tests for the new professional operations:
 *   1. parseTimecode (exact inverse of formatTimecode, incl. drop-frame).
 *   2. Snap targets (clip edges + playhead + markers) vs grid-only snapping.
 *   3. compileInsert / compileOverwrite (the previously-dead compilers, now
 *      wired to the Source Monitor) — success, refusal, atomic apply, undo.
 */
import { describe, test, expect } from "bun:test";
import { parseTimecode, formatTimecode, makeRational } from "../src/lib/editor/time";
import { snapTargetFrames, snapFrameToTargets, movePreview } from "../src/lib/editor/interaction";
import { compileInsert, compileOverwrite } from "../src/lib/editor/edits";
import { applyCommand } from "../src/lib/editor/commands";
import type { Sequence } from "../src/lib/editor/model";

function baseSequence(): Sequence {
  return {
    id: "seq-test",
    name: "test",
    fps: makeRational(30, 1),
    width: 1920,
    height: 1080,
    sampleRate: 48000,
    tracks: [
      { id: "v1", kind: "VIDEO", name: "Video 1", visible: true, muted: false, solo: false, locked: false, volume: 1 },
      { id: "a1", kind: "AUDIO", name: "Audio 1", visible: true, muted: false, solo: false, locked: false, volume: 1 },
    ],
    clips: [],
    transitions: [],
    markers: [],
  };
}

function clip(id: string, start: number, duration: number, srcOut = duration) {
  return {
    id,
    trackId: "v1",
    sourceAssetId: "asset-1",
    sourceInFrame: 0,
    sourceOutFrame: srcOut,
    sourceFps: makeRational(30, 1),
    timelineStartFrame: start,
    timelineDurationFrames: duration,
    playbackSpeed: 1,
    volume: 1,
    muted: false,
    fadeInFrames: 0,
    fadeOutFrames: 0,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    captionText: null,
    captionStyle: null,
    graphicTemplateId: null,
    graphicStyle: null,
    label: id,
    missingMedia: false,
    pan: 0,
    groupId: null,
    effects: [],
    keyframes: [],
  };
}

describe("M48-C parseTimecode (inverse of formatTimecode)", () => {
  test("integer and fractional families round-trip", () => {
    const fps30 = makeRational(30, 1);
    const fps24 = makeRational(24, 1);
    for (const [fps, drop] of [[fps30, false], [fps24, false]] as const) {
      for (const frames of [0, 1, 23, 24, 25, 30, 3600, 3601, 86400, 100000]) {
        expect(parseTimecode(formatTimecode(frames, fps, drop), fps, drop)).toBe(frames);
      }
    }
  });

  test("drop-frame families round-trip exactly (29.97 and 59.94)", () => {
    const fps2997 = makeRational(30000, 1001);
    const fps5994 = makeRational(60000, 1001);
    for (const [fps, nominal] of [[fps2997, 30], [fps5994, 60]] as const) {
      for (const frames of [0, 1, nominal - 1, nominal, 1799, 1800, 1801, 3599, 3600, 10789, 10790]) {
        const text = formatTimecode(frames, fps, true);
        expect(parseTimecode(text, fps, true)).toBe(frames);
        // The ";" separator implies drop notation for drop families.
        expect(parseTimecode(text, fps, false)).toBe(frames);
      }
    }
  });

  test("01:00:00;00 lands exactly one hour of wall time (drop)", () => {
    const fps2997 = makeRational(30000, 1001);
    const hour = Math.round(3600 * (30000 / 1001));
    expect(parseTimecode("01:00:00;00", fps2997, true)).toBe(hour);
    // The formatter SKIPS display values ;00 and ;01 at minute starts —
    // 00:01:00;02 is the first frame of minute 1 (real SMPTE drop notation).
    expect(parseTimecode("00:01:00;02", fps2997, true)).toBe(1800);
    expect(() => parseTimecode("00:01:00;00", fps2997, true)).toThrow();
  });

  test("short forms: MM:SS, SS, SS:FF", () => {
    const fps30 = makeRational(30, 1);
    // Fields read right-to-left (professional goto convention): the last
    // segment is always frames; two segments mean SS:FF.
    expect(parseTimecode("10:05", fps30)).toBe(10 * 30 + 5);
    expect(parseTimecode("7", fps30)).toBe(7); // bare number = frames
    expect(parseTimecode("0:07", fps30)).toBe(7); // 0 seconds, 7 frames
    expect(parseTimecode("7:15", fps30)).toBe(7 * 30 + 15);
    expect(parseTimecode("00:00:07:15", fps30)).toBe(7 * 30 + 15);
  });

  test("invalid input throws honestly", () => {
    const fps30 = makeRational(30, 1);
    expect(() => parseTimecode("", fps30)).toThrow();
    expect(() => parseTimecode("aa:bb", fps30)).toThrow();
    expect(() => parseTimecode("00:00:60:00", fps30)).toThrow(); // seconds out of range
    expect(() => parseTimecode("00:00:00:30", fps30)).toThrow(); // frames >= nominal fps
  });
});

describe("M48-C snap targets", () => {
  test("collects clip edges, playhead and markers, deduplicated and sorted", () => {
    const seq = baseSequence();
    seq.clips = [clip("c1", 90, 60), clip("c2", 300, 60)];
    seq.markers = [{ id: "m1", frame: 300, label: "" }];
    const targets = snapTargetFrames(seq, 150);
    expect(targets).toEqual([0, 90, 150, 300, 360]);
  });

  test("snapping prefers the nearest target within the threshold over the grid", () => {
    const targets = [90, 300, 360];
    expect(snapFrameToTargets(93, targets, 1, 6)).toBe(90);
    expect(snapFrameToTargets(297, targets, 1, 6)).toBe(300);
    expect(snapFrameToTargets(293, targets, 1, 6)).toBe(293); // distance 7 > threshold → unchanged
    expect(snapFrameToTargets(200, targets, 10, 6)).toBe(200); // no target near → grid (200 is on-grid)
  });

  test("movePreview uses targets when provided (backwards compatible)", () => {
    const seq = baseSequence();
    seq.clips = [clip("c1", 90, 60)];
    const targets = snapTargetFrames(seq, 0);
    const preview = movePreview(clip("moving", 0, 60), 92, 1, targets);
    expect(preview.newTimelineStartFrame).toBe(90);
    const legacy = movePreview(clip("moving", 0, 60), 92, 1);
    expect(legacy.newTimelineStartFrame).toBe(92);
  });
});

describe("M48-C compileInsert / compileOverwrite (Source Monitor wiring)", () => {
  test("insert pushes later clips right and places the incoming clip at the playhead", () => {
    const seq = baseSequence();
    seq.clips = [clip("a", 0, 90), clip("b", 90, 90)];
    const incoming = clip("new", 0, 30);
    const op = compileInsert(seq, "v1", 45, incoming);
    expect(op).not.toBeNull();
    if (!op) return;
    // Both existing clips shift: "a" STRADDLES the insertion point (ends at 90 > 45)
    // and "b" starts at 90 — classic insert moves the whole straddling clip.
    expect(op.commands.filter((c: Record<string, unknown>) => c.type === "MoveClip").length).toBe(2);
    expect(op.commands.some((c: Record<string, unknown>) => c.type === "AddClip" && (c.clip as { id: string }).id === "new")).toBe(true);
    // Apply the WHOLE compiled batch through the canonical executor in order.
    let applied = seq;
    const inverses: unknown[][] = [];
    for (const cmd of op.commands) {
      const r = applyCommand(applied, cmd);
      expect(r.sequence).toBeDefined();
      inverses.push(r.inverse);
      applied = r.sequence;
    }
    expect(applied.clips.find((c) => c.id === "a")!.timelineStartFrame).toBe(30);
    expect(applied.clips.find((c) => c.id === "b")!.timelineStartFrame).toBe(120);
    expect(applied.clips.find((c) => c.id === "new")!.timelineStartFrame).toBe(45);
    // Undo parity: applying every inverse restores the pre-insert layout.
    let undone = applied;
    for (const inv of [...inverses].reverse()) for (const cmd of inv) undone = applyCommand(undone, cmd).sequence;
    expect(undone.clips.find((c) => c.id === "a")!.timelineStartFrame).toBe(0);
    expect(undone.clips.find((c) => c.id === "b")!.timelineStartFrame).toBe(90);
    expect(undone.clips.some((c) => c.id === "new")).toBe(false);
  });

  test("overwrite trims the overlapped tail and removes the fully-covered clip", () => {
    const seq = baseSequence();
    seq.clips = [clip("a", 0, 90), clip("b", 90, 90)];
    const incoming = { ...clip("ow", 0, 120), timelineStartFrame: 60 }; // covers a's tail + ALL of b
    const op = compileOverwrite(seq, "v1", incoming);
    expect(op).not.toBeNull();
    if (!op) return;
    // a: [0..90) overlapped from 60 → tail trim; b: [90..180) fully covered → remove.
    expect(op.commands.some((c: Record<string, unknown>) => c.type === "TrimClip" && c.clipId === "a")).toBe(true);
    expect(op.commands.some((c: Record<string, unknown>) => c.type === "RemoveClip" && c.clipId === "b")).toBe(true);
    expect(op.commands.some((c: Record<string, unknown>) => c.type === "AddClip")).toBe(true);
    // Apply the whole compiled batch and validate the result.
    let next = seq;
    const inverses: unknown[][] = [];
    for (const cmd of op.commands) {
      const r = applyCommand(next, cmd);
      expect(r.sequence).toBeDefined();
      inverses.push(r.inverse);
      next = r.sequence;
    }
    const a = next.clips.find((c) => c.id === "a")!;
    expect(a.timelineStartFrame + a.timelineDurationFrames).toBe(60); // tail trimmed at the overwrite start
    expect(next.clips.find((c) => c.id === "ow")!.timelineStartFrame).toBe(60);
    expect(next.clips.some((c) => c.id === "b")).toBe(false);
    expect(next.clips.some((c) => c.id === "ow")).toBe(true);
    // Undo restores b and a's original length.
    for (const inv of [...inverses].reverse()) for (const cmd of inv) next = applyCommand(next, cmd).sequence;
    expect(next.clips.some((c) => c.id === "b")).toBe(true);
    expect(next.clips.find((c) => c.id === "a")!.timelineDurationFrames).toBe(90);
  });

  test("refusals are honest: locked track returns null", () => {
    const seq = baseSequence();
    seq.tracks[0].locked = true;
    expect(compileInsert(seq, "v1", 0, clip("n", 0, 10))).toBeNull();
    expect(compileOverwrite(seq, "v1", { ...clip("n", 0, 10), timelineStartFrame: 0 })).toBeNull();
  });
});
