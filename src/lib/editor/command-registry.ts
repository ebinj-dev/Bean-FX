/**
 * BEAN FX — M43-B authoritative editing-command registry (FilmCraft pattern).
 *
 * One typed descriptor per command in the canonical union (`commands.ts`).
 * The descriptor layer ADDS discovery (list/describe), availability gating,
 * risk/approval policy and pure before/after previews — it never re-implements
 * execution: preview runs the SAME `applyCommand` the UI, the AI plan executor
 * and MCP all dispatch through, so a previewed change and an applied change
 * cannot diverge.
 *
 * Everything here is pure (no DB) so agents, tests and the UI can consult the
 * registry synchronously; the DB-facing service lives in
 * `src/lib/my-ai/commands-service.ts` (revision-aware run/batch + provenance).
 */
import { CommandSchema, applyCommand, type Command } from "./commands";
import { clipEndFrame, type Sequence } from "./model";

export type CommandRisk = "low" | "timeline" | "destructive";
export type CommandCategory =
  | "tracks"
  | "clips"
  | "transitions"
  | "effects"
  | "captions"
  | "graphics"
  | "markers"
  | "groups"
  | "keyframes";

export interface RegistryAvailability {
  ok: boolean;
  /** Set when ok is false — a short human/agent-readable reason. */
  reason?: string;
}

export interface PreviewDiff {
  clipsAdded: string[];
  clipsRemoved: string[];
  clipsModified: string[];
  tracksAdded: string[];
  tracksRemoved: string[];
  transitionsAdded: string[];
  transitionsRemoved: string[];
  markersAdded: string[];
  markersRemoved: string[];
}

export interface PreviewSequenceState {
  clipCount: number;
  trackCount: number;
  transitionCount: number;
  markerCount: number;
  /** Timeline span end (max clip end) — 0 for an empty sequence. */
  durationFrames: number;
}

export type CommandPreview =
  | { ok: true; diff: PreviewDiff; sequenceAfter: PreviewSequenceState }
  | { ok: false; error: string };

export interface CommandDescriptor {
  /** Stable, unique, agent-facing id (`timeline.<camelCaseType>`). */
  id: string;
  /** The exact discriminated-union literal — the canonical command type. */
  commandType: Command["type"];
  description: string;
  category: CommandCategory;
  /** Capabilities a caller must hold to dispatch this command. */
  capabilities: string[];
  /** What the command may touch. Every timeline command is project-scoped. */
  scope: "project";
  risk: CommandRisk;
  /**
   * Approval policy: destructive commands are refused by the commands service
   * unless the caller presents an approval context (an approved MY AI plan,
   * a hash-bound MCP approval, or an authenticated UI session). Plan-level
   * approval (M8 §8) governs the AI path independently of this flag.
   */
  requiresApproval: boolean;
  /** Concise typed parameter documentation (agent-facing "describe"). */
  paramsDoc: string;
  /**
   * Cheap enabled-condition pre-check against the sequence state. Advisory
   * only — the executor remains the authoritative validator (fail-closed).
   */
  available(seq: Sequence): RegistryAvailability;
}

function clipIds(seq: Sequence): Set<string> {
  return new Set(seq.clips.map((c) => c.id));
}

function trackIds(seq: Sequence): Set<string> {
  return new Set(seq.tracks.map((t) => t.id));
}

function transitionIds(seq: Sequence): Set<string> {
  return new Set(seq.transitions.map((t) => t.id));
}

function markerIds(seq: Sequence): Set<string> {
  return new Set(seq.markers.map((m) => m.id));
}

function sequenceState(seq: Sequence): PreviewSequenceState {
  return {
    clipCount: seq.clips.length,
    trackCount: seq.tracks.length,
    transitionCount: seq.transitions.length,
    markerCount: seq.markers.length,
    durationFrames: seq.clips.reduce((m, c) => Math.max(m, clipEndFrame(seq, c)), 0),
  };
}

/** Pure before/after preview — runs the canonical `applyCommand` on a clone
 *  (applyCommand never mutates its input) and diffs the two sequences. */
export function previewCommand(seq: Sequence, input: unknown): CommandPreview {
  const beforeIds = {
    clips: clipIds(seq),
    tracks: trackIds(seq),
    transitions: transitionIds(seq),
    markers: markerIds(seq),
  };
  let after: Sequence;
  try {
    after = applyCommand(seq, input).sequence;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const diff: PreviewDiff = {
    clipsAdded: [],
    clipsRemoved: [],
    clipsModified: [],
    tracksAdded: [],
    tracksRemoved: [],
    transitionsAdded: [],
    transitionsRemoved: [],
    markersAdded: [],
    markersRemoved: [],
  };
  const afterById = new Map(after.clips.map((c) => [c.id, c]));
  for (const c of after.clips) {
    if (!beforeIds.clips.has(c.id)) diff.clipsAdded.push(c.id);
  }
  for (const c of seq.clips) {
    if (!afterById.has(c.id)) diff.clipsRemoved.push(c.id);
    else if (JSON.stringify(c) !== JSON.stringify(afterById.get(c.id))) diff.clipsModified.push(c.id);
  }
  for (const t of after.tracks) if (!beforeIds.tracks.has(t.id)) diff.tracksAdded.push(t.id);
  for (const t of seq.tracks) if (!after.tracks.some((x) => x.id === t.id)) diff.tracksRemoved.push(t.id);
  for (const t of after.transitions) if (!beforeIds.transitions.has(t.id)) diff.transitionsAdded.push(t.id);
  for (const t of seq.transitions) if (!after.transitions.some((x) => x.id === t.id)) diff.transitionsRemoved.push(t.id);
  for (const m of after.markers) if (!beforeIds.markers.has(m.id)) diff.markersAdded.push(m.id);
  for (const m of seq.markers) if (!after.markers.some((x) => x.id === m.id)) diff.markersRemoved.push(m.id);
  return { ok: true, diff, sequenceAfter: sequenceState(after) };
}

const MUTATE_CAP = ["timeline.mutate"];

type AvailFn = (seq: Sequence) => RegistryAvailability;

const ok: AvailFn = () => ({ ok: true });
const needTracks = (n: number): AvailFn => (seq) =>
  seq.tracks.length >= n ? { ok: true } : { ok: false, reason: `requires at least ${n} track(s)` };
const needClips = (n: number): AvailFn => (seq) =>
  seq.clips.length >= n ? { ok: true } : { ok: false, reason: `requires at least ${n} clip(s)` };

/** Descriptor table — ONE entry per canonical command type (M43-B acceptance:
 *  the completeness test proves the table covers every union member). */
function d(
  commandType: Command["type"],
  description: string,
  category: CommandCategory,
  risk: CommandRisk,
  paramsDoc: string,
  available: AvailFn,
): CommandDescriptor {
  const camel = commandType.charAt(0).toLowerCase() + commandType.slice(1);
  return {
    id: `timeline.${camel}`,
    commandType,
    description,
    category,
    capabilities: MUTATE_CAP,
    scope: "project",
    risk,
    requiresApproval: risk === "destructive",
    paramsDoc,
    available,
  };
}

export const COMMAND_DESCRIPTORS: CommandDescriptor[] = [
  d("AddTrack", "Add a timeline track (VIDEO/AUDIO/CAPTION/GRAPHIC).", "tracks", "low",
    "track: {id, kind, name, visible?, muted?, solo?, locked?, volume?}", needTracks(0)),
  d("RemoveTrack", "Remove an EMPTY track (refused while it still carries clips).", "tracks", "destructive",
    "trackId", needTracks(1)),
  d("UpdateTrack", "Toggle track flags or rename: visible/muted/solo/locked/name/volume.", "tracks", "low",
    "trackId, visible?/muted?/solo?/locked? (bool), name? (1-80 chars), volume? (0-4)", needTracks(1)),
  d("AddClip", "Append a media/caption/graphic clip to a track (durations re-derived from the rational timebase).", "clips", "low",
    "clip: {id, trackId, sourceAssetId, sourceInFrame, sourceOutFrame, sourceFps:{num,den}, timelineStartFrame, playbackSpeed?, volume?, muted?, fadeInFrames?, fadeOutFrames?, transform?, captionText?, captionStyle?, graphicTemplateId?, label?, effects?, keyframes?}", ok),
  d("RemoveClip", "Remove one clip (also detaches transitions that referenced it).", "clips", "destructive",
    "clipId", needClips(1)),
  d("SplitClip", "Split a clip at a timeline frame into two clips (exact integer timebase split; new ids supplied by the caller).", "clips", "timeline",
    "clipId, atTimelineFrame, newLeftId, newRightId", needClips(1)),
  d("TrimClipAudioStream", "M48-H1 — trim the AUDIO stream only (J/L cuts, manual A/V sync): newAudioSourceInFrame/OutFrame in the asset's source-frame clock. The video range and timeline window are untouched; auto-unlinks A/V.", "clips", "timeline",
    "clipId, newAudioSourceInFrame?/newAudioSourceOutFrame? (int ≥0, nullable)", needClips(1)),
  d("AddBus", "M48-H2 — add an audio bus (DIALOGUE/MUSIC/SFX/AMBIENCE) with gain, pan, mute and solo. Reversible.", "tracks", "timeline",
    "bus { id, kind, name, gain?, pan?, muted?, solo? }", needClips(0)),
  d("RemoveBus", "M48-H2 — remove an empty audio bus (refused while tracks are assigned — routing stays explicit). Reversible.", "tracks", "timeline",
    "busId", needClips(0)),
  d("UpdateBus", "M48-H2 — bus fader/pan/mute/solo/name. Drives the REAL mix: preview Web Audio graph and the FFmpeg export read the same values.", "tracks", "timeline",
    "busId, name?/gain?/pan?/muted?/solo?", needClips(0)),
  d("AssignTrackBus", "M48-H2 — route a track into a bus (null = straight to master). Reversible.", "tracks", "timeline",
    "trackId, busId|null", needClips(0)),
  d("CreateMulticamGroup", "M48-H3 — create a multicamera group: named angles (asset + label + MANUAL sync offset in the angle's own source frames). Automatic waveform sync is not implemented and not claimed.", "clips", "timeline",
    "group { id, name, angles[{ id, assetId, label, offsetFrames }] }", needClips(0)),
  d("RemoveMulticamGroup", "M48-H3 — remove a multicam group (refused while clips reference it). Reversible.", "clips", "timeline",
    "groupId", needClips(0)),
  d("AssignMulticamGroup", "M48-H3 — tag a clip as part of a multicam group (angle metadata; descriptive, not a second engine). Reversible.", "clips", "timeline",
    "clipId, groupId|null, angleId?", needClips(1)),
  d("SwitchMulticamAngle", "M48-H3 — switch the active camera angle at the playhead: splits the clip when the playhead is strictly inside and retargets the right segment to the chosen angle (REAL timeline edit, sync offset applied, fully reversible).", "clips", "timeline",
    "clipId, angleId, atTimelineFrame, newSourceFps, newRightId?", needClips(1)),
  d("SetClipAvLink", "M48-H1 — link or unlink a clip's audio and video streams. Linking resolves the audio range back to the video range (the timeline window is video-authoritative); unlinking pins the audio range so the streams may diverge.", "clips", "timeline",
    "clipId, linked (boolean)", needClips(1)),
  d("TrimClip", "Trim head/tail: newSourceInFrame and/or newSourceOutFrame, optionally moving the timeline start.", "clips", "timeline",
    "clipId, newSourceInFrame?/newSourceOutFrame? (int ≥0), newTimelineStartFrame?", needClips(1)),
  d("MoveClip", "Move a clip's timeline start (optionally to another track of the SAME kind).", "clips", "timeline",
    "clipId, newTimelineStartFrame (int ≥0), newTrackId?", needClips(1)),
  d("RippleDelete", "Remove a clip and close the gap by shifting later clips on that track left.", "clips", "destructive",
    "clipId", needClips(1)),
  d("InsertClip", "Insert a clip at a position, shifting later clips on that track right (ripple insert).", "clips", "timeline",
    "clip: (same shape as AddClip)", needClips(1)),
  d("ReplaceClip", "Re-point a clip at a different source asset and range (placement unchanged).", "clips", "timeline",
    "clipId, newSourceAssetId, newSourceInFrame, newSourceOutFrame, newSourceFps?", needClips(1)),
  d("RelinkAssets", "Bulk-relink every clip referencing dead asset ids to new asset ids (placement and ranges untouched).", "clips", "destructive",
    "mappings: [{deadAssetId, newAssetId}] (1-200)", ok),
  d("AddTransition", "Add a transition (CUT/CROSS_DISSOLVE/FADE_TO_BLACK/FADE_FROM_BLACK/WIPE_*/SLIDE_*/PUSH_*/ZOOM_*) across two adjacent clips on a VIDEO/AUDIO track.", "transitions", "timeline",
    "transitionId, trackId, kind, startFrame, durationFrames (≥1), params: Record<string, number>", (seq) =>
      seq.tracks.some((t) => t.kind === "VIDEO" || t.kind === "AUDIO") && seq.clips.length >= 2
        ? { ok: true }
        : { ok: false, reason: "requires a VIDEO/AUDIO track and at least 2 clips" }),
  d("RemoveTransition", "Remove a transition by id.", "transitions", "destructive",
    "transitionId", (seq) => (seq.transitions.length > 0 ? { ok: true } : { ok: false, reason: "no transitions exist" })),
  d("AddEffect", "Attach a registered filter effect to a clip.", "effects", "low",
    "clipId, effect: EffectSchema", needClips(1)),
  d("RemoveEffect", "Remove an effect from a clip.", "effects", "destructive",
    "clipId, effectId", needClips(1)),
  d("AddCaption", "Add a caption clip (must live on a CAPTION track and carry captionText).", "captions", "low",
    "clip: (same shape as AddClip; trackId must be a CAPTION track)", ok),
  d("AddGraphic", "Add a graphic clip (must live on a GRAPHIC track and carry graphicTemplateId).", "graphics", "low",
    "clip: (same shape as AddClip; trackId must be a GRAPHIC track)", ok),
  d("SetKeyframe", "Set/replace a transform keyframe (value+interpolation) on a clip.", "keyframes", "low",
    "clipId, keyframe: {id, property, frame, value, interpolation}", needClips(1)),
  d("RemoveKeyframe", "Remove a clip transform keyframe by id.", "keyframes", "destructive",
    "clipId, keyframeId", needClips(1)),
  d("ChangeVolume", "Set a clip's volume multiplier (0-4).", "clips", "low",
    "clipId, volume (0-4)", needClips(1)),
  d("ChangePlaybackSpeed", "Change a clip's playback speed (0 < speed ≤ 16); timeline duration recomputes exactly.", "clips", "timeline",
    "clipId, speed (0-16 exclusive)", needClips(1)),
  d("UpdateClipProperties", "Update clip transform/muted/label/pan/fades/caption text+style/graphic template+style.", "clips", "low",
    "clipId, transform?/muted?/label?/pan?/fadeInFrames?/fadeOutFrames?/captionText?/captionStyle?/graphicTemplateId?/graphicStyle?", needClips(1)),
  d("AddMarker", "Add a named marker at a timeline frame (sorted by frame).", "markers", "low",
    "marker: {id, frame (int ≥0), label? (≤120 chars)}", ok),
  d("RemoveMarker", "Remove a marker by id.", "markers", "destructive",
    "markerId", (seq) => (seq.markers.length > 0 ? { ok: true } : { ok: false, reason: "no markers exist" })),
  d("UpdateMarker", "Move a marker (newFrame) and/or relabel it (newLabel).", "markers", "low",
    "markerId, newFrame? (int ≥0), newLabel? (≤120 chars)", (seq) => (seq.markers.length > 0 ? { ok: true } : { ok: false, reason: "no markers exist" })),
  d("GroupClips", "Tag 2-200 clips with a shared groupId (grouping never merges clips).", "groups", "low",
    "clipIds: string[] (2-200), groupId", needClips(2)),
  d("UngroupClips", "Clear the group tag on 1-200 clips.", "groups", "low",
    "clipIds: string[] (1-200)", needClips(1)),
  d("CloseGaps", "Left-shift clips per track so no two consecutive clips leave a gap (refused on tracks with transitions).", "clips", "timeline",
    "trackIds?: string[] (default: every track)", needClips(2)),
  d("AlignClipsToPlayhead", "Align the start of every listed clip to one frame.", "clips", "timeline",
    "clipIds: string[] (1-200), frame (int ≥0)", needClips(1)),
  d("SetClipGroup", "Low-level: set/clear one clip's group tag.", "groups", "low",
    "clipId, groupId (string ≤64 | null)", needClips(1)),
  d("RollEdit", "Roll edit: move the shared boundary between two ADJACENT same-speed clips on one track (both source ranges shift equally; boundary must stay inside both).", "clips", "timeline",
    "leftClipId, rightClipId, newBoundaryFrame (int ≥0)", needClips(2)),
  d("SetEffectKeyframe", "Set/replace a per-effect parameter keyframe (param must belong to the effect's spec).", "keyframes", "low",
    "clipId, effectId, keyframe: {id, param, frame, value, interpolation?}", needClips(1)),
  d("RemoveEffectKeyframe", "Remove a per-effect keyframe by id.", "keyframes", "destructive",
    "clipId, effectId, keyframeId", needClips(1)),
  d("SetEffectKeyframes", "Bulk-replace one effect's whole animation state (the exact inverse unit).", "keyframes", "timeline",
    "clipId, effectId, keyframes: [{id, param, frame, value, interpolation?}] (≤256), animatedParams: string[] (≤16)", needClips(1)),
  d("ToggleEffectParamAnimation", "Enable/disable animation of one effect parameter.", "keyframes", "low",
    "clipId, effectId, param, enabled (bool)", needClips(1)),
];

/** Completeness invariant (asserted by the M43-B test suite): the table covers
 *  every discriminated-union member exactly once. */
export function registryCommandTypes(): Command["type"][] {
  return CommandSchema.options.map((o: { shape: { type: { value: string } } }) => o.shape.type.value as Command["type"]);
}

export function descriptorById(id: string): CommandDescriptor | undefined {
  return COMMAND_DESCRIPTORS.find((x) => x.id === id);
}

export function descriptorForType(type: Command["type"]): CommandDescriptor | undefined {
  return COMMAND_DESCRIPTORS.find((x) => x.commandType === type);
}
