/**
 * M43-A Unit 1 — RIISHE real scene-change detection ("RIISHE sees the
 * timeline"). Tests: showinfo parser (pure), REAL ffmpeg scene detection on
 * a generated hard-cut fixture, and executor integration of the planner's
 * source→timeline marker math through applyCommand.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { detectSceneChanges, parseSceneShowinfoLog } from "../src/lib/my-ai/tools/video-analysis";
import { MEDIA_ROOT } from "../src/lib/media-storage";
import { applyCommand } from "../src/lib/editor/commands";
import { SequenceSchema, clipTimelineDuration, type Sequence } from "../src/lib/editor/model";

describe("M43-A scene showinfo parser", () => {
  test("parses ordered unique pts_time values from showinfo lines", () => {
    const log = [
      "[Parsed_showinfo_1 @ 0x5f] n:   0 pts:     60 pts_time:2.04",
      "[Parsed_showinfo_1 @ 0x5f] n:   1 pts:    120 pts_time:4",
      "[Parsed_showinfo_1 @ 0x5f] n:   2 pts:    180 pts_time:6.000",
      "frame= 180 fps=0.0 q=-1.0 Lsize=N/A time=00:00:06.00",
    ].join("\n");
    const cuts = parseSceneShowinfoLog(log);
    expect(cuts).toEqual([2.04, 4, 6.000]);
  });

  test("ignores non-showinfo lines, duplicates and negative times", () => {
    const log = [
      "[Parsed_showinfo_1 @ 0x5f] n:   0 pts:     60 pts_time:2.04",
      "ffmpeg version 7.1.5 ...",
      "[Parsed_showinfo_1 @ 0x5f] n:   1 pts:     60 pts_time:2.04",
      "[Parsed_showinfo_1 @ 0x5f] n:   2 pts_time:-0.5",
      "no timestamps here",
    ].join("\n");
    expect(parseSceneShowinfoLog(log)).toEqual([2.04]);
  });
});

describe("M43-A REAL ffmpeg scene detection", () => {
  const fixtureDir = path.join(MEDIA_ROOT, ".m43a-test-fixtures");
  const fixture = path.join(fixtureDir, "three-cuts.mp4");

  test("detects the real hard cuts in a generated 3-color clip", async () => {
    fs.mkdirSync(fixtureDir, { recursive: true });
    // red 2s → blue 2s → green 2s → yellow 2s: three real hard cuts at 2/4/6s.
    const gen = spawnSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=red:s=320x180:d=2:r=30",
      "-f", "lavfi", "-i", "color=c=blue:s=320x180:d=2:r=30",
      "-f", "lavfi", "-i", "color=c=green:s=320x180:d=2:r=30",
      "-f", "lavfi", "-i", "color=c=yellow:s=320x180:d=2:r=30",
      "-filter_complex", "[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[vout]",
      "-map", "[vout]", "-c:v", "libx264", "-preset", "ultrafast", fixture]);
    expect(gen.status).toBe(0);
    expect(fs.statSync(fixture).size).toBeGreaterThan(1000);

    const analysis = await detectSceneChanges(fixture, { threshold: 0.3, timeoutMs: 60_000 });
    expect(analysis).not.toBeNull();
    expect(analysis!.toolBanner).toMatch(/ffmpeg version/);
    expect(analysis!.durationSec).not.toBeNull();
    expect(analysis!.durationSec!).toBeGreaterThan(7.5);
    // The real cuts must be found near 2s, 4s, 6s (±0.3s tolerance).
    expect(analysis!.cutSecs.length).toBeGreaterThanOrEqual(3);
    expect(Math.abs(analysis!.cutSecs[0] - 2)).toBeLessThan(0.3);
    const near4 = analysis!.cutSecs.find((t) => Math.abs(t - 4) < 0.3);
    expect(near4).toBeDefined();
    const near6 = analysis!.cutSecs.find((t) => Math.abs(t - 6) < 0.3);
    expect(near6).toBeDefined();
  }, 90_000);
});

describe("M43-A executor integration (marker math ↔ executor math)", () => {
  function buildSeq(): Sequence {
    return SequenceSchema.parse({
      id: "seq-m43a", name: "Unit 1 fixture", fps: { num: 30, den: 1 },
      width: 320, height: 180, sampleRate: 48000,
      tracks: [{ id: "t1", kind: "VIDEO", name: "V1" }],
      clips: [{
        id: "clip-c", trackId: "t1", sourceAssetId: "asset-1",
        sourceInFrame: 0, sourceOutFrame: 240, sourceFps: { num: 30, den: 1 },
        timelineStartFrame: 0, timelineDurationFrames: 240, playbackSpeed: 1,
      }],
      transitions: [], markers: [],
    });
  }

  test("scene cut at 4s → marker at timeline frame 120; AddMarker applies exactly", () => {
    // Planner math: cut 4s @ clip source fps 30 → sFrame 120; tl = 0 +
    // clipTimelineDuration(120, 0, 30/1, 30/1, 1) = 120. Executor applies it.
    const tl = 0 + clipTimelineDuration(120, 0, { num: 30, den: 1 }, { num: 30, den: 1 }, 1);
    expect(tl).toBe(120);
    const res = applyCommand(buildSeq(), { type: "AddMarker", marker: { id: "myai_marker_t1", frame: tl, label: "Scene change @ 4.00s" } });
    expect(res.sequence.markers.length).toBe(1);
    expect(res.sequence.markers[0].frame).toBe(120);
    expect(res.sequence.markers[0].label).toBe("Scene change @ 4.00s");
  });

  test("uneven timebases: 24fps source in 30fps seq maps 4s cut to frame 120", () => {
    // Source [0,192) @24fps = 8s → timeline 240 @30fps. Cut at 4s → sFrame 96;
    // tl = 0 + round(96 * 30 * 1 / (1 * 24)) = 120. Exact integer.
    const tl = 0 + clipTimelineDuration(96, 0, { num: 24, den: 1 }, { num: 30, den: 1 }, 1);
    expect(tl).toBe(120);
    const res = applyCommand(buildSeq(), { type: "AddMarker", marker: { id: "myai_marker_t2", frame: tl, label: "Scene change @ 4.00s" } });
    expect(res.sequence.markers[0].frame).toBe(120);
  });
});
