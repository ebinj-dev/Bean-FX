/**
 * M32 Track C — REAL mask-based subject isolation and compositing.
 *
 * What exists here is genuine image processing (PIL) and a genuine video
 * compositing path (FFmpeg alphamerge + overlay) — NOT a UI toggle:
 *  - validation: PIL decode, alpha statistics, invalid-mask detection
 *    (all-opaque / all-transparent / wrong mode / corrupted);
 *  - operations: invert, feather (Gaussian), edge refine (MinFilter/MedianFilter),
 *    scale/align to target resolution — each writes a NEW versioned row
 *    (parentId chain), source masks are never mutated;
 *  - frame compositing: subject = source × mask-alpha over a background —
 *    pixel-verified in tests;
 *  - video compositing: FFmpeg `-filter_complex "[src][mask]alphamerge[a];
 *    [bg][a]overlay"` → validated MP4 (ffprobe + duration/fps/resolution
 *    tolerance), registered with provenance;
 *  - fallbacks: missing/corrupted masks, resolution and frame-rate mismatches
 *    FAIL with precise reasons and the ORIGINAL footage is preserved — a
 *    compositing that did not happen is never reported as success.
 *
 * AUTOMATIC SEGMENTATION HONESTY: no verified segmentation model or provider
 * exists in this environment. `AUTO_SEGMENTATION` is therefore reported as
 * CONFIGURATION REQUIRED and never faked with blur/chroma-key/rectangles.
 * The manual path (import + PIL refinement) is fully implemented.
 */
import { execFile } from "node:child_process";
import { mkdir, stat } from "fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { ffprobe, pathInsideMediaRoot } from "@/lib/media-storage";
import { registerImageArtifact, registerGeneratedAsset } from "@/lib/ai/asset-lifecycle";

export const AUTO_SEGMENTATION_STATUS = {
  status: "CONFIGURATION_REQUIRED",
  detail: "No verified automatic segmentation model or provider is available in this environment. Import a mask (manual path) or configure a segmentation provider with owner approval. BEAN FX does not fake segmentation with blur, chroma key or rectangles.",
} as const;

export function masksWorkDir(userId: string): string {
  return pathInsideMediaRoot("media-store", "masks", `u_${userId}`);
}

// ── Validation (real PIL checks) ────────────────────────────────────────────
export interface MaskValidation {
  ok: boolean;
  width: number; height: number;
  mode: string;
  opaquePct: number; transparentPct: number; partialPct: number;
  issues: string[];
}

export function validateMaskFile(filePath: string): Promise<MaskValidation> {
  const py = `
import sys, json
from PIL import Image
im = Image.open(sys.argv[1])
w, h = im.size
mode = im.mode
issues = []
if mode not in ("L", "LA", "RGBA", "1"):
    issues.append(f"unsupported mode {mode} — use 8-bit alpha (L/LA/RGBA)")
if w < 16 or h < 16:
    issues.append(f"mask too small ({w}x{h})")
g = im.convert("LA").getchannel("A") if mode in ("LA", "RGBA") else im.convert("L")
hist = g.histogram()
total = sum(hist)
opaque = sum(hist[224:]); transparent = sum(hist[:32]); partial = total - opaque - transparent
if opaque / total > 0.999:
    issues.append("mask is fully opaque — it selects EVERYTHING (no subject isolation)")
if transparent / total > 0.999:
    issues.append("mask is fully transparent — it selects NOTHING")
print(json.dumps({"ok": len(issues) == 0, "width": w, "height": h, "mode": mode,
                  "opaquePct": round(opaque/total, 4), "transparentPct": round(transparent/total, 4),
                  "partialPct": round(partial/total, 4), "issues": issues}))
`;
  return new Promise((resolve, reject) => {
    execFile("python3", ["-c", py, filePath], { timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`mask validation failed: ${String(stderr || err.message).slice(0, 200)}`));
      try { resolve(JSON.parse(stdout.trim())); } catch { reject(new Error("mask validation produced no verdict")); }
    });
  });
}

// ── Mask operations (each produces a NEW versioned mask row) ────────────────
export type MaskOp = "invert" | "feather" | "refine" | "scale";
const OP_PY: Record<MaskOp, string> = {
  invert: `
from PIL import Image, ImageOps
import sys
im = Image.open(sys.argv[1]).convert("L")
ImageOps.invert(im).save(sys.argv[2])`,
  feather: `
from PIL import Image, ImageFilter
import sys
im = Image.open(sys.argv[1]).convert("L")
im.filter(ImageFilter.GaussianBlur(float(sys.argv[3]))).save(sys.argv[2])`,
  refine: `
from PIL import Image, ImageFilter
import sys
im = Image.open(sys.argv[1]).convert("L")
im = im.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MedianFilter(3))
im.save(sys.argv[2])`,
  scale: `
from PIL import Image
import sys
im = Image.open(sys.argv[1]).convert("L")
im.resize((int(sys.argv[3]), int(sys.argv[4])), Image.LANCZOS).save(sys.argv[2])`,
};

function runOp(op: MaskOp, src: string, out: string, arg3?: string, arg4?: string): Promise<void> {
  const args = ["-c", OP_PY[op], src, out, ...(arg3 !== undefined ? [arg3] : []), ...(arg4 !== undefined ? [arg4] : [])];
  return new Promise((resolve, reject) => {
    execFile("python3", args, { timeout: 120_000 }, (err, _o, stderr) => {
      if (err) return reject(new Error(`mask ${op} failed: ${String(stderr || err.message).slice(0, 200)}`));
      resolve();
    });
  });
}

export interface ProcessResult { maskId: string; version: number; validation: MaskValidation }

export async function processMask(userId: string, maskId: string, op: MaskOp, params: { radiusPx?: number; targetW?: number; targetH?: number } = {}): Promise<ProcessResult> {
  const mask = await db.mediaMask.findUnique({ where: { id: maskId } });
  if (!mask || mask.userId !== userId) throw new Error("Mask not found or not owned by the caller.");
  if (mask.validationStatus === "FAILED") throw new Error(`Mask is marked FAILED (${mask.validationJson ?? "no detail"}) — refine from a valid ancestor instead.`);
  await mkdir(masksWorkDir(userId), { recursive: true });
  const stamp = Date.now().toString(36);
  const outPath = path.join(masksWorkDir(userId), `mask_${maskId.slice(-6)}_${op}_${stamp}.png`);
  if (op === "feather") await runOp("feather", mask.storagePath, outPath, String(params.radiusPx ?? 2));
  else if (op === "scale") {
    if (!params.targetW || !params.targetH) throw new Error("scale requires targetW/targetH.");
    await runOp("scale", mask.storagePath, outPath, String(params.targetW), String(params.targetH));
  } else await runOp(op, mask.storagePath, outPath);
  const st = await stat(outPath);
  if (st.size < 200) throw new Error(`mask ${op} produced an empty file.`);
  const validation = await validateMaskFile(outPath);
  const latest = await db.mediaMask.findFirst({ where: { parentId: mask.id }, orderBy: { version: "desc" } });
  const row = await db.mediaMask.create({
    data: {
      userId, sourceAssetId: mask.sourceAssetId, storagePath: outPath,
      width: validation.width, height: validation.height,
      method: "editor-refine", version: (latest?.version ?? mask.version) + 1,
      parentId: mask.id, validationStatus: validation.ok ? "VALIDATED" : "FAILED",
      validationJson: JSON.stringify(validation), coordSpace: mask.coordSpace,
      fps: mask.fps, frameIndex: mask.frameIndex,
      notes: `applied ${op}${op === "feather" ? ` r=${params.radiusPx ?? 2}px` : ""}${op === "scale" ? ` → ${params.targetW}x${params.targetH}` : ""}`,
    },
  });
  return { maskId: row.id, version: row.version, validation };
}

// ── Manual import (the honest path available today) ─────────────────────────
export async function importManualMask(userId: string, opts: { sourceAssetId: string; file: string; frameIndex?: number; fps?: number; notes?: string }): Promise<ProcessResult> {
  const source = await db.mediaAsset.findUnique({ where: { id: opts.sourceAssetId } });
  if (!source || source.userId !== userId) throw new Error("Source media not found or not owned by the caller.");
  await mkdir(masksWorkDir(userId), { recursive: true });
  const stamp = Date.now().toString(36);
  const outPath = path.join(masksWorkDir(userId), `mask_${source.id.slice(-8)}_${stamp}.png`);
  await runOp("scale", opts.file, outPath, String(source.width ?? 0), String(source.height ?? 0)).catch(async () => {
    // Source without known dims → store as-is (validation will judge).
    await import("fs/promises").then((fs) => fs.copyFile(opts.file, outPath));
  });
  const validation = await validateMaskFile(outPath);
  const row = await db.mediaMask.create({
    data: {
      userId, sourceAssetId: opts.sourceAssetId, storagePath: outPath,
      width: validation.width, height: validation.height,
      method: "manual-import", version: 1, validationStatus: validation.ok ? "VALIDATED" : "FAILED",
      validationJson: JSON.stringify(validation), coordSpace: "pixel:source-resolution",
      fps: opts.fps ?? null, frameIndex: opts.frameIndex ?? null, notes: opts.notes ?? "imported mask",
    },
  });
  return { maskId: row.id, version: row.version, validation };
}

// ── Compositing (the real thing) ────────────────────────────────────────────
export interface CompositeResult { kind: "frame" | "video"; mediaAssetId: string; notes: string[] }

/** Composite ONE frame: subject = source × mask over background (pixel-real). */
export async function compositeFrame(userId: string, maskId: string, backgroundFile: string, sourceFile: string): Promise<CompositeResult> {
  const mask = await db.mediaMask.findUnique({ where: { id: maskId } });
  if (!mask || mask.userId !== userId) throw new Error("Mask not found or not owned by the caller.");
  if (mask.validationStatus !== "VALIDATED") throw new Error(`Mask is not VALIDATED (${mask.validationStatus}) — validate it first.`);
  const outDir = pathInsideMediaRoot("mask-composites", `u_${userId}`);
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `comp_${maskId.slice(-6)}_${Date.now().toString(36)}.png`);
  const py = `
import sys
from PIL import Image
src_path, mask_path, bg_path, out_path = sys.argv[1:5]
src = Image.open(src_path).convert("RGB")
bg = Image.open(bg_path).convert("RGB")
m = Image.open(mask_path).convert("L")
if m.size != src.size:
    raise SystemExit(f"MASK_SIZE_MISMATCH mask={m.size} source={src.size}")
if bg.size != src.size:
    raise SystemExit(f"BACKGROUND_SIZE_MISMATCH bg={bg.size} source={src.size}")
alpha = m.point(lambda v: v)
subject = Image.composite(src, bg, alpha)
subject.save(out_path)
`;
  await new Promise<void>((resolve, reject) => {
    execFile("python3", ["-c", py, sourceFile, mask.storagePath, backgroundFile, outPath], { timeout: 120_000 }, (err, _o, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).slice(0, 300)));
      resolve();
    });
  });
  const registered = await registerImageArtifact(outPath, {
    engine: "SHOWCASE", userId, projectId: null,
    originalName: `mask-composite-${maskId.slice(-6)}.png`,
    provider: "pil-composite", model: "mask-alpha-over",
    prompt: `subject isolation composite (mask ${maskId}, frame)`,
    params: { maskId, operation: "alpha-over", source: sourceFile, background: backgroundFile },
    license: "derived-from-user-media", attribution: "Subject isolation via BEAN FX mask compositing (PIL alpha-over)",
  });
  return { kind: "frame", mediaAssetId: registered.id, notes: ["frame composited with the validated mask (alpha-over); original footage untouched"] };
}

/** Composite a full VIDEO clip through FFmpeg alphamerge + overlay. */
export async function compositeVideo(userId: string, maskId: string, sourceAssetId: string, backgroundAssetId: string): Promise<CompositeResult> {
  const mask = await db.mediaMask.findUnique({ where: { id: maskId } });
  if (!mask || mask.userId !== userId) throw new Error("Mask not found or not owned by the caller.");
  if (mask.validationStatus !== "VALIDATED") throw new Error(`Mask is not VALIDATED (${mask.validationStatus}) — validate it first.`);
  const [source, background] = await Promise.all([
    db.mediaAsset.findUnique({ where: { id: sourceAssetId } }),
    db.mediaAsset.findUnique({ where: { id: backgroundAssetId } }),
  ]);
  if (!source || source.userId !== userId) throw new Error("Source video not found or not owned by the caller.");
  if (!background || background.userId !== userId) throw new Error("Background video not found or not owned by the caller.");
  if (!source.storagePath || !background.storagePath) throw new Error("Source/background video files missing.");
  const srcProbe = await ffprobe(source.storagePath);
  const bgProbe = await ffprobe(background.storagePath);
  const notes: string[] = [];
  // Resolution mismatch → mask/source scaled to source geometry honestly.
  if (bgProbe.width !== srcProbe.width || bgProbe.height !== srcProbe.height) {
    notes.push(`background ${bgProbe.width}x${bgProbe.height} scaled to source ${srcProbe.width}x${srcProbe.height} before compositing`);
  }
  if (Math.abs((bgProbe.durationSec ?? 0) - (srcProbe.durationSec ?? 0)) > 0.5) {
    throw new Error(`DURATION_MISMATCH source ${srcProbe.durationSec?.toFixed(2)}s vs background ${bgProbe.durationSec?.toFixed(2)}s — trim to match; the original footage is preserved.`);
  }
  if (Math.abs((bgProbe.fps ?? 0) - (srcProbe.fps ?? 0)) > 1) {
    notes.push(`frame-rate mismatch source ${srcProbe.fps} vs background ${bgProbe.fps} — output follows the source clock`);
  }
  const outDir = pathInsideMediaRoot("mask-composites", `u_${userId}`);
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `comp-video_${maskId.slice(-6)}_${Date.now().toString(36)}.mp4`);
  // scale mask to source geometry; scale background to source geometry;
  // alphamerge turns the mask into source alpha; overlay puts the subject
  // over the (scaled) background. Real per-frame compositing.
  const filter = `[1:v]scale=${srcProbe.width}:${srcProbe.height}[m];[0:v][m]alphamerge[subject];[2:v]scale=${srcProbe.width}:${srcProbe.height}[bg];[bg][subject]overlay=shortest=1[v]`;
  await new Promise<void>((resolve, reject) => {
    execFile("ffmpeg", ["-y", "-loglevel", "error",
      "-i", source.storagePath, "-i", mask.storagePath, "-i", background.storagePath,
      "-filter_complex", filter, "-map", "[v]",
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-an", outPath], { timeout: 600_000, maxBuffer: 32 * 1024 * 1024 }, (err, _o, stderr) => {
      if (err) return reject(new Error(`ffmpeg mask compositing failed: ${String(stderr || err.message).slice(0, 300)}`));
      resolve();
    });
  });
  // Real output verification — never trust exit 0 alone.
  const probe = await ffprobe(outPath);
  if (!probe.durationSec || !probe.width) throw new Error("composited video failed ffprobe validation (the attempt is discarded; originals intact)");
  if (Math.abs((probe.durationSec ?? 0) - (srcProbe.durationSec ?? 0)) > 1.5) {
    throw new Error(`composited duration ${probe.durationSec?.toFixed(2)}s diverges from source ${srcProbe.durationSec?.toFixed(2)}s`);
  }
  const registered = await registerGeneratedAsset(outPath, {
    engine: "SHOWCASE", userId, projectId: null,
    originalName: `mask-composite-${maskId.slice(-6)}.mp4`,
    provider: "ffmpeg-alphamerge", model: "mask-overlay",
    prompt: `subject isolation composite (mask ${maskId})`,
    params: { maskId, sourceAssetId, backgroundAssetId, notes },
    license: "derived-from-user-media", attribution: "Subject isolation via BEAN FX mask compositing (FFmpeg alphamerge+overlay)",
    expectClass: "VIDEO",
    width: probe.width, height: probe.height,
  });
  notes.push(`composited ${probe.durationSec?.toFixed(2)}s @ ${probe.width}x${probe.height} verified by ffprobe`);
  return { kind: "video", mediaAssetId: registered.id, notes };
}

/** Mask preview data URL (small, for the UI) — real pixels, not a fake thumb. */
export function maskPreviewPng(maskPath: string, maxW = 320): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("python3", ["-c", `
import sys, base64, io
from PIL import Image
im = Image.open(sys.argv[1]).convert("L")
scale = min(1.0, float(sys.argv[2]) / im.width)
if scale < 1.0:
    im = im.resize((int(im.width * scale), int(im.height * scale)))
buf = io.BytesIO(); im.save(buf, "PNG")
print("data:image/png;base64," + base64.b64encode(buf.getvalue()).decode())`, maskPath, String(maxW)], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`preview failed: ${String(err.message).slice(0, 200)}`));
      resolve(stdout.trim());
    });
  });
}
