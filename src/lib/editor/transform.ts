/**
 * BEAN FX — M37: clip transform engine (position / scale / rotation / opacity).
 *
 * ONE evaluation module shared by the preview (Program monitor + composition
 * canvas), the composition-canvas boxes and the export renderer, so preview
 * and export cannot disagree — the same contract as lib/editor/audio.ts and
 * lib/editor/filters.ts.
 *
 * Coordinates and semantics (the model's documented convention, see
 * composition-canvas.tsx): transform.x/y are SEQUENCE composition pixels,
 * offset from the frame CENTER; scale is a multiplier around the center;
 * rotation is degrees; opacity is 0..1. CSS applies its transform functions
 * right-to-left, so `translate(x) scale(s) rotate(r)` rotates first, then
 * scales, then translates — the export chain applies the same order
 * (rotate → scale → overlay position) and uniform scale commutes with
 * rotation, so the two paths agree.
 *
 * Animation: property keyframes (clip.keyframes, clip-relative TIMELINE
 * frames) are evaluated through lib/nikki/animation.ts — the SAME evaluator
 * the NIIKI graphics engine uses (LINEAR/HOLD/EASE* closed-form, BEZIER as a
 * frame-exact ladder), so all animated properties across the app share one
 * interpolation contract. Without keyframes the static clip.transform value
 * applies.
 *
 * Export strategy on this deployment's FFmpeg (7.1.5, measured — see the M27
 * note in filters.ts):
 *   - position (x/y): overlay filter expressions, eval=frame — EXACT
 *     piecewise-linear (the overlay filter, unlike eq, genuinely evaluates
 *     per frame; verified empirically before implementation).
 *   - rotation: `rotate` angle expression per frame (exact) when no scale or
 *     opacity animation forces segment splits; constant per sampled segment
 *     otherwise.
 *   - scale / opacity: no per-frame expression support on this build (scale
 *     expressions have no `t`; overlay's alpha is a format flag) — they
 *     render as PIECEWISE-CONSTANT sampled segments via the established M27
 *     machinery (real FFmpeg processing every frame; ramps become short
 *     constant steps, exact at every keyframe). Documented honest bound.
 */
import type { Clip, Keyframe, Sequence } from "./model";
import { evaluateProperty, ffmpegExprFor, type NikkiKeyframe } from "@/lib/nikki/animation";
import { ANIM_SAMPLE_INTERVAL, ANIM_MAX_SEGMENTS } from "./filters";

/** Clip transform properties that support keyframes (model: KeyframeProperty). */
export const TRANSFORM_PROPS = ["x", "y", "scale", "rotation", "opacity"] as const;
export type TransformProp = (typeof TRANSFORM_PROPS)[number];

/** A resolved transform at one instant (composition-pixel convention). */
export interface ResolvedTransform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
}

const DEFAULT_TRANSFORM: ResolvedTransform = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };

/** Keyframes for one transform property, sorted by clip-relative frame. */
export function transformKeyframes(clip: Clip, prop: TransformProp): Keyframe[] {
  return clip.keyframes.filter((k) => k.property === prop).sort((a, b) => a.frame - b.frame);
}

/** True when any transform property has keyframes (the animated case). */
export function clipHasTransformAnimation(clip: Clip): boolean {
  return TRANSFORM_PROPS.some((p) => transformKeyframes(clip, p).length > 0);
}

/**
 * Resolved transform at a timeline frame. Keyframed properties evaluate
 * through the shared NIIKI evaluator; properties without keyframes fall back
 * to the clip's static transform value (fallback semantics — not a multiply —
 * because property keyframes DEFINE the value like every NLE).
 */
export function transformAt(clip: Clip, timelineFrame: number): ResolvedTransform {
  const out = { ...DEFAULT_TRANSFORM, ...clip.transform };
  const rel = Math.max(0, timelineFrame - clip.timelineStartFrame);
  for (const prop of TRANSFORM_PROPS) {
    const kfs = transformKeyframes(clip, prop);
    if (kfs.length === 0) continue;
    out[prop] = evaluateProperty(kfs as NikkiKeyframe[], prop, rel, {
      fallback: out[prop],
      durationFrames: clip.timelineDurationFrames,
    });
  }
  return out;
}

/** Identity check with a small opacity tolerance (1 → identity alpha). */
export function transformIsIdentity(t: ResolvedTransform): boolean {
  return Math.abs(t.x) < 1e-9 && Math.abs(t.y) < 1e-9 && Math.abs(t.scale - 1) < 1e-9 && Math.abs(t.rotation) < 1e-9 && t.opacity > 0.999;
}

/** True when the clip carries any transform at all (static or animated). */
export function clipHasTransform(clip: Clip): boolean {
  return !transformIsIdentity({ ...DEFAULT_TRANSFORM, ...clip.transform }) || clipHasTransformAnimation(clip);
}

/** True when scale or opacity is keyframed — those two force segment splits
 *  (piecewise-constant export); x/y and rotation alone animate exactly. */
export function transformNeedsSegments(clip: Clip): boolean {
  return transformKeyframes(clip, "scale").length > 0 || transformKeyframes(clip, "opacity").length > 0;
}

/**
 * Segment boundaries (clip-relative, sorted) where a piecewise-constant
 * transform must be re-sampled: keyframe frames plus ANIM_SAMPLE_INTERVAL
 * synthetic samples between each animated property's first and last keyframe
 * — the SAME sampling contract as segmentSplitFrames in filters.ts.
 */
export function transformSplitFrames(clip: Clip, clipDurationFrames?: number): number[] {
  const frames = new Set<number>();
  const props: TransformProp[] = ["scale", "opacity"];
  for (const prop of props) {
    const kfs = transformKeyframes(clip, prop);
    if (kfs.length === 0) continue;
    const first = kfs[0].frame;
    const last = kfs[kfs.length - 1].frame;
    for (let f = first; f <= last; f += ANIM_SAMPLE_INTERVAL) frames.add(f);
    frames.add(first);
    frames.add(last);
    if (clipDurationFrames !== undefined && frames.size > ANIM_MAX_SEGMENTS) {
      frames.clear();
      for (const k of kfs) frames.add(k.frame);
    }
  }
  return [...frames].filter((f) => f >= 0 && (clipDurationFrames === undefined || f < clipDurationFrames)).sort((a, b) => a - b).slice(0, ANIM_MAX_SEGMENTS);
}

/** All clip-relative frames where ANY transform property changes value:
 *  the sampled split set for scale/opacity plus every keyframe of the exact
 *  properties (x/y/rotation — they carry no sampled boundaries). */
export function transformBoundaryFrames(clip: Clip, clipDurationFrames?: number): number[] {
  const frames = new Set<number>(transformSplitFrames(clip, clipDurationFrames));
  for (const prop of ["x", "y", "rotation"] as TransformProp[]) {
    for (const k of transformKeyframes(clip, prop)) frames.add(k.frame);
  }
  return [...frames].filter((f) => f >= 0 && (clipDurationFrames === undefined || f < clipDurationFrames)).sort((a, b) => a - b);
}

// ── Preview (CSS) ─────────────────────────────────────────────────────────────

/**
 * CSS transform + opacity for the preview element. `displayScale` is the
 * composition→display factor (rendered width ÷ sequence width of the
 * contain-fit element); transform.x/y are composition pixels, so they scale
 * with the frame display size exactly like the export's sequence pixels.
 * Returns null entries when the transform is the identity (no style churn).
 */
export function cssTransformStyle(t: ResolvedTransform, displayScale: number): { transform: string | null; opacity: string | null } {
  if (transformIsIdentity(t)) return { transform: null, opacity: null };
  const translate = `translate(${(t.x * displayScale).toFixed(2)}px, ${(t.y * displayScale).toFixed(2)}px)`;
  const scale = `scale(${t.scale.toFixed(4)})`;
  const rotate = `rotate(${t.rotation.toFixed(3)}deg)`;
  const transform = `${translate} ${scale} ${rotate}`;
  return { transform, opacity: t.opacity < 0.999 ? t.opacity.toFixed(4) : null };
}

// ── Export (FFmpeg) ───────────────────────────────────────────────────────────

const q4 = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(4));

/**
 * Piecewise-constant FFmpeg expression for one transform property over the
 * SAMPLED boundaries (the stepped export of scale/opacity — the values are
 * the same evaluateProperty math, stepped at transformSplitFrames). Returns
 * null when the property is not keyframed (caller uses the constant).
 * `tOffsetSec` shifts keyframe times to the segment's local clock: t=0 of the
 * emitted expression corresponds to clip-relative frame `-tOffsetSec*fps`.
 */
function steppedTransformExpr(clip: Clip, prop: TransformProp, boundaries: number[], fps: number, tOffsetSec: number): string | null {
  const kfs = transformKeyframes(clip, prop);
  if (kfs.length === 0) return null;
  const valueAt = (frame: number): string => {
    const v = evaluateProperty(kfs as NikkiKeyframe[], prop, frame, {
      fallback: 0,
      durationFrames: clip.timelineDurationFrames,
    });
    return q4(v);
  };
  // Nested 3-arg if()s over the sampled boundaries, in segment-local seconds.
  let expr = valueAt(boundaries[boundaries.length - 1]);
  for (let i = boundaries.length - 2; i >= 0; i--) {
    const bSec = boundaries[i + 1] / fps - tOffsetSec;
    expr = `if(lte(t\\,${q4(Math.max(0, bSec))})\\,${valueAt(boundaries[i])}\\,${expr})`;
  }
  return expr;
}

/**
 * Segment-geometry FFmpeg filters for ONE segment of a visual clip
 * (rotation → scale → opacity, appended AFTER the effect chain and BEFORE
 * the PTS shift — geometry works on segment-local frames). `atFrame` is the
 * clip-relative frame the segment's constants are sampled at; `tOffsetSec`
 * maps that frame to the segment's t=0 (used only by the exact rotation
 * expression). Identity transforms emit NOTHING (byte-identical graphs for
 * untouched projects).
 *
 * Animated rotation uses the exact per-frame rotate expression; animated
 * scale/opacity arrive pre-stepped via transformSplitFrames (the caller
 * samples at segment boundaries).
 */
export function segmentTransformFilters(
  clip: Clip,
  seq: Sequence,
  atFrame: number,
  opts: { exactRotation: boolean; tOffsetSec: number; boundaries?: number[] },
): string[] {
  const fps = seq.fps.num / seq.fps.den;
  const t = transformAt(clip, clip.timelineStartFrame + atFrame);
  const parts: string[] = [];
  const animatedRotation = transformKeyframes(clip, "rotation").length > 0;

  if (t.rotation !== 0 || animatedRotation) {
    if (opts.exactRotation && animatedRotation) {
      // Exact per-frame angle. `rotate` genuinely evaluates per frame on this
      // build (its expression variables include t — verified); times are the
      // window-relative clock: clipOffsetSec + frame/fps.
      const expr = ffmpegExprFor(transformKeyframes(clip, "rotation") as NikkiKeyframe[], "rotation", {
        fallback: clip.transform.rotation,
        durationFrames: clip.timelineDurationFrames,
        fps,
        clipOffsetSec: opts.tOffsetSec,
      });
      parts.push(`format=yuva420p,rotate=a='${expr}':fillcolor=black@0`);
    } else {
      // Constant angle for this segment (static or stepped sample).
      parts.push(`format=yuva420p,rotate=a=${q4((t.rotation * Math.PI) / 180)}:fillcolor=black@0`);
    }
  }

  if (Math.abs(t.scale - 1) > 1e-9) {
    const w = Math.max(2, Math.round(seq.width * t.scale));
    const h = Math.max(2, Math.round(seq.height * t.scale));
    parts.push(`scale=${w}:${h}`);
  }

  if (t.opacity < 0.999) {
    // Alpha carrier before the mixer — colorchannelmixer scales alpha only.
    parts.push(`format=yuva420p,colorchannelmixer=aa=${q4(t.opacity)}`);
  }
  return parts;
}

/** True when any visual clip in the list carries a non-identity transform. */
export function anyClipHasTransform(clips: Clip[]): boolean {
  return clips.some(clipHasTransform);
}

/**
 * Overlay x/y expressions positioning ONE clip's (already scaled) stream on
 * the composition canvas: overlay places the foreground's TOP-LEFT, so the
 * center-anchored composition convention becomes
 *   x(t) = W·(1 − s(t))/2 + x(t),   y(t) = H·(1 − s(t))/2 + y(t).
 * Animated x/y are EXACT piecewise-linear expressions (overlay eval=frame);
 * an animated scale embeds the stepped scale expression into the centering
 * term so the two stay consistent. `clipOffsetSec` maps keyframe times onto
 * the overlay's window-relative clock (t=0 = render-window start).
 * Returns null entries when the term is the constant 0 (no expression churn).
 */
export function overlayPositionExprs(
  clip: Clip,
  seq: Sequence,
  fps: number,
  clipOffsetSec: number,
  /** True when the clip's segment was re-fitted to the sequence dims after a
   *  transform scale (the split path): the scaled content is ALREADY centered
   *  by the transparent pad / center crop, so the centering compensation term
   *  must NOT be emitted again. */
  refitToSequence = false,
): { x: string | null; y: string | null } {
  const base = { ...DEFAULT_TRANSFORM, ...clip.transform };
  const boundaries = transformSplitFrames(clip, clip.timelineDurationFrames);
  const scaleAnimated = transformKeyframes(clip, "scale").length > 0;
  const scaleExpr = scaleAnimated && !refitToSequence ? steppedTransformExpr(clip, "scale", boundaries, fps, clipOffsetSec) : null;
  const sTerm = (axis: "x" | "y"): string | null => {
    const size = axis === "x" ? seq.width : seq.height;
    const offset = base[axis];
    if (scaleExpr) {
      // Animated scale: the centering term tracks the stepped s(t); the
      // static offset stays additive (position and scale are independent).
      const animatedCenter = `${q4(size)}*(1-(${scaleExpr}))*0.5`;
      return Math.abs(offset) < 1e-9 ? animatedCenter : `(${animatedCenter})+(${q4(offset)})`;
    }
    const kfExpr = transformKeyframes(clip, axis).length
      ? ffmpegExprFor(transformKeyframes(clip, axis) as NikkiKeyframe[], axis, {
          fallback: offset,
          durationFrames: clip.timelineDurationFrames,
          fps,
          clipOffsetSec,
        })
      : null;
    // Static centering (scale constant, unsplit path) + static offset, plus
    // any exact keyframed term for this axis. Re-fitted clips skip the
    // centering entirely — their scaled content is already frame-centered.
    const staticTerm = refitToSequence ? offset : size * (1 - base.scale) * 0.5 + offset;
    if (!kfExpr) return Math.abs(staticTerm) < 1e-9 ? null : q4(staticTerm);
    return Math.abs(staticTerm) < 1e-9 ? kfExpr : `(${q4(staticTerm)})+(${kfExpr})`;
  };
  return { x: sTerm("x"), y: sTerm("y") };
}

/**
 * Multi-run transform policy (export): per-clip position and opacity are
 * structurally fine inside transition runs too (each clip positions on its
 * own transparent canvas before the xfade), so NO transform configuration is
 * refused — the graph stays per-clip end to end. Scale/rotation remain
 * per-segment geometry inside every clip's chain.
 */
export function transformPolicyNote(): string {
  return "clip transforms (position/scale/rotation/opacity, static or keyframed) render per clip, including inside transition runs";
}
