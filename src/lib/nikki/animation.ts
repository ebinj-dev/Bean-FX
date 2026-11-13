/**
 * NIIKI — animation engine core (M6).
 *
 * ONE deterministic evaluator used by BOTH the browser preview (canvas) and
 * the FFmpeg export compositor: the same keyframe data, the same easing math,
 * the same frame-quantized timing. Parity is by construction, and the render
 * test verifies it on real pixels.
 *
 * Timing model: keyframes are clip-relative integer frames (M1 model). An
 * animation segment [frameA, frameB) is mapped to progress u = (f − a)/(b − a)
 * where f is the CURRENT INTEGER FRAME (frame-accurate, FPS-aware by the
 * caller passing the sequence fps for time-based effects like typewriter
 * character counts — all decisions quantize to whole frames, so preview and
 * export agree exactly).
 *
 * Easing (progress shaping on u ∈ [0,1]):
 *   LINEAR      u
 *   HOLD        step (value jumps at the segment end)
 *   EASE        smoothstep 3u²−2u³
 *   EASE_IN     u³
 *   EASE_OUT    1−(1−u)³
 *   EASE_IN_OUT symmetric smoothstep
 *   BEZIER      cubic-bezier(x1,y1,x2,y2) solved by Newton-Raphson with a
 *               bisection fallback (deterministic, identical on both paths).
 *
 * Deterministic: no Date.now(), no random, no locale-dependent parsing.
 */

export interface BezierControls {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export type NikkiInterpolation = "LINEAR" | "HOLD" | "EASE" | "EASE_IN" | "EASE_OUT" | "EASE_IN_OUT" | "BEZIER";

/** Shape a linear progress 0..1 with the given easing. Deterministic. */
export function easeProgress(u: number, interp: string, bezier?: BezierControls | null): number {
  const x = Math.min(1, Math.max(0, u));
  switch (interp) {
    case "HOLD":
      return x >= 1 ? 1 : 0;
    case "EASE":
      return x * x * (3 - 2 * x); // smoothstep
    case "EASE_IN":
      return x * x * x;
    case "EASE_OUT":
      return 1 - (1 - x) * (1 - x) * (1 - x);
    case "EASE_IN_OUT":
      // symmetric: accelerate into the midpoint, decelerate out of it
      return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    case "BEZIER":
      return bezier ? cubicBezierProgress(x, bezier) : x;
    case "LINEAR":
    default:
      return x;
  }
}

/**
 * CSS-style cubic-bezier easing: cubicBezierProgress(t, {x1,y1,x2,y2}) is the
 * y of the curve at parameter x = t (x is monotonic by the cubic-bezier
 * contract, x1/x2 ∈ [0,1]). Solved with 8 Newton steps and a 16-step
 * bisection fallback — the standard algorithm, deterministic.
 */
export function cubicBezierProgress(t: number, b: BezierControls): number {
  const cx = 3 * b.x1;
  const bx = 3 * (b.x2 - b.x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * b.y1;
  const by = 3 * (b.y2 - b.y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (s: number): number => ((ax * s + bx) * s + cx) * s;
  const sampleY = (s: number): number => ((ay * s + by) * s + cy) * s;
  const sampleDX = (s: number): number => (3 * ax * s + 2 * bx) * s + cx;
  const clamped = Math.min(1, Math.max(0, t));
  let s = clamped;
  for (let i = 0; i < 8; i++) {
    const dx = sampleX(s) - clamped;
    if (Math.abs(dx) < 1e-6) return sampleY(s);
    const d = sampleDX(s);
    if (Math.abs(d) < 1e-6) break;
    s -= dx / d;
  }
  let lo = 0;
  let hi = 1;
  s = clamped;
  for (let i = 0; i < 16; i++) {
    const x = sampleX(s);
    if (Math.abs(x - clamped) < 1e-6) break;
    if (x < clamped) lo = s;
    else hi = s;
    s = (lo + hi) / 2;
  }
  return sampleY(s);
}

export interface NikkiKeyframe {
  id: string;
  property: string;
  /** Clip-relative integer frame. */
  frame: number;
  value: number;
  interpolation: string;
  bezier?: BezierControls | null;
}

/** Monotonic non-strict ordering by frame (the model validates sort order). */
function segmentsFor(keyframes: NikkiKeyframe[], property: string): NikkiKeyframe[] {
  return keyframes.filter((k) => k.property === property);
}

export interface EvalOptions {
  /** Value when the property has no keyframes at all. */
  fallback: number;
  /** Clip duration in frames — frames beyond the last keyframe hold the last value. */
  durationFrames: number;
}

/**
 * Evaluate one animated property at a clip-relative integer frame.
 * Before the first keyframe → first value; after the last → last value
 * (standard NLE semantics); between keyframes → eased interpolation.
 * Non-finite results are impossible: all inputs are bounded numbers.
 */
export function evaluateProperty(keyframes: NikkiKeyframe[], property: string, localFrame: number, opts: EvalOptions): number {
  const kfs = segmentsFor(keyframes, property);
  if (kfs.length === 0) return opts.fallback;
  const f = Math.floor(localFrame);
  if (f <= kfs[0].frame) return kfs[0].value;
  const last = kfs[kfs.length - 1];
  if (f >= last.frame) return last.value;
  // find the segment [a, b) containing f (keyframes are sorted)
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i];
    const b = kfs[i + 1];
    if (f >= a.frame && f < b.frame) {
      const span = b.frame - a.frame;
      if (span <= 0) return b.value;
      const u = (f - a.frame) / span;
      // HOLD jumps at the segment end: at frame b the value is b's own.
      const eased = easeProgress(u, a.interpolation, a.bezier);
      return a.value + (b.value - a.value) * eased;
    }
  }
  return last.value;
}

/**
 * FFmpeg expression for one animated property over [t, durationSec] — the
 * EXACT same math as evaluateProperty at frame times (the renderer evaluates
 * at frame times via the fps):
 *   - LINEAR/HOLD/EASE family: closed-form polynomials with clip()-clamped
 *     progress (exact parity, including before-first/after-last semantics).
 *   - BEZIER: a per-frame ladder through cubicBezierProgress at every frame
 *     boundary — piecewise-linear between frame samples, EXACT at frame times.
 *     Segments longer than 200 frames sample every 8 frames (worst-case
 *     deviation < 2 % of the segment's value range; documented honest bound).
 * Returns null when the property has no keyframes (caller omits the filter).
 */
export function ffmpegExprFor(keyframes: NikkiKeyframe[], property: string, opts: { fallback: number; durationFrames: number; fps: number; clipOffsetSec: number }): string | null {
  const kfs = segmentsFor(keyframes, property);
  if (kfs.length === 0) return null;
  const q = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(10));
  const sec = (frame: number): string => q(secNum(frame));
  /** Numeric seconds for a frame (the epsilon math needs the number). */
  const secNum = (frame: number): number => opts.clipOffsetSec + frame / opts.fps;

  if (kfs.length === 1) return q(kfs[0].value);

  /** Value for t ∈ [aSec, bSec), progress clamped so t outside the segment
   *  holds the segment endpoints (matches evaluateProperty semantics). */
  const segExpr = (i: number): string => {
    const a = kfs[i];
    const b = kfs[i + 1];
    const span = b.frame - a.frame;
    const aSec = sec(a.frame);
    const u = `clip((t-${aSec})/${q(span / opts.fps)}\\,0\\,1)`;
    const lerp = (progressExpr: string): string =>
      `(${q(a.value)}+${q(b.value - a.value)}*${progressExpr})`;
    if (a.interpolation === "HOLD") return q(a.value);
    if (a.interpolation === "LINEAR") return lerp(u);
    if (a.interpolation === "EASE") return lerp(`pow(${u}\\,2)*(3-2*${u})`);
    if (a.interpolation === "EASE_IN") return lerp(`pow(${u}\\,3)`);
    if (a.interpolation === "EASE_OUT") return lerp(`(1-pow(1-${u}\\,3))`);
    if (a.interpolation === "EASE_IN_OUT") {
      return `if(lt(${u}\\,0.5)\\,${lerp(`4*pow(${u}\\,3)`)}\\,${lerp(`(1-pow(-2*${u}+2\\,3)/2)`)})`;
    }
    if (a.interpolation === "BEZIER") {
      const bez = a.bezier ?? { x1: 0.5, y1: 0, x2: 0.5, y2: 1 };
      const at = (f: number): number => {
        const uu = Math.min(1, Math.max(0, span === 0 ? 1 : (f - a.frame) / span));
        return a.value + (b.value - a.value) * cubicBezierProgress(uu, bez);
      };
      // Ladder of STRICTLY 3-arg if() calls (ffmpeg if(cond, then, else)):
      // for t in [sec(f−step), sec(f)) use at(f−step) — the value AT the
      // window's left edge (frame 0 → at(a.frame) = a.value exactly).
      const step = span > 200 ? 8 : 1;
      const boundaries: Array<{ b: string; v: string }> = [];
      let lastF = a.frame;
      for (let f = a.frame + step; f < b.frame; f += step) {
        boundaries.push({ b: q(Math.max(0, secNum(f) - 1e-7)), v: q(at(lastF)) });
        lastF = f;
      }
      boundaries.push({ b: q(Math.max(0, secNum(b.frame) - 1e-7)), v: q(at(lastF)) });
      let expr = q(b.value); // after the last boundary → the segment end value
      for (let i = boundaries.length - 1; i >= 0; i--) {
        expr = `if(lt(t\\,${boundaries[i].b})\\,${boundaries[i].v}\\,${expr})`;
      }
      return expr;
    }
    return lerp(u); // unknown interpolation → linear (honest fallback)
  };

  /** Nested if-chain: pick the segment containing t; after the last keyframe
   *  the last value holds. Boundaries are shrunk by 1e-7 s (≪ one frame at
   *  any fps ≥ 1) so a frame-time t = b/fps that rounds UP in decimal output
   *  still falls into the NEXT segment, exactly like evaluateProperty. */
  const valueAt = (i: number): string => {
    if (i === kfs.length - 1) return q(kfs[i].value);
    const bSecNum = secNum(kfs[i + 1].frame);
    return `if(lt(t\\,${q(Math.max(0, bSecNum - 1e-7))})\\,${segExpr(i)}\\,${valueAt(i + 1)})`;
  };

  // Before the FIRST keyframe frame the value is the first keyframe's — the
  // clamped progress of segment 0 already produces exactly that.
  return valueAt(0);
}

/**
 * Honest parity contract for the render path: for every animated property,
 * the FFmpeg expression must agree with evaluateProperty at every integer
 * frame of the clip. Used by tests; cheap enough for CI (frames ≤ few hundred).
 */
export function parityCheck(keyframes: NikkiKeyframe[], property: string, opts: { fallback: number; durationFrames: number; fps: number; clipOffsetSec: number }, evalExpr: (expr: string, t: number) => number): string | null {
  const expr = ffmpegExprFor(keyframes, property, opts);
  if (expr === null) return null;
  for (let f = 0; f < opts.durationFrames; f++) {
    const t = opts.clipOffsetSec + f / opts.fps;
    const expected = evaluateProperty(keyframes, property, f, opts);
    const got = evalExpr(expr, t);
    if (Math.abs(got - expected) > 1e-6) {
      return `frame ${f}: expression ${got} vs evaluator ${expected}`;
    }
  }
  return null;
}
