/**
 * M10 — AI Creative Director typed contracts (§10).
 *
 * Every analysis result, finding, recommendation, variant and scorecard
 * crosses a zod boundary before persistence. Honesty is part of the schema:
 * evidence carries an explicit LABEL (measured | inferred | ai-interpretation |
 * insufficient-evidence) and missing data is null — never an invented score.
 */
import { z } from "zod";

// ── evidence ────────────────────────────────────────────────────────────────
// M11 adds "model-observed": evidence from REAL local frame/scene analysis
// (JAZMII deterministic analyzer) — distinct from "measured" (waveform/
// timing numbers) and from "ai-interpretation" (LLM reading).
export const EvidenceLabel = z.enum(["measured", "model-observed", "inferred", "ai-interpretation", "insufficient-evidence"]);
export type EvidenceLabelId = z.infer<typeof EvidenceLabel>;

export const Severity = z.enum(["info", "minor", "moderate", "major"]);

export const FindingCategory = z.enum([
  "opening-hook",
  "long-pause",
  "dead-air",
  "pacing",
  "caption-timing",
  "repeated-narration",
  "audio-quality",
  "transition",
  "ending-cta",
  "scene-structure",
  "visual-repetition",
  "technical",
  "narrative",
  // ── M11 cross-modal categories ──
  "speech-across-cut",
  "narration-without-visuals",
  "visuals-without-narration",
  "caption-mismatch",
  "av-sync",
  "static-visuals",
  "audio-gap",
]);
export type FindingCategoryId = z.infer<typeof FindingCategory>;

export const FindingSchema = z.object({
  findingNo: z.number().int().min(1),
  category: FindingCategory,
  startSec: z.number().min(0).nullable(),
  endSec: z.number().min(0).nullable(),
  severity: Severity,
  confidence: z.number().min(0).max(1).nullable(),
  evidenceLabel: EvidenceLabel,
  /** Measured values + source references (engine, job/asset ids, thresholds). */
  evidence: z.record(z.string(), z.unknown()),
  explanation: z.string().min(1).max(1200),
  suggestion: z.string().max(600).nullable(),
  engine: z.enum(["RIISHE", "GANGZII", "NIIKI", "JAZMII", "LAXII", "MYAI", "deterministic"]),
});
export type Finding = z.infer<typeof FindingSchema>;

// ── creative brief (§3) ─────────────────────────────────────────────────────
export const CreativeBriefSchema = z.object({
  mainSubject: z.string().min(1).max(400),
  /** AI interpretation of the message — clearly not a measured fact. */
  mainMessage: z.string().min(1).max(600),
  storyStructure: z.string().min(1).max(800),
  openingHook: z.object({
    summary: z.string().min(1).max(500),
    evidenceSec: z.number().min(0).nullable(),
    basis: EvidenceLabel,
  }),
  supportingPoints: z.array(z.string().max(300)).max(10),
  importantScenes: z.array(z.object({ index: z.number().int().min(1), note: z.string().max(200) })).max(12),
  endingAndCta: z.string().max(500).nullable(),
  /** Narrative elements the context could not establish. */
  missingElements: z.array(z.string().max(300)).max(10),
  /** STRICT separation: what came from real project data vs model reading. */
  observed: z.array(z.string().max(300)).max(20),
  interpreted: z.array(z.string().max(300)).max(20),
  audience: z.string().max(200).nullable(),
});
export type CreativeBrief = z.infer<typeof CreativeBriefSchema>;

// ── recommendations (§5) ────────────────────────────────────────────────────
export const RecEngine = z.enum(["RIISHE", "GANGZII", "NIIKI", "JAZMII", "LAXII", "MYAI"]);

/**
 * Proposal payloads. ONLY `timeline-commands` executes on the timeline —
 * through validated M1 commands and the versioned persistence path. Engine
 * actions route to the EXISTING durable jobs (no new execution paths);
 * `informational` never executes.
 */
export const ProposalPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("timeline-commands"),
    /** M1 commands (parseCommand-validated at proposal time AND execution). */
    commands: z.array(z.record(z.string(), z.unknown())).min(1).max(20),
  }),
  z.object({
    kind: z.literal("engine-action"),
    engine: RecEngine,
    action: z.enum(["laxii-thumbnail-variants", "laxii-broll-image", "gangzii-loudness", "riishe-autocut-analysis", "jazmii-broll"]),
    /** Engine params — validated by the engine's own schema at dispatch. */
    params: z.record(z.string(), z.unknown()),
  }),
  z.object({
    kind: z.literal("informational"),
    note: z.string().min(1).max(1000),
  }),
]);
export type ProposalPayload = z.infer<typeof ProposalPayloadSchema>;

export const RecommendationSchema = z.object({
  recNo: z.number().int().min(1),
  kind: z.enum(["informational", "executable"]),
  engine: RecEngine,
  title: z.string().min(1).max(160),
  detail: z.string().min(1).max(1200),
  target: z
    .object({
      clipId: z.string().max(64).nullable(),
      trackId: z.string().max(64).nullable(),
      startSec: z.number().min(0).nullable(),
      endSec: z.number().min(0).nullable(),
    })
    .nullable(),
  payload: ProposalPayloadSchema,
  preview: z.record(z.string(), z.unknown()).nullable(),
  requiresApproval: z.boolean(),
  /** Human explanation of WHY (evidence-backed, referencing finding ids). */
  rationale: z.string().max(800),
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

// ── scorecard (§7) ──────────────────────────────────────────────────────────
export const ScorecardDimensionSchema = z.object({
  key: z.enum([
    "hook-clarity",
    "story-coherence",
    "pacing-consistency",
    "audio-quality",
    "caption-quality",
    "visual-consistency",
    "ending-cta-clarity",
    "technical-export-readiness",
  ]),
  /** 1..5; null when data is missing — never invented. */
  score: z.number().int().min(1).max(5).nullable(),
  basis: z.enum(["deterministic", "ai-assessment", "mixed"]),
  evidence: z.array(z.string().max(300)).max(8),
  explanation: z.string().min(1).max(900),
  confidence: z.number().min(0).max(1).nullable(),
  missingData: z.array(z.string().max(240)).max(6),
  suggestions: z.array(z.string().max(300)).max(5),
});
export type ScorecardDimension = z.infer<typeof ScorecardDimensionSchema>;

export const ScorecardSchema = z.object({
  modelVersion: z.string(),
  dimensions: z.array(ScorecardDimensionSchema).length(8),
  /** The documented disclaimer — always present, always honest. */
  overallNote: z.string().min(1).max(900),
});
export type Scorecard = z.infer<typeof ScorecardSchema>;

export const SCORECARD_MODEL_VERSION = "m10-scorecard-1.0";
export const SCORECARD_DISCLAIMER =
  "Creative evaluation only — NOT a prediction of virality, revenue or audience retention. No viewer analytics exist in this system; scores reflect the evidence described in each dimension.";

// ── variants (§6) ───────────────────────────────────────────────────────────
export const VariantKind = z.enum(["hook", "narration-section", "thumbnail", "title", "description", "cta", "scene-sequence"]);

export const VariantPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string().min(1).max(4000) }),
  z.object({ kind: z.literal("thumbnail"), assetId: z.string().max(64) }),
  z.object({ kind: z.literal("timeline-commands"), commands: z.array(z.record(z.string(), z.unknown())).min(1).max(20) }),
]);
export type VariantPayload = z.infer<typeof VariantPayloadSchema>;

export const VariantSchema = z.object({
  kind: VariantKind,
  label: z.string().min(1).max(120),
  description: z.string().min(1).max(800),
  changedElements: z.array(z.string().max(160)).max(8),
  payload: VariantPayloadSchema,
  provenance: z.record(z.string(), z.unknown()),
});
export type Variant = z.infer<typeof VariantSchema>;

// ── assistant (§8) ──────────────────────────────────────────────────────────
export const AssistantIntent = z.enum([
  "review-project",
  "improve-opening",
  "find-pauses",
  "improve-captions",
  "suggest-broll",
  "compare-thumbnails",
  "strengthen-ending",
  "prepare-export",
  "show-improvements",
  "general-question",
]);
export type AssistantIntentId = z.infer<typeof AssistantIntent>;

export const AssistantDecisionSchema = z.object({
  intent: AssistantIntent,
  scope: z.enum(["full", "retention", "scorecard", "brief"]).nullable(),
  language: z.enum(["en", "ta"]),
  /** Short reply produced WITHOUT needing new analysis (general questions). */
  reply: z.string().max(1200).nullable(),
  needsFreshReview: z.boolean(),
});
export type AssistantDecision = z.infer<typeof AssistantDecisionSchema>;

// ── staleness (same formula as MY AI executor — one definition of "current") ─
export function contextVersionOf(version: number, clipCount: number, maxEndFrame: number): string {
  return `v:${version}:${clipCount}:${maxEndFrame}`;
}

// ── M11: unified multimodal observation (§2) ────────────────────────────────
export const ObservationSchema = z.object({
  projectId: z.string().max(64),
  versionId: z.string().max(80),
  assetId: z.string().max(64).nullable(),
  clipId: z.string().max(64).nullable(),
  streamIndex: z.number().int().min(0).nullable(),
  sourceStartSec: z.number().min(0).nullable(),
  sourceEndSec: z.number().min(0).nullable(),
  timelineStartSec: z.number().min(0).nullable(),
  timelineEndSec: z.number().min(0).nullable(),
  method: z.string().max(60),
  evidenceType: z.enum(["audio", "speech", "caption", "visual", "pacing", "sync", "structure"]),
  confidence: z.number().min(0).max(1).nullable(),
  status: z.enum(["analyzed", "detected-not-analyzed", "failed", "unsupported", "missing"]),
  detail: z.record(z.string(), z.unknown()).nullable(),
});
export type Observation = z.infer<typeof ObservationSchema>;
