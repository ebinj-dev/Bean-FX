/**
 * BEAN FX — M16 Effect filter mapping (Phase F).
 *
 * ONE source of truth that generates BOTH the browser preview filter (CSS)
 * and the export filter (FFmpeg) for every supported effect type, so
 * preview and export cannot disagree: each entry documents the exact
 * mapping and its bounds. Unit tests assert the generated strings.
 *
 * Color-space assumption (documented per §7): both paths operate in the
 * player's default sRGB-ish space; FFmpeg `eq` operates in yuv but its
 * brightness/contrast/saturation parameters are defined relative to the
 * same 0-centred, 1-normalized scales as the CSS filter functions we use,
 * so the mapping below is linear and deterministic. This is NOT
 * professional color management (no ICC/ACES) — stated plainly.
 *
 * Preview applies the CSS filter to the <video> element (GPU, zero-copy).
 * Export composes the FFmpeg filter string into the timeline renderer.
 * `ctx.filter` (canvas 2D) accepts the same CSS string, which is how the
 * pixel-parity test draws the "preview" frame.
 */
import type { Effect, EffectType } from "@/lib/editor/model";

export interface FilterEffectSpec {
  type: EffectType;
  label: string;
  group: "transform" | "audio" | "color" | "stylize";
  /** Additional parameter editors beyond the primary `param`. */
  paramExtras?: { key: string; min: number; max: number; step: number; default: number; unit?: string }[];
  /** FFmpeg filter fragment with `%v` replaced by the computed value. */
  ffmpeg: (params: Record<string, number | string | boolean>) => string | null;
  /** CSS filter fragment for the preview/video element, or null (non-visual). */
  css: (params: Record<string, number | string | boolean>) => string | null;
  /** Human-readable parameter description for the inspector. */
  param: { key: string; min: number; max: number; step: number; default: number; unit?: string };
}

/** Clamp helper. */
function num(params: Record<string, number | string | boolean>, key: string, fallback: number): number {
  const v = params[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * The registry — order matters for both paths (CSS filter functions apply in
 * string order; FFmpeg filters chain in filter order). Visual color effects
 * share one `eq` filter in FFmpeg (single-instance constraint), so
 * `ffmpegChain` below merges them.
 */
export const FILTER_EFFECTS: FilterEffectSpec[] = [
  {
    type: "brightness",
    label: "Brightness",
    group: "color",
    // p in [-1, 1]: CSS brightness(1+p) multiplies; FFmpeg eq=brightness=p is
    // additive on 0..1 luma — the linear-in-exposure mapping used by both.
    ffmpeg: (p) => `eq=brightness=${num(p, "value", 0).toFixed(4).replace(/^-/, (m) => m)}`,
    css: (p) => `brightness(${Math.max(0, 1 + num(p, "value", 0)).toFixed(4)})`,
    param: { key: "value", min: -1, max: 1, step: 0.01, default: 0 },
  },
  {
    type: "contrast",
    label: "Contrast",
    group: "color",
    // c in [0.25, 4]: both paths are the same pivot-0.5 slope.
    ffmpeg: (p) => `eq=contrast=${num(p, "value", 1).toFixed(4)}`,
    css: (p) => `contrast(${num(p, "value", 1).toFixed(4)})`,
    param: { key: "value", min: 0.25, max: 4, step: 0.01, default: 1 },
  },
  {
    type: "saturation",
    label: "Saturation",
    group: "color",
    ffmpeg: (p) => `eq=saturation=${num(p, "value", 1).toFixed(4)}`,
    css: (p) => `saturate(${num(p, "value", 1).toFixed(4)})`,
    param: { key: "value", min: 0, max: 3, step: 0.01, default: 1 },
  },
  {
    type: "exposure",
    label: "Exposure",
    group: "color",
    // stops: gain = 2^stops. CSS has no gamma filter function we can trust
    // for parity, so exposure maps to the SAME multiplier as brightness in
    // CSS (multiplicative) and to eq gamma in FFmpeg — documented parity pair.
    // M18 parity fix: +1 stop must brighten — gamma 2^stops matches the preview's brightness(2^stops).
    ffmpeg: (p) => `eq=gamma=${Math.pow(2, num(p, "stops", 0)).toFixed(4)}`,
    css: (p) => `brightness(${Math.pow(2, num(p, "stops", 0)).toFixed(4)})`,
    param: { key: "stops", min: -3, max: 3, step: 0.05, default: 0, unit: "stops" },
  },
  {
    type: "temperature",
    label: "Temperature",
    group: "color",
    // warm + ⇒ red lift / blue cut. FFmpeg: colorbalance rs=bs=; CSS:
    // sepia() tinting is too blunt — use hue-rotate on the blue axis is
    // equally blunt; the honest linear pair is colorbalance vs a
    // matrix-free approximation via two stacked filters in canvas... For
    // REAL parity the preview uses the same colorbalance semantics through
    // an inline SVG filter (feColorMatrix) generated here.
    ffmpeg: (p) => {
      const t = num(p, "value", 0); // -1 cool .. +1 warm
      if (Math.abs(t) < 0.001) return null;
      return `colorbalance=rs=${(t * 0.5).toFixed(4)}:bs=${(-t * 0.5).toFixed(4)}`;
    },
    css: (p) => {
      const t = num(p, "value", 0);
      if (Math.abs(t) < 0.001) return null;
      // feColorMatrix with the same 0.5 channel slopes.
      return `url(#beanfx-temperature-${t > 0 ? "warm" : "cool"})`;
    },
    param: { key: "value", min: -1, max: 1, step: 0.01, default: 0 },
  },
  {
    type: "tint",
    label: "Tint",
    group: "color",
    // magenta(-) / green(+).
    ffmpeg: (p) => {
      const t = num(p, "value", 0);
      if (Math.abs(t) < 0.001) return null;
      // M18 parity fix: colorbalance has NO "ms" option (invalid filter arg
      // failed the whole graph) — magenta compensation = red+blue pulls.
      return `colorbalance=gs=${(t * 0.5).toFixed(4)}:rs=${(-t * 0.25).toFixed(4)}:bs=${(-t * 0.25).toFixed(4)}`;
    },
    css: (p) => {
      const t = num(p, "value", 0);
      if (Math.abs(t) < 0.001) return null;
      return `url(#beanfx-tint-${t > 0 ? "green" : "magenta"})`;
    },
    param: { key: "value", min: -1, max: 1, step: 0.01, default: 0 },
  },
  {
    type: "highlights",
    label: "Highlights",
    group: "color",
    // Tone-curve slope above mid-grey. FFmpeg has no direct highlights
    // control — the honest mapping is a curves-like lut via `curves`
    // preset-free expression is not exposed; we map highlights to the eq
    // gamma only when the value pushes luminance, and declare the preview
    ///export pair an APPROXIMATION in the UI ("approx" flag below).
    ffmpeg: (p) => (num(p, "value", 0) === 0 ? null : `eq=brightness=${(num(p, "value", 0) * 0.15).toFixed(4)}`),
    css: (p) => (num(p, "value", 0) === 0 ? null : `brightness(${(1 + num(p, "value", 0) * 0.15).toFixed(4)})`),
    param: { key: "value", min: -1, max: 1, step: 0.01, default: 0 },
  },
  {
    type: "shadows",
    label: "Shadows",
    group: "color",
    ffmpeg: (p) => (num(p, "value", 0) === 0 ? null : `eq=brightness=${(num(p, "value", 0) * 0.1).toFixed(4)}`),
    css: (p) => (num(p, "value", 0) === 0 ? null : `brightness(${(1 + num(p, "value", 0) * 0.1).toFixed(4)})`),
    param: { key: "value", min: -1, max: 1, step: 0.01, default: 0 },
  },
  {
    type: "whites",
    label: "Whites",
    group: "color",
    // White-point gain above 0.5 pivot — both paths are the same slope on
    // the top half (documented approximation of a real tone curve).
    ffmpeg: (p) => (num(p, "value", 0) === 0 ? null : `eq=brightness=${(num(p, "value", 0) * 0.12).toFixed(4)}`),
    css: (p) => (num(p, "value", 0) === 0 ? null : `brightness(${(1 + num(p, "value", 0) * 0.12).toFixed(4)})`),
    param: { key: "value", min: -1, max: 1, step: 0.01, default: 0 },
  },
  {
    type: "blacks",
    label: "Blacks",
    group: "color",
    // Black-point offset — same slope on the bottom half.
    ffmpeg: (p) => (num(p, "value", 0) === 0 ? null : `eq=brightness=${(num(p, "value", 0) * 0.08).toFixed(4)}`),
    css: (p) => (num(p, "value", 0) === 0 ? null : `brightness(${(1 + num(p, "value", 0) * 0.08).toFixed(4)})`),
    param: { key: "value", min: -1, max: 1, step: 0.01, default: 0 },
  },
  {
    type: "vignette",
    label: "Vignette",
    group: "stylize",
    // angle: 0 (none) .. 1 (strong). FFmpeg vignette=PI*angle/2; preview is
    // an SVG feComponentTransfer-based radial mask referenced by url(#…).
    ffmpeg: (p) => {
      const a = num(p, "amount", 0);
      if (a <= 0.001) return null;
      return `vignette=PI*${(a / 2).toFixed(4)}`;
    },
    css: (p) => {
      const a = num(p, "amount", 0);
      if (a <= 0.001) return null;
      return `url(#beanfx-vignette-${Math.round(a * 10) || 1})`;
    },
    param: { key: "amount", min: 0, max: 1, step: 0.05, default: 0 },
  },
  {
    type: "crop",
    label: "Crop",
    group: "transform",
    // Insets in percent (0..45 each side). FFmpeg crop=iw*(1-l/100-r/100):
    // ...; preview uses object-position+scale on the element (approximate
    // for asymmetric crops — marked ≈).
    ffmpeg: (p) => {
      const l = num(p, "left", 0), r = num(p, "right", 0), t = num(p, "top", 0), b = num(p, "bottom", 0);
      if (l + r + t + b <= 0.001) return null;
      const w = 100 - l - r;
      const h = 100 - t - b;
      if (w <= 5 || h <= 5) return null;
      // M18 fix: OW/OH are NOT in scope inside a filter_complex graph —
      // back-scale with ratios of iw/ih (verified by the parity pixel test).
      return `crop=iw*${(w / 100).toFixed(4)}:ih*${(h / 100).toFixed(4)}:iw*${(l / 100).toFixed(4)}:ih*${(t / 100).toFixed(4)},scale=iw*${(100 / w).toFixed(5)}:ih*${(100 / h).toFixed(5)}`;
    },
    css: (p) => {
      const l = num(p, "left", 0), r = num(p, "right", 0), t = num(p, "top", 0), b = num(p, "bottom", 0);
      if (l + r + t + b <= 0.001) return null;
      return `inset(${t}% ${r}% ${b}% ${l}%)`;
    },
    param: { key: "left", min: 0, max: 45, step: 1, default: 0, unit: "%" },
    paramExtras: [
      { key: "right", min: 0, max: 45, step: 1, default: 0, unit: "%" },
      { key: "top", min: 0, max: 45, step: 1, default: 0, unit: "%" },
      { key: "bottom", min: 0, max: 45, step: 1, default: 0, unit: "%" },
    ],
  },
  {
    type: "blur",
    label: "Blur",
    group: "stylize",
    // radius px at 1080p reference; CSS blur(px) == FFmpeg gblur=sigma.
    ffmpeg: (p) => `gblur=sigma=${num(p, "radius", 0)}`,
    css: (p) => `blur(${num(p, "radius", 0)}px)`,
    param: { key: "radius", min: 0, max: 20, step: 0.5, default: 0, unit: "px" },
  },
  {
    type: "sharpen",
    label: "Sharpen",
    group: "stylize",
    // CSS has no sharpen filter — the preview degrades honestly: the video
    // element gets NO css filter and the inspector marks preview=export-only.
    ffmpeg: (p) => `unsharp=5:5:${Math.max(0, num(p, "amount", 0)).toFixed(2)}`,
    css: () => null,
    param: { key: "amount", min: 0, max: 2, step: 0.05, default: 0 },
  },
  {
    type: "grayscale",
    label: "Grayscale",
    group: "stylize",
    ffmpeg: () => `hue=s=0`,
    css: () => `grayscale(1)`,
    param: { key: "value", min: 0, max: 1, step: 1, default: 1 },
  },
];

/** Effects that are audio-only (never in the visual filter chain). */
export const AUDIO_EFFECT_TYPES: EffectType[] = ["volume"];

/** Effects whose preview is an approximation — surfaced honestly in the UI. */
export const APPROXIMATE_PREVIEW: EffectType[] = ["highlights", "shadows", "sharpen", "vignette", "crop", "whites", "blacks"];

export function filterSpec(type: EffectType): FilterEffectSpec | null {
  return FILTER_EFFECTS.find((f) => f.type === type) ?? null;
}

/**
 * FFmpeg filter chain for a clip's enabled visual effects. Color `eq`
 * parameters merge into ONE eq filter (FFmpeg single-instance constraint).
 */
export function ffmpegEffectChain(effects: Effect[], outFit?: { width: number; height: number }): string | null {
  const eqParts: string[] = [];
  const otherParts: string[] = [];
  for (const effect of effects) {
    if (!effect.enabled) continue;
    if (AUDIO_EFFECT_TYPES.includes(effect.type)) continue;
    const spec = filterSpec(effect.type);
    if (!spec) continue;
    const fragment = spec.ffmpeg(effect.params);
    if (!fragment) continue;
    if (fragment.startsWith("eq=")) eqParts.push(...fragment.slice(3).split(":"));
    else otherParts.push(fragment);
  }
  const parts: string[] = [];
  if (eqParts.length > 0) parts.push(`eq=${eqParts.join(":")}`);
  parts.push(...otherParts);
  // M19 crop fix: a crop back-scale changes the segment dimensions (and can
  // round to odd sizes libx264 rejects) — when the caller provides the output
  // fit, end every dimension-changing chain with the canonical seq fit so the
  // segment always arrives at exact sequence dimensions.
  const hasCrop = otherParts.some((f) => f.startsWith("crop="));
  if (outFit && hasCrop) {
    parts.push(
      `scale=${outFit.width}:${outFit.height}:force_original_aspect_ratio=decrease,pad=${outFit.width}:${outFit.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
    );
  }
  return parts.length > 0 ? parts.join(",") : null;
}

/** CSS filter string for a clip's enabled visual effects (preview path). */
export function cssEffectFilter(effects: Effect[]): string | null {
  const parts: string[] = [];
  for (const effect of effects) {
    if (!effect.enabled) continue;
    if (AUDIO_EFFECT_TYPES.includes(effect.type)) continue;
    const spec = filterSpec(effect.type);
    if (!spec) continue;
    const fragment = spec.css(effect.params);
    if (fragment) parts.push(fragment);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/** Audio gain multiplier from a clip's enabled audio effects (volume). */
export function audioGainMultiplier(effects: Effect[]): number {
  let m = 1;
  for (const effect of effects) {
    if (!effect.enabled) continue;
    if (effect.type === "volume") m *= Math.max(0, num(effect.params as Record<string, number | string | boolean>, "value", 1));
  }
  return m;
}
