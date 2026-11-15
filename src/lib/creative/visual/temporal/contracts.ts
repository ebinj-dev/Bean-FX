/**
 * M13 — Temporal Visual Intelligence typed contracts (§2–§9/§13).
 *
 * Every temporal record crosses a zod boundary before persistence. Honesty
 * rules are part of the schema:
 *  - tracks are REAL multi-frame correspondences (OpenCV CSRT over consecutive
 *    decoded frames) — a sequence of independent image descriptions is NOT a
 *    track and never stored as one;
 *  - motion measurements live in PIXEL space with the coordinate system
 *    documented on every record — pixel displacement is never converted to
 *    real-world speed without calibrated scene geometry;
 *  - camera motion is estimated SEPARATELY from foreground motion (global
 *    registration first) — a large frame difference alone is never reported
 *    as object movement;
 *  - lost tracking produces broken/uncertain tracks — identity continuity is
 *    never invented, and re-appearance links are labeled `inferred`.
 */
import { z } from "zod";

// ── settings (§11 fingerprints + §2 limits) ─────────────────────────────────
export const TemporalSettingsSchema = z.object({
  /** Sampling rate for the consecutive-frame window (frames per second). */
  sampleFps: z.number().min(1).max(15).default(5),
  /** Hard cap on frames sampled per run (per asset). */
  maxFrames: z.number().default(60),
  /** Window length per tracking pass (seconds) — scene-aware windows. */
  windowSec: z.number().min(2).max(30).default(8),
  /** Minimum detection area (fraction of frame area) to track. */
  minBoxAreaFrac: z.number().min(0.0001).max(0.5).default(0.004),
  /** Max simultaneous tracks per window. */
  maxTracks: z.number().default(5),
  /** Global camera-motion estimation pass (deterministic). */
  cameraMotion: z.boolean().default(true),
  /** Optional provider category labeling of tracked subjects (consent-gated). */
  providerLabels: z.boolean().default(false),
});
export type TemporalSettings = z.infer<typeof TemporalSettingsSchema>;

export const TEMPORAL_SETTINGS_VERSION = "m13-temporal-1.0";
export const TEMPORAL_INDEX_VERSION = "m13-temporal-index-1.0";
export const TRACKING_METHOD = "opencv-csrt+mog2";
export const TRACKING_MODEL = "opencv-4.13.0 (Apache-2.0) — CSRT tracker, MOG2 detector, phase-correlation registration";

// ── frames (§2) ─────────────────────────────────────────────────────────────
export const TemporalFrameSchema = z.object({
  frameId: z.string().max(96),
  assetId: z.string().max(64),
  clipId: z.string().max(64).nullable(),
  /** SOURCE-media seconds (ffmpeg showinfo pts — exact even for VFR inputs). */
  sourceSec: z.number().min(0),
  /** TIMELINE seconds of the mapped placement (null when off-timeline). */
  timelineSec: z.number().min(0).nullable(),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  windowIndex: z.number().int().min(0),
  sampleIntervalSec: z.number().min(0),
  extractionMethod: z.enum(["consecutive-sample"]),
});
export type TemporalFrame = z.infer<typeof TemporalFrameSchema>;

// ── tracks (§3) ─────────────────────────────────────────────────────────────
export const BoundingBoxSchema = z.object({
  /** Top-left origin, pixel coordinates in the SAMPLED frame space. */
  x: z.number().min(0),
  y: z.number().min(0),
  w: z.number().min(1),
  h: z.number().min(1),
});
export type BoundingBox = z.infer<typeof BoundingBoxSchema>;

export const TrackSampleSchema = z.object({
  sourceSec: z.number().min(0),
  timelineSec: z.number().min(0).nullable(),
  bbox: BoundingBoxSchema,
  /** Center in NORMALIZED [0,1] frame coordinates (resize-independent). */
  nx: z.number().min(0).max(1),
  ny: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  visibility: z.enum(["visible", "occluded", "lost"]),
  frameId: z.string().max(96),
});
export type TrackSample = z.infer<typeof TrackSampleSchema>;

export const OcclusionIntervalSchema = z.object({
  startSec: z.number().min(0),
  endSec: z.number().min(0),
  reason: z.string().max(160),
});
export type OcclusionInterval = z.infer<typeof OcclusionIntervalSchema>;

export const TrackSchema = z.object({
  trackId: z.string().max(96),
  assetId: z.string().max(64),
  windowIndex: z.number().int().min(0),
  /** Detector-generic ("moving-object") or provider-labeled (consent). */
  category: z.string().max(60).nullable(),
  categoryProvenance: z.enum(["detector", "provider", "none"]).nullable(),
  method: z.string().max(80),
  model: z.string().max(160),
  samples: z.array(TrackSampleSchema).max(200),
  entrySourceSec: z.number().min(0),
  exitSourceSec: z.number().min(0),
  entryTimelineSec: z.number().min(0).nullable(),
  exitTimelineSec: z.number().min(0).nullable(),
  occlusionIntervals: z.array(OcclusionIntervalSchema).max(12),
  terminationReason: z.enum(["window-end", "tracker-lost", "left-frame", "budget", "merged"]),
  confidence: z.number().min(0).max(1).nullable(),
  /** Candidate re-appearance link — labeled `inferred`, NEVER identity. */
  reappearsAs: z.array(z.string().max(96)).max(4),
  /** Duplicate-detection result: this track was merged into another. */
  mergedInto: z.string().max(96).nullable().default(null),
  provider: z.string().max(60).nullable(),
  model2: z.string().max(80).nullable(),
});
export type Track = z.infer<typeof TrackSchema>;

// ── motion measurements (§4) ────────────────────────────────────────────────
export const MotionMeasurementSchema = z.object({
  trackId: z.string().max(96),
  coordinateSystem: z.literal("pixel-top-left-origin (sampled frame space) + normalized [0,1] center"),
  frameIntervalSec: z.number().min(0),
  resolution: z.string().max(32),
  /** Net displacement of the box CENTER over the track (pixels). */
  displacementPx: z.number(),
  /** Pixel displacement per second — PIXEL SPACE ONLY, never real-world. */
  speedPxPerSec: z.number().nullable(),
  direction: z.enum(["left", "right", "up", "down", "toward-camera", "away-from-camera", "static", "mixed", "uncertain"]).nullable(),
  directionVector: z.object({ dx: z.number(), dy: z.number() }).nullable(),
  accelTrend: z.enum(["accelerating", "decelerating", "steady", "insufficient-data"]).nullable(),
  onsetSec: z.number().min(0).nullable(),
  stopSec: z.number().min(0).nullable(),
  suddenJumps: z.array(z.object({ sourceSec: z.number(), prevNx: z.number(), prevNy: z.number(), nextNx: z.number(), nextNy: z.number(), px: z.number() })).max(8),
  repeatedPatternSec: z.number().min(0).nullable(),
  /** Foreground motion AFTER removing global camera motion (px/frame). */
  foregroundPxPerFrame: z.number().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  limitations: z.string().max(400),
});
export type MotionMeasurement = z.infer<typeof MotionMeasurementSchema>;

// ── camera motion (§5) ──────────────────────────────────────────────────────
export const CameraMotionSchema = z.object({
  windowIndex: z.number().int().min(0),
  assetId: z.string().max(64),
  classification: z.enum(["static", "pan", "tilt", "zoom", "pan-tilt", "handheld-like", "mixed", "uncertain"]),
  /** Median per-frame global translation (pixels, registration-derived). */
  medianDxPx: z.number().nullable(),
  medianDyPx: z.number().nullable(),
  /** Per-frame zoom RATE derived from the window-cumulative multiscale ratio. */
  medianScaleRatio: z.number().nullable(),
  panningSec: z.array(z.object({ startSec: z.number(), endSec: z.number(), dxPxPerFrame: z.number() })).max(8),
  zoomingSec: z.array(z.object({ startSec: z.number(), endSec: z.number(), ratioPerFrame: z.number() })).max(8),
  abruptChanges: z.array(z.object({ sourceSec: z.number(), dxPx: z.number(), dyPx: z.number() })).max(8),
  confidence: z.number().min(0).max(1).nullable(),
  method: z.string().max(80),
  note: z.string().max(400),
});
export type CameraMotion = z.infer<typeof CameraMotionSchema>;

// ── temporal events (§6) ────────────────────────────────────────────────────
export const TemporalEventSchema = z.object({
  eventId: z.string().max(96),
  type: z.enum([
    "subject-entry", "subject-exit", "subject-lost", "motion-onset", "motion-stop",
    "sudden-position-change", "repeated-motion", "camera-move", "static-span",
    "subject-continuity-candidate", "speech-over-motion", "speech-over-static",
  ]),
  sourceStartSec: z.number().min(0),
  sourceEndSec: z.number().min(0),
  timelineStartSec: z.number().min(0).nullable(),
  timelineEndSec: z.number().min(0).nullable(),
  sceneIds: z.array(z.string().max(96)).max(12),
  trackIds: z.array(z.string().max(96)).max(12),
  frameRefs: z.array(z.string().max(96)).max(8),
  method: z.string().max(80),
  /** measured | model-observed | inferred | ai-interpretation | insufficient-evidence */
  evidenceLabel: z.string().max(40),
  confidence: z.number().min(0).max(1).nullable(),
  description: z.string().max(500),
  evidence: z.record(z.string(), z.unknown()),
});
export type TemporalEvent = z.infer<typeof TemporalEventSchema>;

export const TemporalIndexSchema = z.object({
  analysisVersion: z.string().max(40),
  assetId: z.string().max(64),
  assetName: z.string().max(200),
  durationSec: z.number().min(0).nullable(),
  width: z.number().int().min(1).nullable(),
  height: z.number().int().min(1).nullable(),
  sourceFps: z.number().min(0).nullable(),
  settings: TemporalSettingsSchema,
  frames: z.array(TemporalFrameSchema).max(400),
  tracks: z.array(TrackSchema).max(40),
  motion: z.array(MotionMeasurementSchema).max(40),
  camera: z.array(CameraMotionSchema).max(12),
  /** Lightweight copies of the M12 scene records (reuse, not duplication). */
  sceneSummaries: z
    .array(
      z.object({
        sceneId: z.string().max(96),
        sourceStartSec: z.number().min(0),
        sourceEndSec: z.number().min(0),
        timelineStartSec: z.number().min(0).nullable(),
        description: z.string().max(800).nullable(),
        representativeAssetId: z.string().max(64).nullable(),
      }),
    )
    .max(80)
    .default([]),
  events: z.array(TemporalEventSchema).max(80),
  measurement: z.object({
    framesSampled: z.number().int().min(0),
    windows: z.number().int().min(0),
    tracksTotal: z.number().int().min(0),
    tracksLost: z.number().int().min(0),
    cameraClassified: z.number().int().min(0),
    providerLabelsUsed: z.number().int().min(0),
    consentVisual: z.boolean(),
  }),
  notes: z.array(z.string().max(400)).max(12),
});
export type TemporalIndex = z.infer<typeof TemporalIndexSchema>;

// ── temporal search (§7) ────────────────────────────────────────────────────
export const TemporalSearchRequestSchema = z.object({
  query: z.string().min(1).max(300),
  assetId: z.string().max(64).optional(),
  trackId: z.string().max(96).optional(),
  timeStartSec: z.number().min(0).optional(),
  timeEndSec: z.number().min(0).optional(),
  limit: z.number().int().min(1).max(20).default(8),
});
export type TemporalSearchRequest = z.infer<typeof TemporalSearchRequestSchema>;

export const TemporalSearchResultSchema = z.object({
  kind: z.enum(["track", "event", "scene"]),
  refId: z.string().max(96),
  assetId: z.string().max(64),
  sourceStartSec: z.number().min(0),
  sourceEndSec: z.number().min(0),
  timelineStartSec: z.number().min(0).nullable(),
  description: z.string().max(400).nullable(),
  previewAssetId: z.string().max(64).nullable(),
  relevanceScore: z.number().min(0).max(1),
  evidence: z.string().max(400),
});
export type TemporalSearchResult = z.infer<typeof TemporalSearchResultSchema>;

export const TemporalSearchResponseSchema = z.object({
  available: z.boolean(),
  method: z.enum(["provider-ranking", "local-predicate", "none"]),
  results: z.array(TemporalSearchResultSchema).max(20),
  notes: z.array(z.string().max(300)).max(6),
});
export type TemporalSearchResponse = z.infer<typeof TemporalSearchResponseSchema>;

// ── motion-graphics proposals (§8) ──────────────────────────────────────────
export const MographKeyframeSchema = z.object({
  /** M1 keyframe id (required by KeyframeSchema). */
  id: z.string().min(1).max(64),
  property: z.enum(["x", "y", "opacity"]),
  /** CLIP-relative frame (M1 keyframe model — survives timeline moves). */
  frame: z.number().int().min(0),
  /** x/y in % of frame size, OFFSET FROM THE ANCHOR (NIIKI state semantics). */
  value: z.number().min(-200).max(200),
  interpolation: z.enum(["LINEAR", "HOLD"]).default("LINEAR"),
});
export type MographKeyframe = z.infer<typeof MographKeyframeSchema>;

export const MographProposalSchema = z.object({
  proposalId: z.string().max(96),
  trackId: z.string().max(96),
  assetId: z.string().max(64),
  templateId: z.string().max(64),
  templateVersion: z.number().int().min(1),
  label: z.string().max(200),
  primaryText: z.string().max(120),
  /** Timeline frame where the graphic clip starts. */
  clipStartTimelineFrame: z.number().int().min(0),
  durationFrames: z.number().int().min(1),
  keyframes: z.array(MographKeyframeSchema).max(200),
  /** Tracking gaps (held last-known position; no extrapolation). */
  gaps: z.array(z.object({ fromFrame: z.number().int(), toFrame: z.number().int(), note: z.string().max(200) })).max(12),
  warnings: z.array(z.string().max(300)).max(6),
  previewAssetIds: z.array(z.string().max(64)).max(8),
  confidence: z.number().min(0).max(1).nullable(),
  requiresApproval: z.literal(true),
  payload: z.object({
    kind: z.literal("timeline-commands"),
    commands: z.array(z.record(z.string(), z.unknown())).max(2),
  }),
});
export type MographProposal = z.infer<typeof MographProposalSchema>;

// ── provider structured outputs ─────────────────────────────────────────────
export const VisionTrackLabelSchema = z.object({
  labels: z.array(z.object({ trackId: z.string().max(96), category: z.string().max(60), confidence: z.number().min(0).max(1) })).max(12),
});
export type VisionTrackLabel = z.infer<typeof VisionTrackLabelSchema>;

export const VisionTemporalRankingSchema = z.object({
  results: z.array(z.object({ refId: z.string().max(96), kind: z.enum(["track", "event", "scene"]), relevanceScore: z.number().min(0).max(1), evidence: z.string().max(300) })).max(20),
});

export function trackIdOf(assetId: string, windowIndex: number, n: number): string {
  return `${assetId}:w${windowIndex}t${n}`;
}

export function eventIdOf(assetId: string, type: string, n: number): string {
  return `${assetId}:e${type}:${n}`;
}
