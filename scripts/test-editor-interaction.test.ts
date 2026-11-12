import { describe, expect, test } from "bun:test";
import {
  clipAtPoint,
  clipRect,
  frameToX,
  movePreview,
  projectedDurationFrames,
  rulerScale,
  snapFrame,
  trimPreview,
  trimPreviewToCommand,
  xToFrame,
} from "../src/lib/editor/interaction";
import { applyCommand } from "../src/lib/editor/commands";
import { makeRational, type Rational } from "../src/lib/editor/time";
import type { Clip, Sequence } from "../src/lib/editor/model";

const FPS = { num: 30, den: 1 };
const FPS_R: Rational = makeRational(30, 1);

function seq(): Sequence {
  return {
    id: "s",
    name: "S",
    fps: FPS_R,
    width: 1920,
    height: 1080,
    sampleRate: 48000,
    tracks: [
      { id: "v1", kind: "VIDEO", name: "V1", visible: true, muted: false, solo: false, locked: false },
      { id: "a1", kind: "AUDIO", name: "A1", visible: true, muted: false, solo: false, locked: false },
    ],
    clips: [],
    transitions: [],
  };
}

function addClip(s: Sequence, id: string, start: number, dur = 90): Sequence {
  return applyCommand(s, {
    type: "AddClip",
    clip: {
      id,
      trackId: "v1",
      sourceAssetId: "asset-1",
      sourceInFrame: 0,
      sourceOutFrame: dur,
      sourceFps: FPS,
      timelineStartFrame: start,
    },
  }).sequence;
}

describe("timeline interaction — frame↔pixel mapping", () => {
  test("round trip xToFrame(frameToX(f)) returns f", () => {
    for (const f of [0, 15, 90, 300, 900]) {
      const x = frameToX(f, 2, FPS, 0);
      expect(Math.round(xToFrame(x, 2, FPS, 0))).toBe(f);
    }
  });

  test("scroll shifts the mapping consistently", () => {
    const x = frameToX(400, 1, FPS, 300);
    expect(Math.round(xToFrame(x, 1, FPS, 300))).toBe(400);
  });

  test("negative frames clamp to 0", () => {
    expect(xToFrame(-500, 1, FPS, 0)).toBe(0);
  });

  test("snapFrame snaps to the grid and never below 0", () => {
    expect(snapFrame(13, 15)).toBe(15);
    expect(snapFrame(7, 15)).toBe(0);
    expect(snapFrame(-9, 15)).toBe(0);
    expect(snapFrame(13, 0)).toBe(13); // snapping disabled → integer
  });
});

describe("timeline interaction — hit testing", () => {
  test("body hit on the clip; miss outside", () => {
    const s = addClip(seq(), "a", 30, 90);
    const hit = clipAtPoint(s, "v1", 60, 1, FPS);
    expect(hit?.clip.id).toBe("a");
    expect(hit?.zone).toBe("body");
    expect(clipAtPoint(s, "v1", 10, 1, FPS)).toBeNull();
    expect(clipAtPoint(s, "a1", 60, 1, FPS)).toBeNull(); // other track
  });

  test("edges resolve to trim zones at typical zoom", () => {
    const s = addClip(seq(), "a", 30, 90);
    const inHit = clipAtPoint(s, "v1", 31, 2, FPS);
    expect(inHit?.zone).toBe("trim-in");
    const outHit = clipAtPoint(s, "v1", 118, 2, FPS);
    expect(outHit?.zone).toBe("trim-out");
  });

  test("overlap: later-starting clip wins the hit", () => {
    let s = addClip(seq(), "a", 0, 120);
    s = applyCommand(s, {
      type: "AddClip",
      clip: {
        id: "b",
        trackId: "v1",
        sourceAssetId: "asset-1",
        sourceInFrame: 0,
        sourceOutFrame: 60,
        sourceFps: FPS,
        timelineStartFrame: 60,
      },
    }).sequence;
    expect(clipAtPoint(s, "v1", 90, 1, FPS)?.clip.id).toBe("b");
    expect(clipAtPoint(s, "v1", 30, 1, FPS)?.clip.id).toBe("a");
  });
});

describe("timeline interaction — move preview", () => {
  test("target snaps and clamps", () => {
    const s = addClip(seq(), "a", 30);
    const clip = s.clips[0];
    expect(movePreview(clip, 133, 15).newTimelineStartFrame).toBe(135);
    expect(movePreview(clip, -40, 15).newTimelineStartFrame).toBe(0);
    expect(movePreview(clip, 0, 0).newTimelineStartFrame).toBe(0);
  });
});

describe("timeline interaction — trim preview matches the engine exactly", () => {
  test("trim-in at frame 60 shifts start and source together", () => {
    const s = addClip(seq(), "a", 30, 90); // source [0,90) → timeline [30,120)
    const clip = s.clips[0];
    const preview = trimPreview(s, clip, "trim-in", 60, FPS, 1);
    expect(preview.newTimelineStartFrame).toBe(60);
    expect(preview.newSourceInFrame).toBe(30);
    // Commit through the real engine: duration recomputes to the preview's
    // implied geometry (clip now covers [60,120) with source [30,90)).
    const after = applyCommand(s, trimPreviewToCommand(s, preview)).sequence;
    const trimmed = after.clips[0];
    expect(trimmed.timelineStartFrame).toBe(60);
    expect(trimmed.timelineDurationFrames).toBe(60);
    expect(trimmed.sourceInFrame).toBe(30);
  });

  test("trim-out at frame 90 shortens the clip; engine recomputes identically", () => {
    const s = addClip(seq(), "a", 0, 90);
    const clip = s.clips[0];
    const preview = trimPreview(s, clip, "trim-out", 90, FPS, 1);
    expect(preview.newSourceOutFrame).toBe(90);
    const after = applyCommand(s, trimPreviewToCommand(s, preview)).sequence;
    expect(after.clips[0].timelineDurationFrames).toBe(90);
    expect(after.clips[0].sourceOutFrame).toBe(90);
  });

  test("trim-in can never consume the whole clip (min 1 frame survives)", () => {
    const s = addClip(seq(), "a", 0, 90);
    const clip = s.clips[0];
    const preview = trimPreview(s, clip, "trim-in", 89, FPS, 1);
    const after = applyCommand(s, trimPreviewToCommand(s, preview)).sequence;
    expect(after.clips[0].timelineDurationFrames).toBe(1);
    const refused = trimPreview(s, clip, "trim-in", 500, FPS, 1);
    expect(refused.newTimelineStartFrame).toBe(89); // clamped to end-1
  });

  test("trim-out refuses to invert the clip", () => {
    const s = addClip(seq(), "a", 0, 90);
    const clip = s.clips[0];
    const preview = trimPreview(s, clip, "trim-out", 0, FPS, 1);
    expect(preview.newSourceOutFrame).toBe(1); // min end = start + 1
  });

  test("25fps source trims map through the timebases exactly", () => {
    let s = seq();
    s = applyCommand(s, {
      type: "AddClip",
      clip: {
        id: "p",
        trackId: "v1",
        sourceAssetId: "asset-1",
        sourceInFrame: 0,
        sourceOutFrame: 100,
        sourceFps: { num: 25, den: 1 },
        timelineStartFrame: 0,
      },
    }).sequence;
    const clip = s.clips[0];
    const preview = trimPreview(s, clip, "trim-in", 30, FPS, 1); // 1 s of timeline
    const after = applyCommand(s, trimPreviewToCommand(s, preview)).sequence;
    expect(after.clips[0].sourceInFrame).toBe(25);
    expect(after.clips[0].timelineStartFrame).toBe(30);
    expect(() => applyCommand(s, trimPreviewToCommand(s, preview))).not.toThrow();
  });
});

describe("timeline interaction — geometry + ruler", () => {
  test("clipRect width follows the duration at the zoom", () => {
    const s = addClip(seq(), "a", 0, 90);
    const r = clipRect(s.clips[0], 2, FPS, 0);
    expect(r.left).toBeGreaterThan(0);
    expect(r.width).toBeCloseTo(90 * (120 * (1 / 30)), 0); // 60 px/s × 3 s = 180
  });

  test("rulerScale picks a 1/2/5-family major step", () => {
    // 3000/8 = 375 → family value 500 (5 × 10²)
    expect(rulerScale(3000).majorFrames).toBe(500);
    expect(rulerScale(300).majorFrames % 1).toBe(0);
    const big = rulerScale(1_000_000);
    expect(big.majorFrames).toBeGreaterThan(1000);
  });

  test("projectedDurationFrames reflects the engine's recompute", () => {
    const s = addClip(seq(), "a", 0, 90);
    expect(projectedDurationFrames(0, 45, s.clips[0], FPS)).toBe(45);
    expect(projectedDurationFrames(30, 90, s.clips[0], FPS)).toBe(60);
  });
});
