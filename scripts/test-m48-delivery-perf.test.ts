/**
 * M48-F — SRT sidecar generation + 1000-clip performance gates.
 */
import { describe, test, expect } from "bun:test";
import { sequenceToSrt } from "../src/lib/editor/captions";
import { makeRational } from "../src/lib/editor/time";
import { applyTransaction } from "../src/lib/editor/engine";
import { assertValidSequence } from "../src/lib/editor/model";
import type { Sequence, Clip } from "../src/lib/editor/model";

function baseSequence(): Sequence {
  return {
    id: "seq-srt",
    name: "srt",
    fps: makeRational(30, 1),
    width: 1920,
    height: 1080,
    sampleRate: 48000,
    tracks: [
      { id: "v1", kind: "VIDEO", name: "Video 1", visible: true, muted: false, solo: false, locked: false, volume: 1 },
      { id: "c1", kind: "CAPTION", name: "Captions", visible: true, muted: false, solo: false, locked: false, volume: 1 },
    ],
    clips: [],
    transitions: [],
    markers: [],
  };
}

function captionClip(id: string, start: number, dur: number, text: string): Clip {
  return {
    id, trackId: "c1", sourceAssetId: null, sourceInFrame: 0, sourceOutFrame: dur, sourceFps: makeRational(30, 1),
    timelineStartFrame: start, timelineDurationFrames: dur, playbackSpeed: 1, volume: 1, muted: false,
    fadeInFrames: 0, fadeOutFrames: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    captionText: text, captionStyle: null, graphicTemplateId: null, graphicStyle: null, label: null,
    missingMedia: false, pan: 0, groupId: null, effects: [], keyframes: [],
  };
}

describe("M48-F SRT sidecar from canonical caption tracks", () => {
  test("cues in timeline order with wall-clock stamps at sequence fps", () => {
    const seq = baseSequence();
    seq.clips = [captionClip("a", 0, 30, "Hello world"), captionClip("b", 90, 30, "Second line"), captionClip("v", 45, 30, "ignored — video track")];
    seq.clips[2].trackId = "v1";
    const srt = sequenceToSrt(seq);
    expect(srt).toContain("1\n00:00:00,000 --> 00:00:01,000\nHello world");
    // 90 frames @30fps = 3.000 s exactly.
    expect(srt).toContain("2\n00:00:03,000 --> 00:00:04,000\nSecond line");
    expect(srt).not.toContain("ignored");
  });

  test("non-integer stamps round to milliseconds honestly (29.97)", () => {
    const seq = baseSequence();
    seq.fps = makeRational(30000, 1001);
    seq.clips = [captionClip("a", 0, 30, "drop frame timeline")];
    const srt = sequenceToSrt(seq);
    // 30 frames @ 29.97 = 1.001 s → the cue END stamps at 00:00:01,001.
    expect(srt).toContain("00:00:00,000 --> 00:00:01,001");
  });

  test("no captions → empty sidecar (never invented)", () => {
    const seq = baseSequence();
    expect(sequenceToSrt(seq)).toBe("");
    const seq2 = baseSequence();
    seq2.clips = [captionClip("blank", 0, 30, "   ")];
    expect(sequenceToSrt(seq2)).toBe("");
  });
});

describe("M48-F performance gates (1000-clip timeline)", () => {
  function bigSequence(clips: number): Sequence {
    const seq = baseSequence();
    seq.tracks.push({ id: "v2", kind: "VIDEO", name: "Video 2", visible: true, muted: false, solo: false, locked: false, volume: 1 });
    for (let i = 0; i < clips; i += 1) {
      const clip = captionClip(`p${i}`, i * 30, 30, `clip ${i}`);
      clip.trackId = i % 2 === 0 ? "v1" : "v2";
      clip.captionText = null;
      clip.sourceAssetId = "asset-x";
      seq.clips.push(clip);
    }
    return seq;
  }

  test("validate a 1000-clip sequence under 1 s", () => {
    const seq = bigSequence(1000);
    const t0 = performance.now();
    assertValidSequence(seq);
    const dt = performance.now() - t0;
    expect(dt).toBeLessThan(1000);
    console.log(`  [perf] validate 1000 clips: ${dt.toFixed(1)} ms`);
  });

  test("atomic batch over 1000 clips (500 moves) under 3 s and undoable", () => {
    const seq = bigSequence(1000);
    const moves = seq.clips.slice(0, 500).map((c, i) => ({ type: "MoveClip", clipId: c.id, newTimelineStartFrame: 100000 + i * 30 }));
    const t0 = performance.now();
    const r = applyTransaction(seq, moves); // throws on failure — reaching here means success
    const dt = performance.now() - t0;
    expect(r.sequence).toBeDefined();
    expect(r.inverses.length).toBe(500);
    expect(dt).toBeLessThan(3000);
    console.log(`  [perf] atomic 500-move batch on 1000-clip seq: ${dt.toFixed(1)} ms`);
    // Undo parity at scale: applying inverses restores the original head positions.
    const t1 = performance.now();
    let cur = r.sequence;
    for (const inv of [...r.inverses].reverse()) cur = applyTransaction(cur, inv).sequence;
    const undoMs = performance.now() - t1;
    expect(cur.clips.find((c) => c.id === "p0")!.timelineStartFrame).toBe(0);
    expect(undoMs).toBeLessThan(3000);
    console.log(`  [perf] undo 500 inverses: ${undoMs.toFixed(1)} ms`);
  });

  test("SRT generation over 500 caption cues under 250 ms", () => {
    const seq = baseSequence();
    for (let i = 0; i < 500; i += 1) seq.clips.push(captionClip(`c${i}`, i * 30, 30, `cue ${i}`));
    const t0 = performance.now();
    const srt = sequenceToSrt(seq);
    const dt = performance.now() - t0;
    expect(dt).toBeLessThan(250);
    expect(srt).toContain("cue 499");
    console.log(`  [perf] SRT 500 cues: ${dt.toFixed(1)} ms`);
  });
});
