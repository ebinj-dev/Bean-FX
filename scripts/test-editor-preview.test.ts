import { describe, expect, test } from "bun:test";
import {
  activeAudioAt,
  activeCaptionAt,
  activeVideoClipAt,
  fadeMultiplierAt,
  sequenceEndFrame,
  sourceSecondsAt,
} from "../src/lib/editor/preview";
import { makeRational, type Rational } from "../src/lib/editor/time";
import type { Clip, Sequence, Track } from "../src/lib/editor/model";

const FPS: Rational = makeRational(30, 1);

function track(id: string, kind: Track["kind"], extra: Partial<Track> = {}): Track {
  return { id, kind, name: id, visible: true, muted: false, solo: false, locked: false, ...extra };
}

function clip(id: string, trackId: string, start: number, dur: number, extra: Partial<Clip> = {}): Clip {
  return {
    id,
    trackId,
    sourceAssetId: `asset-${id}`,
    sourceInFrame: 0,
    sourceOutFrame: dur,
    sourceFps: { num: 30, den: 1 },
    timelineStartFrame: start,
    timelineDurationFrames: dur,
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
    ...extra,
  };
}

function baseSeq(): Sequence {
  return {
    id: "s",
    name: "S",
    fps: FPS,
    width: 1920,
    height: 1080,
    sampleRate: 48000,
    tracks: [track("v1", "VIDEO"), track("v2", "VIDEO"), track("cap", "CAPTION"), track("a1", "AUDIO")],
    clips: [],
    transitions: [],
  };
}

describe("preview resolution — video compositing", () => {
  test("gap at playhead → no active video (monitor shows black)", () => {
    const seq = baseSeq();
    seq.clips.push(clip("a", "v1", 0, 90));
    expect(activeVideoClipAt(seq, 100)).toBeNull();
    expect(activeVideoClipAt(seq, 89)).not.toBeNull();
  });

  test("later track composites on top (overwrite)", () => {
    const seq = baseSeq();
    seq.clips.push(clip("bottom", "v1", 0, 90));
    seq.clips.push(clip("top", "v2", 30, 60));
    expect(activeVideoClipAt(seq, 10)!.clip.id).toBe("bottom");
    expect(activeVideoClipAt(seq, 45)!.clip.id).toBe("top");
    expect(activeVideoClipAt(seq, 95)).toBeNull();
  });

  test("hidden tracks do not composite; muted tracks still show video", () => {
    const seq = baseSeq();
    seq.tracks[0].visible = false; // v1 hidden
    seq.clips.push(clip("hidden", "v1", 0, 90));
    seq.clips.push(clip("shown", "v2", 0, 90));
    expect(activeVideoClipAt(seq, 10)!.clip.id).toBe("shown");
    const seq2 = baseSeq();
    seq2.tracks[1].muted = true; // muted ≠ hidden for video
    seq2.clips.push(clip("m", "v2", 0, 90));
    expect(activeVideoClipAt(seq2, 10)!.clip.id).toBe("m");
  });
});

describe("preview resolution — audio mix", () => {
  test("audio and video clips both contribute; mute hides a clip", () => {
    const seq = baseSeq();
    seq.clips.push(clip("v", "v1", 0, 90));
    seq.clips.push(clip("a", "a1", 0, 90, { volume: 0.5 }));
    const mix = activeAudioAt(seq, 10);
    expect(mix.map((m) => m.clip.id).sort()).toEqual(["a", "v"]);
    const seq2 = baseSeq();
    seq2.clips.push(clip("a2", "a1", 0, 90, { muted: true }));
    expect(activeAudioAt(seq2, 10)).toEqual([]);
  });

  test("solo on one track silences everything else", () => {
    const seq = baseSeq();
    seq.clips.push(clip("v", "v1", 0, 90));
    seq.clips.push(clip("a", "a1", 0, 90));
    seq.tracks[3].solo = true; // a1 soloed
    const mix = activeAudioAt(seq, 10);
    expect(mix.map((m) => m.clip.id)).toEqual(["a"]);
  });

  test("track mute silences the whole track", () => {
    const seq = baseSeq();
    seq.clips.push(clip("a", "a1", 0, 90));
    seq.tracks[3].muted = true;
    expect(activeAudioAt(seq, 10)).toEqual([]);
  });

  test("captions and graphics never contribute audio", () => {
    const seq = baseSeq();
    seq.clips.push(clip("c", "cap", 0, 30, { captionText: "hi" }));
    expect(activeAudioAt(seq, 10)).toEqual([]);
  });
});

describe("preview resolution — captions", () => {
  test("returns the visible caption with text", () => {
    const seq = baseSeq();
    seq.clips.push(clip("c1", "cap", 0, 30, { captionText: "hello" }));
    seq.clips.push(clip("c2", "cap", 60, 30, { captionText: "world" }));
    expect(activeCaptionAt(seq, 10)?.captionText).toBe("hello");
    expect(activeCaptionAt(seq, 45)).toBeNull();
    expect(activeCaptionAt(seq, 70)?.captionText).toBe("world");
  });
});

describe("preview resolution — source time mapping", () => {
  test("same timebase: timeline frame maps 1:1 into source seconds", () => {
    const c = clip("x", "v1", 30, 90, { sourceInFrame: 15, sourceOutFrame: 105 });
    // timeline frame 30 = clip start = source frame 15 = 0.5 s
    expect(sourceSecondsAt(c, 30, FPS)).toBeCloseTo(0.5, 6);
    // timeline frame 60 = 30 frames in = source frame 45 = 1.5 s
    expect(sourceSecondsAt(c, 60, FPS)).toBeCloseTo(1.5, 6);
  });

  test("25fps source into 30fps sequence maps through the timebases", () => {
    const c = clip("y", "v1", 0, 120, { sourceFps: { num: 25, den: 1 }, sourceOutFrame: 100 });
    // timeline frame 30 = 1 s of timeline = 25 source frames = 1.0 s
    expect(sourceSecondsAt(c, 30, FPS)).toBeCloseTo(1.0, 5);
  });

  test("2× speed: timeline frame 30 reads source frame 60", () => {
    const c = clip("z", "v1", 0, 45, { playbackSpeed: 2, sourceOutFrame: 90 });
    expect(sourceSecondsAt(c, 30, FPS)).toBeCloseTo(2.0, 6);
  });

  test("before clip start clamps to the clip head", () => {
    const c = clip("w", "v1", 100, 45, { sourceInFrame: 30, sourceOutFrame: 75 });
    expect(sourceSecondsAt(c, 50, FPS)).toBeCloseTo(1.0, 6); // source frame 30
  });
});

describe("preview resolution — fades and extent", () => {
  test("fade in/out multipliers ramp 0→1→0", () => {
    const c = clip("f", "v1", 0, 90, { fadeInFrames: 30, fadeOutFrames: 30 });
    expect(fadeMultiplierAt(c, 0)).toBe(0);
    expect(fadeMultiplierAt(c, 15)).toBeCloseTo(0.5, 5);
    expect(fadeMultiplierAt(c, 45)).toBe(1);
    expect(fadeMultiplierAt(c, 75)).toBeCloseTo(0.5, 5);
    expect(fadeMultiplierAt(c, 89)).toBeCloseTo(1 / 30, 5);
  });

  test("sequenceEndFrame follows the last clip", () => {
    const seq = baseSeq();
    seq.clips.push(clip("a", "v1", 0, 90));
    seq.clips.push(clip("b", "v2", 200, 30));
    expect(sequenceEndFrame(seq)).toBe(230);
    expect(sequenceEndFrame(baseSeq())).toBe(0);
  });
});
