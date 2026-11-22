/**
 * BEAN FX — M37 golden-graph verification (run with: bun scripts/verify-m37-graph.ts).
 *
 * Builds REAL timeline graphs through buildTimelineGraph for transform
 * fixtures, then executes them with the deployment's actual ffmpeg against
 * generated test sources — proving the emitted filter strings are executable
 * end to end (bun unit tests alone only assert substrings).
 *
 * Fixtures:
 *   A — single clip, static transform (position + scale + rotation + opacity)
 *   B — transition run where BOTH clips are transformed (animated scale,
 *       animated position, animated opacity) through the per-clip canvas path
 *   C — animated rotation only (exact per-frame rotate expression path)
 *
 * Every graph must encode successfully and probe back with the sequence
 * dimensions and window duration. Exits non-zero on any failure.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { model } from "./m17-imports";
import { buildTimelineGraph } from "../src/lib/publish/timeline-render";
import type { Clip, Sequence } from "../src/lib/editor/model";

const fps = { num: 30, den: 1 };
let failures = 0;

const kf = (property: string, frame: number, value: number) => ({
  id: `k_${property}_${frame}`, property, frame, value, interpolation: "LINEAR", bezier: null,
});

function clip(overrides: Record<string, unknown>): Clip {
  return model.ClipSchema.parse({
    id: "c", trackId: "V1", sourceAssetId: "a1", sourceInFrame: 0, sourceOutFrame: 60, sourceFps: fps,
    timelineStartFrame: 0, timelineDurationFrames: 60, playbackSpeed: 1, volume: 1, muted: false,
    fadeInFrames: 0, fadeOutFrames: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null, label: null,
    missingMedia: false, pan: 0, groupId: null, effects: [], keyframes: [],
    ...overrides,
  });
}

function seq(clips: Clip[], transitions: unknown[] = []): Sequence {
  return model.SequenceSchema.parse({
    id: "seq", name: "M37 golden", fps, width: 640, height: 360, sampleRate: 48000,
    tracks: [{ id: "V1", kind: "VIDEO", name: "V1", visible: true, muted: false, solo: false, locked: false, volume: 1 }],
    clips, transitions, markers: [],
  });
}

function run(label: string, sequence: Sequence, inputs: string[]): void {
  const assetInputs = new Map(inputs.map((_, i) => [`a${i + 1}`, { index: i, isImage: false, hasAudio: false }]));
  const graph = buildTimelineGraph(sequence, 0, 120, assetInputs, { applied: [], skipped: [] });
  const dir = mkdtempSync(path.join(os.tmpdir(), "m37-golden-"));
  try {
    const graphPath = path.join(dir, "graph.txt");
    const outPath = path.join(dir, "out.mp4");
    writeFileSync(graphPath, graph.filterComplex);
    const args = ["-y", "-loglevel", "error"];
    for (const input of inputs) args.push("-i", input);
    args.push("-/filter_complex", graphPath, "-map", "[mixout]");
    if (!graph.filterComplex.includes("anullsink")) {
      // audio-only graphs map just [mixout]; video graphs map the composite too
      args.unshift("-map_stub"); // placeholder removed below
      args.splice(args.indexOf("-map_stub"), 1);
      args.push("-map", graph.videoLabel);
    }
    args.push("-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-c:a", "aac", "-t", "4", outPath);
    const proc = spawnSync("ffmpeg", args, { timeout: 120_000, encoding: "utf8" });
    if (proc.status !== 0) {
      failures += 1;
      console.error(`FAIL ${label}: ffmpeg exited ${proc.status}\n${(proc.stderr ?? "").slice(-1200)}`);
      return;
    }
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", outPath]).toString());
    const video = probe.streams.find((s: { codec_type: string }) => s.codec_type === "video");
    const dur = Number(probe.format.duration);
    const dimsOk = video && Number(video.width) === sequence.width && Number(video.height) === sequence.height;
    const durOk = Math.abs(dur - 4) < 0.6;
    if (dimsOk && durOk) {
      console.log(`PASS ${label} (${video.width}x${video.height}, ${dur.toFixed(2)}s, graph ${graph.filterComplex.length} chars)`);
    } else {
      failures += 1;
      console.error(`FAIL ${label}: probe mismatch — ${video?.width}x${video?.height}, ${dur}s (wanted ${sequence.width}x${sequence.height}, ~4s)`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const work = mkdtempSync(path.join(os.tmpdir(), "m37-src-"));
try {
  const srcA = path.join(work, "a.mp4");
  const srcB = path.join(work, "b.mp4");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=4", "-pix_fmt", "yuv420p", srcA]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "smptebars=s=640x360:r=30:d=4", "-pix_fmt", "yuv420p", srcB]);

  // A — static transform on one clip.
  run(
    "A static transform",
    seq([clip({ transform: { x: 80, y: 40, scale: 0.6, rotation: 15, opacity: 0.8 } })]),
    [srcA],
  );

  // B — transformed clips joined by a transition (per-clip canvas path).
  const a = clip({ id: "ca", timelineStartFrame: 0, timelineDurationFrames: 60, sourceAssetId: "a1", transform: { x: 60, y: -30, scale: 0.7, rotation: 0, opacity: 0.9 } });
  const b = clip({ id: "cb", timelineStartFrame: 60, timelineDurationFrames: 60, sourceAssetId: "a2", transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, keyframes: [kf("scale", 0, 1), kf("scale", 60, 1.6), kf("x", 0, -120), kf("x", 60, 40), kf("opacity", 0, 0.3), kf("opacity", 60, 1)] });
  const transition = { id: "t1", trackId: "V1", kind: "CROSS_DISSOLVE", startFrame: 60, endFrame: 75, durationFrames: 15, clipAId: "ca", clipBId: "cb", params: {} };
  run("B transition run (animated transform)", seq([a, b], [transition]), [srcA, srcB]);

  // C — animated rotation only (exact expression path).
  const c = clip({ keyframes: [kf("rotation", 0, 0), kf("rotation", 60, 45)] });
  run("C animated rotation (exact)", seq([c]), [srcA]);
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} golden-graph failure(s)`);
  process.exit(1);
}
console.log("\nAll golden graphs executed and validated.");
