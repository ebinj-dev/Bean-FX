/**
 * BEAN FX — Editor timeline data model (Milestone 1, shared editing core).
 *
 * Sequence → Tracks → Clips, with transitions, effects and keyframes. All
 * times are integer frames (see ./time.ts). Zod schemas are the single source
 * of truth: they validate AI proposals, client edits and stored snapshots
 * alike — nothing reaches the timeline without passing them.
 *
 * Compositing semantics (documented, deterministic):
 *   - VIDEO / GRAPHIC / CAPTION / OVERLAY tracks composite top-down in track
 *     order; overlapping clips are LEGAL (flagged as warnings by validation).
 *   - AUDIO tracks mix additively; overlaps are legal but flagged.
 *   - Hard ERRORS (rejected, never stored): unknown track references, orphan
 *     or non-adjacent transitions, non-monotonic keyframes, invalid ranges.
 */
import { z } from "zod";
import { makeRational, type Rational, assertValidRange } from "./time";
import { NikkiGraphicStyleSchema, type NikkiGraphicStyle } from "@/lib/nikki/types";

export const TrackKind = z.enum(["VIDEO", "AUDIO", "CAPTION", "GRAPHIC", "OVERLAY"]);
export type TrackKind = z.infer<typeof TrackKind>;

export const RationalSchema = z.object({ num: z.number().int().positive(), den: z.number().int().positive() });

// M16 Phase F: additive extension — color correction + sharpening. Old
// sequences with the original six types keep parsing unchanged.
// M45 Unit B: additive VFX extension — chroma key, shape masks, motion blur.
// Old sequences keep parsing unchanged (enum values are additive).
export const EffectType = z.enum([
  "opacity",
  "volume",
  "flipH",
  "flipV",
  "grayscale",
  "blur",
  "brightness",
  "contrast",
  "saturation",
  "exposure",
  "temperature",
  "tint",
  "highlights",
  "shadows",
  "sharpen",
  "vignette",
  "whites",
  "blacks",
  "crop",
  // M45 Unit B — NIIKI VFX (each maps to a REAL ffmpeg filter AND a canvas
  // preview op in filters.ts, preserving preview/export parity).
  "chromaKey",
  "rectMask",
  "ellipseMask",
  "motionBlur",
]);
export type EffectType = z.infer<typeof EffectType>;

/** M27 P2 — per-EFFECT-parameter keyframes. `frame` is CLIP-RELATIVE on the
 *  TIMELINE clock (0 = clip start; survives timeline moves like property
 *  keyframes). Interpolation modes match the property-keyframe family minus
 *  BEZIER (not exposed for effect params — never displayed as functional). */
export const EffectKeyframeSchema = z.object({
  id: z.string().min(1).max(64),
  param: z.string().min(1).max(32),
  frame: z.number().int().min(0),
  value: z.number(),
  interpolation: z.enum(["HOLD", "LINEAR", "EASE_IN", "EASE_OUT", "EASE_IN_OUT"]).default("LINEAR"),
});
export type EffectKeyframe = z.infer<typeof EffectKeyframeSchema>;

export const EffectSchema = z.object({
  id: z.string().min(1).max(64),
  type: EffectType,
  enabled: z.boolean().default(true),
  params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).default({}),
  /** M27 P2 — parameter keyframes (only for params listed in animatedParams). */
  keyframes: z.array(EffectKeyframeSchema).max(256).default([]),
  /** Params with animation ENABLED — disabling ignores stored keyframes
   *  (non-destructive toggle; legacy effects parse with an empty list). */
  animatedParams: z.array(z.string().max(32)).max(16).default([]),
});
export type Effect = z.infer<typeof EffectSchema>;

// M6 NIIKI: added scaleX/scaleY/blur/letterSpacing (additive — old sequences
// with the original six properties keep parsing unchanged).
export const KeyframeProperty = z.enum(["opacity", "scale", "x", "y", "volume", "rotation", "scaleX", "scaleY", "blur", "letterSpacing"]);
export type KeyframeProperty = z.infer<typeof KeyframeProperty>;

// M6 NIIKI: standard easing family + cubic-Bézier (HOLD/LINEAR/EASE unchanged).
export const Interpolation = z.enum(["LINEAR", "HOLD", "EASE", "EASE_IN", "EASE_OUT", "EASE_IN_OUT", "BEZIER"]);
export type Interpolation = z.infer<typeof Interpolation>;

export const BezierSchema = z.object({
  x1: z.number().min(0).max(1),
  y1: z.number().min(-2).max(2),
  x2: z.number().min(0).max(1),
  y2: z.number().min(-2).max(2),
});

export const KeyframeSchema = z.object({
  id: z.string().min(1).max(64),
  property: KeyframeProperty,
  /** Clip-relative frame (0 = clip start) — survives timeline moves. */
  frame: z.number().int().min(0),
  value: z.number(),
  interpolation: Interpolation.default("LINEAR"),
  /** Controls for BEZIER interpolation (M6 NIIKI, additive optional). */
  bezier: BezierSchema.nullable().default(null),
});
export type Keyframe = z.infer<typeof KeyframeSchema>;

export const TransformSchema = z.object({
  x: z.number().default(0),
  y: z.number().default(0),
  scale: z.number().min(0.01).max(20).default(1),
  rotation: z.number().default(0),
  opacity: z.number().min(0).max(1).default(1),
});
export type Transform = z.infer<typeof TransformSchema>;

export const CaptionStyleSchema = z.object({
  fontSize: z.number().min(8).max(400).default(48),
  color: z.string().max(24).default("#FFFFFF"),
  background: z.string().max(24).nullable().default(null),
  position: z.enum(["TOP", "CENTER", "BOTTOM"]).default("BOTTOM"),
});
export type CaptionStyle = z.infer<typeof CaptionStyleSchema>;

export const ClipSchema = z.object({
  id: z.string().min(1).max(64),
  trackId: z.string().min(1).max(64),
  /** Asset in the project's media library; empty string = placeholder that
   *  must carry missingMedia=true (never silently faked as present). */
  sourceAssetId: z.string().max(64).default(""),
  /** Source media range in the SOURCE's own timebase, exclusive out-point. */
  sourceInFrame: z.number().int().min(0),
  sourceOutFrame: z.number().int().min(0),
  sourceFps: RationalSchema,
  /** Timeline position on the sequence clock. */
  timelineStartFrame: z.number().int().min(0),
  /** Authoritative timeline length in sequence frames (validated by the
   *  engine against the source range, speed and timebases). */
  timelineDurationFrames: z.number().int().min(1),
  playbackSpeed: z.number().positive().max(16).default(1),
  volume: z.number().min(0).max(4).default(1),
  muted: z.boolean().default(false),
  fadeInFrames: z.number().int().min(0).default(0),
  fadeOutFrames: z.number().int().min(0).default(0),
  transform: TransformSchema.prefault({}),
  captionText: z.string().max(2000).nullable().default(null),
  captionStyle: CaptionStyleSchema.nullable().default(null),
  graphicTemplateId: z.string().max(64).nullable().default(null),
  /** M6 NIIKI: the graphic clip's editable content/look/animation. Null for
   *  non-graphic clips and for legacy graphic placeholders. */
  graphicStyle: NikkiGraphicStyleSchema.nullable().default(null),
  label: z.string().max(120).nullable().default(null),
  missingMedia: z.boolean().default(false),
  /** M26 P2 — clip-level stereo pan (-1 left … 1 right). Additive default. */
  pan: z.number().min(-1).max(1).default(0),
  /** M26 P1 — editing group id (any set of clips sharing an id moves as one
   *  via the GroupClips/UngroupClips commands). Null = ungrouped. */
  groupId: z.string().max(64).nullable().default(null),
  /** M48-H1 — independent AUDIO stream source range, in the asset's source
   *  frame clock (same timebase as sourceIn/OutFrame; audio has no frames of
   *  its own, so the asset's video fps clock timestamps the audio stream).
   *  Null/null = the audio follows the video range exactly (legacy clips and
   *  linked clips). When set, the AUDIO stream is trimmed/offset independently
   *  (J/L cuts, manual A/V sync shifts) while the video range — and therefore
   *  the clip's timeline window — is untouched. The audible audio is clamped
   *  to the clip's timeline window by the renderer and preview alike. */
  audioSourceInFrame: z.number().int().min(0).nullable().default(null),
  audioSourceOutFrame: z.number().int().min(0).nullable().default(null),
  /** M48-H1 — linked A/V behaviour. true (default): the two streams are one
   *  range and TrimClip/MoveClip style edits move both. false: the streams are
   *  independent (an audio-stream range may exist and differ from the video
   *  range). Enforced by validation: linked clips carry NO distinct audio
   *  range. */
  avLinked: z.boolean().default(true),
  /** M48-H3 — multicam membership metadata (which group and angle this clip
   *  segment currently shows). Switching an angle produces REAL timeline
   *  segments tagged with these; they are descriptive, not a second engine. */
  multicamGroupId: z.string().max(64).nullable().default(null),
  multicamAngleId: z.string().max(64).nullable().default(null),
  effects: z.array(EffectSchema).max(32).default([]),
  keyframes: z.array(KeyframeSchema).max(512).default([]),
});
export type Clip = z.infer<typeof ClipSchema>;

export const TrackSchema = z.object({
  id: z.string().min(1).max(64),
  kind: TrackKind,
  name: z.string().min(1).max(80),
  visible: z.boolean().default(true),
  muted: z.boolean().default(false),
  solo: z.boolean().default(false),
  locked: z.boolean().default(false),
  /** M26 P2 — per-track fader (multiplicative with clip volume). Additive:
   *  legacy sequences parse with the default. */
  volume: z.number().min(0).max(4).default(1),
  /** M48-H2 — the bus this track routes into. Null = straight to the master
   *  bus (legacy behaviour). The bus object lives on Sequence.buses. */
  busId: z.string().max(64).nullable().default(null),
});
export type Track = z.infer<typeof TrackSchema>;

/**
 * M48-H2 — professional audio buses. REAL routing: a bus sums its assigned
 * tracks' stems, applies its own gain/pan/mute/solo, and feeds the master.
 * The mixer UI's bus faders/pans/meters drive the SAME values the FFmpeg
 * export mixes with — no decorative controls. Four bus kinds cover the
 * standard dialogue/music/SFX/ambience routing; the master bus is implicit
 * (the sequence output), not a listed object. DSP (EQ/compression/limiting/
 * ducking) is NOT implemented here and must not be advertised.
 */
export const AudioBusKind = z.enum(["DIALOGUE", "MUSIC", "SFX", "AMBIENCE"]);
export type AudioBusKindValue = z.infer<typeof AudioBusKind>;
export const AudioBusSchema = z.object({
  id: z.string().min(1).max(64),
  kind: AudioBusKind,
  name: z.string().min(1).max(40),
  gain: z.number().min(0).max(4).default(1),
  pan: z.number().min(-1).max(1).default(0),
  muted: z.boolean().default(false),
  solo: z.boolean().default(false),
});
export type AudioBus = z.infer<typeof AudioBusSchema>;

// M6 NIIKI: added slide/push/zoom kinds (mapped 1:1 onto FFmpeg xfade in the
// render path; the original six kinds are unchanged).
export const TransitionKind = z.enum([
  "CUT",
  "CROSS_DISSOLVE",
  "FADE_TO_BLACK",
  "FADE_FROM_BLACK",
  "WIPE_LEFT",
  "WIPE_RIGHT",
  "SLIDE_LEFT",
  "SLIDE_RIGHT",
  "PUSH_LEFT",
  "PUSH_RIGHT",
  "ZOOM_IN",
  "ZOOM_OUT",
]);
export type TransitionKind = z.infer<typeof TransitionKind>;

export const TransitionSchema = z.object({
  id: z.string().min(1).max(64),
  trackId: z.string().min(1).max(64),
  kind: TransitionKind,
  /** Half-open range on the sequence clock: [startFrame, endFrame). */
  startFrame: z.number().int().min(0),
  endFrame: z.number().int().min(0),
  durationFrames: z.number().int().min(1),
  clipAId: z.string().min(1).max(64),
  clipBId: z.string().min(1).max(64),
  params: z.record(z.string(), z.number()).default({}),
});
export type Transition = z.infer<typeof TransitionSchema>;

/** M26 P1 — timeline markers (sequence-level annotations on the sequence
 *  clock). Additive: legacy sequences parse with an empty list. */
export const MarkerSchema = z.object({
  id: z.string().min(1).max(64),
  frame: z.number().int().min(0),
  label: z.string().max(120).default(""),
});
export type Marker = z.infer<typeof MarkerSchema>;

/** M48-H3 — one camera angle of a multicam group. offsetFrames is in the
 *  angle's OWN source-frame clock: the source frame this angle shows at the
 *  group's sync point (0 = starts exactly at the sync point). */
export const MulticamAngleSchema = z.object({
  id: z.string().min(1).max(64),
  assetId: z.string().min(1).max(64),
  label: z.string().min(1).max(24),
  offsetFrames: z.number().int().min(0).default(0),
});
export type MulticamAngle = z.infer<typeof MulticamAngleSchema>;

export const MulticamGroupSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  angles: z.array(MulticamAngleSchema).min(1).max(8),
});
export type MulticamGroup = z.infer<typeof MulticamGroupSchema>;

export const SequenceSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  fps: RationalSchema,
  width: z.number().int().min(16).max(8192),
  height: z.number().int().min(16).max(8192),
  sampleRate: z.number().int().min(8000).max(384000),
  tracks: z.array(TrackSchema).max(64),
  clips: z.array(ClipSchema).max(20000),
  transitions: z.array(TransitionSchema).max(4000),
  markers: z.array(MarkerSchema).max(200).default([]),
  /** M48-H2 — bus configuration (persistent, edited only through reversible
   *  commands). Legacy sequences parse with an empty list (all tracks route
   *  straight to the master). */
  buses: z.array(AudioBusSchema).max(8).default([]),
  /** M48-H3 — multicamera source groups: several camera angles covering the
   *  same scene, each with a MANUAL sync offset (source frames of that
   *  angle's own clock) relative to the shared sync point. Synchronization
   *  is manual by contract — automatic waveform sync is NOT implemented and
   *  must not be claimed. */
  multicamGroups: z.array(MulticamGroupSchema).max(4).default([]),
});
export type Sequence = z.infer<typeof SequenceSchema>;


/** Clip end on the timeline (exclusive). */
export function clipEndFrame(seq: Sequence, clip: Clip): number {
  return clip.timelineStartFrame + clip.timelineDurationFrames;
}

export function clipTimelineDuration(sourceOut: number, sourceIn: number, sourceFps: Rational, seqFps: Rational, speed: number): number {
  // Source range → seconds → sequence frames ÷ speed. Integer at the last step.
  const sourceFrames = sourceOut - sourceIn;
  const seqFrames = Math.round((sourceFrames * seqFps.num * sourceFps.den) / (sourceFps.num * seqFps.den) / speed);
  if (seqFrames < 1) throw new Error("computed timeline duration is shorter than one frame — trim rejected");
  return seqFrames;
}

export function sequenceDurationFrames(seq: Sequence): number {
  let end = 0;
  for (const c of seq.clips) end = Math.max(end, clipEndFrame(seq, c));
  return end;
}

export interface ValidationReport {
  errors: string[];
  warnings: string[];
}

/** Full structural validation. Errors must never be persisted; warnings are
 *  legitimate editing states (overlaps) surfaced for the UI and MY AI. */
export function validateSequence(seq: Sequence): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const trackById = new Map(seq.tracks.map((t) => [t.id, t]));
  const clipById = new Map(seq.clips.map((c) => [c.id, c]));

  // Duplicate ids are corrupt state, not an edit.
  const seenTracks = new Set<string>();
  for (const t of seq.tracks) {
    if (seenTracks.has(t.id)) errors.push(`duplicate track id ${t.id}`);
    seenTracks.add(t.id);
  }
  const seenClips = new Set<string>();
  for (const c of seq.clips) {
    if (seenClips.has(c.id)) errors.push(`duplicate clip id ${c.id}`);
    seenClips.add(c.id);
  }

  // M48-H2 — bus integrity: unique bus ids; every track busId references an
  // existing bus (a dangling assignment would silently route to nowhere).
  const seenBuses = new Set<string>();
  for (const b of seq.buses ?? []) {
    if (seenBuses.has(b.id)) errors.push(`duplicate bus id ${b.id}`);
    seenBuses.add(b.id);
  }
  for (const t of seq.tracks) {
    if (t.busId && !seenBuses.has(t.busId)) {
      errors.push(`track ${t.id} references unknown bus ${t.busId}`);
    }
  }

  // M48-H3 — multicam integrity: unique group/angle ids; a clip's group tag
  // must reference an existing group, and its angle tag must be one of that
  // group's angles.
  const angleIdsByGroup = new Map<string, Set<string>>();
  for (const g of seq.multicamGroups ?? []) {
    if (angleIdsByGroup.has(g.id)) errors.push(`duplicate multicam group id ${g.id}`);
    const angles = new Set<string>();
    for (const a of g.angles) {
      if (angles.has(a.id)) errors.push(`duplicate angle id ${a.id} in multicam group ${g.id}`);
      angles.add(a.id);
    }
    angleIdsByGroup.set(g.id, angles);
  }
  for (const c of seq.clips) {
    if (c.multicamGroupId && !angleIdsByGroup.has(c.multicamGroupId)) {
      errors.push(`clip ${c.id} references unknown multicam group ${c.multicamGroupId}`);
    } else if (c.multicamGroupId && c.multicamAngleId && !angleIdsByGroup.get(c.multicamGroupId)!.has(c.multicamAngleId)) {
      errors.push(`clip ${c.id} references angle ${c.multicamAngleId} which is not in group ${c.multicamGroupId}`);
    }
  }

  for (const c of seq.clips) {
    const track = trackById.get(c.trackId);
    if (!track) {
      errors.push(`clip ${c.id} references unknown track ${c.trackId}`);
      continue;
    }
    try {
      assertValidRange(c.sourceInFrame, c.sourceOutFrame, `clip ${c.id} source range`);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
    // M48-H1 — independent audio stream range: both endpoints or neither; the
    // range itself must be valid; a LINKED clip must not carry a distinct
    // audio range (linking resolves to the video range by contract).
    // Legacy plain-object sequences may omit the audio-stream fields entirely
    // (undefined = not set — same as null).
    const aIn = c.audioSourceInFrame ?? null;
    const aOut = c.audioSourceOutFrame ?? null;
    const linked = c.avLinked ?? true;
    const hasAudioRange = aIn !== null || aOut !== null;
    if (hasAudioRange) {
      if (aIn === null || aOut === null) {
        errors.push(`clip ${c.id} audio stream range must set BOTH endpoints (or neither)`);
      } else {
        try {
          assertValidRange(aIn, aOut, `clip ${c.id} audio source range`);
        } catch (e) {
          errors.push(e instanceof Error ? e.message : String(e));
        }
        if (linked) {
          errors.push(`clip ${c.id} is avLinked=true but carries a distinct audio stream range — unlink first`);
        }
      }
    }
    if (!Number.isInteger(c.timelineStartFrame) || c.timelineStartFrame < 0) {
      errors.push(`clip ${c.id} timeline start must be a non-negative integer frame`);
    }
    if (c.timelineDurationFrames < 1) {
      errors.push(`clip ${c.id} timeline duration must be at least one frame`);
    }
    // Recompute the timeline duration from the authoritative source data.
    const expected = clipTimelineDuration(c.sourceOutFrame, c.sourceInFrame, makeRational(c.sourceFps.num, c.sourceFps.den), makeRational(seq.fps.num, seq.fps.den), c.playbackSpeed);
    if (expected !== c.timelineDurationFrames) {
      errors.push(
        `clip ${c.id} timeline duration ${c.timelineDurationFrames} does not match source range/speed (expected ${expected}) — corrupted state`,
      );
    }
    if (!c.missingMedia && !c.sourceAssetId) {
      // M6 NIIKI: graphic/overlay clips are legitimately media-less when they
      // carry a template id — their content IS the graphic, not an asset.
      const gTrack = track && (track.kind === "GRAPHIC" || track.kind === "OVERLAY");
      if (!(gTrack && c.graphicTemplateId)) {
        errors.push(`clip ${c.id} has no source asset and is not flagged missingMedia — refusing fake media`);
      }
    }
    for (let i = 1; i < c.keyframes.length; i++) {
      if (c.keyframes[i].frame < c.keyframes[i - 1].frame) {
        errors.push(`clip ${c.id} keyframes are not sorted by frame`);
        break;
      }
    }
    if (c.fadeInFrames + c.fadeOutFrames >= c.timelineDurationFrames) {
      warnings.push(`clip ${c.id} fades cover the whole clip`);
    }
  }

  // Overlap detection per track (warnings — compositing/mixing are legal).
  const byTrack = new Map<string, Clip[]>();
  for (const c of seq.clips) {
    const list = byTrack.get(c.trackId) ?? [];
    list.push(c);
    byTrack.set(c.trackId, list);
  }
  for (const [trackId, clips] of byTrack) {
    const sorted = [...clips].sort((a, b) => a.timelineStartFrame - b.timelineStartFrame);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].timelineStartFrame < clipEndFrame(seq, sorted[i - 1])) {
        warnings.push(`overlap on track ${trackId}: ${sorted[i - 1].id} and ${sorted[i].id}`);
      }
    }
  }

  for (const tr of seq.transitions) {
    const track = trackById.get(tr.trackId);
    if (!track) {
      errors.push(`transition ${tr.id} references unknown track ${tr.trackId}`);
      continue;
    }
    const a = clipById.get(tr.clipAId);
    const b = clipById.get(tr.clipBId);
    if (!a || !b) {
      errors.push(`transition ${tr.id} references missing clip(s) ${tr.clipAId}/${tr.clipBId}`);
      continue;
    }
    if (a.trackId !== tr.trackId || b.trackId !== tr.trackId) {
      errors.push(`transition ${tr.id} clips are not on the transition's track`);
    }
    // Overlap semantics: A's tail and B's head overlap across the transition
    // range (A ends at the range end, B starts at the range start).
    if (clipEndFrame(seq, a) !== tr.endFrame || b.timelineStartFrame !== tr.startFrame) {
      errors.push(`transition ${tr.id} does not overlap its clips correctly (A must end at ${tr.endFrame}, B must start at ${tr.startFrame})`);
    }
    if (tr.endFrame - tr.startFrame !== tr.durationFrames) {
      errors.push(`transition ${tr.id} durationFrames does not match its range`);
    }
  }

  return { errors, warnings };
}

/** Throws when the sequence carries hard errors — used before any persist. */
export function assertValidSequence(seq: Sequence): ValidationReport {
  const report = validateSequence(seq);
  if (report.errors.length > 0) {
    throw new Error(`invalid sequence: ${report.errors[0]}${report.errors.length > 1 ? ` (+${report.errors.length - 1} more)` : ""}`);
  }
  return report;
}

export function parseSequence(json: unknown): Sequence {
  return SequenceSchema.parse(json);
}
