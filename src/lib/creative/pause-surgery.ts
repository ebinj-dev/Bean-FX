/**
 * M11 — Advanced multi-clip pause surgery (§6).
 *
 * A deterministic planner that turns MEASURED silence spans into safe, M1
 * command batches covering M10's unsupported cases:
 *   - pauses inside ONE clip            → SplitClip ×2 + RippleDelete (M10 path)
 *   - pauses crossing a clip JUNCTION   → trim tail of A + head of B, then
 *                                         shift downstream clips on the SAME
 *                                         track (frame-exact MoveClip chain)
 *
 * Safety model (all frame-exact, fps-derived):
 *  - user-configurable thresholds: minPauseSec, minRetainedGapSec (margins
 *    kept on both sides of every cut), maxRemovalsPerRun;
 *  - overlapping spans are MERGED before planning (overlap resolution);
 *  - locked tracks refuse the whole plan for that track;
 *  - a TRANSITION touching a junction refuses that removal (transition
 *    semantics are never silently broken);
 *  - inter-clip gaps (no clip under the span) are refused when video tracks
 *    exist — shifting downstream audio alone would desync picture/captions;
 *  - caption-bearing clips warn (caption text rides the clip);
 *  - removals are ordered DESCENDING by start so every command batch —
 *    computed on the original clock — remains valid while the chain applies;
 *  - everything runs through parseCommand → validateCommand → in-memory
 *    dry-apply (preview) → applyTimelineEdits (one version, undo/redo
 *    intact, atomic: any failure writes nothing). Stale versions are
 *    rejected by the caller (recommendation execution path).
 *
 * Measured silence is NEVER removed automatically — this module only PLANS;
 * execution requires explicit user approval.
 */
import { clipEndFrame, type Sequence } from "@/lib/editor/model";
import { parseCommand, validateCommand, applyCommand, EditorError, type Command } from "@/lib/editor/commands";
import type { MeasuredContext } from "./context";

export interface SurgeryOptions {
  minPauseSec: number;
  minRetainedGapSec: number;
  maxRemovalsPerRun: number;
}

export const SURGERY_DEFAULTS: SurgeryOptions = { minPauseSec: 1.5, minRetainedGapSec: 0.25, maxRemovalsPerRun: 6 };

export function validateSurgeryOptions(input: unknown): SurgeryOptions {
  const o = (input ?? {}) as Partial<SurgeryOptions>;
  const clamp = (v: number | undefined, lo: number, hi: number, dflt: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
  return {
    minPauseSec: clamp(o.minPauseSec, 0.5, 20, SURGERY_DEFAULTS.minPauseSec),
    minRetainedGapSec: clamp(o.minRetainedGapSec, 0.05, 2, SURGERY_DEFAULTS.minRetainedGapSec),
    maxRemovalsPerRun: Math.round(clamp(o.maxRemovalsPerRun, 1, 12, SURGERY_DEFAULTS.maxRemovalsPerRun)),
  };
}

export interface PlannedRemoval {
  spanSec: { start: number; end: number };
  kind: "single-clip" | "cross-clip-junction";
  commands: Command[];
  affectedClipIds: string[];
  warnings: string[];
  removedTimelineFrames: number;
}

export interface PauseSurgeryPlan {
  trackId: string | null;
  fps: number;
  removals: PlannedRemoval[];
  skipped: { span: { start: number; end: number }; reason: string }[];
  warnings: string[];
  totalRemovedFrames: number;
}

interface TrackClip {
  id: string;
  startFrame: number;
  endFrame: number;
  sourceInFrame: number;
  sourceOutFrame: number;
  srcFps: number;
  speed: number;
  hasCaption: boolean;
}

function collectTrackClips(seq: Sequence, trackId: string): TrackClip[] {
  const track = seq.tracks.find((t) => t.id === trackId);
  if (!track) return [];
  const srcFpsOf = (c: { sourceFps: { num: number; den: number } }) => c.sourceFps.num / c.sourceFps.den;
  return seq.clips
    .filter((c) => c.trackId === trackId)
    .map((c) => ({
      id: c.id,
      startFrame: c.timelineStartFrame,
      endFrame: clipEndFrame(seq, c),
      sourceInFrame: c.sourceInFrame,
      sourceOutFrame: c.sourceOutFrame,
      srcFps: srcFpsOf(c),
      speed: c.playbackSpeed || 1,
      hasCaption: Boolean(c.captionText && c.captionText.trim()),
    }))
    .sort((a, b) => a.startFrame - b.startFrame);
}

function timelineToSourceFrames(c: TrackClip, fps: number, timelineFrame: number): number {
  const local = timelineFrame - c.startFrame;
  return c.sourceInFrame + Math.round((local * c.srcFps * c.speed) / fps);
}

/** Merge overlapping/near spans; enforce the retained-gap margins. */
export function mergeSilenceSpans(spans: { start: number; end: number }[], fps: number, opts: SurgeryOptions): { start: number; end: number }[] {
  const margin = opts.minRetainedGapSec * fps;
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const merged: { startFrame: number; endFrame: number }[] = [];
  for (const s of sorted) {
    const sf = Math.round(s.start * fps);
    const ef = Math.round(s.end * fps);
    const last = merged[merged.length - 1];
    if (last && sf - last.endFrame < margin * 2) last.endFrame = Math.max(last.endFrame, ef);
    else merged.push({ startFrame: sf, endFrame: ef });
  }
  return merged.map((m) => ({ start: m.startFrame / fps, end: m.endFrame / fps }));
}

/**
 * Plan pause removals for the given timeline silence spans. Returns the
 * removals (M1 command batches on the ORIGINAL clock, descending order) plus
 * every skip with its honest reason.
 */
export function planPauseSurgery(seq: Sequence, timelineSpans: { start: number; end: number }[], optionsInput: Partial<SurgeryOptions> = {}, trackId?: string | null): PauseSurgeryPlan {
  const opts = validateSurgeryOptions(optionsInput);
  const fps = seq.fps.num / seq.fps.den;
  const skipped: PauseSurgeryPlan["skipped"] = [];
  const warnings: string[] = [];

  // Choose the audio track: the requested one, else the AUDIO track with the
  // most clip coverage under the spans.
  const audioTracks = seq.tracks.filter((t) => t.kind === "AUDIO");
  const chosen = trackId ? audioTracks.find((t) => t.id === trackId) ?? null : audioTracks.map((t) => ({ t, n: seq.clips.filter((c) => c.trackId === t.id).length })).sort((a, b) => b.n - a.n)[0]?.t ?? null;
  if (!chosen) {
    return { trackId: null, fps, removals: [], skipped: timelineSpans.map((s) => ({ span: s, reason: "no AUDIO track exists on the timeline" })), warnings, totalRemovedFrames: 0 };
  }
  if (chosen.locked) {
    return { trackId: chosen.id, fps, removals: [], skipped: timelineSpans.map((s) => ({ span: s, reason: `track ${chosen.id} is LOCKED — edit refused` })), warnings, totalRemovedFrames: 0 };
  }
  const hasVideoTracks = seq.tracks.some((t) => t.kind === "VIDEO" && seq.clips.some((c) => c.trackId === t.id));
  const clips = collectTrackClips(seq, chosen.id);
  const transitions = seq.transitions.filter((tr) => tr.trackId === chosen.id);
  const merged = mergeSilenceSpans(timelineSpans, fps, opts);
  const minPauseFrames = Math.round(opts.minPauseSec * fps);
  const marginFrames = Math.round(opts.minRetainedGapSec * fps);

  const removals: PlannedRemoval[] = [];
  const candidates = merged
    .filter((s) => {
      const lenFrames = Math.round(s.end * fps) - Math.round(s.start * fps);
      if (lenFrames < minPauseFrames) {
        skipped.push({ span: s, reason: `pause ${(lenFrames / fps).toFixed(2)} s is below the configured minimum (${opts.minPauseSec} s)` });
        return false;
      }
      return true;
    })
    .sort((a, b) => b.start - a.start); // DESCENDING — original-clock validity

  for (const span of candidates) {
    if (removals.length >= opts.maxRemovalsPerRun) {
      skipped.push({ span, reason: `run cap reached (${opts.maxRemovalsPerRun} removals per plan) — re-run for the rest` });
      continue;
    }
    const sf = Math.round(span.start * fps);
    const ef = Math.round(span.end * fps);
    const covering = clips.filter((c) => c.startFrame < ef && c.endFrame > sf);

    // ── inter-clip gap: no clip under the span ──
    if (covering.length === 0) {
      skipped.push({
        span,
        reason: hasVideoTracks
          ? "span falls in a GAP between audio clips — closing it would shift downstream audio relative to picture/captions on other tracks (manual cut required)"
          : "span falls in a gap between clips with no adjacent content — nothing to trim",
      });
      continue;
    }

    const a = covering[0];
    const b = covering[covering.length - 1];

    // ── single clip ──
    if (covering.length === 1) {
      if (sf - a.startFrame < marginFrames || a.endFrame - ef < marginFrames) {
        skipped.push({ span, reason: `cut would leave less than the configured retained gap (${opts.minRetainedGapSec} s) inside clip ${a.id}` });
        continue;
      }
      const leftId = `ps-${a.id}-l`.slice(0, 60);
      const midId = `ps-${a.id}-m`.slice(0, 60);
      const rightId = `ps-${a.id}-r`.slice(0, 60);
      const commands: Command[] = [
        parseCommand({ type: "SplitClip", clipId: a.id, atTimelineFrame: sf, newLeftId: leftId, newRightId: midId }),
        parseCommand({ type: "SplitClip", clipId: midId, atTimelineFrame: ef, newLeftId: midId, newRightId: rightId }),
        parseCommand({ type: "RippleDelete", clipId: midId }),
      ];
      if (a.hasCaption) warnings.push(`clip ${a.id} carries a caption — trimming changes what the caption covers; review caption text after applying`);
      warnings.push(`RippleDelete shifts later clips on track ${chosen.id} left by ${ef - sf} frames; content on OTHER tracks does not shift — check synchronization for long removals.`);
      removals.push({ spanSec: span, kind: "single-clip", commands, affectedClipIds: [a.id], warnings: [], removedTimelineFrames: ef - sf });
      continue;
    }

    // ── cross-clip junction ──
    const junctionTransitions = transitions.filter((tr) => (tr.clipAId === a.id && tr.clipBId === b.id) || (tr.endFrame > sf - 2 && tr.startFrame < ef + 2));
    if (junctionTransitions.length > 0) {
      skipped.push({ span, reason: `a transition (${junctionTransitions[0].kind}) spans this junction — trimming would break transition semantics; edit manually` });
      continue;
    }
    // Portion of the span inside A (its tail) and inside B (its head).
    const aCutEnd = Math.min(ef, a.endFrame - marginFrames);
    const bCutStart = Math.max(sf, b.startFrame + marginFrames);
    if (aCutEnd <= a.startFrame + marginFrames || bCutStart >= b.endFrame - marginFrames) {
      skipped.push({ span, reason: "junction trim would leave less than the retained gap on one side" });
      continue;
    }
    const aRemoveFrames = aCutEnd - Math.max(sf, a.startFrame + marginFrames);
    const bRemoveFrames = Math.min(ef, b.endFrame - marginFrames) - bCutStart;
    const newAOut = timelineToSourceFrames(a, fps, a.endFrame - aRemoveFrames);
    const newBIn = timelineToSourceFrames(b, fps, b.startFrame + bRemoveFrames);
    if (newAOut <= a.sourceInFrame || newBIn >= b.sourceOutFrame) {
      skipped.push({ span, reason: "source-range mapping produced an empty clip on one side — span not safely trimmable" });
      continue;
    }
    const commands: Command[] = [
      parseCommand({ type: "TrimClip", clipId: a.id, newSourceOutFrame: newAOut }),
      parseCommand({ type: "TrimClip", clipId: b.id, newSourceInFrame: newBIn }),
    ];
    const totalRemoved = aRemoveFrames + bRemoveFrames;
    // Close the junction: B moves left by A's shrink (its own head trim already
    // shortened it); clips AFTER B move by the full removed delta so content
    // stays contiguous on the track.
    const downstream = clips.filter((c) => c.endFrame > b.startFrame);
    for (const c of downstream) {
      const shift = c.id === b.id ? aRemoveFrames : totalRemoved;
      commands.push(parseCommand({ type: "MoveClip", clipId: c.id, newTimelineStartFrame: Math.max(0, c.startFrame - shift) }));
    }
    const affected = [a.id, b.id, ...clips.filter((c) => c.endFrame > b.startFrame && c.id !== b.id).map((c) => c.id)];
    const capClips = affected.filter((id) => clips.find((c) => c.id === id)?.hasCaption);
    if (capClips.length) warnings.push(`caption-bearing clip(s) ${capClips.join(", ")} move/trim — caption text rides the clip; review timing after applying`);
    warnings.push(`${affected.length} clip(s) on track ${chosen.id} trim/shift by ${totalRemoved} frames total; other tracks unaffected — check synchronization for long removals.`);
    removals.push({ spanSec: span, kind: "cross-clip-junction", commands, affectedClipIds: affected, warnings: [], removedTimelineFrames: totalRemoved });
  }

  return { trackId: chosen.id, fps, removals, skipped, warnings, totalRemovedFrames: removals.reduce((n, r) => n + r.removedTimelineFrames, 0) };
}

/** Validate the full command chain against the live sequence (throws nothing). */
export function validateSurgeryPlan(seq: Sequence, plan: PauseSurgeryPlan): { ok: boolean; error?: string } {
  let s = seq;
  try {
    for (const r of plan.removals) {
      for (const cmd of r.commands) {
        const validity = validateCommand(s, cmd);
        if (!validity.ok) return { ok: false, error: validity.error };
        s = applyCommand(s, cmd).sequence;
      }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof EditorError ? err.message : err instanceof Error ? err.message : "plan refused" };
  }
}
