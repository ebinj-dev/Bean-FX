/**
 * M15 — Professional editing tools over the M1 command engine.
 *
 * Every tool compiles to EXISTING validated commands (no new timeline
 * semantics): razor → SplitClip; slip → one TrimClip with both source edges
 * shifted by the same delta while the timeline position is pinned (M1
 * supports newSourceInFrame + newSourceOutFrame + newTimelineStartFrame in a
 * single command); slide → MoveClip on the target plus compensating TrimClips
 * on both neighbors, applied as one atomic batch. Nothing here invents a
 * second engine — invalid requests are refused by the engine's validity gate.
 */
import { clipEndFrame, type Clip, type Sequence } from "./model";


export type EditToolId = "select" | "track-select" | "razor" | "roll" | "slip" | "slide" | "hand" | "zoom" | "text" | "transform";

export interface ToolSpec {
  id: EditToolId;
  label: string;
  shortcut: string;
  hint: string;
}

export const EDIT_TOOLS: ToolSpec[] = [
  { id: "select", label: "Select", shortcut: "V", hint: "Select, move and trim clips" },
  { id: "track-select", label: "Track Select", shortcut: "A", hint: "Select every clip forward on a track" },
  { id: "razor", label: "Razor", shortcut: "C", hint: "Click a clip to cut it at that frame" },
  { id: "roll", label: "Roll", shortcut: "E", hint: "Drag a shared clip boundary to roll the cut (extends one clip, trims the other)" },
  { id: "slip", label: "Slip", shortcut: "Y", hint: "Drag clip content without moving it in time" },
  { id: "slide", label: "Slide", shortcut: "U", hint: "Move the clip; neighbors close the gap" },
  { id: "hand", label: "Hand", shortcut: "H", hint: "Pan the timeline" },
  { id: "zoom", label: "Zoom", shortcut: "Z", hint: "Click to zoom into a point" },
  { id: "text", label: "Text", shortcut: "T", hint: "Click a caption track to add a caption" },
  { id: "transform", label: "Transform", shortcut: "R", hint: "Drag layers directly on the program monitor" },
];

/** Clip source length in SOURCE frames. */
export function sourceLength(clip: Clip): number {
  return clip.sourceOutFrame - clip.sourceInFrame;
}

/**
 * Slip: shift the visible source window by `deltaSourceFrames` without moving
 * the clip in the timeline. One TrimClip command — pinned
 * newTimelineStartFrame keeps the position exact.
 */
export function slipCommand(clip: Clip, deltaSourceFrames: number): Record<string, unknown> | null {
  const len = sourceLength(clip);
  const newIn = clip.sourceInFrame + deltaSourceFrames;
  const newOut = clip.sourceOutFrame + deltaSourceFrames;
  if (newIn < 0 || newOut < newIn + 1) return null; // outside the source media — refused honestly (no wraparound)
  return {
    type: "TrimClip",
    clipId: clip.id,
    newSourceInFrame: newIn,
    newSourceOutFrame: newOut,
    newTimelineStartFrame: clip.timelineStartFrame,
  };
}

/**
 * Slide: move the clip along its own track by `deltaTimelineFrames` while the
 * neighbors trim to close both gaps — the SEQUENCE duration stays constant
 * (classic slide). Returns one atomic command batch, or null when the
 * neighbors cannot absorb the delta.
 */
export function slideCommands(seq: Sequence, clip: Clip, deltaTimelineFrames: number, sourceDurations?: Map<string, number>): Record<string, unknown>[] | null {
  if (deltaTimelineFrames === 0) return null;
  const track = seq.tracks.find((t) => t.id === clip.trackId);
  if (!track || track.locked) return null;
  // timeline frames → source frames at this clip's rate (engine-inverse math).
  const toSource = (timelineFrames: number, c: Clip) =>
    Math.round((timelineFrames * c.sourceFps.num * seq.fps.den) / (c.sourceFps.den * seq.fps.num) / c.playbackSpeed);
  const start = clip.timelineStartFrame;
  const end = clipEndFrame(seq, clip);
  const newStart = start + deltaTimelineFrames;
  const newEnd = end + deltaTimelineFrames;
  if (newStart < 0) return null;
  const onTrack = seq.clips
    .filter((c) => c.trackId === clip.trackId && c.id !== clip.id)
    .sort((a, b) => a.timelineStartFrame - b.timelineStartFrame);
  const prev = [...onTrack].reverse().find((c) => clipEndFrame(seq, c) <= start);
  const next = onTrack.find((c) => c.timelineStartFrame >= end);
  if (!prev && !next) return null; // nothing to slide against — plain move instead
  const commands: Record<string, unknown>[] = [{ type: "MoveClip", clipId: clip.id, newTimelineStartFrame: newStart }];
  if (prev) {
    // Left neighbor keeps its start; its OUT edge must land on newStart.
    const prevEnd = clipEndFrame(seq, prev);
    const deltaFrames = newStart - prevEnd;
    if (deltaFrames !== 0) {
      const deltaSource = toSource(deltaFrames, prev);
      const newOut = prev.sourceOutFrame + deltaSource;
      if (deltaSource < 0 && newOut - prev.sourceInFrame < 1) return null; // window too short
      if (deltaSource > 0 && newOut > prev.sourceOutFrame) {
        // Extension needs KNOWN media beyond the used window (probe durations).
        const known = sourceDurations?.get(prev.sourceAssetId);
        if (prev.missingMedia || typeof known !== "number" || known <= 0 || newOut > known) return null;
      }
      commands.push({ type: "TrimClip", clipId: prev.id, newSourceOutFrame: newOut });
    }
  } else if (deltaTimelineFrames < 0) return null; // nothing on the left to absorb
  if (next) {
    // Right neighbor's IN edge must land on newEnd; its start moves with it.
    const deltaFrames = next.timelineStartFrame - newEnd;
    if (deltaFrames !== 0) {
      const deltaSource = toSource(deltaFrames, next);
      const newIn = next.sourceInFrame - deltaSource;
      const newNextStart = next.timelineStartFrame - deltaFrames;
      if (newIn < 0) return null; // before the media start — honest refusal
      if (newIn >= next.sourceOutFrame) return null; // window would invert
      commands.push({ type: "TrimClip", clipId: next.id, newSourceInFrame: newIn, newTimelineStartFrame: newNextStart });
    } else {
      commands.push({ type: "MoveClip", clipId: next.id, newTimelineStartFrame: newEnd });
    }
  } else if (deltaTimelineFrames > 0) return null;
  return commands;
}
