import { describe, expect, test } from "bun:test";
import { applyCommand, EditorError, parseCommand, validateCommand } from "../src/lib/editor/commands";
import { EditHistory, applyTransaction } from "../src/lib/editor/engine";
import { assertValidSequence, validateSequence, type Sequence } from "../src/lib/editor/model";
import { makeRational } from "../src/lib/editor/time";

/** A realistic base sequence: two video tracks, graphics/captions, audio. */
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
      { id: "t-v2", kind: "VIDEO", name: "Video 2", visible: true, muted: false, solo: false, locked: false },
      { id: "t-cap", kind: "CAPTION", name: "Captions", visible: true, muted: false, solo: false, locked: false },
      { id: "t-a1", kind: "AUDIO", name: "Audio 1", visible: true, muted: false, solo: false, locked: false },
    ],
    clips: [],
    transitions: [],
  };
}

/** A 5-second 30fps source clip (150 source frames @ 30fps == 150 timeline frames). */
function clipPayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "c1",
    trackId: "t-v1",
    sourceAssetId: "asset-1",
    sourceInFrame: 0,
    sourceOutFrame: 150,
    sourceFps: { num: 30, den: 1 },
    timelineStartFrame: 0,
    playbackSpeed: 1,
    volume: 1,
    muted: false,
    fadeInFrames: 0,
    fadeOutFrames: 0,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    captionText: null,
    captionStyle: null,
    graphicTemplateId: null,
    label: null,
    missingMedia: false,
    effects: [],
    keyframes: [],
    ...overrides,
  };
}

describe("editing commands — success paths", () => {
  test("AddClip → RemoveClip round trip via inverse", () => {
    const seq = baseSequence();
    const { sequence, inverse } = applyCommand(seq, { type: "AddClip", clip: clipPayload() });
    expect(sequence.clips).toHaveLength(1);
    expect(sequence.clips[0].timelineDurationFrames).toBe(150);
    const undone = applyCommand(sequence, inverse[0]);
    expect(undone.sequence.clips).toHaveLength(0);
  });

  test("MoveClip within track; cross-track move allowed for same kind only", () => {
    let { sequence } = applyCommand(baseSequence(), { type: "AddClip", clip: clipPayload() });
    ({ sequence } = applyCommand(sequence, { type: "MoveClip", clipId: "c1", newTimelineStartFrame: 300 }));
    expect(sequence.clips[0].timelineStartFrame).toBe(300);
    const moved = applyCommand(sequence, { type: "MoveClip", clipId: "c1", newTimelineStartFrame: 10, newTrackId: "t-v2" });
    expect(moved.sequence.clips[0].trackId).toBe("t-v2");
    // audio track is a different kind → refused
    expect(() => applyCommand(moved.sequence, { type: "MoveClip", clipId: "c1", newTimelineStartFrame: 0, newTrackId: "t-a1" })).toThrow(EditorError);
  });

  test("SplitClip at frame 60 produces two exact halves with recomputed source ranges", () => {
    let { sequence } = applyCommand(baseSequence(), { type: "AddClip", clip: clipPayload() });
    const result = applyCommand(sequence, {
      type: "SplitClip",
      clipId: "c1",
      atTimelineFrame: 60,
      newLeftId: "c1",
      newRightId: "c2",
    });
    const left = result.sequence.clips.find((c) => c.id === "c1")!;
    const right = result.sequence.clips.find((c) => c.id === "c2")!;
    expect(left.sourceOutFrame).toBe(60);
    expect(right.sourceInFrame).toBe(60);
    expect(right.timelineStartFrame).toBe(60);
    expect(left.timelineDurationFrames).toBe(60);
    expect(right.timelineDurationFrames).toBe(90);
    // Sequence-level invariant holds (recomputed from source ranges).
    expect(() => assertValidSequence(result.sequence)).not.toThrow();
    // Undo: inverse re-adds the original full clip.
    const undone = applyTransaction(result.sequence, [...result.inverse].reverse());
    expect(undone.sequence.clips).toHaveLength(1);
    expect(undone.sequence.clips[0].id).toBe("c1");
    expect(undone.sequence.clips[0].sourceOutFrame).toBe(150);
  });

  test("TrimClip head shifts the timeline start; tail recomputes the duration", () => {
    let { sequence } = applyCommand(baseSequence(), { type: "AddClip", clip: clipPayload() });
    const head = applyCommand(sequence, { type: "TrimClip", clipId: "c1", newSourceInFrame: 30 });
    expect(head.sequence.clips[0].timelineStartFrame).toBe(30); // head cut shifts start
    expect(head.sequence.clips[0].timelineDurationFrames).toBe(120);
    const tail = applyCommand(head.sequence, { type: "TrimClip", clipId: "c1", newSourceOutFrame: 90 });
    expect(tail.sequence.clips[0].timelineDurationFrames).toBe(60);
    // Invalid: new in beyond out
    expect(() => applyCommand(tail.sequence, { type: "TrimClip", clipId: "c1", newSourceInFrame: 95 })).toThrow(EditorError);
  });

  test("RippleDelete removes the clip and closes the gap, inverse restores everything", () => {
    let seq = baseSequence();
    seq = applyCommand(seq, { type: "AddClip", clip: clipPayload({ id: "a", timelineStartFrame: 0 }) }).sequence;
    seq = applyCommand(seq, { type: "AddClip", clip: clipPayload({ id: "b", timelineStartFrame: 150 }) }).sequence;
    seq = applyCommand(seq, { type: "AddClip", clip: clipPayload({ id: "c", timelineStartFrame: 300 }) }).sequence;
    const result = applyCommand(seq, { type: "RippleDelete", clipId: "b" });
    expect(result.sequence.clips.map((c) => c.id).sort()).toEqual(["a", "c"]);
    const c = result.sequence.clips.find((x) => x.id === "c")!;
    expect(c.timelineStartFrame).toBe(150); // pulled left by the removed duration
    const undone = applyTransaction(result.sequence, [...result.inverse].reverse());
    expect(undone.sequence.clips.map((x) => x.id).sort()).toEqual(["a", "b", "c"]);
    expect(undone.sequence.clips.find((x) => x.id === "c")!.timelineStartFrame).toBe(300);
  });

  test("InsertClip shifts later clips right and undo closes it again", () => {
    let seq = baseSequence();
    seq = applyCommand(seq, { type: "AddClip", clip: clipPayload({ id: "a", timelineStartFrame: 0 }) }).sequence;
    seq = applyCommand(seq, { type: "AddClip", clip: clipPayload({ id: "c", timelineStartFrame: 300 }) }).sequence;
    const result = applyCommand(seq, { type: "InsertClip", clip: clipPayload({ id: "b", timelineStartFrame: 150 }) });
    expect(result.sequence.clips.find((x) => x.id === "c")!.timelineStartFrame).toBe(450);
    const undone = applyTransaction(result.sequence, [...result.inverse].reverse());
    expect(undone.sequence.clips.find((x) => x.id === "c")!.timelineStartFrame).toBe(300);
  });

  test("ReplaceClip swaps the source and recomputes the duration from the new range", () => {
    let { sequence } = applyCommand(baseSequence(), { type: "AddClip", clip: clipPayload() });
    const result = applyCommand(sequence, {
      type: "ReplaceClip",
      clipId: "c1",
      newSourceAssetId: "asset-2",
      newSourceInFrame: 0,
      newSourceOutFrame: 75,
    });
    expect(result.sequence.clips[0].sourceAssetId).toBe("asset-2");
    expect(result.sequence.clips[0].timelineDurationFrames).toBe(75);
    const undone = applyTransaction(result.sequence, [...result.inverse].reverse());
    expect(undone.sequence.clips[0].sourceAssetId).toBe("asset-1");
    expect(undone.sequence.clips[0].timelineDurationFrames).toBe(150);
  });

  test("AddTransition requires overlapping clip head/tail; valid transition applies and undoes", () => {
    let seq = baseSequence();
    seq = applyCommand(seq, { type: "AddClip", clip: clipPayload({ id: "a", timelineStartFrame: 0 }) }).sequence;
    // b starts at 120 so it overlaps a's tail [120,150) — a real cross-dissolve region.
    seq = applyCommand(seq, { type: "AddClip", clip: clipPayload({ id: "b", timelineStartFrame: 120 }) }).sequence;
    // no overlap at [150,180) → refused (nothing ends at 180 / starts at 150 correctly)
    expect(() =>
      applyCommand(seq, { type: "AddTransition", transitionId: "tr1", trackId: "t-v1", kind: "CROSS_DISSOLVE", startFrame: 150, durationFrames: 30 }),
    ).toThrow(EditorError);
    const result = applyCommand(seq, {
      type: "AddTransition",
      transitionId: "tr1",
      trackId: "t-v1",
      kind: "CROSS_DISSOLVE",
      startFrame: 120,
      durationFrames: 30,
    });
    expect(result.sequence.transitions).toHaveLength(1);
    expect(result.sequence.transitions[0].clipAId).toBe("a");
    expect(result.sequence.transitions[0].clipBId).toBe("b");
    const undone = applyTransaction(result.sequence, [...result.inverse].reverse());
    expect(undone.sequence.transitions).toHaveLength(0);
    // captions/graphics tracks never take transitions
    expect(() =>
      applyCommand(result.sequence, { type: "AddTransition", transitionId: "tr2", trackId: "t-cap", kind: "CROSS_DISSOLVE", startFrame: 120, durationFrames: 30 }),
    ).toThrow(EditorError);
  });

  test("caption and graphic clips are validated against their track kinds", () => {
    let seq = baseSequence();
    const caption = applyCommand(seq, {
      type: "AddCaption",
      clip: clipPayload({ id: "cap1", trackId: "t-cap", captionText: "Hello world", sourceOutFrame: 30 }),
    });
    expect(caption.sequence.clips[0].captionText).toBe("Hello world");
    // caption on video track → refused
    expect(() =>
      applyCommand(seq, { type: "AddCaption", clip: clipPayload({ id: "capX", trackId: "t-v1", captionText: "x", sourceOutFrame: 30 }) }),
    ).toThrow(EditorError);
    // graphic without template → refused
    expect(() =>
      applyCommand(seq, { type: "AddGraphic", clip: clipPayload({ id: "g1", trackId: "t-cap", graphicTemplateId: null, sourceOutFrame: 30 }) }),
    ).toThrow(EditorError);
    // caption without text → refused
    expect(() =>
      applyCommand(seq, { type: "AddCaption", clip: clipPayload({ id: "cap2", trackId: "t-cap", captionText: null, sourceOutFrame: 30 }) }),
    ).toThrow(EditorError);
    seq = caption.sequence;
    const kf = applyCommand(seq, {
      type: "SetKeyframe",
      clipId: "cap1",
      keyframe: { id: "k1", property: "opacity", frame: 0, value: 0, interpolation: "LINEAR" },
    });
    const kf2 = applyCommand(kf.sequence, {
      type: "SetKeyframe",
      clipId: "cap1",
      keyframe: { id: "k2", property: "opacity", frame: 29, value: 1, interpolation: "LINEAR" },
    });
    expect(kf2.sequence.clips[0].keyframes.map((k) => k.id)).toEqual(["k1", "k2"]); // sorted
  });

  test("SetKeyframe replaces in place; keyframes must stay inside the clip", () => {
    let { sequence } = applyCommand(baseSequence(), { type: "AddClip", clip: clipPayload() });
    sequence = applyCommand(sequence, {
      type: "SetKeyframe",
      clipId: "c1",
      keyframe: { id: "k1", property: "volume", frame: 10, value: 0.5 },
    }).sequence;
    const replaced = applyCommand(sequence, {
      type: "SetKeyframe",
      clipId: "c1",
      keyframe: { id: "k1", property: "volume", frame: 10, value: 0.9 },
    });
    expect(replaced.sequence.clips[0].keyframes).toHaveLength(1);
    expect(replaced.sequence.clips[0].keyframes[0].value).toBe(0.9);
    expect(() =>
      applyCommand(replaced.sequence, {
        type: "SetKeyframe",
        clipId: "c1",
        keyframe: { id: "k9", property: "volume", frame: 500, value: 1 },
      }),
    ).toThrow(EditorError);
  });

  test("ChangeVolume and ChangePlaybackSpeed recompute and restore exactly via history", () => {
    const history = new EditHistory(baseSequence());
    history.apply([{ type: "AddClip", clip: clipPayload() }]);
    history.apply([{ type: "ChangePlaybackSpeed", clipId: "c1", speed: 2 }]);
    expect(history.current.clips[0].timelineDurationFrames).toBe(75);
    history.apply([{ type: "ChangeVolume", clipId: "c1", volume: 1.5 }]);
    expect(history.current.clips[0].volume).toBe(1.5);
    history.undo(); // restores volume only — the speed change is still applied
    expect(history.current.clips[0].volume).toBe(1);
    expect(history.current.clips[0].playbackSpeed).toBe(2);
    expect(history.current.clips[0].timelineDurationFrames).toBe(75);
    history.undo(); // restores speed and the recomputed duration
    expect(history.current.clips[0].playbackSpeed).toBe(1);
    expect(history.current.clips[0].timelineDurationFrames).toBe(150);
    history.redo();
    history.redo();
    expect(history.current.clips[0].playbackSpeed).toBe(2);
    expect(history.current.clips[0].volume).toBe(1.5);
    expect(() => applyCommand(history.current, { type: "ChangePlaybackSpeed", clipId: "c1", speed: 0 })).toThrow(EditorError);
  });

  test("AddTrack / RemoveTrack guard against duplicates and non-empty tracks", () => {
    let seq = baseSequence();
    seq = applyCommand(seq, {
      type: "AddTrack",
      track: { id: "t-v3", kind: "VIDEO", name: "Video 3", visible: true, muted: false, solo: false, locked: false },
    }).sequence;
    expect(seq.tracks).toHaveLength(5);
    expect(() =>
      applyCommand(seq, {
        type: "AddTrack",
        track: { id: "t-v3", kind: "VIDEO", name: "dup", visible: true, muted: false, solo: false, locked: false },
      }),
    ).toThrow(EditorError);
    seq = applyCommand(seq, { type: "AddClip", clip: clipPayload() }).sequence;
    expect(() => applyCommand(seq, { type: "RemoveTrack", trackId: "t-v1" })).toThrow(/still has clips/);
    const removed = applyCommand(applyCommand(seq, { type: "RemoveClip", clipId: "c1" }).sequence, { type: "RemoveTrack", trackId: "t-v1" });
    expect(removed.sequence.tracks).toHaveLength(4);
    // locked tracks refuse edits
    let locked = baseSequence();
    locked.tracks[0].locked = true;
    expect(() => applyCommand(locked, { type: "AddClip", clip: clipPayload() })).toThrow(/locked/);
  });
});

describe("editing commands — failure scenarios (directive §17)", () => {
  test("malformed commands are rejected by schema validation with actionable errors", () => {
    expect(() => parseCommand({ type: "NukeEverything" })).toThrow(EditorError);
    expect(() => parseCommand({ type: "AddClip", clip: { id: "" } })).toThrow(EditorError);
    expect(() => parseCommand({ type: "MoveClip", clipId: "c1", newTimelineStartFrame: -5 })).toThrow(EditorError);
    expect(() => parseCommand({ type: "ChangeVolume", clipId: "c1", volume: 99 })).toThrow(EditorError);
    // An empty source range is schema-valid but application must refuse it.
    expect(() => applyCommand(baseSequence(), { type: "AddClip", clip: clipPayload({ sourceOutFrame: 0 }) })).toThrow(EditorError);
    expect(() => applyCommand(baseSequence(), { type: "AddClip", clip: clipPayload({ sourceOutFrame: 5, sourceInFrame: 10 }) })).toThrow(EditorError);
  });

  test("missing references fail loudly, never silently", () => {
    const seq = baseSequence();
    expect(() => applyCommand(seq, { type: "RemoveClip", clipId: "ghost" })).toThrow(/does not exist/);
    expect(() => applyCommand(seq, { type: "MoveClip", clipId: "ghost", newTimelineStartFrame: 0 })).toThrow(/does not exist/);
    expect(() => applyCommand(seq, { type: "AddClip", clip: clipPayload({ trackId: "ghost-track" }) })).toThrow(/does not exist/);
    expect(() => applyCommand(seq, { type: "RemoveTransition", transitionId: "ghost" })).toThrow(/does not exist/);
  });

  test("fake media is refused: clip without asset must declare missingMedia", () => {
    const bad = clipPayload({ sourceAssetId: "" });
    const seq = baseSequence();
    // BuildClip succeeds structurally but the model validation refuses it.
    expect(() => applyCommand(seq, { type: "AddClip", clip: bad })).toThrow(/no source asset/);
    const ok = applyCommand(seq, { type: "AddClip", clip: clipPayload({ sourceAssetId: "", missingMedia: true }) });
    expect(ok.sequence.clips[0].missingMedia).toBe(true);
  });

  test("transaction aborts atomically — a failing step leaves no partial state", () => {
    const seq = baseSequence();
    const batch = [
      { type: "AddTrack", track: { id: "t-x", kind: "VIDEO", name: "X", visible: true, muted: false, solo: false, locked: false } },
      { type: "AddClip", clip: clipPayload({ trackId: "ghost" }) }, // fails
    ];
    expect(() => applyTransaction(seq, batch)).toThrow(/aborted at command 2\/2/);
  });

  test("validateCommand reports conflicts without throwing", () => {
    const seq = baseSequence();
    const ok = validateCommand(seq, { type: "AddClip", clip: clipPayload() });
    expect(ok.ok).toBe(true);
    const bad = validateCommand(seq, { type: "RemoveClip", clipId: "ghost" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/does not exist/);
  });

  test("cross-timebase split that cannot land exactly fails honestly (no fake rounding)", () => {
    let { sequence } = applyCommand(baseSequence(), { type: "AddClip", clip: clipPayload({ sourceFps: { num: 24000, den: 1001 } }) });
    // 24000/1001 source into 30fps sequence: each source frame ≈ 1.25 timeline frames.
    // Asking to split at a boundary that cannot match both halves exactly.
    let threw = false;
    try {
      applyCommand(sequence, { type: "SplitClip", clipId: "c1", atTimelineFrame: 61, newLeftId: "l", newRightId: "r" });
    } catch (e) {
      threw = e instanceof EditorError;
    }
    // Either it splits exactly at a snap or fails honestly — both are correct;
    // what is forbidden is a silent 1-frame drift.
    if (!threw) {
      const after = applyCommand(sequence, { type: "SplitClip", clipId: "c1", atTimelineFrame: 61, newLeftId: "l", newRightId: "r" });
      expect(() => assertValidSequence(after.sequence)).not.toThrow();
    }
  });
});

describe("editing commands — M2 extensions (track state + caption editing)", () => {
  test("UpdateTrack toggles are reversible and validated", () => {
    let seq = baseSequence();
    const hidden = applyCommand(seq, { type: "UpdateTrack", trackId: "t-v1", visible: false });
    expect(hidden.sequence.tracks[0].visible).toBe(false);
    const undone = applyTransaction(hidden.sequence, [...hidden.inverse].reverse());
    expect(undone.sequence.tracks[0].visible).toBe(true);
    expect(() => applyCommand(seq, { type: "UpdateTrack", trackId: "ghost", visible: false })).toThrow(EditorError);
    const renamed = applyCommand(seq, { type: "UpdateTrack", trackId: "t-v1", name: "Main Cam" });
    expect(renamed.sequence.tracks[0].name).toBe("Main Cam");
    expect(() => applyCommand(seq, { type: "UpdateTrack", trackId: "t-v1", name: "" })).toThrow(EditorError);
  });

  test("caption text and style are editable through UpdateClipProperties", () => {
    let seq = baseSequence();
    seq = applyCommand(seq, {
      type: "AddCaption",
      clip: clipPayload({ id: "cap1", trackId: "t-cap", captionText: "first draft", sourceOutFrame: 30 }),
    }).sequence;
    const edited = applyCommand(seq, { type: "UpdateClipProperties", clipId: "cap1", captionText: "final text" });
    expect(edited.sequence.clips[0].captionText).toBe("final text");
    const styled = applyCommand(edited.sequence, {
      type: "UpdateClipProperties",
      clipId: "cap1",
      captionStyle: { fontSize: 64, color: "#FFD700", background: null, position: "CENTER" },
    });
    expect(styled.sequence.clips[0].captionStyle?.fontSize).toBe(64);
    const undone = applyTransaction(styled.sequence, [...styled.inverse].reverse());
    expect(undone.sequence.clips[0].captionStyle).toBeNull(); // pre-edit value restored
    // empty caption text is refused on a CAPTION track
    expect(() => applyCommand(seq, { type: "UpdateClipProperties", clipId: "cap1", captionText: "" })).toThrow(/caption clip|requires/i);
  });
});

describe("EditHistory — undo/redo (directive §8)", () => {
  test("a full editing session round-trips through undo and redo", () => {
    const history = new EditHistory(baseSequence());
    history.apply([{ type: "AddClip", clip: clipPayload({ id: "a" }) }]);
    history.apply([{ type: "AddClip", clip: clipPayload({ id: "b", timelineStartFrame: 150 }) }]);
    expect(history.current.clips).toHaveLength(2);
    history.apply([
      { type: "SplitClip", clipId: "a", atTimelineFrame: 60, newLeftId: "a", newRightId: "a2" },
      { type: "ChangeVolume", clipId: "b", volume: 0.5 },
    ]);
    expect(history.current.clips).toHaveLength(3);
    expect(history.current.clips.find((c) => c.id === "b")!.volume).toBe(0.5);
    expect(history.canUndo).toBe(true);

    history.undo();
    expect(history.current.clips).toHaveLength(2); // split undone + volume restored
    expect(history.current.clips.find((c) => c.id === "b")!.volume).toBe(1);
    expect(history.canRedo).toBe(true);

    history.undo();
    expect(history.current.clips).toHaveLength(1);
    history.undo();
    expect(history.current.clips).toHaveLength(0);
    expect(history.canUndo).toBe(false);
    expect(history.undo().ok).toBe(false);

    history.redo();
    history.redo();
    history.redo();
    expect(history.current.clips).toHaveLength(3);
    expect(history.current.clips.find((c) => c.id === "b")!.volume).toBe(0.5);
    expect(history.canRedo).toBe(false);
    expect(history.redo().ok).toBe(false);
  });

  test("undo of a ripple delete restores gaps exactly", () => {
    const history = new EditHistory(baseSequence());
    history.apply([{ type: "AddClip", clip: clipPayload({ id: "a", timelineStartFrame: 0 }) }]);
    history.apply([{ type: "AddClip", clip: clipPayload({ id: "b", timelineStartFrame: 150 }) }]);
    history.apply([{ type: "AddClip", clip: clipPayload({ id: "c", timelineStartFrame: 300 }) }]);
    history.apply([{ type: "RippleDelete", clipId: "b" }]);
    expect(history.current.clips.find((c) => c.id === "c")!.timelineStartFrame).toBe(150);
    history.undo();
    expect(history.current.clips.map((c) => c.id).sort()).toEqual(["a", "b", "c"]);
    expect(history.current.clips.find((c) => c.id === "c")!.timelineStartFrame).toBe(300);
    expect(validateSequence(history.current).errors).toEqual([]);
  });
});
