/**
 * M11 — Advanced preview & edit simulation (§8).
 *
 * Simulates a proposed M1 command chain against the CURRENT head sequence IN
 * MEMORY — the database is never touched. The preview is derived from the
 * ACTUAL plan (the same commands execution would apply), so what the user
 * approves is exactly what runs.
 *
 * Honest scope: this is a structural simulation (clip list, durations,
 * affected clips, caption moves, warnings) — it is NOT a rendered export and
 * is never presented as one. Rendering happens only through the existing M6
 * pipeline.
 */
import { clipEndFrame, type Sequence } from "@/lib/editor/model";
import { applyCommand, validateCommand, parseCommand, type Command } from "@/lib/editor/commands";

export interface ClipSummary {
  id: string;
  trackId: string;
  trackKind: string;
  label: string | null;
  hasCaption: boolean;
  startSec: number;
  endSec: number;
}

export interface PlanPreview {
  ok: boolean;
  error?: string;
  before: { clipCount: number; durationSec: number; clips: ClipSummary[] };
  after: { clipCount: number; durationSec: number; clips: ClipSummary[] } | null;
  durationDeltaSec: number | null;
  affectedClipIds: string[];
  /** The proposed cuts (timeline seconds) for cut visualization. */
  cuts: { startSec: number; endSec: number; removedSec: number }[];
  /** Clips whose timeline position moved (e.g. caption-bearing clips). */
  movedClips: { clipId: string; fromStartSec: number; toStartSec: number }[];
  warnings: string[];
}

function summarize(seq: Sequence, fps: number, maxClips = 60): { clipCount: number; durationSec: number; clips: ClipSummary[] } {
  const maxEnd = seq.clips.reduce((m, c) => Math.max(m, clipEndFrame(seq, c)), 0);
  const clips: ClipSummary[] = seq.clips
    .slice(0, maxClips)
    .map((c) => ({
      id: c.id,
      trackId: c.trackId,
      trackKind: seq.tracks.find((t) => t.id === c.trackId)?.kind ?? "?",
      label: c.label,
      hasCaption: Boolean(c.captionText && c.captionText.trim()),
      startSec: Math.round((c.timelineStartFrame / fps) * 100) / 100,
      endSec: Math.round((clipEndFrame(seq, c) / fps) * 100) / 100,
    }))
    .sort((a, b) => a.startSec - b.startSec || a.trackId.localeCompare(b.trackId));
  return { clipCount: seq.clips.length, durationSec: Math.round((maxEnd / fps) * 100) / 100, clips };
}

/**
 * Dry-run a plan: validate + apply the chain to an in-memory sequence and
 * return the before/after comparison. NO database writes, ever.
 */
export function previewPlan(seq: Sequence, commandInputs: unknown[], affectedClipIds: string[] = [], cuts: { startSec: number; endSec: number }[] = []): PlanPreview {
  const fps = seq.fps.num / seq.fps.den;
  const before = summarize(seq, fps);
  const commands: Command[] = [];
  try {
    for (const input of commandInputs) commands.push(parseCommand(input));
  } catch (err) {
    return { ok: false, error: `invalid command: ${(err as Error).message.slice(0, 200)}`, before, after: null, durationDeltaSec: null, affectedClipIds, cuts: [], movedClips: [], warnings: [] };
  }
  let working = seq;
  for (const cmd of commands) {
    const validity = validateCommand(working, cmd);
    if (!validity.ok) {
      return { ok: false, error: `validation failed at ${cmd.type}: ${validity.error}`, before, after: null, durationDeltaSec: null, affectedClipIds, cuts: [], movedClips: [], warnings: [] };
    }
    try {
      working = applyCommand(working, cmd).sequence;
    } catch (err) {
      return { ok: false, error: `simulation refused ${cmd.type}: ${(err as Error).message.slice(0, 200)}`, before, after: null, durationDeltaSec: null, affectedClipIds, cuts: [], movedClips: [], warnings: [] };
    }
  }
  const after = summarize(working, fps);
  // Clips whose timeline start moved (from the simulated result).
  const beforeStarts = new Map(seq.clips.map((c) => [c.id, c.timelineStartFrame]));
  const movedClips = working.clips
    .filter((c) => beforeStarts.get(c.id) !== undefined && beforeStarts.get(c.id) !== c.timelineStartFrame)
    .map((c) => ({ clipId: c.id, fromStartSec: Math.round(((beforeStarts.get(c.id) as number) / fps) * 100) / 100, toStartSec: Math.round((c.timelineStartFrame / fps) * 100) / 100 }))
    .slice(0, 40);
  const warnings: string[] = [];
  if (movedClips.length > 0) {
    const hasOtherTrackContent = new Set(seq.clips.map((c) => c.trackId)).size > 1;
    if (hasOtherTrackContent) warnings.push("Some clips shift on their track — verify synchronization with content on other tracks (picture, captions).");
    const captionMoved = movedClips.some((m) => before.clips.find((c) => c.id === m.clipId)?.hasCaption || working.clips.find((c) => c.id === m.clipId)?.captionText);
    if (captionMoved) warnings.push("Caption-bearing clips move — caption text rides its clip; review caption timing after applying.");
  }
  if (seq.transitions.length > 0 && commands.some((c) => c.type === "RippleDelete" || c.type === "RemoveClip" || c.type === "TrimClip")) {
    warnings.push("The plan trims/removes clips on a timeline with transitions — transitions touching affected clips may be removed or invalid; review the result.");
  }
  return {
    ok: true,
    before,
    after,
    durationDeltaSec: Math.round((after.durationSec - before.durationSec) * 100) / 100,
    affectedClipIds,
    cuts: cuts.map((c) => ({ startSec: Math.round(c.startSec * 100) / 100, endSec: Math.round(c.endSec * 100) / 100, removedSec: Math.round((c.endSec - c.startSec) * 100) / 100 })),
    movedClips,
    warnings,
  };
}
