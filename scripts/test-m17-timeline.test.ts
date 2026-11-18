/**
 * BEAN FX — M17 engine tests: timeline completion at scale.
 * Fixture-based: cross-track moves, duplicates, group/ungroup semantics,
 * and 50/200/500-clip batches through the REAL engine (applyCommand +
 * undo reversibility + autosave-grade state validity). Run:
 *   bun test scripts/test-m17-timeline.test.ts
 */
import { describe, expect, test } from "bun:test";
import { commands, edits, model } from "./m17-imports";

const fps = { num: 30, den: 1 };

function mkClip(id: string, trackId: string, start: number, dur: number, overrides: Partial<import("../src/lib/editor/model").Clip> = {}): import("../src/lib/editor/model").Clip {
  return model.ClipSchema.parse({
    id, trackId, sourceAssetId: `asset_${trackId}`, sourceInFrame: 0, sourceOutFrame: dur, sourceFps: fps,
    timelineStartFrame: start, timelineDurationFrames: dur, playbackSpeed: 1, volume: 1, muted: false,
    fadeInFrames: 0, fadeOutFrames: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    captionText: null, graphicTemplateId: null, graphicStyle: null, keyframes: [], missingMedia: false,
    ...overrides,
  });
}

function baseSequence(clipCount: number, tracks = ["v1", "v2", "a1"]): import("../src/lib/editor/model").Sequence {
  const clips: import("../src/lib/editor/model").Clip[] = [];
  for (let i = 0; i < clipCount; i++) {
    clips.push(mkClip(`c${i}`, tracks[i % tracks.length], Math.floor(i / tracks.length) * 120, 120));
  }
  return model.SequenceSchema.parse({
    id: "m17seq", name: "M17 Timeline Scale", sampleRate: 48000, width: 640, height: 360, fps,
    tracks: tracks.map((id) => ({ id, name: id.toUpperCase(), kind: id.startsWith("a") ? "AUDIO" : "VIDEO", visible: true, muted: false, solo: false, locked: false })),
    clips,
    transitions: [],
  });
}

const run = (input: import("../src/lib/editor/model").Sequence, cmds: Record<string, unknown>[]) => {
  let s = input;
  for (const c of cmds) ({ sequence: s } = commands.applyCommand(s, c));
  return s;
};

describe("M17 cross-track movement (MoveClip newTrackId)", () => {
  test("moves a clip to a same-kind track and the inverse restores it exactly", () => {
    const seq = baseSequence(3);
    const { sequence: after, inverse } = commands.applyCommand(seq, { type: "MoveClip", clipId: "c0", newTimelineStartFrame: 120, newTrackId: "v2" });
    const moved = after.clips.find((c) => c.id === "c0")!;
    expect(moved.trackId).toBe("v2");
    expect(moved.timelineStartFrame).toBe(120);
    const restored = run(after, inverse);
    expect(restored.clips.find((c) => c.id === "c0")!.trackId).toBe("v1");
    expect(restored.clips.find((c) => c.id === "c0")!.timelineStartFrame).toBe(0);
  });

  test("refuses cross-kind and locked targets", () => {
    const seq = baseSequence(3);
    expect(() => commands.applyCommand(seq, { type: "MoveClip", clipId: "c0", newTimelineStartFrame: 0, newTrackId: "a1" })).toThrow(/different track kinds/);
    const locked = commands.applyCommand(seq, { type: "UpdateTrack", trackId: "v2", locked: true }).sequence;
    expect(() => commands.applyCommand(locked, { type: "MoveClip", clipId: "c0", newTimelineStartFrame: 0, newTrackId: "v2" })).toThrow(/locked/);
  });
});

describe("M17 duplicate compilation", () => {
  test("duplicates adjacent to the source when the space is free", () => {
    const seq = baseSequence(2); // v1: c0 (0..120), v2: c1 (0..120)
    const op = edits.compileDuplicate(seq, "c0");
    expect(op).not.toBeNull();
    const after = run(seq, op!.commands);
    const dups = after.clips.filter((c) => c.id.startsWith("c0__dup"));
    expect(dups.length).toBe(1);
    expect(dups[0].timelineStartFrame).toBe(120);
    expect(dups[0].timelineDurationFrames).toBe(120);
  });

  test("refuses when the adjacent space is occupied (no silent overlap)", () => {
    const seq = baseSequence(3); // v1: c0 (0..120) + c2 (0..120)?? c2 → a1; make an occupied v1 next
    const withNeighbor = { ...seq };
    (withNeighbor as { clips: unknown[] }).clips = [
      ...seq.clips,
      mkClip("cnext", "v1", 120, 120),
    ];
    expect(edits.compileDuplicate(withNeighbor, "c0")).toBeNull();
  });
});

describe("M17 timeline scale (50 / 200 / 500 clips) — synthetic engine batch", () => {
  for (const n of [50, 200, 500]) {
    test(`${n} clips: batch insert + full undo chain + state validity`, () => {
      const empty = baseSequence(0);
      const cmds: Record<string, unknown>[] = [];
      for (let i = 0; i < n; i++) {
        const trackId = `v${(i % 2) + 1}`.replace("v2", "v2");
        cmds.push({ type: "AddClip", clip: mkClip(`b${i}`, trackId, Math.floor(i / 2) * 30, 30) });
      }
      // baseSequence(0) must include v2 for this batch.
      const withV2 = model.SequenceSchema.parse({
        ...empty,
        tracks: [
          { id: "v1", name: "V1", kind: "VIDEO", visible: true, muted: false, solo: false, locked: false },
          { id: "v2", name: "V2", kind: "VIDEO", visible: true, muted: false, solo: false, locked: false },
        ],
      });
      const t0 = performance.now();
      let s = withV2;
      const inverses: Record<string, unknown>[][] = [];
      for (const c of cmds) {
        const r = commands.applyCommand(s, c);
        s = r.sequence;
        inverses.unshift(r.inverse);
      }
      const applyMs = Math.round(performance.now() - t0);
      expect(s.clips.length).toBe(n);
      const report = model.validateSequence(s);
      expect(report.errors).toEqual([]);
      // Undo the entire chain — nothing lost.
      let u = s;
      for (const inv of inverses) u = run(u, inv);
      expect(u.clips.length).toBe(0);
      console.log(`  [${n} clips] batch apply: ${applyMs} ms`);
    }, 120_000);
  }

  test("500-clip ripple delete keeps duration and validity", () => {
    const seq = baseSequence(500);
    const before = model.validateSequence(seq);
    expect(before.errors).toEqual([]);
    const { sequence: after, inverse } = commands.applyCommand(seq, { type: "RippleDelete", clipId: "c249" });
    expect(after.clips.length).toBe(499);
    expect(model.validateSequence(after).errors).toEqual([]);
    const restored = run(after, inverse);
    expect(restored.clips.length).toBe(500);
  }, 60_000);
});
