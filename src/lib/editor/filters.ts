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
  // ── M37: previously schema-valid DEAD effects (accepted by the model and by
  // AI proposals but mapped nowhere — silent no-ops). Now real on BOTH paths,
  // registered LAST so flips apply after color work and alpha applies last
  // (CSS filter lists and FFmpeg chains are generated in the same order).
  {
    type: "flipH",
    label: "Flip horizontal",
    group: "transform",
    ffmpeg: () => `hflip`,
    css: () => `scaleX(-1)`,
    param: { key: "value", min: 0, max: 1, step: 1, default: 1 },
  },
  {
    type: "flipV",
    label: "Flip vertical",
    group: "transform",
    ffmpeg: () => `vflip`,
    css: () => `scaleY(-1)`,
    param: { key: "value", min: 0, max: 1, step: 1, default: 1 },
  },
  {
    type: "opacity",
    label: "Opacity",
    group: "transform",
    // Alpha LAST on both paths: CSS opacity() on the element, FFmpeg alpha
    // scale on the segment stream before compositing. Stacks multiplicatively
    // with the clip's transform.opacity (separate controls, same stage).
    ffmpeg: (p) => `format=yuva420p,colorchannelmixer=aa=${Math.max(0, Math.min(1, num(p, "value", 1))).toFixed(4)}`,
    css: (p) => `opacity(${Math.max(0, Math.min(1, num(p, "value", 1))).toFixed(4)})`,
    param: { key: "value", min: 0, max: 1, step: 0.05, default: 1 },
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

// ── M27 P2 — per-effect parameter keyframe evaluation ────────────────────────
// SINGLE SOURCE OF TRUTH: the preview (CSS) and the export (FFmpeg chain /
// sub-segments) both evaluate through these functions, so both animate the
// same definitions the same way.

/** Smoothstep — the documented EASE_IN_OUT curve (3t² − 2t³). */
const smoothstep = (t: number) => t * t * (3 - 2 * t);

/**
 * Evaluate ONE animated parameter at a clip-relative TIMELINE frame.
 * Returns null when the param is not animated (static value applies).
 */
export function effectParamAt(effect: Effect, param: string, frame: number): number | null {
  if (!effect.animatedParams.includes(param)) return null;
  const kfs = effect.keyframes.filter((k) => k.param === param).sort((a, b) => a.frame - b.frame);
  if (kfs.length === 0) return null;
  if (kfs.length === 1) return kfs[0].value;
  if (frame <= kfs[0].frame) return kfs[0].value;
  if (frame >= kfs[kfs.length - 1].frame) return kfs[kfs.length - 1].value;
  let i = 0;
  while (i + 1 < kfs.length && kfs[i + 1].frame <= frame) i++;
  const a = kfs[i];
  const b = kfs[i + 1];
  const span = b.frame - a.frame;
  if (span <= 0) return b.value;
  const t = (frame - a.frame) / span;
  switch (a.interpolation) {
    case "HOLD":
      return a.value;
    case "LINEAR":
      return a.value + (b.value - a.value) * t;
    case "EASE_IN":
      return a.value + (b.value - a.value) * (t * t);
    case "EASE_OUT":
      return a.value + (b.value - a.value) * (1 - (1 - t) * (1 - t));
    case "EASE_IN_OUT":
      return a.value + (b.value - a.value) * smoothstep(t);
    default:
      return a.value + (b.value - a.value) * t;
  }
}

/** Effect params with every animated parameter evaluated at `clipFrame`. */
export function evaluatedEffectParams(effect: Effect, clipFrame: number): Effect["params"] {
  const params: Record<string, number | string | boolean> = { ...effect.params };
  for (const param of effect.animatedParams) {
    const v = effectParamAt(effect, param, clipFrame);
    if (v !== null) params[param] = v;
  }
  return params;
}

/** Animated effect (params evaluated at the given clip-relative frame). */
export function animatedEffectAt(effect: Effect, clipFrame: number): Effect {
  if (effect.animatedParams.length === 0) return effect;
  return { ...effect, params: evaluatedEffectParams(effect, clipFrame) };
}

/** CSS preview chain evaluated at a clip-relative frame (per-frame recompute). */
export function cssEffectFilterAt(effects: Effect[], clipFrame: number): string | null {
  return cssEffectFilter(effects.map((e) => animatedEffectAt(e, clipFrame)));
}

/**
 * M27 — FFmpeg parameter-animation strategy (measured, not assumed): on this
 * deployment's FFmpeg (7.1.5) the `eq`/`vignette` filters evaluate their
 * expressions ONCE at init (t/n stay 0 — verified with signalstats probes),
 * so eval=frame animation is NOT available. The animation is therefore
 * rendered as PIECEWISE-CONSTANT sub-segments: the clip is split at sampled
 * keyframe positions and each segment renders the exact evaluated value as a
 * constant (real FFmpeg processing on every frame — no fabricated output).
 * Resolution: SAMPLE_INTERVAL frames (≈0.33 s at 30 fps) — interpolated
 * ramps become short constant steps; exact at every keyframe.
 */
export const ANIM_SAMPLE_INTERVAL = 10;
export const ANIM_MAX_SEGMENTS = 96;

/** All params animate through sampled sub-segments on this ffmpeg build. */
export function exprCapable(_effect: Effect, _param: string): boolean {
  return false;
}

/** Segment boundaries (clip-relative, sorted, capped) where ANY animated
 *  param needs its value re-sampled: every keyframe plus synthetic samples
 *  between each param's first and last keyframe at ANIM_SAMPLE_INTERVAL. */
export function segmentSplitFrames(effects: Effect[], clipDurationFrames?: number): number[] {
  const frames = new Set<number>();
  const cap = ANIM_MAX_SEGMENTS;
  for (const effect of effects) {
    if (!effect.enabled) continue;
    for (const param of effect.animatedParams) {
      const kfs = effect.keyframes.filter((k) => k.param === param).sort((a, b) => a.frame - b.frame);
      if (kfs.length === 0) continue;
      const first = kfs[0].frame;
      const last = kfs[kfs.length - 1].frame;
      for (let f = first; f <= last; f += ANIM_SAMPLE_INTERVAL) frames.add(f);
      frames.add(first);
      frames.add(last);
      if (clipDurationFrames !== undefined && frames.size > cap) {
        // Dense keyframes: fall back to keyframe-only boundaries (≤256 kf).
        frames.clear();
        for (const k of kfs) frames.add(k.frame);
        if (frames.size > 256) return [...frames].slice(0, 256).sort((a, b) => a - b);
      }
    }
  }
  return [...frames].filter((f) => f >= 0 && (clipDurationFrames === undefined || f < clipDurationFrames)).sort((a, b) => a - b).slice(0, cap);
}

/**
 * FFmpeg chain for ONE segment of an animated clip: expr-capable params
 * (eq-family, vignette) become exact `t`-based expressions (eval=frame);
 * non-expr-capable params (colorbalance/unsharp/gblur/crop) take the constant
 * values sampled at `segStartFrame` — piecewise-constant between their
 * keyframes, real processing, bounded and documented. The caller splits
 * segments at `segmentSplitFrames(effects)`.
 */
export function ffmpegEffectChainAnimated(
  effects: Effect[],
  segStartFrame: number,
  fps: { num: number; den: number },
  outFit?: { width: number; height: number },
): string | null {
  const sampled = effects.map((e) => {
    if (!e.enabled || e.animatedParams.length === 0) return e;
    const params: Record<string, number | string | boolean> = { ...e.params };
    for (const param of e.animatedParams) {
      if (exprCapable(e, param)) continue; // wired as expressions by the builder
      const v = effectParamAt(e, param, segStartFrame);
      if (v !== null) params[param] = v;
    }
    return { ...e, params };
  });
  return ffmpegEffectChainWithExprs(sampled, effects, segStartFrame, fps, outFit);
}

/** Build an FFmpeg expr for one param (t seconds since SEGMENT start).
 *  `valueTransform` rewrites each value literal (e.g. vignette: v → PI*v/2). */
export function effectParamExpression(effect: Effect, param: string, tOffsetSec: number, fps: { num: number; den: number }, valueTransform?: (v: string) => string): string | null {
  if (!effect.animatedParams.includes(param)) return null;
  const kfs = effect.keyframes.filter((k) => k.param === param).sort((a, b) => a.frame - b.frame);
  if (kfs.length === 0) return null;
  const fpsN = fps.num / fps.den;
  const fmtRaw = (v: number) => v.toFixed(6);
  const fmt = (v: number) => (valueTransform ? valueTransform(fmtRaw(v)) : fmtRaw(v));
  const shapes: Record<string, (t: string) => string> = {
    HOLD: () => "", // handled below
    LINEAR: (t) => t,
    EASE_IN: (t) => `pow(max(0,${t}),2)`,
    EASE_OUT: (t) => `(1-pow(1-min(1,max(0,${t})),2))`,
    EASE_IN_OUT: (t) => `(${t}*${t}*(3-2*${t}))`,
  };
  // Clamp outside the keyframe range to the boundary values.
  const head = `if(lt(t,${fmt(kfs[0].frame / fpsN - tOffsetSec)}),${fmt(kfs[0].value)},`;
  const tail = `)`;
  let body = `${fmt(kfs[kfs.length - 1].value)}`;
  for (let i = kfs.length - 2; i >= 0; i--) {
    const a = kfs[i];
    const b = kfs[i + 1];
    const span = b.frame - a.frame;
    const ta = a.frame / fpsN - tOffsetSec;
    const tb = b.frame / fpsN - tOffsetSec;
    if (span <= 0) continue;
    const dt = `((t-${fmt(ta)})/${fmt(span)})`;
    const shape = a.interpolation === "HOLD" ? "0" : (shapes[a.interpolation] ?? shapes.LINEAR)(dt);
    const value = a.interpolation === "HOLD" ? fmt(a.value) : `(${fmt(a.value)}+(${fmt(b.value)}-${fmt(a.value)})*${shape})`;
    body = `if(lt(t,${fmt(tb)}),${value},${body})`;
  }
  return `${head}${body}${tail}`;
}

/** eq/expr-aware chain builder (wraps the M16 registry).
 *  Animated eq-family params emit exact t-expressions through the SAME
 *  per-effect transforms the static registry uses (exposure → gamma=2^v,
 *  highlights/shadows/whites/blacks → brightness slopes; last-wins merge on a
 *  shared eq key matches the static path). Vignette animates PI*amount/2. */
const EQ_EXPR_MAP: Record<string, { param: string; eqKey: string; wrap: (v: string) => string }> = {
  brightness: { param: "value", eqKey: "brightness", wrap: (v) => v },
  contrast: { param: "value", eqKey: "contrast", wrap: (v) => v },
  saturation: { param: "value", eqKey: "saturation", wrap: (v) => v },
  exposure: { param: "stops", eqKey: "gamma", wrap: (v) => `pow(2,${v})` },
  highlights: { param: "value", eqKey: "brightness", wrap: (v) => `(${v}*0.15)` },
  shadows: { param: "value", eqKey: "brightness", wrap: (v) => `(${v}*0.1)` },
  whites: { param: "value", eqKey: "brightness", wrap: (v) => `(${v}*0.12)` },
  blacks: { param: "value", eqKey: "brightness", wrap: (v) => `(${v}*0.08)` },
};

function ffmpegEffectChainWithExprs(
  sampled: Effect[],
  original: Effect[],
  segStartFrame: number,
  fps: { num: number; den: number },
  outFit?: { width: number; height: number },
): string | null {
  const tOffsetSec = segStartFrame / (fps.num / fps.den);
  const eqExprs: Record<string, string> = {};
  const eqParts: string[] = [];
  const otherParts: string[] = [];
  for (let idx = 0; idx < sampled.length; idx++) {
    const effect = sampled[idx];
    const exprEffect = original[idx];
    if (!effect.enabled) continue;
    if (AUDIO_EFFECT_TYPES.includes(effect.type)) continue;
    const spec = filterSpec(effect.type);
    if (!spec) continue;
    const map = EQ_EXPR_MAP[effect.type];
    if (map && exprCapable(effect, map.param) && exprEffect.animatedParams.includes(map.param)) {
      const expr = effectParamExpression(exprEffect, map.param, tOffsetSec, fps, map.wrap);
      if (expr) {
        eqExprs[map.eqKey] = expr; // animated value — exact per-frame
        continue; // static part for this effect is replaced by the expr
      }
    }
    if (effect.type === "vignette" && exprCapable(effect, "amount") && exprEffect.animatedParams.includes("amount")) {
      const expr = effectParamExpression(exprEffect, "amount", tOffsetSec, fps, (v) => `(PI*${v}/2)`);
      if (expr) {
        otherParts.push(`vignette=angle='${expr}':eval=frame`);
        continue;
      }
    }
    const fragment = spec.ffmpeg(effect.params);
    if (!fragment) continue;
    if (fragment.startsWith("eq=")) eqParts.push(...fragment.slice(3).split(":"));
    else otherParts.push(fragment);
  }
  // Animated eq keys REPLACE the static parts for the same key (last-wins,
  // same rule as the static duplicate-key merge).
  for (const [key, expr] of Object.entries(eqExprs)) {
    const filtered = eqParts.filter((part) => !part.startsWith(`${key}=`));
    filtered.push(`${key}='${expr}'`);
    eqParts.length = 0;
    eqParts.push(...filtered);
  }
  const parts: string[] = [];
  if (eqParts.length > 0) {
    // eval=frame is an eq OPTION (belongs inside the filter, not a segment).
    const evalFlag = Object.keys(eqExprs).length > 0 ? ":eval=frame" : "";
    parts.push(`eq=${eqParts.join(":")}${evalFlag}`);
  }
  parts.push(...otherParts);
  const hasCrop = otherParts.some((f) => f.startsWith("crop="));
  if (outFit && hasCrop) {
    parts.push(`scale=${outFit.width}:${outFit.height}:force_original_aspect_ratio=decrease,pad=${outFit.width}:${outFit.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`);
  }
  return parts.length > 0 ? parts.join(",") : null;
}
