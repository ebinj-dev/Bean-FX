/**
 * M13 — Temporal frame sampling (§2).
 *
 * Extends M12's sparse sampling with CONSECUTIVE-frame windows for real
 * tracking:
 *  - scene-aware windows (M12/JAZMII deterministic cut boundaries) split into
 *    `windowSec` passes;
 *  - each window is resampled at `sampleFps` with the ffmpeg `fps` filter
 *    (variable-frame-rate inputs are CFR-ized first — the standard handling —
 *    and exact per-frame timestamps come from `showinfo` pts_time of the
 *    RESAMPLED stream, so VFR never desynchronizes the analysis);
 *  - every frame keeps full provenance (asset, timeline clip, SOURCE seconds,
 *    TIMELINE seconds via the shared speed-aware mappers, dimensions,
 *    sampling interval, window index);
 *  - budget: `maxFrames` across all windows with an even per-window spread;
 *  - frames live in the per-run temp dir; the job cleans it in `finally`.
 */
import { execFile } from "child_process";
import { mkdir } from "fs/promises";
import path from "path";
import { timelinePlacementsFor, visualFrameDir, type FrameExtractionContext } from "../frames";
import { frameIdOf } from "../contracts";
import type { TemporalFrame, TemporalSettings } from "./contracts";

export interface TemporalWindow {
  index: number;
  startSec: number;
  endSec: number;
}

export interface TemporalSampleSet {
  frames: TemporalFrame[];
  /** Absolute JPEG paths keyed by frameId (temp — cleaned by the job). */
  files: Map<string, string>;
  windows: TemporalWindow[];
}

/** Scene cuts → tracking windows (≤ windowSec each, bounded count). */
export function planWindows(durationSec: number, settings: TemporalSettings, sceneCuts: number[]): TemporalWindow[] {
  const bounds = [0, ...sceneCuts.filter((c) => c > 0 && c < durationSec), durationSec];
  const scenes: { start: number; end: number }[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    if (bounds[i + 1] - bounds[i] >= 0.5) scenes.push({ start: bounds[i], end: bounds[i + 1] });
  }
  if (scenes.length === 0) scenes.push({ start: 0, end: durationSec });
  const windows: TemporalWindow[] = [];
  let index = 0;
  for (const sc of scenes) {
    for (let t = sc.start; t < sc.end - 0.2; t += settings.windowSec) {
      windows.push({ index: index++, startSec: Math.round(t * 100) / 100, endSec: Math.round(Math.min(sc.end, t + settings.windowSec) * 100) / 100 });
      if (windows.length >= 12) return windows;
    }
  }
  return windows;
}

function ffmpegRun(args: string[], timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", ["-hide_banner", "-nostats", ...args], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`ffmpeg temporal sampling failed: ${String(stderr).slice(0, 240)}`));
      resolve(`${stdout}\n${stderr}`);
    });
  });
}

/** Parse showinfo pts_time lines (one per output frame, in order). */
function parseShowinfoPts(output: string): number[] {
  const pts: number[] = [];
  const re = /pts_time:([\d.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    const t = Number(m[1]);
    if (Number.isFinite(t)) pts.push(Math.round(t * 1000) / 1000);
  }
  return pts;
}

/**
 * Extract consecutive sampled frames for the planned windows of ONE asset.
 * Individual frame failures are recorded honestly (no silent gaps); the call
 * throws only when the asset file itself is unreadable.
 */
export async function extractTemporalFrames(asset: { id: string; storagePath: string; width: number | null; height: number | null; durationSec: number | null }, settings: TemporalSettings, ctx: FrameExtractionContext, windows: TemporalWindow[], runKey: string): Promise<TemporalSampleSet> {
  if (!asset.storagePath) throw new Error(`asset ${asset.id} has no storage path`);
  if (!asset.durationSec || asset.durationSec <= 0) throw new Error(`asset ${asset.id} has no measurable duration`);
  const dir = visualFrameDir(runKey);
  await mkdir(dir, { recursive: true });

  const srcWidth = asset.width ?? 320;
  const outWidth = Math.min(480, Math.max(160, srcWidth)); // tracking scale — small, provider-agnostic
  const files = new Map<string, string>();
  const frames: TemporalFrame[] = [];

  // Budget: even per-window frame caps.
  const perWindowCap = Math.max(3, Math.floor(settings.maxFrames / Math.max(1, windows.length)));

  for (const w of windows) {
    const len = Math.max(0.4, w.endSec - w.startSec);
    let output: string;
    try {
      output = await ffmpegRun([
        "-ss", String(w.startSec), "-t", String(len), "-i", asset.storagePath,
        "-vf", `fps=${settings.sampleFps},scale=${outWidth}:-2,showinfo`,
        "-q:v", "5", "-start_number", "0",
        path.join(dir, `w${w.index}_%04d.jpg`),
      ]);
    } catch (err) {
      frames.push({
        frameId: `w${w.index}.failed`, assetId: asset.id, clipId: null,
        sourceSec: w.startSec, timelineSec: null, width: outWidth, height: 0,
        windowIndex: w.index, sampleIntervalSec: 1 / settings.sampleFps,
        extractionMethod: "consecutive-sample",
      });
      continue;
    }
    const pts = parseShowinfoPts(output);
    // showinfo pts are relative to the -ss seek point for output frames of
    // some builds; the fps filter grid is authoritative: pts[i] ≈ i/sampleFps.
    const grid: number[] = pts.length > 0 ? pts : Array.from({ length: Math.floor(len * settings.sampleFps) }, (_, i) => Math.round((w.startSec + i / settings.sampleFps) * 1000) / 1000);
    const capped = grid.slice(0, perWindowCap);
    for (let i = 0; i < capped.length; i++) {
      const file = path.join(dir, `w${w.index}_${String(i).padStart(4, "0")}.jpg`);
      // With input seeking, showinfo pts_time is window-relative → absolute.
      const sourceSec = pts.length > 0
        ? Math.round((w.startSec + pts[i]) * 1000) / 1000
        : Math.round((w.startSec + i / settings.sampleFps) * 1000) / 1000;
      const placements = timelinePlacementsFor(sourceSec, ctx);
      const primary = placements[0] ?? null;
      const frameId = frameIdOf(asset.id, sourceSec, "consecutive-sample");
      try {
        const { imageSize } = await import("../frames");
        const size = await imageSize(file).catch(() => ({ width: outWidth, height: 0 }));
        const record: TemporalFrame = {
          frameId,
          assetId: asset.id,
          clipId: primary?.clipId ?? null,
          sourceSec,
          timelineSec: primary?.timelineSec ?? null,
          width: size.width,
          height: size.height,
          windowIndex: w.index,
          sampleIntervalSec: Math.round((1 / settings.sampleFps) * 1000) / 1000,
          extractionMethod: "consecutive-sample",
        };
        if (size.height > 0) {
          files.set(frameId, file);
          frames.push(record);
        } else {
          frames.push({ ...record, height: 0 });
        }
      } catch {
        frames.push({
          frameId, assetId: asset.id, clipId: primary?.clipId ?? null, sourceSec,
          timelineSec: primary?.timelineSec ?? null, width: outWidth, height: 0,
          windowIndex: w.index, sampleIntervalSec: 1 / settings.sampleFps,
          extractionMethod: "consecutive-sample",
        });
      }
    }
  }
  return { frames, files, windows };
}
