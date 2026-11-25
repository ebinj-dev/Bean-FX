/**
 * M43-A Unit 1 — REAL scene-change detection for RIISHE ("RIISHE sees the
 * timeline").
 *
 * detectSceneChanges runs genuine ffmpeg scene detection against the asset
 * file on disk (`select='gt(scene,T)',showinfo`) and returns the detected
 * cut points in seconds. The planner uses the evidence to (a) enrich the
 * LLM prompt and (b) emit REAL AddMarker commands at the exact timeline
 * frames (executor math — clipTimelineDuration), so chapter/marker requests
 * anchor to actual video cuts, never invented positions.
 *
 * Safety: argv-array spawn (no shell), path must sit inside MEDIA_ROOT,
 * hard timeout, stderr capped. The ffmpeg version banner is captured as
 * evidence — the same honesty trail as the silence analysis (M42-I).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { isInsideMediaRoot, MEDIA_ROOT } from "@/lib/media-storage";

export interface SceneAnalysis {
  /** Ordered scene-cut points in seconds (media time). */
  cutSecs: number[];
  durationSec: number | null;
  threshold: number;
  /** ffmpeg version banner line — proof the run used the real binary. */
  toolBanner: string | null;
}

/**
 * Pure parser (unit-tested): ffmpeg showinfo lines → cut points.
 * One showinfo line per frame that passed the scene filter:
 *   [Parsed_showinfo_1 @ ...] n:   0 pts:     60 pts_time:2.04
 * Deduplicated and sorted; negative/NaN values dropped.
 */
export function parseSceneShowinfoLog(stderr: string): number[] {
  const cuts: number[] = [];
  for (const rawLine of stderr.split(/\r?\n/)) {
    if (!rawLine.includes("showinfo")) continue;
    const m = rawLine.match(/pts_time:\s*(-?\d+(?:\.\d+)?)/);
    if (!m) continue;
    const t = Number(m[1]);
    if (!Number.isFinite(t) || t < 0) continue;
    if (!cuts.some((c) => Math.abs(c - t) < 1e-3)) cuts.push(t);
  }
  return cuts.sort((a, b) => a - b);
}

interface RunResult {
  code: number;
  stderr: string;
  banner: string | null;
}

function runFfmpeg(args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let banner: string | null = null;
    let stderrAll = "";
    let settled = false;
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        resolve({ code: 124, stderr: stderrAll, banner });
      }
    }, timeoutMs);
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      if (!banner) banner = text.match(/ffmpeg version [^\n]*/)?.[0] ?? null;
      stderrAll += text.length > 8192 ? text.slice(0, 8192) : text;
      if (stderrAll.length > 262_144) stderrAll = stderrAll.slice(-262_144);
    });
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code: 127, stderr: `spawn error: ${err.message}`, banner: null });
      }
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code: code ?? 1, stderr: stderrAll, banner });
      }
    });
  });
}

export interface SceneDetectOptions {
  /** Scene-change threshold 0..1 (default 0.4 — real hard cuts /shot changes). */
  threshold?: number;
  timeoutMs?: number;
}

/**
 * Analyze a media file inside MEDIA_ROOT for scene cuts. Returns null when
 * the file is outside the media root or ffmpeg is unavailable — callers
 * must treat null as "analysis not possible" and disclose that, never
 * invent cut points.
 */
export async function detectSceneChanges(storagePath: string, opts: SceneDetectOptions = {}): Promise<SceneAnalysis | null> {
  const abs = path.isAbsolute(storagePath) ? storagePath : path.join(MEDIA_ROOT, storagePath);
  if (!isInsideMediaRoot(abs)) return null;
  const threshold = Math.min(1, Math.max(0, opts.threshold ?? 0.4));
  // NOTE: no -hide_banner — the "ffmpeg version" line is the evidence banner.
  const { code, stderr, banner } = await runFfmpeg(
    ["-nostats", "-i", abs, "-vf", `select='gt(scene,${threshold})',showinfo`, "-an", "-f", "null", "-"],
    opts.timeoutMs ?? 60_000,
  );
  if (code !== 0 && code !== 1) return null; // 1 is common with -f null; parse anyway
  const cutSecs = parseSceneShowinfoLog(stderr);
  const durMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const durationSec = durMatch ? Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3]) : null;
  return { cutSecs, durationSec, threshold, toolBanner: banner };
}
