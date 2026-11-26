/**
 * BEAN FX — M45 Unit B NIIKI VFX: canvas preview ops.
 *
 * Preview parity for the VFX effect types that have NO CSS filter equivalent
 * (chromaKey, rectMask, ellipseMask, motionBlur). Each op implements the SAME
 * parameterization and documented math as its FFmpeg fragment in filters.ts:
 *
 *  - chromaKey:   Euclidean RGB distance to the key color; pixels closer
 *                 than `similarity` are transparent, `blend` is the
 *                 soft-edge width; mild spill suppression desaturates
 *                 semi-keyed pixels. The export uses FFmpeg colorkey — the
 *                 SAME RGB-space metric (chromakey's YUV metric keyed
 *                 neutrals in live verification and was rejected for
 *                 parity).
 *  - rectMask:    alpha = 255·clip(min(x/(w·l), (w-1-x)/(w·r), y/(h·t),
 *                 (h-1-y)/(h·b)), 0, 1) — the exact geq expression.
 *  - ellipseMask: alpha = 255·clip((1-d)/f, 0, 1) with the normalized
 *                 ellipse distance d — the exact geq expression.
 *  - motionBlur:  uniform average of the previous N frames (tmix); preview
 *                 is approximate (ring-buffer alignment) — disclosed in
 *                 APPROXIMATE_PREVIEW.
 *
 * All ops are pure ImageData transforms so the NIIKI workspace can apply them
 * to a still frame AND the monitor can apply them per playback frame.
 */
import type { EffectType } from "@/lib/editor/model";

type NumberParam = number | string | boolean | undefined;

function n(params: Record<string, NumberParam>, key: string, fallback: number): number {
  const v = params[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function b(params: Record<string, NumberParam>, key: string): boolean {
  return params[key] === true;
}

/** Hex "#rrggbb" → normalized [r,g,b] in 0..1; invalid → classic green. */
export function keyColorToRgb(color: NumberParam): [number, number, number] {
  const s = typeof color === "string" ? color : "";
  const m = /^#?([0-9a-fA-F]{6})$/.exec(s);
  if (!m) return [0, 0.694, 0.251]; // #00b140 — classic chroma green
  const int = parseInt(m[1], 16);
  return [((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255];
}

/** Chroma key the ImageData in place (M45 — see module doc for the math).
 *  Metric: Euclidean RGB distance to the key color normalized by the RGB
 *  cube diagonal (441.7). Saturation-neutral pixels (white/gray/skin) stay
 *  far from saturated green/blue keys, so the default similarity 0.2 keys
 *  the screen without eating neutrals. libavfilter's chromakey works in YUV
 *  with different internal weighting — the export filter is the authority;
 *  this is the same algorithm family for preview (disclosed). */
const RGB_DIAGONAL = Math.sqrt(3) * 255;

export function applyChromaKeyToImageData(data: ImageData, params: Record<string, NumberParam>): void {
  const [kr, kg, kb] = keyColorToRgb(params.color);
  const similarity = n(params, "similarity", 0.2) * RGB_DIAGONAL;
  const blend = Math.max(0.001, n(params, "blend", 0.1)) * RGB_DIAGONAL;
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    const dist = Math.hypot(px[i] - kr * 255, px[i + 1] - kg * 255, px[i + 2] - kb * 255);
    if (dist <= similarity) {
      px[i + 3] = 0;
    } else if (dist < similarity + blend) {
      const t = (dist - similarity) / blend;
      px[i + 3] = Math.round(255 * t);
      // Spill suppression: pull semi-keyed pixels toward neutral luma.
      const spill = 1 - t;
      const avg = (px[i] + px[i + 1] + px[i + 2]) / 3;
      px[i] = Math.round(px[i] * (1 - spill) + avg * spill);
      px[i + 1] = Math.round(px[i + 1] * (1 - spill) + avg * spill);
      px[i + 2] = Math.round(px[i + 2] * (1 - spill) + avg * spill);
    }
  }
}

/** Rectangle mask — the exact geq ramp (box = opaque, feather = edge width). */
export function applyRectMaskToImageData(data: ImageData, params: Record<string, NumberParam>): void {
  const w = data.width, h = data.height;
  const l = n(params, "left", 10) / 100, r = n(params, "right", 10) / 100;
  const t = n(params, "top", 10) / 100, bo = n(params, "bottom", 10) / 100;
  const f = Math.max(0.0001, n(params, "feather", 5) / 100);
  const inv = b(params, "invert");
  const fw = Math.max(0.0001, Math.min(w, h) * f);
  const x0 = w * l, x1 = w * (1 - r);
  const y0 = h * t, y1 = h * (1 - bo);
  const px = data.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.min((x - x0) / fw, (x1 - 1 - x) / fw, (y - y0) / fw, (y1 - 1 - y) / fw);
      const a = Math.max(0, Math.min(1, d));
      const alpha = inv ? 255 * (1 - a) : 255 * a;
      const i = (y * w + x) * 4;
      px[i + 3] = Math.min(px[i + 3], Math.round(alpha));
    }
  }
}

/** Ellipse mask — the exact geq ramp. */
export function applyEllipseMaskToImageData(data: ImageData, params: Record<string, NumberParam>): void {
  const w = data.width, h = data.height;
  const cx = n(params, "centerX", 50) / 100, cy = n(params, "centerY", 50) / 100;
  const rx = Math.max(0.001, n(params, "radiusX", 35) / 100), ry = Math.max(0.001, n(params, "radiusY", 35) / 100);
  const f = Math.max(0.0001, n(params, "feather", 10) / 100);
  const inv = b(params, "invert");
  const px = data.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.sqrt(((x - w * cx) / (w * rx)) ** 2 + ((y - h * cy) / (h * ry)) ** 2);
      const a = Math.max(0, Math.min(1, (1 - d) / f));
      const alpha = inv ? 255 * (1 - a) : 255 * a;
      const i = (y * w + x) * 4;
      px[i + 3] = Math.min(px[i + 3], Math.round(alpha));
    }
  }
}

/** Average a ring of previous frames (uniform weights, tmix semantics). */
export function blendFrameRing(target: ImageData, ring: ImageData[]): void {
  if (ring.length === 0) return;
  const t = target.data;
  const k = ring.length;
  for (const frame of ring) {
    if (frame.width !== target.width || frame.height !== target.height) continue;
    const s = frame.data;
    for (let i = 0; i < t.length; i++) t[i] += s[i] / k;
  }
}

/** Apply one canvas-VFX effect to an ImageData (dispatch by type). */
export function applyCanvasVfx(type: EffectType, data: ImageData, params: Record<string, NumberParam>): void {
  switch (type) {
    case "chromaKey": return applyChromaKeyToImageData(data, params);
    case "rectMask": return applyRectMaskToImageData(data, params);
    case "ellipseMask": return applyEllipseMaskToImageData(data, params);
    default: return;
  }
}
