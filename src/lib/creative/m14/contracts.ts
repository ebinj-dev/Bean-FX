/**
 * M14 — AI Art Direction & Motion Composition typed contracts.
 *
 * Every M14 record crosses a zod boundary before persistence. Honesty rules:
 *  - palette swatches carry PROVENANCE (direction | system | user-brand);
 *  - scene timestamps from RIISHE are VERBATIM (never invented); estimated
 *    timings are flagged `estimate: true`;
 *  - blend modes are a deliberately SMALL set ({normal, multiply, screen}) —
 *    a mode is advertised only when it renders correctly in BOTH the preview
 *    evaluator and the export compositor (pixel-tested);
 *  - transparency claims come from actual pixel alpha (verified), never from
 *    the provider's capability list alone;
 *  - track bindings follow the M13 gap policy: HOLD at the last measured
 *    position, never extrapolate, identity never claimed.
 */
import { z } from "zod";

// ── art direction (§4) ──────────────────────────────────────────────────────
export const PaletteSwatchSchema = z.object({
  hex: z.string().regex(/^#[0-9a-fA-F]{6}$/, "hex #RRGGBB"),
  role: z.string().max(40),
  source: z.enum(["direction", "system", "user-brand"]),
});
export type PaletteSwatch = z.infer<typeof PaletteSwatchSchema>;

export const StyleProfileSchema = z.object({
  palette: z.array(PaletteSwatchSchema).min(3).max(8),
  medium: z.string().max(120),
  texture: z.string().max(120),
  lineTreatment: z.string().max(120),
  lighting: z.string().max(120),
  composition: z.string().max(160),
  shapeLanguage: z.string().max(120),
  consistencyRules: z.array(z.string().max(200)).max(6),
});
export type StyleProfile = z.infer<typeof StyleProfileSchema>;

export const ArtDirectionSchema = z.object({
  name: z.string().max(80),
  rationale: z.string().max(600),
  styleProfile: StyleProfileSchema,
  typography: z.string().max(240),
  backgroundTreatment: z.string().max(240),
  illustrationApproach: z.string().max(240),
  compositionApproach: z.string().max(240),
  motionLanguage: z.string().max(240),
  sceneContinuity: z.string().max(240),
  assetRequirements: z.array(z.string().max(120)).max(8),
  transitions: z.array(z.string().max(120)).max(6),
  constraints: z.array(z.string().max(200)).max(6),
  /** Deterministic anti-homogenization fingerprint (computed server-side). */
  fingerprint: z.string().max(64).optional(),
});
export type ArtDirection = z.infer<typeof ArtDirectionSchema>;

export const DirectionBriefSchema = z.object({
  projectContext: z.string().max(600).default(""),
  storyOrProduct: z.string().min(1).max(1200),
  audience: z.string().max(300).default(""),
  format: z.enum(["16:9", "9:16", "1:1", "4:5"]).default("16:9"),
  narration: z.string().max(4000).default(""),
  brandReferences: z.string().max(600).default(""),
  requestedStyle: z.string().max(200).default(""),
  motionIntensity: z.enum(["subtle", "moderate", "dynamic"]).default("moderate"),
  language: z.enum(["en", "ta"]).default("en"),
});
export type DirectionBrief = z.infer<typeof DirectionBriefSchema>;

// ── scene plan (§5) ─────────────────────────────────────────────────────────
export const SceneSchema = z.object({
  sceneId: z.string().max(96),
  /** RIISHE segment indices this scene covers (evidence refs). */
  segmentRefs: z.array(z.number().int().min(0)).max(12),
  /** VERBATIM RIISHE seconds when real timestamps exist (never invented). */
  startSec: z.number().min(0),
  endSec: z.number().min(0),
  timingSource: z.enum(["riishe-verbatim", "estimated"]),
  visualConcept: z.string().max(400),
  compositionDescription: z.string().max(400),
  requiredAssets: z.array(z.string().max(120)).max(6),
  onScreenText: z.string().max(200),
  motionRecommendation: z.string().max(200),
  cameraMovement: z.string().max(120),
  transitionRecommendation: z.string().max(120),
  evidence: z.string().max(400),
  confidence: z.number().min(0).max(1).nullable(),
  approvalStatus: z.enum(["PENDING", "APPROVED", "REVISED"]).default("PENDING"),
});
export type Scene = z.infer<typeof SceneSchema>;

export const ScenePlanDocSchema = z.object({
  analysisVersion: z.string().max(40),
  language: z.enum(["en", "ta"]),
  format: z.enum(["16:9", "9:16", "1:1", "4:5"]),
  targetDurationSec: z.number().min(2).max(600).nullable(),
  artDirectionId: z.string().max(64).nullable(),
  scenes: z.array(SceneSchema).max(60),
  notes: z.array(z.string().max(300)).max(8),
});
export type ScenePlanDoc = z.infer<typeof ScenePlanDocSchema>;

// ── composition document (§8) — the SINGLE canonical representation ────────
export const BlendMode = z.enum(["normal", "multiply", "screen"]);
export type BlendModeT = z.infer<typeof BlendMode>;

/** Layer keyframes reuse the M1/M6 semantics: clip-relative frame + value. */
export const LayerKeyframeSchema = z.object({
  id: z.string().min(1).max(64),
  property: z.enum(["x", "y", "scale", "rotation", "opacity"]),
  frame: z.number().int().min(0),
  value: z.number(),
  interpolation: z.enum(["LINEAR", "HOLD", "EASE", "EASE_IN", "EASE_OUT", "EASE_IN_OUT"]).default("LINEAR"),
});
export type LayerKeyframe = z.infer<typeof LayerKeyframeSchema>;

export const LayerTransformSchema = z.object({
  x: z.number().min(-4000).max(4000).default(0),
  y: z.number().min(-4000).max(4000).default(0),
  scale: z.number().min(0.01).max(8).default(1),
  rotation: z.number().min(-360).max(360).default(0),
  opacity: z.number().min(0).max(1).default(1),
});
export type LayerTransform = z.infer<typeof LayerTransformSchema>;

export const MaskSchema = z.object({
  kind: z.enum(["alpha"]).default("alpha"),
  /** Source layer id whose ALPHA channel drives the mask. */
  sourceLayerId: z.string().max(64),
  invert: z.boolean().default(false),
  opacity: z.number().min(0).max(1).default(1),
  transform: LayerTransformSchema.prefault({}),
});
export type Mask = z.infer<typeof MaskSchema>;

export const LayerSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().max(80).default("layer"),
  kind: z.enum(["background", "image", "video", "graphic", "text", "shape"]),
  sourceAssetId: z.string().max(64).nullable().default(null),
  /** Plain-colour fills for background/shape layers (#RRGGBB or #RRGGBBAA). */
  color: z.string().regex(/^#[0-9a-fA-F]{6,8}$/).nullable().default(null),
  text: z.string().max(300).nullable().default(null),
  /** Font size in px at composition scale (text layers). */
  fontSize: z.number().min(8).max(400).default(48),
  visible: z.boolean().default(true),
  locked: z.boolean().default(false),
  blend: BlendMode.default("normal"),
  transform: LayerTransformSchema.prefault({}),
  anchor: z.object({ x: z.number().min(0).max(1).default(0.5), y: z.number().min(0).max(1).default(0.5) }).prefault({}),
  /** Composition-frame range (inclusive start, exclusive end). */
  startFrame: z.number().int().min(0).default(0),
  endFrame: z.number().int().min(1),
  keyframes: z.array(LayerKeyframeSchema).max(400).default([]),
  mask: MaskSchema.nullable().default(null),
  /** M13 track binding — the layer FOLLOWS a validated tracked subject. */
  trackBinding: z
    .object({
      temporalTrackId: z.string().max(96),
      sourceAssetId: z.string().max(64),
      /** HOLD at last measured position through gaps (M13 policy). */
      gapPolicy: z.literal("hold").default("hold"),
      offsetX: z.number().min(-2000).max(2000).default(0),
      offsetY: z.number().min(-2000).max(2000).default(0),
      attachedFrameRange: z.object({ startFrame: z.number().int().min(0), endFrame: z.number().int().min(1) }),
    })
    .nullable()
    .default(null),
});
export type Layer = z.infer<typeof LayerSchema>;

export const CompositionDocSchema = z.object({
  analysisVersion: z.string().max(40).default("m14-composition-1.0"),
  width: z.number().int().min(160).max(1920),
  height: z.number().int().min(160).max(1920),
  fps: z.number().int().min(10).max(60),
  durationFrames: z.number().int().min(1).max(3600),
  layers: z.array(LayerSchema).max(24),
});
export type CompositionDoc = z.infer<typeof CompositionDocSchema>;

export const COMPOSITION_LIMITS = {
  maxLayers: 24,
  maxDimension: 1920,
  maxDurationFrames: 3600,
  maxRenderSeconds: 120,
  maxMaskDimension: 1920,
  maxFramesPerRender: 3600,
} as const;

// ── validated evaluator output (per-frame layer state) ──────────────────────
export const LayerFrameStateSchema = z.object({
  layerId: z.string().max(64),
  kind: LayerSchema.shape.kind,
  visible: z.boolean(),
  opacity: z.number().min(0).max(1),
  x: z.number(),
  y: z.number(),
  scale: z.number(),
  rotation: z.number(),
  blend: BlendMode,
  /** Resolved track-binding position when attached (null = not attached). */
  trackX: z.number().nullable(),
  trackY: z.number().nullable(),
  trackGap: z.boolean(),
  color: z.string().nullable(),
  text: z.string().nullable(),
  fontSize: z.number(),
  sourceAssetId: z.string().nullable(),
});
export type LayerFrameState = z.infer<typeof LayerFrameStateSchema>;

export const CompositionFrameStateSchema = z.object({
  frame: z.number().int().min(0),
  width: z.number(),
  height: z.number(),
  fps: z.number(),
  layers: z.array(LayerFrameStateSchema).max(24),
});
export type CompositionFrameState = z.infer<typeof CompositionFrameStateSchema>;

// ── provider structured outputs ─────────────────────────────────────────────
export const ArtDirectionSetSchema = z.object({
  directions: z.array(ArtDirectionSchema).min(3).max(3),
});
export type ArtDirectionSet = z.infer<typeof ArtDirectionSetSchema>;

export const SceneConceptSetSchema = z.object({
  scenes: z.array(z.object({ sceneId: z.string().max(96), visualConcept: z.string().max(400), compositionDescription: z.string().max(400), onScreenText: z.string().max(200), motionRecommendation: z.string().max(200), cameraMovement: z.string().max(120), transitionRecommendation: z.string().max(120), confidence: z.number().min(0).max(1) })).max(60),
});
export type SceneConceptSet = z.infer<typeof SceneConceptSetSchema>;
