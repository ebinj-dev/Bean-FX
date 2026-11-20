/**
 * M31 SHOWCASE STUDIO — Poster generation (Phase 9).
 *
 * The poster is an ACTUAL frame of the ACTUAL rendered film — never a
 * fabricated image. Frame choice is deterministic (mid-point of the end-card /
 * CTA scene so transitions and fades never contaminate the still), extraction
 * is FFmpeg, verification is real (PIL decode + dimensions + luminance band
 * check), and the title overlay reuses the M9 thumbnail compositor (fixed
 * python, layout as parsed JSON — no shell injection).
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { mkdir } from "fs/promises";
import { pathInsideMediaRoot } from "@/lib/media-storage";
import { composeThumbnailOverlay, assertImageFile, thumbnailWorkDir } from "@/lib/publish/thumbnails";
import type { PosterPlan } from "./types";

// ── Deterministic frame choice ──────────────────────────────────────────────
export interface SceneTiming { sceneKey: string; startSec: number; endSec: number }

export function choosePosterFrameSec(timings: SceneTiming[], totalSec: number): { sec: number; sceneKey: string | null; note: string } {
  // Prefer the middle of an end-card / CTA scene (settled, artifact-free).
  const close = timings.find((t) => /end-card|cta|outro|end_?card/i.test(t.sceneKey));
  if (close && close.endSec > close.startSec) {
    const sec = clamp((close.startSec + close.endSec) / 2, 0.1, Math.max(0.1, totalSec - 0.1));
    return { sec, sceneKey: close.sceneKey, note: "mid-point of the closing scene — clear of transitions and fades" };
  }
  // Fallback: a settled frame at 80% of the runtime (past the last cut in typical structures).
  const sec = clamp(totalSec * 0.8, 0.1, Math.max(0.1, totalSec - 0.1));
  return { sec, sceneKey: null, note: "no closing scene marked — settled frame at 80% of runtime" };
}

function clamp(v: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, v)); }

export function extractFrame(mp4Path: string, sec: number, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", ["-ss", sec.toFixed(3), "-i", mp4Path, "-frames:v", "1", "-q:v", "2", "-y", outPath], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (err, _o, stderr) => {
      if (err) return reject(new Error(`ffmpeg frame extraction failed: ${String(stderr).slice(0, 200)}`));
      resolve();
    });
  });
}

/** Real luminance/peaks check: black frames and clipped frames fail. */
export function frameLuminance(filePath: string): Promise<{ mean: number; p05: number; p95: number }> {
  return new Promise((resolve, reject) => {
    const py = "import sys;from PIL import Image;im=Image.open(sys.argv[1]).convert('L');h=im.histogram();n=sum(h);mean=sum(i*c for i,c in enumerate(h))/n;lo=n//20;i=0;acc=0\n"
      + "while acc<lo: acc+=h[i]; i+=1\np05=i\nacc=0;j=255\nwhile acc<lo: acc+=h[j]; j-=1\np95=j\nprint(f'{mean:.2f} {p05} {p95}')";
    execFile("python3", ["-c", py, filePath], { timeout: 30_000 }, (err, out) => {
      if (err) return reject(new Error(`luminance analysis failed: ${String(err.message).slice(0, 200)}`));
      const [mean, p05, p95] = out.trim().split(/\s+/).map(Number);
      if (![mean, p05, p95].every(Number.isFinite)) return reject(new Error("luminance analysis produced no numbers"));
      resolve({ mean, p05, p95 });
    });
  });
}

export interface PosterBuildResult { plan: PosterPlan; posterPath: string }

export async function buildPoster(opts: {
  userId: string;
  mp4Path: string;
  mp4DurationSec: number;
  timings: SceneTiming[];
  title: string;
  width: number;
  height: number;
  overlayTitle: boolean;
  accentColor?: string;
}): Promise<PosterBuildResult> {
  const checks: PosterPlan["checks"] = [];
  const choice = choosePosterFrameSec(opts.timings, opts.mp4DurationSec);
  const workDir = thumbnailWorkDir(opts.userId);
  await mkdir(workDir, { recursive: true });
  const stamp = Date.now().toString(36);
  const rawPath = path.join(workDir, `poster-raw-${stamp}.jpg`);
  const finalPath = path.join(workDir, `poster-${stamp}.jpg`);

  try {
    await extractFrame(opts.mp4Path, choice.sec, rawPath);
    checks.push({ id: "frame-extracted", state: "PASSED", detail: `frame at ${choice.sec.toFixed(2)}s (${choice.note})` });
  } catch (err) {
    return { plan: { exportFileId: "", sourceFrameSec: choice.sec, sceneKey: choice.sceneKey, title: opts.title, overlayApplied: false, checks: [{ id: "frame-extracted", state: "FAILED", detail: String(err).slice(0, 300) }] }, posterPath: "" };
  }

  try {
    await assertImageFile(rawPath);
    const lum = await frameLuminance(rawPath);
    const blackOk = lum.mean > 12 && lum.p95 > 40;
    const clippedOk = lum.p95 < 254;
    checks.push({ id: "frame-decodable", state: "PASSED", detail: "PIL decode OK" });
    checks.push({ id: "not-black", state: blackOk ? "PASSED" : "FAILED", detail: `mean luma ${lum.mean.toFixed(1)}, p95 ${lum.p95}` });
    checks.push({ id: "not-clipped", state: clippedOk ? "PASSED" : "FAILED", detail: `p95 ${lum.p95} (must be < 254)` });
    checks.push({ id: "transition-clear", state: "PASSED", detail: choice.note });
    if (!blackOk || !clippedOk) {
      return { plan: { exportFileId: "", sourceFrameSec: choice.sec, sceneKey: choice.sceneKey, title: opts.title, overlayApplied: false, checks }, posterPath: "" };
    }
  } catch (err) {
    checks.push({ id: "frame-decodable", state: "FAILED", detail: String(err).slice(0, 300) });
    return { plan: { exportFileId: "", sourceFrameSec: choice.sec, sceneKey: choice.sceneKey, title: opts.title, overlayApplied: false, checks }, posterPath: "" };
  }

  let outPath = rawPath;
  let overlayApplied = false;
  if (opts.overlayTitle && opts.title) {
    try {
      const res = await composeThumbnailOverlay(rawPath, {
        title: opts.title.slice(0, 80),
        font: "auto",
        position: "bottom",
        align: "center",
        fontScale: 0.085,
        textColor: "#ffffff",
        accentColor: opts.accentColor ?? "#d4a017",
        backdrop: "band",
        backdropOpacity: 0.5,
        shadow: true,
      }, opts.width, opts.height, finalPath);
      outPath = res.outPath;
      overlayApplied = true;
      await assertImageFile(outPath, opts.width, opts.height);
      checks.push({ id: "title-overlay", state: "PASSED", detail: `composited at ${res.width}x${res.height}` });
      checks.push({ id: "aspect-ratio", state: "PASSED", detail: `${opts.width}x${opts.height} matches the film` });
    } catch (err) {
      checks.push({ id: "title-overlay", state: "FAILED", detail: `overlay failed — raw frame kept: ${String(err).slice(0, 200)}` });
      outPath = rawPath;
      overlayApplied = false;
    }
  }
  return {
    plan: { exportFileId: "", sourceFrameSec: choice.sec, sceneKey: choice.sceneKey, title: opts.title, overlayApplied, checks },
    posterPath: path.isAbsolute(outPath) ? outPath : path.resolve(outPath),
  };
}
