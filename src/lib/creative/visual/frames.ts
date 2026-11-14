/**
 * M12 — Visual Intelligence frame extraction engine (§2).
 *
 * Extracts REAL decoded frames from the source video with:
 *  - configurable temporal sampling (uniform interval);
 *  - scene-based sampling (JAZMII deterministic cut midpoints);
 *  - frame deduplication via the existing 64-bit aHash;
 *  - resizing within provider limits (width-capped JPEG);
 *  - FULL provenance per frame: project version context, asset, timeline
 *    clip, SOURCE-media seconds and TIMELINE seconds (speed-aware mapping
 *    from M11), dimensions, extraction method.
 *
 * Frames live in a per-run temp directory under MEDIA_ROOT/tmp — the caller
 * is responsible for cleanup (cleanupVisualFrameDir). Analysis frames are
 * never registered as library assets; only chosen REPRESENTATIVE frames
 * become IMAGE assets (scenes.ts), so quota is not consumed by bulk frames.
 */
import { execFile } from "child_process";
import { mkdir, readdir, readFile, rm } from "fs/promises";
import path from "path";
import { MEDIA_ROOT, pathInsideMediaRoot } from "@/lib/media-storage";
import { ahashFile } from "@/lib/jazmii/analysis";
import { sourceToTimelineSec } from "../multimodal";
import { frameIdOf, type VisualFrame, type VisualSettings } from "./contracts";

export interface FrameSourceClip {
  clipId: string;
  sourceInFrame: number;
  sourceOutFrame: number;
  sourceFpsNum: number;
  sourceFpsDen: number;
  playbackSpeed: number;
  timelineStartFrame: number;
}

export interface FrameExtractionContext {
  seqFps: number;
  /** VIDEO-track clips carrying this asset (for timeline mapping). */
  clips: FrameSourceClip[];
}

export interface ExtractedFrameSet {
  frames: VisualFrame[];
  /** Absolute paths of extracted JPEGs keyed by frameId (temp — cleanup after use). */
  files: Map<string, string>;
  framesDeduped: number;
  framesSkippedBudget: number;
}

export function visualFrameDir(runKey: string): string {
  return pathInsideMediaRoot("tmp", "visual-frames", runKey);
}

export async function cleanupVisualFrameDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

function ffmpegRun(args: string[], timeoutMs = 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) return reject(new Error(`ffmpeg frame extraction failed: ${String(stderr).slice(0, 220)}`));
      resolve();
    });
  });
}

/** Map a source second into every timeline placement (may be several clips).
 *  Exported for the M13 temporal sampler (same speed-aware mapping). */
export function timelinePlacementsFor(sourceSec: number, ctx: FrameExtractionContext): { clipId: string; timelineSec: number }[] {
  const out: { clipId: string; timelineSec: number }[] = [];
  for (const c of ctx.clips) {
    const srcFps = c.sourceFpsNum / c.sourceFpsDen;
    const srcStart = c.sourceInFrame / srcFps;
    const srcEnd = c.sourceOutFrame / srcFps;
    if (sourceSec >= srcStart - 1e-6 && sourceSec <= srcEnd + 1e-6) {
      const t = sourceToTimelineSec(
        {
          sourceInFrame: c.sourceInFrame,
          sourceOutFrame: c.sourceOutFrame,
          sourceFps: { num: c.sourceFpsNum, den: c.sourceFpsDen },
          playbackSpeed: c.playbackSpeed,
          timelineStartFrame: c.timelineStartFrame,
        } as Parameters<typeof sourceToTimelineSec>[0],
        ctx.seqFps,
        sourceSec,
        sourceSec,
      );
      out.push({ clipId: c.clipId, timelineSec: Math.round(t.timelineStartSec * 100) / 100 });
    }
  }
  return out;
}

/**
 * Deterministic candidate sampling: scene midpoints first (when JAZMII cuts
 * are known), interleaved with uniform interval samples, deduped by proximity,
 * capped by budget with an even spread across the duration.
 */
export function sampleCandidates(durationSec: number, settings: VisualSettings, sceneCuts: number[]): { sec: number; method: VisualFrame["extractionMethod"] }[] {
  const candidates: { sec: number; method: VisualFrame["extractionMethod"] }[] = [];
  const push = (sec: number, method: VisualFrame["extractionMethod"]) => {
    if (!Number.isFinite(sec) || sec < 0 || sec > durationSec) return;
    candidates.push({ sec: Math.min(durationSec - 0.05, Math.round(sec * 100) / 100), method });
  };
  for (let i = 0; i < sceneCuts.length; i++) {
    const start = i === 0 ? 0 : sceneCuts[i - 1];
    const end = sceneCuts[i];
    if (end - start >= 0.4) push((start + end) / 2, "scene-midpoint");
  }
  for (let t = settings.sampleIntervalSec / 2; t < durationSec; t += settings.sampleIntervalSec) {
    push(t, "uniform-sample");
  }
  // Dedupe near-identical candidates (≤0.5 s apart), preferring scene midpoints.
  candidates.sort((a, b) => a.sec - b.sec || (a.method === "scene-midpoint" ? -1 : 1));
  const picked: { sec: number; method: VisualFrame["extractionMethod"] }[] = [];
  for (const c of candidates) {
    if (picked.some((p) => Math.abs(p.sec - c.sec) < 0.5)) continue;
    picked.push(c);
  }
  // Budget: keep an even spread across the duration.
  if (picked.length > settings.maxFramesPerAsset) {
    const kept: typeof picked = [];
    for (let i = 0; i < settings.maxFramesPerAsset; i++) {
      kept.push(picked[Math.floor(((i + 0.5) / settings.maxFramesPerAsset) * picked.length)]);
    }
    return kept;
  }
  return picked;
}

/**
 * Extract + dedupe frames for ONE source asset. Never throws for individual
 * frame failures (recorded honestly); throws only when the asset file itself
 * is unreadable (caller decides permanent vs retry).
 */
export async function extractFrames(asset: { id: string; storagePath: string; width: number | null; height: number | null; durationSec: number | null }, settings: VisualSettings, ctx: FrameExtractionContext, sceneCuts: number[], runKey: string): Promise<ExtractedFrameSet> {
  if (!asset.storagePath) throw new Error(`asset ${asset.id} has no storage path`);
  const dir = visualFrameDir(runKey);
  await mkdir(dir, { recursive: true });
  const duration = asset.durationSec ?? 0;
  if (duration <= 0) throw new Error(`asset ${asset.id} has no measurable duration`);

  const candidates = sampleCandidates(duration, settings, sceneCuts);
  const files = new Map<string, string>();
  const frames: VisualFrame[] = [];
  const keptHashes: { hash: string; frameId: string }[] = [];
  let deduped = 0;

  // Source width drives the scale filter (never upscale).
  const srcWidth = asset.width ?? settings.maxFrameWidth;
  const outWidth = Math.min(settings.maxFrameWidth, srcWidth);

  for (const cand of candidates) {
    const placements = timelinePlacementsFor(cand.sec, ctx);
    const frameId = frameIdOf(asset.id, cand.sec, cand.method);
    const file = path.join(dir, `${frameId.replace(/[^a-zA-Z0-9:_-]/g, "_")}.jpg`);
    try {
      await ffmpegRun(["-ss", String(cand.sec), "-i", asset.storagePath, "-frames:v", "1", "-vf", `scale=${outWidth}:-2`, "-q:v", "5", file]);
      const hash = await ahashFile(file);
      const twin = keptHashes.find((k) => hammingHex(k.hash, hash) <= settings.duplicateHashDistance);
      if (twin) {
        deduped += 1;
        frames.push(mkFrame(frameId, asset.id, cand, placements, outWidth, "skipped-duplicate", hash, twin.frameId));
        continue;
      }
      keptHashes.push({ hash, frameId });
      files.set(frameId, file);
      frames.push(mkFrame(frameId, asset.id, cand, placements, outWidth, "extracted", hash));
    } catch (err) {
      frames.push(mkFrame(frameId, asset.id, cand, placements, outWidth, "failed", null, (err as Error).message.slice(0, 280)));
    }
  }
  return { frames, files, framesDeduped: deduped, framesSkippedBudget: Math.max(0, candidates.length - settings.maxFramesPerAsset) };
}

function mkFrame(frameId: string, assetId: string, cand: { sec: number; method: VisualFrame["extractionMethod"] }, placements: { clipId: string; timelineSec: number }[], width: number, status: VisualFrame["status"], hash: string | null, dupOf: string | null = null, error: string | null = null): VisualFrame {
  const primary = placements[0] ?? null;
  return {
    frameId,
    assetId,
    clipId: primary?.clipId ?? null,
    sourceSec: cand.sec,
    timelineSec: primary?.timelineSec ?? null,
    width,
    height: 0, // measured after extraction below (setFrameHeights)
    extractionMethod: cand.method,
    ahash: hash ?? "",
    dupOf,
    status,
    analysis: null,
    confidence: null,
    provider: null,
    model: null,
    error,
  };
}

/** Fill real pixel heights from the extracted files (ffmpeg scale keeps AR). */
export async function setFrameHeights(frames: VisualFrame[], files: Map<string, string>): Promise<void> {
  for (const f of frames) {
    const file = files.get(f.frameId);
    if (!file) continue;
    const { width, height } = await imageSize(file);
    f.width = width;
    f.height = height;
  }
}

export async function imageSize(file: string): Promise<{ width: number; height: number }> {
  const { width, height } = await new Promise<{ width: number; height: number }>((resolve, reject) => {
    execFile("python3", ["-c", "import sys;from PIL import Image;im=Image.open(sys.argv[1]);print(im.size[0],im.size[1])", file], { timeout: 20_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      const [w, h] = stdout.trim().split(/\s+/).map(Number);
      resolve({ width: w, height: h });
    });
  });
  return { width, height };
}

/** Hamming distance between two aHash hex strings (0..64). */
export function hammingHex(a: string, b: string): number {
  if (!a || !b || a.length !== b.length) return 64;
  const x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  return x.toString(2).split("").filter((c) => c === "1").length;
}

/** Read one frame file as base64 JPEG for the vision provider. */
export async function readFrameBase64(file: string): Promise<string> {
  const buf = await readFile(file);
  return buf.toString("base64");
}

/** List remaining temp files (cleanup verification in tests). */
export async function listFrameDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

export const VISUAL_MEDIA_ROOT = MEDIA_ROOT;
