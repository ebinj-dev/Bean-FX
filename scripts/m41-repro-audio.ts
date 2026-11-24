/**
 * M41 Phase E — reproduce the failing mp4 render filter graph locally.
 * Loads the E2E sequence JSON, builds the REAL graph via buildTimelineGraph,
 * runs the REAL ffmpeg command, prints the tail of stderr on failure.
 * Usage: bun scripts/m41-repro-audio.ts <timeline.json> <assetA.(mp4)> <assetB.(mp4)>
 */
import { buildTimelineGraph } from "../src/lib/publish/timeline-render";
import { spawnSync } from "node:child_process";

const [tlPath, aPath, bPath] = process.argv.slice(2);
const tl = JSON.parse(require("node:fs").readFileSync(tlPath, "utf8"));
const seq = tl.sequence ?? tl;

// Asset inputs in the order the worker assigns: unique sourceAssetIds across
// visual + audio plans (worker: sorted insertion order over the plans).
const assetIds = [...new Set(seq.clips.map((c: { sourceAssetId: string }) => c.sourceAssetId))];
const paths = new Map([
  [assetIds[0], aPath],
  [assetIds[1] ?? assetIds[0], bPath],
]);
const inputs = new Map();
assetIds.forEach((id, i) => inputs.set(id, { index: i, isImage: false, hasAudio: true }));

// Optional bisection: mutate the SEQUENCE before building (M41 debugging)
const variant = process.env.M41_VARIANT ?? "full";
if (variant === "no-transition") seq.transitions = [];
if (variant === "no-overlap") {
  for (const c of seq.clips) if (c.id === "cB" || c.id === "aB") c.timelineStartFrame = 240;
}
if (variant === "audio-only-dup") {
  // video clips muted: audio graph unchanged, video trivial — isolates AAC
  for (const c of seq.clips) if (c.trackId.endsWith("-v1")) c.muted = true;
}
if (variant === "no-dup-audio") {
  // remove the DEDICATED audio clips (keep only video clips' own audio)
  seq.clips = seq.clips.filter((c: { id: string }) => c.id !== "aA" && c.id !== "aB");
}

const graph = buildTimelineGraph(seq, 0, 345, inputs);
console.log(`variant=${variant} audioPlans:`, graph.audioPlanCount, "videoPlans:", graph.videoPlanCount);

const args: string[] = ["-y", "-v", "error", "-strict", "-2"];
for (const id of assetIds) args.push("-i", paths.get(id)!);
args.push("-filter_complex", graph.filterComplex);
args.push("-map", graph.videoLabel, "-map", "[mixout]");
args.push("-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-b:a", "192k", "-t", "11.5", "/tmp/m41-repro.mp4");

const r = spawnSync("ffmpeg", args, { encoding: "utf8" });
if (r.status === 0) {
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", "/tmp/m41-repro.mp4"], { encoding: "utf8" });
  console.log("RENDER OK — duration:", probe.stdout.trim());
} else {
  console.log("RENDER FAILED status", r.status);
  const lines = (r.stderr ?? "").split("\n").filter(Boolean);
  console.log(lines.slice(-18).join("\n"));
}
