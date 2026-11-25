/**
 * M42-I Unit 1 — REAL audio analysis for RIISHE ("RIISHE hears the timeline").
 *
 * detectSilenceRanges runs genuine ffmpeg `silencedetect` against the asset
 * file on disk and returns the detected silence ranges. The planner uses the
 * result to (a) enrich the LLM prompt with real data and (b) emit REAL
 * TrimClip commands in the deterministic fallback — never fabricated ranges.
 *
 * Safety: argv-array spawn (no shell), path must sit inside MEDIA_ROOT,
 * hard 20 s timeout, output parsed from stderr per ffmpeg's silencedetect
 * format:  [silencedetect @ …] silence_start: 2.103424 / silence_end: 4.006
 * | silence_duration: 1.9026
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { isInsideMediaRoot, MEDIA_ROOT } from "@/lib/media-storage";

export interface SilenceRange {
  startSec: number;
  endSec: number;
  durationSec: number;
}

export interface SilenceAnalysis {
  ranges: SilenceRange[];
  durationSec: number | null;
  noiseDb: number;
  minSilenceSec: number;
  /** ffmpeg version banner line — proof the run used the real binary. */
  toolBanner: string | null;
}

/** Pure parser (unit-tested): silencedetect stderr → ranges. */
export function parseSilencedetectLog(stderr: string): SilenceRange[] {
  const ranges: SilenceRange[] = [];
  let pendingStart: number | null = null;
  for (const rawLine of stderr.split(/\r?\n/)) {
    const startMatch = rawLine.match(/silence_start:\s*(-?\d+(?:\.\d+)?)/);
    if (startMatch) {
      pendingStart = Math.max(0, Number(startMatch[1]));
      continue;
    }
    const endMatch = rawLine.match(/silence_end:\s*(-?\d+(?:\.\d+)?)/);
    if (endMatch && pendingStart !== null) {
      const end = Math.max(0, Number(endMatch[1]));
      const durMatch = rawLine.match(/silence_duration:\s*(-?\d+(?:\.\d+)?)/);
      ranges.push({ startSec: pendingStart, endSec: end, durationSec: durMatch ? Number(durMatch[1]) : Math.max(0, end - pendingStart) });
      pendingStart = null;
    }
  }
  // Trailing silence: a start without an end (file ends silent). The caller
  // clamps endSec to the real duration; keep it open-ended here.
  if (pendingStart !== null) {
    ranges.push({ startSec: pendingStart, endSec: Number.POSITIVE_INFINITY, durationSec: Number.POSITIVE_INFINITY });
  }
  return ranges;
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
      stderrAll += text.length > 4096 ? text.slice(0, 4096) : text;
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

export interface SilenceDetectOptions {
  /** Loudness threshold in dB (default −30 dBFS — conversational speech bed). */
  noiseDb?: number;
  /** Minimum silence length in seconds (default 0.5 s). */
  minSilenceSec?: number;
  timeoutMs?: number;
}

/**
 * Analyze a media file inside MEDIA_ROOT. Returns null when the file is
 * outside the media root or ffmpeg is unavailable — callers must treat null
 * as "analysis not possible" and disclose that, never invent ranges.
 */
export async function detectSilenceRanges(storagePath: string, opts: SilenceDetectOptions = {}): Promise<SilenceAnalysis | null> {
  // storagePath may be relative to MEDIA_ROOT (as stored) or an absolute path
  // already inside it — both resolve to the same file; anything else refused.
  const abs = path.isAbsolute(storagePath) ? storagePath : path.join(MEDIA_ROOT, storagePath);
  if (!isInsideMediaRoot(abs)) return null;
  const noiseDb = opts.noiseDb ?? -30;
  const minSilenceSec = opts.minSilenceSec ?? 0.5;
  const { code, stderr, banner } = await runFfmpeg(
    // NOTE: no -hide_banner — the "ffmpeg version" line is captured as the
    // evidence banner (proof the run used the real binary).
    ["-nostats", "-i", abs, "-af", `silencedetect=noise=${noiseDb}dB:d=${minSilenceSec}`, "-f", "null", "-"],
    opts.timeoutMs ?? 20_000,
  );
  if (code !== 0 && code !== 1) return null; // 1 is common with -f null; parse anyway
  if (!/silence_start|silence_end/.test(stderr) && code !== 0 && code !== 1) return null;
  const ranges = parseSilencedetectLog(stderr);
  const durMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const durationSec = durMatch
    ? Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3])
    : null;
  if (durationSec !== null) {
    for (const r of ranges) if (!Number.isFinite(r.endSec)) { r.endSec = durationSec; r.durationSec = Math.max(0, durationSec - r.startSec); }
  }
  return { ranges, durationSec, noiseDb, minSilenceSec, toolBanner: banner };
}

/** Seconds → frames on a clip's source timeline (integer, clamped ≥ 0). */
export function secToSourceFrames(sec: number, fps: number): number {
  return Math.max(0, Math.round(sec * fps));
}

export interface ClipSourceWindow {
  sourceInFrame: number;
  sourceOutFrame: number;
}

export interface HeadTailTrim {
  newSourceInFrame: number;
  newSourceOutFrame: number;
  /** Honest disclosures: what was trimmed and what was kept (interior). */
  notes: string[];
  changed: boolean;
}

/**
 * M42-I Unit 1 (pure, unit-tested) — map detected silence ranges onto ONE
 * clip's REAL source window: trim silence touching the HEAD or the TAIL;
 * interior silence is KEPT and disclosed (removal needs split+ripple, which
 * the executor supports but auto-computing split ids is a separate unit).
 * Guarantees ≥ 1 frame remains and the window stays inside the real bounds.
 */
export function headTailTrim(win: ClipSourceWindow, ranges: SilenceRange[], fps: number): HeadTailTrim {
  const notes: string[] = [];
  const inSec = win.sourceInFrame / fps;
  const outSec = win.sourceOutFrame / fps;
  const headSilence = ranges
    .filter((r) => r.startSec <= inSec + 0.25 && r.endSec > inSec)
    .sort((a, b) => b.endSec - a.endSec)[0];
  const tailSilence = ranges
    .filter((r) => r.endSec >= outSec - 0.25 && r.startSec < outSec)
    .sort((a, b) => a.startSec - b.startSec)[0];
  let newIn = win.sourceInFrame;
  let newOut = win.sourceOutFrame;
  if (headSilence) {
    newIn = Math.max(win.sourceInFrame, Math.min(secToSourceFrames(headSilence.endSec, fps), win.sourceOutFrame - 1));
    notes.push(`head silence [${headSilence.startSec.toFixed(2)}-${headSilence.endSec.toFixed(2)}s] → source in ${win.sourceInFrame}→${newIn}`);
  }
  if (tailSilence) {
    newOut = Math.max(newIn + 1, Math.min(secToSourceFrames(tailSilence.startSec, fps), win.sourceOutFrame));
    notes.push(`tail silence [${tailSilence.startSec.toFixed(2)}-${tailSilence.endSec.toFixed(2)}s] → source out ${win.sourceOutFrame}→${newOut}`);
  }
  // Interior silence is NOT disclosed here — the planner owns it (Unit 2:
  // the longest interior range becomes a split+ripple cut; the rest are
  // disclosed as KEPT at plan level).
  return { newSourceInFrame: newIn, newSourceOutFrame: newOut, notes, changed: Boolean(headSilence || tailSilence) && newOut - newIn >= 1 };
}

export interface InteriorSplitPlan {
  /** Source frames (asset timebase) of the silent middle to remove. */
  sFrame: number;
  eFrame: number;
  range: SilenceRange;
  note: string;
}

/**
 * M42-I Unit 2 (pure, unit-tested) — pick the LONGEST interior silence in a
 * clip's source window and map it to source frames for a split+ripple cut.
 * Interior = strictly inside the window (0.25 s tolerance matches
 * headTailTrim). Returns null when there is no trimmable interior silence.
 * The caller clamps further against post-trim geometry.
 */
export function interiorSplitPlan(win: ClipSourceWindow, ranges: SilenceRange[], fps: number): InteriorSplitPlan | null {
  const inSec = win.sourceInFrame / fps;
  const outSec = win.sourceOutFrame / fps;
  const interior = ranges
    .filter((r) => r.startSec > inSec + 0.25 && r.endSec < outSec - 0.25)
    .sort((a, b) => b.durationSec - a.durationSec);
  const range = interior[0];
  if (!range) return null;
  let sFrame = Math.max(win.sourceInFrame + 1, Math.min(secToSourceFrames(range.startSec, fps), win.sourceOutFrame - 2));
  let eFrame = Math.max(sFrame + 1, Math.min(secToSourceFrames(range.endSec, fps), win.sourceOutFrame - 1));
  if (eFrame - sFrame < 1) return null; // sub-frame silence — nothing to cut
  return {
    sFrame,
    eFrame,
    range,
    note: `interior silence [${range.startSec.toFixed(2)}-${range.endSec.toFixed(2)}s] → split+ripple cut at source frames [${sFrame}, ${eFrame})`,
  };
}
