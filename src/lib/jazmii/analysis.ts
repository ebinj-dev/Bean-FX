/**
 * JAZMII — deterministic video analysis (M7 §6C).
 *
 * Everything here is FFprobe/FFmpeg + PIL — measured facts, labeled as
 * HEURISTIC where the filter is heuristic (scene scores). No AI claims.
 *
 * - Metadata: existing media-storage ffprobe (real).
 * - Scene boundaries: ffmpeg scene-score threshold on a downscaled luma
 *   stream (`select='gt(scene,T)'` + showinfo) — a classic heuristic.
 * - Black segments: ffmpeg blackdetect; freeze segments: freezedetect.
 * - Keyframes: evenly spaced thumbnail extraction (not "AI keyframes").
 * - Scene similarity: 64-bit average-hash (aHash) per scene via PIL —
 *   deterministic perceptual hashing; a real numeric similarity basis,
 *   honestly named (not "AI understanding").
 */
import { execFile } from "child_process";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { ffprobe } from "@/lib/media-storage";
import type { JazmiiAnalysisReport, JazmiiScene } from "./types";

export const SCENE_THRESHOLD = Number(process.env.BEANFX_JAZMII_SCENE_THRESHOLD ?? 0.3);
const MAX_SCENES = 60;
const MAX_KEYFRAMES = 8;

function run(args: string[], timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(`ffmpeg failed: ${String(stderr).slice(0, 300)}`));
      resolve(`${stdout}\n${stderr}`);
    });
  });
}

export function gcdAspect(w: number, h: number): string {
  const g = (a: number, b: number): number => (b === 0 ? a : g(b, a % b));
  const d = g(w, h);
  const rw = w / d;
  const rh = h / d;
  if (rw > 32 || rh > 32) return (w / h).toFixed(3);
  return `${rw}:${rh}`;
}

/** Parse showinfo output lines for scene-change pts_time + scores. */
function parseShowinfo(output: string): JazmiiScene[] {
  const scenes: JazmiiScene[] = [];
  const re = /pts_time:([\d.]+)/g;
  let m: RegExpExecArray | null;
  let index = 0;
  while ((m = re.exec(output)) !== null && index < MAX_SCENES) {
    const t = Number(m[1]);
    if (Number.isFinite(t)) {
      scenes.push({ index: index++, startSec: t, endSec: t, score: 0 });
    }
  }
  return scenes;
}

export interface AnalyzeOpts {
  /** Emit thumbnails + run heavy filters (default true for jobs). */
  withArtifacts?: boolean;
  artifactDir?: string;
}

/** Full deterministic analysis of a video file. Throws on unreadable input. */
export async function analyzeVideoFile(filePath: string, mediaId: string, opts: AnalyzeOpts = {}): Promise<JazmiiAnalysisReport> {
  const probe = await ffprobe(filePath);
  if (!probe.durationSec || !probe.width || !probe.height) {
    throw new Error(`Cannot analyze ${path.basename(filePath)}: ffprobe could not establish duration/resolution`);
  }
  const fps = probe.fps && Number.isFinite(probe.fps) ? probe.fps : 30;
  const dur = probe.durationSec;

  // Scene boundaries (heuristic): threshold on scene score, downscaled.
  const sceneOut = await run([
    "-hide_banner", "-nostats",
    "-i", filePath,
    "-vf", `scale=160:-2,select='gt(scene\\,${SCENE_THRESHOLD})',showinfo`,
    "-an", "-f", "null", "-",
  ]);
  const cuts = parseShowinfo(sceneOut);
  const scenes: JazmiiScene[] = cuts.length > 0
    ? cuts.map((c, i) => ({
        index: i,
        startSec: c.startSec,
        endSec: i + 1 < cuts.length ? cuts[i + 1].startSec : dur,
        score: 0,
      }))
    : [{ index: 0, startSec: 0, endSec: dur, score: 0 }];

  // Black + freeze detection (real ffmpeg filters, bounded to ≤ 10 min input).
  const detectArgs = ["-hide_banner", "-nostats", "-t", String(Math.min(dur, 600))];
  const blackOut = await run([...detectArgs, "-i", filePath, "-vf", "blackdetect=d=0.5:pix_th=0.10", "-an", "-f", "null", "-"]);
  const freezeOut = await run([...detectArgs, "-i", filePath, "-vf", "freezedetect=n=-60dB:d=2", "-an", "-f", "null", "-"]);
  const parseRanges = (out: string, videoDur: number): { startSec: number; endSec: number }[] => {
    const ranges: { startSec: number; endSec: number }[] = [];
    // Tolerates both "black_start:2 black_end:3.2" and the freezedetect form
    // "lavfi.freezedetect.freeze_start: 0" (space after the colon, filter
    // prefix), and an EOF-open freeze (no *_end printed → runs to the video end).
    const re = /(black|freeze)_start:\s*([\d.]+)/g;
    const endRe = new RegExp(String.raw`(black|freeze)_end:\s*([\d.]+)`, "g");
    const ends: number[] = [];
    let em: RegExpExecArray | null;
    while ((em = endRe.exec(out)) !== null) ends.push(Number(em[2]));
    let ei = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(out)) !== null) {
      const s = Number(m[2]);
      const e = ei < ends.length ? ends[ei++] : videoDur;
      if (e > s) ranges.push({ startSec: s, endSec: Math.min(e, videoDur) });
    }
    return ranges;
  };

  // Keyframes + scene hashes.
  const keyframeFiles: { file: string; sec: number }[] = [];
  const sceneHashes: string[] = [];
  if (opts.withArtifacts !== false && opts.artifactDir) {
    await mkdir(opts.artifactDir, { recursive: true });
    const count = Math.min(MAX_KEYFRAMES, Math.max(1, Math.floor(dur / 2)));
    for (let i = 0; i < count; i++) {
      const sec = Math.min(dur - 0.2, ((i + 0.5) / count) * dur);
      const file = path.join(opts.artifactDir, `key_${mediaId}_${i}.jpg`);
      await run(["-hide_banner", "-loglevel", "error", "-y", "-ss", String(sec), "-i", filePath, "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "4", file]);
      keyframeFiles.push({ file, sec: Number(sec.toFixed(2)) });
    }
    // aHash per scene (≤ 24 scenes hashed): PIL 8×8 luma average hash.
    const hashSrc = keyframeFiles.slice(0, 1).map((k) => k.file);
    void hashSrc;
    for (const scene of scenes.slice(0, 24)) {
      const mid = Math.min(dur - 0.2, (scene.startSec + scene.endSec) / 2);
      const tmp = path.join(opts.artifactDir, `hash_${mediaId}_${scene.index}.jpg`);
      await run(["-hide_banner", "-loglevel", "error", "-y", "-ss", String(mid), "-i", filePath, "-frames:v", "1", "-vf", "scale=160:-2", tmp]);
      sceneHashes.push(await ahashFile(tmp));
    }
  }

  return {
    mediaId,
    durationSec: dur,
    fps,
    width: probe.width,
    height: probe.height,
    aspectRatio: gcdAspect(probe.width, probe.height),
    videoCodec: probe.videoCodec ?? null,
    audioCodec: probe.audioCodec ?? null,
    hasAudio: Boolean(probe.audioCodec),
    scenes,
    analysisMethod: "ffmpeg-heuristic",
    blackSegments: parseRanges(blackOut, dur),
    freezeSegments: parseRanges(freezeOut, dur),
    keyframeFiles,
    sceneHashes,
  };
}

/** 64-bit average hash (aHash) of an image file — deterministic. */
export async function ahashFile(file: string): Promise<string> {
  const out = await new Promise<string>((resolve, reject) => {
    execFile(
      "python3",
      ["-c", "import sys;from PIL import Image;im=Image.open(sys.argv[1]).convert('L').resize((8,8));px=list(im.getdata());avg=sum(px)/len(px);print(''.join('1' if p>avg else '0' for p in px))", file],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
    );
  });
  // hex-encode the 64 bits
  return BigInt(`0b${out}`).toString(16).padStart(16, "0");
}

/** Hamming distance between two aHash hex strings (0..64). */
export function ahashDistance(a: string, b: string): number {
  const x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  return x.toString(2).split("").filter((c) => c === "1").length;
}

/** Save a JSON artifact (analysis report) next to the media file. */
export async function writeAnalysisArtifact(dir: string, mediaId: string, report: JazmiiAnalysisReport): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `analysis_${mediaId}.json`);
  await writeFile(file, JSON.stringify(report, null, 2), "utf8");
  return file;
}
