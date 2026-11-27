/**
 * BEAN FX — Timeline interaction math (Milestone 2, editor integration).
 *
 * Pure functions behind the timeline's pointer interactions: hit-testing,
 * frame↔pixel mapping, snapping, and the exact trim/move previews the UI
 * shows while dragging. Everything is integer-frame based; pixels exist only
 * at the input/output boundary of the DOM events.
 */
import { clipEndFrame, clipTimelineDuration, type Clip, type Sequence } from "./model";
import { makeRational } from "./time";

export const TRACK_HEADER_WIDTH = 128;
export const TRACK_HEIGHT = 56;
export const RULER_HEIGHT = 28;
export const TRIM_HANDLE_PX = 8;

/** Pixels per second at a given zoom level (zoom 1 = 60 px/s baseline). */
export function pixelsPerFrame(zoom: number, seqFps: { num: number; den: number }): number {
  const pxPerSecond = 60 * Math.max(0.1, Math.min(8, zoom));
  return pxPerSecond * (seqFps.den / seqFps.num);
}

export function frameToX(frame: number, zoom: number, seqFps: { num: number; den: number }, scrollFrames: number): number {
  return (frame - scrollFrames) * pixelsPerFrame(zoom, seqFps) + TRACK_HEADER_WIDTH;
}

/** DOM x → integer frame (clamped at 0; snapping happens explicitly). */
export function xToFrame(x: number, zoom: number, seqFps: { num: number; den: number }, scrollFrames: number): number {
  const raw = (x - TRACK_HEADER_WIDTH) / pixelsPerFrame(zoom, seqFps) + scrollFrames;
  return Math.max(0, Math.round(raw));
}

/** Snap a frame to the nearest grid step (0 disables snapping). */
export function snapFrame(frame: number, gridFrames: number): number {
  if (!gridFrames || gridFrames <= 1) return Math.max(0, Math.round(frame));
  return Math.max(0, Math.round(frame / gridFrames) * gridFrames);
}

/**
 * M48-C — professional snap targets: every clip edge on every track, the
 * playhead and every marker. Deduplicated and sorted; the caller snaps to the
 * nearest target within the threshold instead of to the grid alone.
 */
export function snapTargetFrames(seq: Sequence, playhead: number): number[] {
  const targets = new Set<number>([0, playhead]);
  for (const clip of seq.clips) {
    targets.add(clip.timelineStartFrame);
    targets.add(clipEndFrame(seq, clip));
  }
  for (const marker of seq.markers) targets.add(marker.frame);
  return [...targets].sort((a, b) => a - b);
}

/** Snap to the nearest target within `thresholdFrames` (falls back to the grid step). */
export function snapFrameToTargets(frame: number, targets: number[], gridFrames: number, thresholdFrames = 6): number {
  const rounded = Math.max(0, Math.round(frame));
  let best: number | null = null;
  let bestDist = thresholdFrames;
  for (const t of targets) {
    const dist = Math.abs(t - rounded);
    if (dist <= bestDist) {
      bestDist = dist;
      best = t;
    }
  }
  if (best !== null) return best;
  return snapFrame(rounded, gridFrames);
}

export interface ClipHit {
  clip: Clip;
  /** Which drag affordance the point lands on. */
  zone: "body" | "trim-in" | "trim-out";
}

/** Hit-test a point (in frames) against the clips of one track. Topmost
 *  (latest-starting overlapping) clip wins; edges take precedence. */
export function clipAtPoint(seq: Sequence, trackId: string, frame: number, zoom: number, seqFps: { num: number; den: number }): ClipHit | null {
  const candidates = seq.clips
    .filter((c) => c.trackId === trackId && frame >= c.timelineStartFrame && frame < clipEndFrame(seq, c))
    .sort((a, b) => b.timelineStartFrame - a.timelineStartFrame);
  const clip = candidates[0];
  if (!clip) return null;
  const edgeFrames = TRIM_HANDLE_PX / pixelsPerFrame(zoom, seqFps);
  if (frame - clip.timelineStartFrame < edgeFrames) return { clip, zone: "trim-in" };
  if (clipEndFrame(seq, clip) - frame <= edgeFrames) return { clip, zone: "trim-out" };
  return { clip, zone: "body" };
}

export interface MovePreview {
  clipId: string;
  newTimelineStartFrame: number;
}

/** Move preview: target frame clamps at 0 and snaps to targets (M48-C) or the grid. */
export function movePreview(clip: Clip, targetFrame: number, gridFrames: number, snapTargets?: number[]): MovePreview {
  const snapped = snapTargets && snapTargets.length > 0
    ? snapFrameToTargets(targetFrame, snapTargets, gridFrames)
    : snapFrame(targetFrame, gridFrames);
  return {
    clipId: clip.id,
    newTimelineStartFrame: Math.max(0, snapped),
  };
}

export interface TrimPreview {
  clipId: string;
  newSourceInFrame?: number;
  newSourceOutFrame?: number;
  newTimelineStartFrame?: number;
}

/**
 * Trim preview for a pointer drag on one edge. Timeline-first semantics: the
 * pointer defines where the timeline edge should land; the source range
 * follows through the integer timebase mapping, and the timeline duration is
 * recomputed exactly the way the command engine will (so the preview matches
 * the committed result frame-for-frame).
 */
export function trimPreview(
  seq: Sequence,
  clip: Clip,
  zone: "trim-in" | "trim-out",
  targetFrame: number,
  seqFps: { num: number; den: number },
  gridFrames: number,
  snapTargets?: number[],
): TrimPreview {
  const target = Math.max(0, snapTargets && snapTargets.length > 0 ? snapFrameToTargets(targetFrame, snapTargets, gridFrames) : snapFrame(targetFrame, gridFrames));
  const seqFpsR = makeRational(seqFps.num, seqFps.den);
  const srcFpsR = makeRational(clip.sourceFps.num, clip.sourceFps.den);
  if (zone === "trim-in") {
    // Cannot trim past the out point: keep at least one frame.
    const maxStart = clipEndFrame(seq, clip) - 1;
    const newStart = Math.min(target, maxStart);
    // timeline offset consumed → source frames (same mapping as srcFromTimeline)
    const consumedTimeline = newStart - clip.timelineStartFrame;
    const consumedSource = Math.round((consumedTimeline * clip.playbackSpeed * srcFpsR.num * seqFpsR.den) / (srcFpsR.den * seqFpsR.num));
    const newSourceIn = Math.min(clip.sourceOutFrame - 1, clip.sourceInFrame + consumedSource);
    return { clipId: clip.id, newSourceInFrame: Math.max(0, newSourceIn), newTimelineStartFrame: newStart };
  }
  // trim-out: target is the new exclusive end; source follows the same rule.
  const minEnd = clip.timelineStartFrame + 1;
  const newEnd = Math.max(target, minEnd);
  const newTimelineDuration = newEnd - clip.timelineStartFrame;
  const newSourceOut = clip.sourceInFrame + Math.round((newTimelineDuration * clip.playbackSpeed * srcFpsR.num * seqFpsR.den) / (srcFpsR.den * seqFpsR.num));
  return { clipId: clip.id, newSourceOutFrame: Math.max(clip.sourceInFrame + 1, newSourceOut) };
}

/** Convert a TrimPreview into the exact TrimClip command payload the engine
 *  accepts (recomputes the duration the same way the engine will). */
export function trimPreviewToCommand(seq: Sequence, preview: TrimPreview): Record<string, unknown> {
  const cmd: Record<string, unknown> = { type: "TrimClip", clipId: preview.clipId };
  if (preview.newSourceInFrame !== undefined) cmd.newSourceInFrame = preview.newSourceInFrame;
  if (preview.newSourceOutFrame !== undefined) cmd.newSourceOutFrame = preview.newSourceOutFrame;
  if (preview.newTimelineStartFrame !== undefined) cmd.newTimelineStartFrame = preview.newTimelineStartFrame;
  return cmd;
}

/** Clip rectangle geometry in pixels (for rendering + drag bounds). */
export function clipRect(clip: Clip, zoom: number, seqFps: { num: number; den: number }, scrollFrames: number): {
  left: number;
  width: number;
} {
  const left = frameToX(clip.timelineStartFrame, zoom, seqFps, scrollFrames);
  const right = frameToX(clip.timelineStartFrame + clip.timelineDurationFrames, zoom, seqFps, scrollFrames);
  return { left, width: Math.max(2, right - left) };
}

/** The ruler scale for the current zoom: (major step frames, minor count). */
export function rulerScale(viewDurationFrames: number, targetMajorTicks = 8): { majorFrames: number; minorCount: number } {
  const raw = viewDurationFrames / targetMajorTicks;
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-6))));
  const norm = raw / pow;
  const major = (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * pow;
  const minorCount = major >= 10 ? 10 : 5;
  return { majorFrames: major, minorCount };
}

/** Duration a clip will occupy if its source range becomes [in, out) — used
 *  by the inspector to show the effect of trims before committing. */
export function projectedDurationFrames(sourceIn: number, sourceOut: number, clip: Clip, seqFps: { num: number; den: number }): number {
  return clipTimelineDuration(sourceOut, sourceIn, makeRational(clip.sourceFps.num, clip.sourceFps.den), makeRational(seqFps.num, seqFps.den), clip.playbackSpeed);
}
