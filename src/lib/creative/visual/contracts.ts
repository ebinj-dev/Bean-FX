/**
 * M12 — Visual Intelligence typed contracts (§2/§3/§4/§5/§6/§12).
 *
 * Every visual record crosses a zod boundary before persistence. Honesty is
 * part of the schema: frames/scenes carry BOTH source-media time and timeline
 * time (explicit, speed-aware), an evidence label, provider/model provenance
 * and a processing status. Missing/failed/unsupported stages are recorded as
 * such — a scene boundary never proves what happens inside the scene, and a
 * description only exists when a REAL vision provider actually inspected the
 * extracted frame.
 */
import { z } from "zod";

// ── settings (§10 fingerprints + §11 limits) ────────────────────────────────
// Ranges are ENFORCED at the API boundary (route schemas) and CLAMPED into
// range by validateVisualSettings (job path) — settings can never widen caps.
export const VisualSettingsSchema = z.object({
  /** Temporal sampling interval for uniform sampling (seconds). */
  sampleIntervalSec: z.number().default(4),
  /** Hard cap on frames extracted AND analyzed per asset per run. */
  maxFramesPerAsset: z.number().default(24),
  /** Frames are scaled so width ≤ this before storage/provider upload. */
  maxFrameWidth: z.number().default(512),
  /** aHash Hamming distance below which two frames count as near-duplicates. */
  duplicateHashDistance: z.number().default(6),
  /** aHash Hamming distance below which two SCENES count as repeated shots. */
  repeatShotHashDistance: z.number().default(10),
  /** Batch size for provider vision calls (frames per request). */
  visionBatchSize: z.number().default(2),
});
export type VisualSettings = z.infer<typeof VisualSettingsSchema>;

export const VISUAL_SETTINGS_VERSION = "m12-visual-1.0";
export const VISUAL_ANALYSIS_VERSION = "m12-visual-index-1.0";

// ── frames (§2) ─────────────────────────────────────────────────────────────
export const FrameAnalysisSchema = z.object({
  description: z.string().min(1).max(600),
  objects: z.array(z.string().max(80)).max(12),
  activities: z.array(z.string().max(120)).max(6),
  environment: z.string().max(160).nullable(),
  /** Visible text only when the provider actually reports reading text. */
  visibleText: z.string().max(300).nullable(),
  shotType: z.enum(["wide", "medium", "close-up", "unknown"]).nullable(),
  composition: z.string().max(240).nullable(),
  subjectPosition: z.string().max(120).nullable(),
});
export type FrameAnalysis = z.infer<typeof FrameAnalysisSchema>;

export const VisualFrameSchema = z.object({
  frameId: z.string().max(96),
  /** Source video asset the frame was extracted from. */
  assetId: z.string().max(64),
  /** Timeline clip placement this frame maps into (may be null off-timeline). */
  clipId: z.string().max(64).nullable(),
  /** SOURCE-media seconds (the file's own clock). */
  sourceSec: z.number().min(0),
  /** TIMELINE seconds of the mapped placement (null when not on the timeline). */
  timelineSec: z.number().min(0).nullable(),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  extractionMethod: z.enum(["uniform-sample", "scene-midpoint", "scene-representative"]),
  /** 64-bit aHash hex (deterministic duplicate/similarity basis). */
  ahash: z.string().max(16),
  /** The kept frame this frame duplicates (skipped-duplicate provenance). */
  dupOf: z.string().max(96).nullable(),
  status: z.enum(["extracted", "analyzed", "failed", "skipped-duplicate", "skipped-budget", "skipped-no-consent"]),
  analysis: FrameAnalysisSchema.nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  provider: z.string().max(60).nullable(),
  model: z.string().max(80).nullable(),
  error: z.string().max(300).nullable(),
});
export type VisualFrame = z.infer<typeof VisualFrameSchema>;

// ── scenes (§4) ─────────────────────────────────────────────────────────────
export const ScenePlacementSchema = z.object({
  clipId: z.string().max(64),
  timelineStartSec: z.number().min(0),
  timelineEndSec: z.number().min(0),
});
export type ScenePlacement = z.infer<typeof ScenePlacementSchema>;

export const VisualSceneSchema = z.object({
  /** Deterministic id: `${assetId}:s${index}`. */
  sceneId: z.string().max(96),
  assetId: z.string().max(64),
  index: z.number().int().min(0),
  /** SOURCE-media range of the scene (JAZMII deterministic cut boundaries). */
  sourceStartSec: z.number().min(0),
  sourceEndSec: z.number().min(0),
  /** Every timeline placement carrying this source range (both clocks). */
  timelinePlacements: z.array(ScenePlacementSchema).max(8),
  representativeFrameId: z.string().max(96).nullable(),
  /** Registered IMAGE asset id of the representative frame (UI thumbnail). */
  representativeAssetId: z.string().max(64).nullable(),
  frameIds: z.array(z.string().max(96)).max(16),
  /** Semantic summary — present ONLY from real provider frame analysis. */
  description: z.string().max(800).nullable(),
  objects: z.array(z.string().max(80)).max(16),
  activities: z.array(z.string().max(120)).max(8),
  category: z.string().max(60).nullable(),
  /** Deterministic aHash similarity neighbours (repeated-shot candidates). */
  similarSceneIds: z.array(z.string().max(96)).max(8),
  repeatGroup: z.number().int().min(0).nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  provider: z.string().max(60).nullable(),
  model: z.string().max(80).nullable(),
  /** `semantic` when a real vision provider inspected frames of this scene. */
  understanding: z.enum(["semantic", "heuristic-only"]),
});
export type VisualScene = z.infer<typeof VisualSceneSchema>;

export const VisualIndexSchema = z.object({
  analysisVersion: z.string().max(40),
  assetId: z.string().max(64),
  assetName: z.string().max(200),
  durationSec: z.number().min(0).nullable(),
  width: z.number().int().min(1).nullable(),
  height: z.number().int().min(1).nullable(),
  fps: z.number().min(0).nullable(),
  settings: VisualSettingsSchema,
  frames: z.array(VisualFrameSchema).max(120),
  scenes: z.array(VisualSceneSchema).max(80),
  /** Deterministic measurement summary (extraction-level, no AI claims). */
  measurement: z.object({
    framesExtracted: z.number().int().min(0),
    framesDeduped: z.number().int().min(0),
    framesAnalyzed: z.number().int().min(0),
    sceneCount: z.number().int().min(0),
    consentVisual: z.boolean(),
  }),
  notes: z.array(z.string().max(400)).max(12),
});
export type VisualIndex = z.infer<typeof VisualIndexSchema>;

// ── narration matching (§6) ─────────────────────────────────────────────────
export const NarrationMatchSchema = z.object({
  segmentIndex: z.number().int().min(0),
  text: z.string().max(500),
  language: z.string().max(30),
  /** Transcript (SOURCE audio) seconds. */
  sourceStartSec: z.number().min(0),
  sourceEndSec: z.number().min(0),
  /** Resolved timeline range of this speech (null when unmappable). */
  timelineStartSec: z.number().min(0).nullable(),
  timelineEndSec: z.number().min(0).nullable(),
  matchedSceneIds: z.array(z.string().max(96)).max(12),
  /** Deterministic coverage of the speech span by timeline video clips. */
  coverage: z.enum(["full", "partial", "none", "unmappable"]),
  /** Grounded relevance verdict (provider when consented, else unknown). */
  relevance: z.enum(["supported", "partially-supported", "unrelated", "unknown"]),
  relevanceScore: z.number().min(0).max(1).nullable(),
  explanation: z.string().max(800),
  missingData: z.array(z.string().max(240)).max(6),
  evidenceLabel: z.enum(["measured", "model-observed", "inferred", "ai-interpretation", "insufficient-evidence"]),
  provider: z.string().max(60).nullable(),
  model: z.string().max(80).nullable(),
});
export type NarrationMatch = z.infer<typeof NarrationMatchSchema>;

// ── footage search (§5) ─────────────────────────────────────────────────────
export const VisualSearchRequestSchema = z.object({
  query: z.string().min(1).max(300),
  assetId: z.string().max(64).optional(),
  /** Optional timeline window filter (seconds). */
  timeStartSec: z.number().min(0).optional(),
  timeEndSec: z.number().min(0).optional(),
  limit: z.number().int().min(1).max(20).default(8),
});
export type VisualSearchRequest = z.infer<typeof VisualSearchRequestSchema>;

export const VisualSearchResultSchema = z.object({
  sceneId: z.string().max(96),
  assetId: z.string().max(64),
  representativeAssetId: z.string().max(64).nullable(),
  sourceStartSec: z.number().min(0),
  sourceEndSec: z.number().min(0),
  timelineStartSec: z.number().min(0).nullable(),
  timelineEndSec: z.number().min(0).nullable(),
  description: z.string().max(400).nullable(),
  matchedTerms: z.array(z.string().max(60)).max(8),
  relevanceScore: z.number().min(0).max(1),
  evidence: z.string().max(300),
});
export type VisualSearchResult = z.infer<typeof VisualSearchResultSchema>;

export const VisualSearchResponseSchema = z.object({
  available: z.boolean(),
  method: z.enum(["provider-ranking", "local-keyword", "none"]),
  results: z.array(VisualSearchResultSchema).max(20),
  notes: z.array(z.string().max(300)).max(6),
});
export type VisualSearchResponse = z.infer<typeof VisualSearchResponseSchema>;

// ── provider vision structured output (§3) ──────────────────────────────────
export const VisionBatchResponseSchema = z.object({
  frames: z.array(FrameAnalysisSchema).min(1).max(4),
});
export type VisionBatchResponse = z.infer<typeof VisionBatchResponseSchema>;

/** Validated provider ranking response for NL search. */
export const VisionSearchRankingSchema = z.object({
  results: z
    .array(
      z.object({
        sceneId: z.string().max(96),
        relevanceScore: z.number().min(0).max(1),
        matchedTerms: z.array(z.string().max(60)).max(8),
        evidence: z.string().max(300),
      }),
    )
    .max(20),
});
export type VisionSearchRanking = z.infer<typeof VisionSearchRankingSchema>;

/** Validated provider narration↔visual relevance response. */
export const VisionMatchVerdictSchema = z.object({
  verdicts: z
    .array(
      z.object({
        segmentIndex: z.number().int().min(0),
        relevance: z.enum(["supported", "partially-supported", "unrelated", "unknown"]),
        relevanceScore: z.number().min(0).max(1).nullable(),
        explanation: z.string().max(600),
      }),
    )
    .max(30),
});
export type VisionMatchVerdict = z.infer<typeof VisionMatchVerdictSchema>;

/** Deterministic ids so findings/recommendations/UI can reference scenes. */
export function sceneIdOf(assetId: string, index: number): string {
  return `${assetId}:s${index}`;
}

export function frameIdOf(assetId: string, sourceSec: number, method: string): string {
  return `${assetId}:f${Math.round(sourceSec * 100)}.${method}`;
}
