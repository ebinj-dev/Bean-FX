/**
 * M4 — RIISHE → timeline: apply approved cut proposals as validated editor
 * commands (audit §3: "Apply proposals as validated commands — M4").
 *
 * Pure mapping module — no I/O, no UI. The caller (editor UI) supplies the
 * current sequence plus a completed RIISHE analysis result and its persisted
 * decisions; this module returns ONE command batch for the session's
 * EditHistory (applyTransaction is atomic: any invalid command aborts the
 * whole batch without mutating the sequence) plus honest warnings for every
 * proposal that could not be represented.
 *
 * Safety principles (extending src/lib/riishe-safety.ts):
 *  - proposals never touch media or the filesystem; they become zod-validated
 *    commands from the M1 command model only (TrimClip / SplitClip /
 *    RippleDelete);
 *  - decision semantics mirror the export-apply path exactly: a candidate is
 *    cut iff its persisted decision is APPROVE, or it has no decision and the
 *    server classified it REMOVE (equivalent to decisionToReview + the
 *    REMOVE/APPROVED filter in auto-cut; equivalence is unit-tested);
 *  - removal ranges are normalized with the same normalizeRanges used by
 *    export and preview (clamp + union + adjacent merge);
 *  - locked tracks are skipped with a warning — never silently unlocked;
 *  - missingMedia clips and clips of other assets are never touched;
 *  - cuts smaller than one frame of the clip's source timebase are skipped
 *    with a warning rather than silently rounded away.
 *
 * Timeline semantics match the export/preview math: removed material is
 * closed up (RippleDelete), so the edited timeline duration equals
 * durationSec − removedSec, segment for segment. Every cut — head, tail or
 * interior — is expressed as SplitClip at its boundaries plus RippleDelete
 * of the removed piece; TrimClip is deliberately NOT used because a trim
 * alone leaves the following material unshifted (a hole in the timeline).
 * Cuts inside one clip are planned against the clip's ORIGINAL geometry and
 * emitted in DESCENDING timeline order: each RippleDelete only shifts
 * material to its right, so earlier (leftward) cut positions stay valid.
 */

import { normalizeRanges } from "./audio-analysis";
import type { Command } from "./editor/commands";
import { clipTimelineDuration, type Clip, type Sequence } from "./editor/model";
import type { SavedDecisionView } from "./types";

/** Minimal candidate surface needed from RiisheAnalyzeResult.candidates. */
export interface RiisheTimelineCandidate {
  id: string;
  start: number;
  end: number;
  review: "REMOVE" | "REVIEW" | "KEEP";
}

/**
 * The effective removal ranges (source-media seconds) a timeline apply would
 * cut — the same membership rule as the export-apply path: a persisted
 * APPROVE makes a cut; a REMOVE verdict with no persisted decision makes a
 * cut; REJECT/KEEP never do. Ranges are clamped to the media duration and
 * unioned (normalizeRanges), so overlapping proposals never double-count.
 */
export function effectiveRemovalSec(
  candidates: RiisheTimelineCandidate[],
  decisions: SavedDecisionView[],
  durationSec: number,
): { start: number; end: number }[] {
  const byId = new Map(decisions.map((d) => [d.candidateId, d.decision] as const));
  const cuts = candidates
    .filter((c) => {
      const decision = byId.get(c.id);
      return decision ? decision === "APPROVE" : c.review === "REMOVE";
    })
    .map((c) => ({ start: c.start, end: c.end }));
  return normalizeRanges(cuts, durationSec);
}

export interface RiisheTimelinePlanStats {
  /** Clips of the analyzed asset found in the sequence. */
  clipsMatched: number;
  /** Clips the plan actually modifies (≥1 cut represented). */
  clipsCut: number;
  /** Clips fully consumed by removals (RippleDeleted). */
  clipsRemoved: number;
  /** Removal ranges represented as timeline cuts. */
  cutsPlanned: number;
  /** Ranges smaller than one frame of the clip's timebase (skipped). */
  cutsSkippedSubFrame: number;
  /** Clips skipped because their track is locked. */
  skippedLocked: number;
  /** Clips skipped because they carry no usable source media. */
  skippedMissingMedia: number;
  /** Total commands in the batch (0 = nothing to do). */
  commandCount: number;
}

export interface RiisheTimelinePlan {
  commands: Command[];
  warnings: string[];
  stats: RiisheTimelinePlanStats;
}

/** Deterministic, collision-free piece ids for SplitClip (≤64 chars). */
function makeIdAllocator(existingIds: Iterable<string>): (clipId: string) => string {
  const used = new Set(existingIds);
  let counter = 0;
  return (clipId: string) => {
    for (;;) {
      counter += 1;
      const id = `m4-${String(counter).padStart(3, "0")}-${clipId.slice(0, 28)}`;
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
  };
}

/**
 * Plan the timeline apply for ONE analyzed asset. Only clips whose
 * sourceAssetId matches are considered; everything else is untouched.
 */
export function planRiisheTimelineApply(input: {
  sequence: Sequence;
  /** Normalized removal ranges in source-media seconds (effectiveRemovalSec). */
  removalsSec: { start: number; end: number }[];
  /** The analyzed media asset id. */
  sourceAssetId: string;
  /** Ids to treat as taken (multi-asset composition: pass the piece ids any
   *  previously built plan allocated, so batches never collide). */
  reservedIds?: Iterable<string>;
}): RiisheTimelinePlan {
  const { sequence, removalsSec, sourceAssetId } = input;
  const commands: Command[] = [];
  const warnings: string[] = [];
  const stats: RiisheTimelinePlanStats = {
    clipsMatched: 0,
    clipsCut: 0,
    clipsRemoved: 0,
    cutsPlanned: 0,
    cutsSkippedSubFrame: 0,
    skippedLocked: 0,
    skippedMissingMedia: 0,
    commandCount: 0,
  };
  if (removalsSec.length === 0) {
    stats.commandCount = 0;
    return { commands, warnings, stats };
  }
  const allocId = makeIdAllocator([...sequence.clips.map((c) => c.id), ...(input.reservedIds ?? [])]);

  for (const clip of sequence.clips) {
    if (clip.sourceAssetId !== sourceAssetId) continue;
    stats.clipsMatched += 1;
    if (clip.missingMedia || clip.sourceOutFrame <= clip.sourceInFrame) {
      stats.skippedMissingMedia += 1;
      warnings.push(
        `clip ${clip.id} carries no usable source media — RIISHE cut skipped (clip left untouched)`,
      );
      continue;
    }
    const track = sequence.tracks.find((t) => t.id === clip.trackId);
    if (!track) {
      warnings.push(`clip ${clip.id} references missing track ${clip.trackId} — skipped`);
      continue;
    }
    if (track.locked) {
      stats.skippedLocked += 1;
      warnings.push(
        `track ${track.id} is locked — RIISHE cuts for clip ${clip.id} skipped (track left untouched)`,
      );
      continue;
    }

    // 1) removal seconds → this clip's source-frame ranges (clip's own
    //    source timebase; the union already prevents double-counting).
    const perSec = clip.sourceFps.num / clip.sourceFps.den;
    const frameRanges: { a: number; b: number }[] = [];
    for (const r of removalsSec) {
      const fs = Math.round(r.start * perSec);
      const fe = Math.round(r.end * perSec);
      const a = Math.max(clip.sourceInFrame, fs);
      const b = Math.min(clip.sourceOutFrame, fe);
      if (b > a) frameRanges.push({ a, b });
      else if (fs < clip.sourceOutFrame && fe > clip.sourceInFrame) {
        // The proposal intersects the clip but rounds away entirely at this
        // timebase — skipped honestly, never silently glued to a neighbor.
        stats.cutsSkippedSubFrame += 1;
        warnings.push(
          `cut [${r.start}s, ${r.end}s] is smaller than one frame of clip ${clip.id}'s timebase — skipped`,
        );
      }
    }
    if (frameRanges.length === 0) continue;
    stats.clipsCut += 1;

    // 2) map to timeline positions with the ENGINE's own duration math so
    //    SplitClip's exactness requirement holds by construction. The clip's
    //    in-point maps to its timeline start directly (clipTimelineDuration
    //    rejects zero-length ranges by design).
    const tlOf = (srcFrame: number): number => {
      if (srcFrame <= clip.sourceInFrame) return clip.timelineStartFrame;
      return (
        clip.timelineStartFrame +
        clipTimelineDuration(srcFrame, clip.sourceInFrame, clip.sourceFps, sequence.fps, clip.playbackSpeed)
      );
    };
    const start = clip.timelineStartFrame;
    const end = start + clip.timelineDurationFrames;

    // Keep source + timeline pairs, drop sub-frame cuts, merge touching
    // ranges at TIMELINE granularity (rounding can make two disjoint source
    // ranges land on the same timeline frame).
    const mapped = frameRanges
      .map(({ a, b }) => ({ sa: a, sb: b, ta: tlOf(a), tb: tlOf(b) }))
      .filter(({ ta, tb }) => {
        if (tb > ta) return true;
        stats.cutsSkippedSubFrame += 1;
        return false;
      });
    for (const m of mapped) {
      m.ta = Math.min(Math.max(m.ta, start), end);
      m.tb = Math.min(Math.max(m.tb, start), end);
    }
    mapped.sort((x, y) => x.ta - y.ta);
    const merged: { sa: number; sb: number; ta: number; tb: number }[] = [];
    for (const m of mapped) {
      const last = merged[merged.length - 1];
      if (last && m.ta <= last.tb) {
        last.sb = Math.max(last.sb, m.sb);
        last.tb = Math.max(last.tb, m.tb);
      } else {
        merged.push({ ...m });
      }
    }
    // Re-check for zero-width after merge (rounding collapse).
    const ranges = merged.filter(({ ta, tb }) => {
      if (tb > ta) return true;
      stats.cutsSkippedSubFrame += 1;
      return false;
    });
    if (ranges.length === 0) continue;

    // 3) emit commands, DESCENDING timeline order (see module docstring).
    for (const { ta, tb } of [...ranges].reverse()) {
      if (ta <= start && tb >= end) {
        // Whole clip consumed by removals — one honest atomic removal.
        commands.push({ type: "RippleDelete", clipId: clip.id });
        stats.clipsRemoved += 1;
        stats.cutsPlanned += 1;
        break;
      }
      if (ta <= start) {
        // Head cut: split the head piece off (it keeps the original clip id)
        // and ripple-delete it — the kept material closes up to `start`.
        const restId = allocId(clip.id);
        commands.push({
          type: "SplitClip",
          clipId: clip.id,
          atTimelineFrame: tb,
          newLeftId: clip.id,
          newRightId: restId,
        });
        commands.push({ type: "RippleDelete", clipId: clip.id });
        stats.cutsPlanned += 1;
        continue;
      }
      if (tb >= end) {
        // Tail cut: split the tail piece off and ripple-delete it — later
        // clips on the track shift left, closing the gap.
        const tailId = allocId(clip.id);
        commands.push({
          type: "SplitClip",
          clipId: clip.id,
          atTimelineFrame: ta,
          newLeftId: clip.id,
          newRightId: tailId,
        });
        commands.push({ type: "RippleDelete", clipId: tailId });
        stats.cutsPlanned += 1;
        continue;
      }
      // Interior cut: split twice around the range on the CURRENT left
      // piece, then ripple-delete the middle piece (closes the gap).
      const rightId = allocId(clip.id);
      const midId = allocId(clip.id);
      const restId = allocId(clip.id);
      commands.push({
        type: "SplitClip",
        clipId: clip.id,
        atTimelineFrame: ta,
        newLeftId: clip.id,
        newRightId: rightId,
      });
      commands.push({
        type: "SplitClip",
        clipId: rightId,
        atTimelineFrame: tb,
        newLeftId: midId,
        newRightId: restId,
      });
      commands.push({ type: "RippleDelete", clipId: midId });
      stats.cutsPlanned += 1;
    }
  }

  stats.commandCount = commands.length;
  return { commands, warnings, stats };
}
