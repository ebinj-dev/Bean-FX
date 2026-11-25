/**
 * M42-I Unit 1 — RIISHE real silence analysis ("RIISHE hears the timeline").
 * Tests: log parser (pure), REAL ffmpeg silencedetect on a generated fixture,
 * head/tail trim mapping guarantees (bounds, ≥1 frame, interior kept).
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { detectSilenceRanges, headTailTrim, parseSilencedetectLog, secToSourceFrames } from "../src/lib/my-ai/tools/audio-analysis";
import { isInsideMediaRoot, MEDIA_ROOT } from "../src/lib/media-storage";

describe("M42-I silence log parser", () => {
  test("parses standard silencedetect stderr pairs", () => {
    const log = [
      "[silencedetect @ 0x55f0] silence_start: 2.103424",
      "[silencedetect @ 0x55f0] silence_end: 4.006016 | silence_duration: 1.902592",
      "[silencedetect @ 0x55f0] silence_start: 5.5",
      "[silencedetect @ 0x55f0] silence_end: 6.0 | silence_duration: 0.5",
    ].join("\n");
    const ranges = parseSilencedetectLog(log);
    expect(ranges.length).toBe(2);
    expect(ranges[0].startSec).toBeCloseTo(2.103424, 4);
    expect(ranges[0].endSec).toBeCloseTo(4.006016, 4);
    expect(ranges[0].durationSec).toBeCloseTo(1.902592, 4);
    expect(ranges[1].startSec).toBe(5.5);
  });

  test("trailing silence (start without end) is kept open-ended", () => {
    const ranges = parseSilencedetectLog("[x] silence_start: 4.5\n");
    expect(ranges.length).toBe(1);
    expect(ranges[0].endSec).toBe(Number.POSITIVE_INFINITY);
  });

  test("negative early start is clamped to 0", () => {
    const ranges = parseSilencedetectLog("[x] silence_start: -0.02\n[x] silence_end: 0.4 | silence_duration: 0.42\n");
    expect(ranges[0].startSec).toBe(0);
  });
});

describe("M42-I REAL ffmpeg silencedetect", () => {
  const fixtureDir = path.join(MEDIA_ROOT, ".m42i-test-fixtures");
  const fixture = path.join(fixtureDir, "tone-silence-tone.mp4");

  test("detects the real silence in a generated tone-silence-tone clip", async () => {
    fs.mkdirSync(fixtureDir, { recursive: true });
    // 2s 440Hz tone, 2s silence, 2s tone — 6s total, 30fps, with audio.
    const gen = spawnSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo:d=2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-filter_complex", "[0:a][1:a][2:a]concat=n=3:v=0:a=1[aout];color=c=black:s=320x180:d=6:r=30[vout]",
      "-map", "[vout]", "-map", "[aout]", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", fixture]);
    expect(gen.status).toBe(0);
    expect(fs.statSync(fixture).size).toBeGreaterThan(1000);
    // The tool accepts BOTH spellings: relative-to-root (as stored) and absolute.
    expect(isInsideMediaRoot(fixture)).toBe(true);
    const analysis = await detectSilenceRanges(fixture, { noiseDb: -40, minSilenceSec: 0.4, timeoutMs: 30_000 });
    expect(analysis).not.toBeNull();
    const analysisRelative = await detectSilenceRanges(".m42i-test-fixtures/tone-silence-tone.mp4", { noiseDb: -40, minSilenceSec: 0.4, timeoutMs: 30_000 });
    expect(analysis).not.toBeNull();
    expect(analysis!.toolBanner).toMatch(/ffmpeg version/);
    expect(analysis!.durationSec).not.toBeNull();
    expect(analysis!.durationSec!).toBeGreaterThan(5.5);
    // The real run must find silence ≈ [2s, 4s].
    const mid = analysis!.ranges.find((r) => r.startSec > 1.5 && r.startSec < 2.6);
    expect(mid).toBeDefined();
    expect(mid!.endSec).toBeGreaterThan(3.4);
    expect(mid!.endSec).toBeLessThan(4.6);
    expect(analysisRelative).not.toBeNull();
    expect(analysisRelative!.ranges.length).toBe(analysis!.ranges.length);
  }, 60_000);
});

describe("M42-I head/tail trim mapping", () => {
  const fps = 30;

  test("trims head+tail silence inside the REAL source window, keeps interior", () => {
    // Clip source window 150..300 (5s..10s on the asset at 30fps).
    const win = { sourceInFrame: 150, sourceOutFrame: 300 };
    const ranges = [
      { startSec: 0, endSec: 5.4, durationSec: 5.4 },          // touches head (ends inside window)
      { startSec: 6.5, endSec: 8.2, durationSec: 1.7 },        // interior
      { startSec: 9.6, endSec: 12, durationSec: 2.4 },         // touches tail (open-ended style)
    ];
    const trim = headTailTrim(win, ranges, fps);
    expect(trim.changed).toBe(true);
    expect(trim.newSourceInFrame).toBeGreaterThan(150);
    expect(trim.newSourceInFrame).toBeLessThanOrEqual(162);   // 5.4s ≈ frame 162
    expect(trim.newSourceOutFrame).toBeLessThan(300);
    expect(trim.newSourceOutFrame).toBeGreaterThanOrEqual(288); // 9.6s ≈ frame 288
    expect(trim.newSourceOutFrame - trim.newSourceInFrame).toBeGreaterThanOrEqual(1);
    // M42-I Unit 2: interior disclosure moved to plan level — headTailTrim
    // notes cover only the head/tail trims.
    expect(trim.notes.every((n) => !n.includes("interior silence"))).toBe(true);
  });

  test("never collapses below one frame and never leaves the real bounds", () => {
    const win = { sourceInFrame: 0, sourceOutFrame: 2 }; // tiny 2-frame clip
    const ranges = [{ startSec: 0, endSec: 5, durationSec: 5 }]; // silence covers everything
    const trim = headTailTrim(win, ranges, fps);
    expect(trim.newSourceOutFrame - trim.newSourceInFrame).toBeGreaterThanOrEqual(1);
    expect(trim.newSourceInFrame).toBeGreaterThanOrEqual(0);
    expect(trim.newSourceOutFrame).toBeLessThanOrEqual(2);
  });

  test("no silence → unchanged, changed=false", () => {
    const trim = headTailTrim({ sourceInFrame: 0, sourceOutFrame: 90 }, [{ startSec: 100, endSec: 110, durationSec: 10 }], fps);
    expect(trim.changed).toBe(false);
    expect(trim.newSourceInFrame).toBe(0);
    expect(trim.newSourceOutFrame).toBe(90);
  });

  test("secToSourceFrames is integer and clamped ≥ 0", () => {
    expect(secToSourceFrames(2.5, 30)).toBe(75);
    expect(secToSourceFrames(-1, 30)).toBe(0);
  });
});

// ── M42-I Unit 2: interior silence → SplitClip + RippleDelete ──────────────
import { interiorSplitPlan } from "../src/lib/my-ai/tools/audio-analysis";
import { applyCommand } from "../src/lib/editor/commands";
import { SequenceSchema, type Sequence } from "../src/lib/editor/model";

describe("M42-I Unit 2 interiorSplitPlan", () => {
  const fps = 30;
  test("picks the LONGEST interior range and maps to clamped source frames", () => {
    // Window 150..300 (5s..10s at 30fps); interior candidates 6.5-8.2s (1.7s)
    // and 8.5-9.4s (0.9s) → longest is [6.5, 8.2] → frames [195, 246].
    const win = { sourceInFrame: 150, sourceOutFrame: 300 };
    const ranges = [
      { startSec: 0, endSec: 5.4, durationSec: 5.4 },   // head-touching
      { startSec: 6.5, endSec: 8.2, durationSec: 1.7 }, // interior A (longest)
      { startSec: 8.5, endSec: 9.4, durationSec: 0.9 }, // interior B
    ];
    const plan = interiorSplitPlan(win, ranges, fps);
    expect(plan).not.toBeNull();
    expect(plan!.sFrame).toBe(195);
    expect(plan!.eFrame).toBe(246);
    expect(plan!.range.durationSec).toBeCloseTo(1.7, 6);
  });

  test("sub-frame silence after clamping → null", () => {
    // Interior range that collapses: window 150..151 (1 frame).
    const plan = interiorSplitPlan({ sourceInFrame: 150, sourceOutFrame: 151 },
      [{ startSec: 5.3, endSec: 5.4, durationSec: 0.1 }], fps);
    expect(plan).toBeNull();
  });

  test("no interior range → null", () => {
    const plan = interiorSplitPlan({ sourceInFrame: 0, sourceOutFrame: 90 },
      [{ startSec: 0, endSec: 2.9, durationSec: 2.9 }], fps);
    expect(plan).toBeNull();
  });
});

describe("M42-I Unit 2 executor integration (planner math ↔ executor math)", () => {
  function buildSeq(): Sequence {
    const seq = {
      id: "seq-m42i2",
      name: "Unit 2 fixture",
      fps: { num: 30, den: 1 },
      width: 320,
      height: 180,
      sampleRate: 48000,
      tracks: [{ id: "t1", kind: "VIDEO", name: "V1" }],
      clips: [{
        id: "clip-c",
        trackId: "t1",
        sourceAssetId: "asset-1",
        sourceInFrame: 0,
        sourceOutFrame: 180, // 6s at 30fps
        sourceFps: { num: 30, den: 1 },
        timelineStartFrame: 0,
        timelineDurationFrames: 180,
        playbackSpeed: 1,
      }],
      transitions: [],
      markers: [],
    };
    return SequenceSchema.parse(seq);
  }

  test("SplitClip → SplitClip → RippleDelete removes the silent middle exactly", () => {
    // Planner math for interior silence [2s, 4s) on clip-c: sFrame=60,
    // eFrame=120; tlForS=60, tlForE=120 (30/30fps, speed 1).
    let seq = buildSeq();
    const cmds = [
      { type: "SplitClip", clipId: "clip-c", atTimelineFrame: 60, newLeftId: "l1", newRightId: "r1" },
      { type: "SplitClip", clipId: "r1", atTimelineFrame: 120, newLeftId: "mid", newRightId: "r2" },
      { type: "RippleDelete", clipId: "mid" },
    ];
    for (const c of cmds) {
      const res = applyCommand(seq, c);
      expect(res.ok !== false).toBe(true);
      seq = res.sequence;
    }
    expect(seq.clips.length).toBe(2);
    // SplitClip RENAMES the left piece to newLeftId ("l1") — clip-c is gone.
    const c = seq.clips.find((x) => x.id === "l1")!;
    const r2 = seq.clips.find((x) => x.id === "r2")!;
    // Left keeps [0,60) at timeline [0,60); silent middle gone; right [120,180)
    // rippled to timeline [60,120). Track closes up: total duration 120.
    expect(c.sourceInFrame).toBe(0);
    expect(c.sourceOutFrame).toBe(60);
    expect(c.timelineStartFrame).toBe(0);
    expect(c.timelineDurationFrames).toBe(60);
    expect(r2.sourceInFrame).toBe(120);
    expect(r2.sourceOutFrame).toBe(180);
    expect(r2.timelineStartFrame).toBe(60);
    expect(r2.timelineDurationFrames).toBe(60);
    expect(seq.clips.every((x) => x.timelineStartFrame + x.timelineDurationFrames <= 120)).toBe(true);
  });

  test("uneven timebases: 24fps source in a 30fps sequence splits exactly", () => {
    // Source [0,144) @24fps = 6s → timeline 180 @30fps. Interior [2s,4s) →
    // sFrame=48, eFrame=96 (24fps), tlForS=60, tlForE=120.
    const seqData = buildSeq();
    seqData.clips[0].sourceOutFrame = 144;
    seqData.clips[0].sourceFps = { num: 24, den: 1 };
    seqData.clips[0].timelineDurationFrames = 180;
    let seq = SequenceSchema.parse(seqData);
    const cmds = [
      { type: "SplitClip", clipId: "clip-c", atTimelineFrame: 60, newLeftId: "l1", newRightId: "r1" },
      { type: "SplitClip", clipId: "r1", atTimelineFrame: 120, newLeftId: "mid", newRightId: "r2" },
      { type: "RippleDelete", clipId: "mid" },
    ];
    for (const c of cmds) {
      const res = applyCommand(seq, c);
      expect(res.ok !== false).toBe(true);
      seq = res.sequence;
    }
    const c = seq.clips.find((x) => x.id === "l1")!;
    const r2 = seq.clips.find((x) => x.id === "r2")!;
    expect(c.sourceOutFrame).toBe(48);
    expect(c.timelineDurationFrames).toBe(60);
    expect(r2.sourceInFrame).toBe(96);
    expect(r2.timelineStartFrame).toBe(60);
    expect(r2.timelineDurationFrames).toBe(60);
  });
});
