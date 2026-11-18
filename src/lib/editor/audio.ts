/**
 * BEAN FX — M17 Phase D: volume automation (keyframe-driven gain).
 *
 * ONE evaluation module shared by the preview mixer, the export renderer
 * and the inspector UI, so preview and export cannot disagree:
 *   - `volumeAutomationAt`: linear/HOLD interpolation over the clip's
 *     volume keyframes (clip-relative frames — survives timeline moves),
 *     multiplied by the clip's base volume.
 *   - `ffmpegVolumeExpression`: the SAME automation as an FFmpeg `volume`
 *     filter expression (eval=frame), for the export path.
 */
import type { Clip, Keyframe } from "./model";

/** Volume keyframes sorted by clip-relative frame. */
export function volumeKeyframes(clip: Clip): Keyframe[] {
  return clip.keyframes.filter((k) => k.property === "volume").sort((a, b) => a.frame - b.frame);
}

/**
 * Effective linear gain at a timeline frame: base volume × automation.
 * Between keyframes: LINEAR interpolation; HOLD holds the previous value.
 * Before the first / after the last keyframe: the nearest keyframe's value.
 */
export function volumeAutomationAt(clip: Clip, timelineFrame: number, fps: { num: number; den: number }): number {
  const points = volumeKeyframes(clip);
  const base = Math.min(4, Math.max(0, clip.volume));
  if (points.length === 0) return base;
  // Keyframes are CLIP-RELATIVE FRAMES (see model.ts) — no seconds conversion.
  void fps;
  const localFrame = Math.max(0, timelineFrame - clip.timelineStartFrame);
  if (localFrame <= points[0].frame) return clampGain(points[0].value * base);
  const last = points[points.length - 1];
  if (localFrame >= last.frame) return clampGain(last.value * base);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (localFrame >= a.frame && localFrame <= b.frame) {
      if (a.interpolation === "HOLD") return clampGain(a.value * base);
      const t = (localFrame - a.frame) / Math.max(1, b.frame - a.frame);
      return clampGain((a.value + (b.value - a.value) * t) * base);
    }
  }
  return clampGain(last.value * base);
}

function clampGain(g: number): number {
  return Math.min(4, Math.max(0, g));
}

/**
 * FFmpeg `volume` filter args for a clip's automation, or null when the
 * clip has no volume keyframes (the static `volume=` path stays).
 * Piecewise-linear over CLIP-LOCAL seconds (the segment starts at 0).
 */
export function ffmpegVolumeArgs(clip: Clip, fps: { num: number; den: number }): { expr: string; evalFrame: boolean } | null {
  const points = volumeKeyframes(clip);
  if (points.length === 0) return null;
  const base = Math.min(4, Math.max(0, clip.volume));
  const fpsNum = fps.num / fps.den;
  const sec = (frame: number) => (frame / fpsNum) / clip.playbackSpeed;
  const q = (n: number) => n.toFixed(4).replace(/\.?0+$/, (m) => (m === "." ? "" : m)) || "0";
  const val = (k: Keyframe) => clampGain(k.value * base).toFixed(4);
  let expr = val(points[0]);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const ta = q(sec(a.frame));
    const tb = q(sec(b.frame));
    if (a.interpolation === "HOLD" || tb === ta) {
      expr = `if(lte(t\\,${tb})\\,${expr}\\,${val(b)})`;
    } else {
      expr = `if(lt(t\\,${ta})\\,${expr}\\,if(lte(t\\,${tb})\\,${val(a)}+(t-${ta})*(${val(b)}-${val(a)})/${q(sec(b.frame) - sec(a.frame))}\\,${val(b)}))`;
    }
  }
  // Beyond the last point: hold the last value (the segment ends anyway).
  return { expr, evalFrame: true };
}
