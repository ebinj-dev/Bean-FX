/**
 * BEAN FX — M1 regression tests for the stabilization fixes:
 *   1. TrimClip undo on caption (missingMedia) clips restores a VALID sequence.
 *   2. MoveClip refuses edits on locked tracks (in-place included).
 *   3. EditHistory.undo reports failure instead of throwing/corrupting.
 *
 * Run: bun test scripts/test-editor-regressions.test.ts
 */
import { describe, expect, test } from "bun:test";
import { EditHistory, applyTransaction } from "../src/lib/editor/engine";
import { validateCommand } from "../src/lib/editor/commands";
import { makeRational, type Rational } from "../src/lib/editor/time";
import type { Sequence } from "../src/lib/editor/model";

function baseSequence(): Sequence {
  return {
    id: "seq-1",
    name: "Test Sequence",
    fps: makeRational(30, 1),
    width: 1920,
    height: 1080,
    sampleRate: 48000,
    tracks: [
      { id: "t-v1", kind: "VIDEO", name: "Video 1", visible: true, muted: false, solo: false, locked: false },
      { id: "t-cap", kind: "CAPTION", name: "Captions", visible: true, muted: false, solo: false, locked: false },
      { id: "t-a1", kind: "AUDIO", name: "Audio 1", visible: true, muted: false, solo: false, locked: false },
    ],
    clips: [],
    transitions: [],
  };
}

function captionClipPayload() {
  return {
    id: "cap-1",
    trackId: "t-cap",
    sourceAssetId: "",
    sourceInFrame: 0,
    sourceOutFrame: 90,
    sourceFps: { num: 30, den: 1 },
    timelineStartFrame: 0,
    playbackSpeed: 1,
    volume: 1,
    muted: false,
    fadeInFrames: 0,
    fadeOutFrames: 0,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    captionText: "hello",
    captionStyle: null,
    graphicTemplateId: null,
    label: "hello",
    missingMedia: true,
    effects: [],
    keyframes: [],
  };
}

describe("stabilization regressions — caption trim undo", () => {
  test("trim a caption clip, then undo: sequence stays valid and the trim is reverted", () => {
    const seeded = applyTransaction(baseSequence(), [{ type: "AddClip", clip: captionClipPayload() } as never]);
    const history = new EditHistory(seeded.sequence);
    const trim = { type: "TrimClip", clipId: "cap-1", newSourceOutFrame: 60 };
    expect(validateCommand(history.current, trim).ok).toBe(true);
    history.apply([trim]);
    const trimmed = history.current.clips.find((c) => c.id === "cap-1")!;
    expect(trimmed.sourceOutFrame).toBe(60);
    expect(trimmed.missingMedia).toBe(true); // caption clip keeps its no-source marker

    const undo = history.undo();
    expect(undo.ok).toBe(true);
    const restored = history.current.clips.find((c) => c.id === "cap-1")!;
    expect(restored.sourceOutFrame).toBe(90);
    // The old inverse forced missingMedia=false → the restored sequence failed
    // validation and the undo threw mid-stack.
    expect(restored.missingMedia).toBe(true);
  });

  test("in-place move of a clip on a locked track is refused by the engine", () => {
    const seeded = applyTransaction(baseSequence(), [{ type: "AddClip", clip: captionClipPayload() } as never]);
    const locked = {
      ...seeded.sequence,
      tracks: seeded.sequence.tracks.map((t) => (t.id === "t-cap" ? { ...t, locked: true } : t)),
    } as Sequence;
    const result = validateCommand(locked, { type: "MoveClip", clipId: "cap-1", newTimelineStartFrame: 30 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("locked");
  });

  test("EditHistory.undo reports a failed inverse instead of throwing or corrupting", () => {
    const seeded = applyTransaction(baseSequence(), [{ type: "AddClip", clip: captionClipPayload() } as never]);
    const history = new EditHistory(seeded.sequence);
    history.apply([{ type: "TrimClip", clipId: "cap-1", newSourceOutFrame: 60 } as never]);
    // Sabotage the inverse to simulate an engine-level failure mid-undo.
    const stack = (history as unknown as { undoStack: { inverse: unknown[] }[] }).undoStack;
    stack[stack.length - 1].inverse = [{ type: "NoSuchCommand" }];
    const result = history.undo();
    expect(result.ok).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
    // The entry was pushed back — the stack did not lose or duplicate it.
    expect(history.canUndo).toBe(true);
    expect(history.current.clips.find((c) => c.id === "cap-1")!.sourceOutFrame).toBe(60);
  });

  test("image clip (stills keep sequence fps 1:1) trims and undoes cleanly", () => {
    const seq = baseSequence();
    (seq.fps as Rational) = makeRational(30, 1);
    const seeded = applyTransaction(seq, [
      {
        type: "AddClip",
        clip: { ...captionClipPayload(), id: "img-1", trackId: "t-v1", sourceAssetId: "asset-img", missingMedia: false, captionText: null, sourceOutFrame: 150 },
      } as never,
    ]);
    const history = new EditHistory(seeded.sequence);
    history.apply([{ type: "TrimClip", clipId: "img-1", newSourceOutFrame: 120 } as never]);
    const undo = history.undo();
    expect(undo.ok).toBe(true);
    expect(history.current.clips.find((c) => c.id === "img-1")!.sourceOutFrame).toBe(150);
  });
});
