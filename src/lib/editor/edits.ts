/**
 * BEAN FX — M16 Professional editing operations (Phase C).
 *
 * Every operation compiles to EXISTING reversible M1 commands applied as one
 * atomic batch — no new engine semantics, no second timeline. Invalid
 * requests return null and the caller surfaces an honest refusal. The
 * invariants checked here (adjacency, bounds, locked tracks, duration
 * preservation) mirror the engine's own gates so refusals happen BEFORE any
 * command is issued.
 */
import { clipEndFrame, type Clip, type Sequence } from "./model";
import { slipCommand, slideCommands } from "./tools";

/** Compile helper result: commands + human explanation of affected objects. */
export interface EditCompilation {
  commands: Record<string, unknown>[];
  summary: string;
}

function findTrack(seq: Sequence, clip: Clip) {
  return seq.tracks.find((t) => t.id === clip.trackId);
}

function clipsOnTrack(seq: Sequence, trackId: string, excluding?: string): Clip[] {
  return seq.clips
    .filter((c) => c.trackId === trackId && c.id !== excluding)
    .sort((a, b) => a.timelineStartFrame - b.timelineStartFrame);
}

/**
 * INSERT (§3.1): push every clip from `frame` onward (on the target track)
 * right by the incoming clip's duration, then add the clip at `frame`.
 * Multi-track targeting: optionally shifts clips on OTHER targeted tracks too.
 */
export function compileInsert(
  seq: Sequence,
  trackId: string,
  frame: number,
  clip: Omit<Clip, "timelineStartFrame">,
  alsoShiftTrackIds: string[] = [],
): EditCompilation | null {
  const track = seq.tracks.find((t) => t.id === trackId);
  if (!track || track.locked) return null;
  const duration = clip.timelineDurationFrames;
  if (duration < 1) return null;
  const tracksToShift = [trackId, ...alsoShiftTrackIds.filter((id) => !seq.tracks.find((t) => t.id === id)?.locked)];
  const commands: Record<string, unknown>[] = [];
  let shifted = 0;
  for (const tid of tracksToShift) {
    for (const c of clipsOnTrack(seq, tid)) {
      if (clipEndFrame(seq, c) <= frame) continue; // before the insertion point — untouched
      commands.push({ type: "MoveClip", clipId: c.id, newTimelineStartFrame: c.timelineStartFrame + duration });
      shifted += 1;
    }
  }
  commands.push({ type: "AddClip", clip: { ...clip, timelineStartFrame: Math.max(0, frame) } });
  return { commands, summary: `Insert: ${shifted} clip(s) shifted, incoming clip placed at frame ${frame}` };
}

/**
 * OVERWRITE (§3.2): place the incoming clip, splitting/removing any clips it
 * overlaps (targeted tracks only). Locked tracks refuse; everything else is
 * trimmed around the occupied range like a real overwrite edit.
 */
export function compileOverwrite(seq: Sequence, trackId: string, clip: Clip): EditCompilation | null {
  const track = seq.tracks.find((t) => t.id === trackId);
  if (!track || track.locked) return null;
  const start = Math.max(0, clip.timelineStartFrame);
  const end = start + clip.timelineDurationFrames;
  const commands: Record<string, unknown>[] = [];
  // Overlap resolution per overlapped clip (classic overwrite):
  //  - starts before the incoming: the covered region is its TAIL → trim OUT;
  //    if the covered region is the clip's MIDDLE → split (head kept, tail re-added).
  //  - starts inside the incoming: head covered → trim IN (or remove when fully covered).
  const toSource = (frames: number, c: Clip) => Math.round((frames * c.sourceFps.num * seq.fps.den) / (c.sourceFps.den * seq.fps.num) / c.playbackSpeed);
  for (const c of clipsOnTrack(seq, trackId)) {
    const cStart = c.timelineStartFrame;
    const cEnd = clipEndFrame(seq, c);
    if (cEnd <= start || cStart >= end) continue; // no overlap
    const overlapStart = Math.max(start, cStart);
    const overlapEnd = Math.min(end, cEnd);
    if (cStart < start) {
      // Clip head survives; the covered region is its tail — or its middle.
      if (overlapEnd >= cEnd) {
        // Whole tail covered → trim OUT.
        const consumed = cEnd - overlapStart;
        const srcDelta = toSource(consumed, c);
        if (c.sourceOutFrame - srcDelta <= c.sourceInFrame) return null;
        commands.push({ type: "TrimClip", clipId: c.id, newSourceOutFrame: c.sourceOutFrame - srcDelta });
      } else {
        // MIDDLE covered → split: keep head [cStart..start], re-add tail [end..cEnd].
        const headLen = start - cStart;
        const headSrc = toSource(headLen, c);
        if (headSrc < 1 || c.sourceOutFrame - toSource(cEnd - end, c) <= c.sourceInFrame + headSrc) return null;
        commands.push({ type: "TrimClip", clipId: c.id, newSourceOutFrame: c.sourceInFrame + headSrc });
        const tailSrc = toSource(cEnd - end, c);
        commands.push({
          type: "AddClip",
          clip: { ...c, id: `${c.id}__owt`, sourceInFrame: c.sourceOutFrame - tailSrc, timelineStartFrame: end, timelineDurationFrames: toSource(cEnd - end, c) },
        });
      }
    } else if (cEnd > end) {
      // Clip starts inside the incoming and its tail survives → trim IN.
      const consumed = overlapEnd - cStart;
      const srcDelta = toSource(consumed, c);
      if (c.sourceInFrame + srcDelta >= c.sourceOutFrame) return null;
      commands.push({ type: "TrimClip", clipId: c.id, newSourceInFrame: c.sourceInFrame + srcDelta, newTimelineStartFrame: overlapEnd });
    } else {
      // Fully covered → remove.
      commands.push({ type: "RemoveClip", clipId: c.id });
    }
  }
  commands.push({ type: "AddClip", clip: { ...clip, timelineStartFrame: start } });
  return { commands, summary: `Overwrite: incoming clip occupies ${start}..${end}, overlaps resolved` };
}

/**
 * ROLL (§3.5): move the shared boundary between two adjacent clips — the
 * left clip's OUT and the right clip's IN move together; both timeline
 * starts of the OUTER edges stay fixed, total duration preserved.
 */
export function compileRoll(seq: Sequence, leftId: string, rightId: string, deltaFrames: number, sourceDurations?: Map<string, number>): EditCompilation | null {
  const left = seq.clips.find((c) => c.id === leftId);
  const right = seq.clips.find((c) => c.id === rightId);
  if (!left || !right || left.trackId !== right.trackId) return null;
  const track = findTrack(seq, left);
  if (!track || track.locked) return null;
  const leftEnd = clipEndFrame(seq, left);
  if (right.timelineStartFrame !== leftEnd) return null; // not adjacent
  const boundary = leftEnd + deltaFrames;
  if (boundary <= left.timelineStartFrame || boundary >= clipEndFrame(seq, right)) return null;
  // Left: extend/shrink OUT by delta (source delta at left's rate).
  const toSource = (frames: number, c: Clip) => Math.round((frames * c.sourceFps.num * seq.fps.den) / (c.sourceFps.den * seq.fps.num) / c.playbackSpeed);
  const leftDelta = toSource(deltaFrames, left);
  const newLeftOut = left.sourceOutFrame + leftDelta;
  // Extending a source window needs KNOWN media beyond the used window —
  // the caller supplies real probe durations; without them extension is
  // refused honestly (no invented media).
  const knownMedia = (c: Clip): number | null => {
    const d = sourceDurations?.get(c.sourceAssetId);
    return typeof d === "number" && d > 0 ? d : null;
  };
  if (deltaFrames > 0 && newLeftOut > left.sourceOutFrame) {
    const known = knownMedia(left);
    if (left.missingMedia || known === null || newLeftOut > known) return null;
  }
  if (deltaFrames < 0 && newLeftOut - left.sourceInFrame < 1) return null;
  // Roll right (+): the right clip's window SHRINKS from the head (its in
  // advances). Roll left (−): the right clip would extend backward into
  // material BEFORE its imported start — unknown media, refused honestly.
  const rightDelta = toSource(deltaFrames, right);
  const newRightIn = right.sourceInFrame + rightDelta;
  if (deltaFrames < 0 && newRightIn < right.sourceInFrame) return null;
  if (newRightIn < 0 || newRightIn >= right.sourceOutFrame) return null;
  return {
    commands: [
      { type: "TrimClip", clipId: left.id, newSourceOutFrame: newLeftOut },
      { type: "TrimClip", clipId: right.id, newSourceInFrame: newRightIn, newTimelineStartFrame: boundary },
    ],
    summary: `Roll: boundary ${leftEnd} → ${boundary} (duration preserved)`,
  };
}

/** LIFT (§3.8): remove the selected clips leaving a gap (no ripple). */
export function compileLift(seq: Sequence, clipIds: string[]): EditCompilation | null {
  if (clipIds.length === 0) return null;
  const commands = clipIds.map((id) => ({ type: "RemoveClip", clipId: id }));
  return { commands, summary: `Lift: ${clipIds.length} clip(s) removed, gap left open` };
}

/** EXTRACT (§3.9): remove the selected clips AND close the gap (ripple). */
export function compileExtract(seq: Sequence, clipIds: string[]): EditCompilation | null {
  if (clipIds.length === 0) return null;
  for (const id of clipIds) {
    const clip = seq.clips.find((c) => c.id === id);
    if (!clip) return null;
    const track = findTrack(seq, clip);
    if (!track || track.locked) return null;
  }
  const commands = clipIds.map((id) => ({ type: "RippleDelete", clipId: id }));
  return { commands, summary: `Extract: ${clipIds.length} clip(s) removed, gap closed on each affected track` };
}

/**
 * Multi-clip group move (§3.12): every selected clip shifts by the same
 * delta on its own track; refuted when any target would overlap a
 * non-selected clip on its track (the engine double-checks).
 */
export function compileGroupMove(seq: Sequence, clipIds: string[], deltaFrames: number): EditCompilation | null {
  if (clipIds.length === 0 || deltaFrames === 0) return null;
  const selected = new Set(clipIds);
  const commands: Record<string, unknown>[] = [];
  for (const id of clipIds) {
    const clip = seq.clips.find((c) => c.id === id);
    if (!clip) return null;
    const track = findTrack(seq, clip);
    if (!track || track.locked) return null;
    const target = clip.timelineStartFrame + deltaFrames;
    if (target < 0) return null;
    const newEnd = target + clip.timelineDurationFrames;
    for (const other of clipsOnTrack(seq, clip.trackId, id)) {
      if (selected.has(other.id)) continue; // selected clips move together
      const oEnd = clipEndFrame(seq, other);
      if (target < oEnd && other.timelineStartFrame < newEnd) return null; // would collide
    }
    commands.push({ type: "MoveClip", clipId: id, newTimelineStartFrame: target });
  }
  return { commands, summary: `Group move: ${clipIds.length} clip(s) by ${deltaFrames}f` };
}

export { slipCommand, slideCommands };
