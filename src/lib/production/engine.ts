/**
 * M31 — BEAN AI Production Studio: native pipeline engine.
 *
 * ORIGINAL BEAN FX implementation. Studied the OpenMontage project as PRODUCT
 * inspiration only (idea→…→delivery lifecycle, production board idea);
 * everything here is independently specified and built on existing BEAN FX
 * contracts: durable Job system (no second queue), canonical timeline command
 * architecture, MY AI/RIISHE engine seams, M30 review system, notification
 * dedup, honest health/QA states.
 *
 * Core rules enforced here:
 * - Server-enforced deterministic stage state machine; invalid transitions rejected.
 * - A stage never reports SUCCEEDED unless its validated output exists.
 * - Resume from the last verified checkpoint (SUCCEEDED stages never re-run;
 *   RUNNING across restarts is re-derived, never trusted).
 * - Paid/consequential provider calls require explicit approval + configuration;
 *   unknown cost is UNKNOWN, never 0; no fabricated provider success.
 * - Rights states are explicit; UNKNOWN/RESTRICTED assets are flagged, not used silently.
 */
import { z } from "zod";
import { ShowcaseInputsSchema, DemonstrationPlanSchema } from "./showcase/types";

// ── Structured brief (intake) ───────────────────────────────────────────────
export const ProductionBriefSchema = z.object({
  title: z.string().min(1).max(120),
  subject: z.string().max(2000).default(""),
  purpose: z.string().max(400).default(""),
  audience: z.string().max(400).default(""),
  platform: z.string().max(120).default(""),
  targetDurationSec: z.number().int().min(3).max(3600),
  aspectRatio: z.enum(["16:9", "9:16", "1:1", "4:5"]).default("16:9"),
  resolution: z.enum(["720p", "1080p"]).default("1080p"),
  fps: z.number().int().min(24).max(60).default(30),
  visualDirection: z.string().max(1000).default(""),
  tone: z.string().max(400).default(""),
  narrationPreference: z.enum(["none", "user-provided", "generated-when-configured"]).default("none"),
  musicPreference: z.enum(["none", "user-provided", "generated-when-configured"]).default("user-provided"),
  subtitles: z.boolean().default(true),
  language: z.enum(["en", "ta"]).default("en"),
  brandIdentity: z.string().max(1000).default(""),
  referenceMediaIds: z.array(z.string()).max(10).default([]),
  sourceMediaIds: z.array(z.string()).max(100).default([]),
  deliveryFormats: z.array(z.enum(["mp4-1080p", "mp4-720p", "mp4-vertical", "mp4-square"])).min(1).default(["mp4-1080p"]),
  commercialUse: z.boolean().default(false),
  briefText: z.string().max(4000).default(""),
  // ── M31 SHOWCASE STUDIO (additive — old briefs parse unchanged) ───────────
  campaignType: z.enum(["product-launch", "app-showcase", "website-promo", "startup-intro", "brand-commercial", "feature-demonstration", "social-promo", "cinematic-trailer"]).default("product-launch"),
  /** Structured showcase inputs for the product-understanding stage. */
  showcaseInputs: ShowcaseInputsSchema.nullable().default(null),
  /** Creative tone control (showcase); free `tone` above remains authoritative prose. */
  tonePreset: z.enum(["premium", "cinematic", "minimal", "futuristic", "bold", "playful", "documentary", "luxury", "tech-commercial", "custom"]).nullable().default(null),
  /** Poster + share copy are produced at delivery unless disabled. */
  posterEnabled: z.boolean().default(true),
  shareCopyPlatforms: z.array(z.enum(["youtube", "instagram", "tiktok", "linkedin", "x", "whatsapp"])).max(6).default(["youtube", "instagram", "tiktok", "linkedin", "x", "whatsapp"]),
});
export type ProductionBrief = z.infer<typeof ProductionBriefSchema>;

// ── Stage keys and states ───────────────────────────────────────────────────
export const STAGE_STATES = ["NOT_STARTED", "READY", "RUNNING", "AWAITING_APPROVAL", "SUCCEEDED", "FAILED", "CANCEL_REQUESTED", "CANCELLED", "SKIPPED", "BLOCKED", "SUPERSEDED"] as const;
export type StageState = (typeof STAGE_STATES)[number];

export const STAGE_TRANSITIONS: Record<StageState, StageState[]> = {
  NOT_STARTED: ["READY", "SKIPPED", "BLOCKED"],
  READY: ["RUNNING", "SKIPPED", "BLOCKED", "CANCELLED"],
  RUNNING: ["SUCCEEDED", "FAILED", "AWAITING_APPROVAL", "CANCEL_REQUESTED", "CANCELLED"],
  AWAITING_APPROVAL: ["SUCCEEDED", "FAILED", "RUNNING", "CANCEL_REQUESTED"],
  SUCCEEDED: ["SUPERSEDED"],
  FAILED: ["READY", "CANCELLED", "SKIPPED"],
  CANCEL_REQUESTED: ["CANCELLED", "FAILED"],
  CANCELLED: ["READY"],
  SKIPPED: ["READY"],
  BLOCKED: ["READY", "SKIPPED"],
  SUPERSEDED: ["READY"],
};

export function canTransition(from: StageState, to: StageState): boolean {
  return (STAGE_TRANSITIONS[from] ?? []).includes(to);
}

// ── Pipeline templates ──────────────────────────────────────────────────────
export interface StageDef {
  key: string;
  title: string;
  /** Execution kind drives the server-side runner. */
  kind: "brief" | "research" | "product_understanding" | "concept" | "script" | "storyboard" | "asset_planning" | "asset_generation" | "edit_planning" | "assembly" | "rough_cut" | "review" | "render" | "qa" | "delivery" | "analysis" | "clip_selection" | "variants";
  requiresApproval: boolean;
  /** Provider-dependent stages need explicit user approval AND configured providers. */
  requiresProvider?: string;
  dependsOn: string[];
  skippable: boolean;
}

export interface PipelineTemplate {
  id: string;
  name: string;
  description: string;
  productionType: string;
  /** GENUINELY executable end-to-end with current engine capabilities. */
  active: boolean;
  /** Exact reason a template is not active (shown verbatim in UI/API). */
  unavailableReason?: string;
  stages: StageDef[];
  deliveryFormats: string[];
  version: number;
}

const STAGE = (key: string, title: string, kind: StageDef["kind"], dependsOn: string[], opts: Partial<StageDef> = {}): StageDef =>
  ({ key, title, kind, dependsOn, requiresApproval: false, skippable: false, ...opts });

/**
 * ACTIVE templates complete the full workflow with real editable projects and
 * validated media using deterministic BEAN FX capability (user media, FFmpeg,
 * canonical commands, existing render/export/QA). Their creative-text stages
 * are user-authored or deterministic drafts — enhanced by MY AI/RIISHE ONLY
 * when a provider is configured (never fabricated).
 */
export const PIPELINE_TEMPLATES: PipelineTemplate[] = [
  {
    id: "showcase-studio",
    name: "SHOWCASE STUDIO — Product to Promo Film",
    description: "Understand a product (description / feature list / authorized website / screenshots / demo recordings / a BEAN FX project), direct the campaign, storyboard it, demonstrate the REAL product, compose with cinematic primitives, and deliver film + poster + share copy on the native timeline.",
    productionType: "showcase",
    active: true,
    deliveryFormats: ["mp4-1080p", "mp4-vertical", "mp4-square"],
    version: 1,
    stages: [
      STAGE("INTAKE", "Select product & inputs", "brief", [], { requiresApproval: true }),
      STAGE("PRODUCT_UNDERSTANDING", "Understand the product", "product_understanding", ["INTAKE"], { requiresApproval: true }),
      STAGE("BRIEF", "Creative brief & campaign type", "brief", ["PRODUCT_UNDERSTANDING"], { requiresApproval: true }),
      STAGE("CONCEPT", "Creative concepts", "concept", ["BRIEF"], { requiresApproval: true }),
      STAGE("SCRIPT", "Script", "script", ["CONCEPT"], { requiresApproval: true }),
      STAGE("STORYBOARD", "Storyboard & shot plan", "storyboard", ["SCRIPT"], { requiresApproval: true }),
      STAGE("ASSET_PLANNING", "Asset & demonstration planning", "asset_planning", ["STORYBOARD"], { requiresApproval: true }),
      STAGE("ASSET_GENERATION", "Asset preparation & generation", "asset_generation", ["ASSET_PLANNING"]),
      STAGE("EDIT_PLANNING", "Composition planning", "edit_planning", ["ASSET_GENERATION"]),
      STAGE("TIMELINE_ASSEMBLY", "Native timeline assembly", "assembly", ["EDIT_PLANNING"]),
      STAGE("ROUGH_CUT", "Rough cut verification", "rough_cut", ["TIMELINE_ASSEMBLY"]),
      STAGE("REVIEW", "Client review (M30)", "review", ["ROUGH_CUT"], { requiresApproval: true }),
      STAGE("FINAL_RENDER", "Final render", "render", ["REVIEW"]),
      STAGE("QUALITY_ASSURANCE", "Production QA", "qa", ["FINAL_RENDER"]),
      STAGE("DELIVERY", "Poster, share copy & delivery", "delivery", ["QUALITY_ASSURANCE"]),
    ],
  },
  {
    id: "social-video-factory",
    name: "Social Video Factory",
    description: "Turn source media into captioned, platform-ready clips with multiple aspect-ratio variants.",
    productionType: "social",
    active: true,
    deliveryFormats: ["mp4-vertical", "mp4-square", "mp4-1080p"],
    version: 1,
    stages: [
      STAGE("INTAKE", "Project intake", "brief", [], { requiresApproval: true }),
      STAGE("BRIEF", "Structured brief", "brief", ["INTAKE"]),
      STAGE("CONCEPT", "Content plan", "concept", ["BRIEF"], { requiresApproval: true }),
      STAGE("SCRIPT", "Scene plan", "script", ["CONCEPT"], { requiresApproval: true }),
      STAGE("ASSET_PLANNING", "Asset planning", "asset_planning", ["SCRIPT"], { requiresApproval: true }),
      STAGE("ASSET_GENERATION", "Asset preparation", "asset_generation", ["ASSET_PLANNING"]),
      STAGE("EDIT_PLANNING", "Edit planning", "edit_planning", ["ASSET_GENERATION"]),
      STAGE("TIMELINE_ASSEMBLY", "Native timeline assembly", "assembly", ["EDIT_PLANNING"]),
      STAGE("ROUGH_CUT", "Rough cut verification", "rough_cut", ["TIMELINE_ASSEMBLY"]),
      STAGE("VARIANTS", "Aspect-ratio variants", "variants", ["ROUGH_CUT"], { requiresApproval: true }),
      STAGE("FINAL_RENDER", "Render", "render", ["VARIANTS"]),
      STAGE("QUALITY_ASSURANCE", "Production QA", "qa", ["FINAL_RENDER"]),
      STAGE("DELIVERY", "Delivery", "delivery", ["QUALITY_ASSURANCE"]),
    ],
  },
  {
    id: "podcast-repurposing",
    name: "Podcast Repurposing",
    description: "Analyze long audio/video, select high-energy segments, produce captioned short-form outputs.",
    productionType: "repurpose",
    active: true,
    deliveryFormats: ["mp4-vertical", "mp4-square"],
    version: 1,
    stages: [
      STAGE("INTAKE", "Project intake", "brief", [], { requiresApproval: true }),
      STAGE("BRIEF", "Structured brief", "brief", ["INTAKE"]),
      STAGE("ANALYSIS", "Media analysis", "analysis", ["BRIEF"]),
      STAGE("CLIP_SELECTION", "Segment selection", "clip_selection", ["ANALYSIS"], { requiresApproval: true }),
      STAGE("EDIT_PLANNING", "Edit planning", "edit_planning", ["CLIP_SELECTION"]),
      STAGE("TIMELINE_ASSEMBLY", "Native timeline assembly", "assembly", ["EDIT_PLANNING"]),
      STAGE("ROUGH_CUT", "Rough cut verification", "rough_cut", ["TIMELINE_ASSEMBLY"]),
      STAGE("VARIANTS", "Short-form variants", "variants", ["ROUGH_CUT"], { requiresApproval: true }),
      STAGE("FINAL_RENDER", "Render", "render", ["VARIANTS"]),
      STAGE("QUALITY_ASSURANCE", "Production QA", "qa", ["FINAL_RENDER"]),
      STAGE("DELIVERY", "Delivery", "delivery", ["QUALITY_ASSURANCE"]),
    ],
  },
  {
    id: "brand-commercial",
    name: "Product & Brand Commercial",
    description: "Brief → concepts → shot plan → edit assembly → client review → final render, connected to the M30 review system.",
    productionType: "commercial",
    active: true,
    deliveryFormats: ["mp4-1080p"],
    version: 1,
    stages: [
      STAGE("INTAKE", "Project intake", "brief", [], { requiresApproval: true }),
      STAGE("BRIEF", "Structured brief", "brief", ["INTAKE"]),
      STAGE("CONCEPT", "Creative concepts", "concept", ["BRIEF"], { requiresApproval: true }),
      STAGE("SCRIPT", "Shot list & script", "script", ["CONCEPT"], { requiresApproval: true }),
      STAGE("ASSET_PLANNING", "Asset planning", "asset_planning", ["SCRIPT"], { requiresApproval: true }),
      STAGE("ASSET_GENERATION", "Asset preparation", "asset_generation", ["ASSET_PLANNING"]),
      STAGE("EDIT_PLANNING", "Edit planning", "edit_planning", ["ASSET_GENERATION"]),
      STAGE("TIMELINE_ASSEMBLY", "Native timeline assembly", "assembly", ["EDIT_PLANNING"]),
      STAGE("ROUGH_CUT", "Rough cut verification", "rough_cut", ["TIMELINE_ASSEMBLY"]),
      STAGE("REVIEW", "Client review (M30)", "review", ["ROUGH_CUT"], { requiresApproval: true }),
      STAGE("FINAL_RENDER", "Final render", "render", ["REVIEW"]),
      STAGE("QUALITY_ASSURANCE", "Production QA", "qa", ["FINAL_RENDER"]),
      STAGE("DELIVERY", "Delivery", "delivery", ["QUALITY_ASSURANCE"]),
    ],
  },
  {
    id: "ai-explainer",
    name: "AI Explainer",
    description: "Research-backed explainer with generated diagrams, narration and captions.",
    productionType: "explainer",
    active: false,
    unavailableReason: "Requires a configured text LLM provider for script/narration authoring and a research capability for verified sources. Current environment: provider credentials absent (CONFIGURATION REQUIRED).",
    deliveryFormats: ["mp4-1080p"],
    version: 1,
    stages: [STAGE("INTAKE", "Project intake", "brief", [], { requiresApproval: true }), STAGE("BRIEF", "Structured brief", "brief", ["INTAKE"])],
  },
  {
    id: "documentary-film",
    name: "Documentary / Real-Footage Film",
    description: "Researched, rights-checked documentary edit from sourced footage.",
    productionType: "documentary",
    active: false,
    unavailableReason: "Requires a research capability with verifiable sources and stock-search provider adapters with verified commercial licensing. Neither is configured (CONFIGURATION REQUIRED); rights verification must never be invented.",
    deliveryFormats: ["mp4-1080p"],
    version: 1,
    stages: [STAGE("INTAKE", "Project intake", "brief", [], { requiresApproval: true }), STAGE("BRIEF", "Structured brief", "brief", ["INTAKE"])],
  },
  {
    id: "talking-head",
    name: "Talking-Head Production",
    description: "Narrated talking-head production with B-roll and captions.",
    productionType: "talking-head",
    active: false,
    unavailableReason: "Requires narration TTS (or authorized talking-head footage plus a text LLM for the script). Narration provider is not configured (CONFIGURATION REQUIRED).",
    deliveryFormats: ["mp4-1080p"],
    version: 1,
    stages: [STAGE("INTAKE", "Project intake", "brief", [], { requiresApproval: true }), STAGE("BRIEF", "Structured brief", "brief", ["INTAKE"])],
  },
];

export function getTemplate(id: string): PipelineTemplate | null {
  return PIPELINE_TEMPLATES.find((t) => t.id === id) ?? null;
}

// ── Concepts (deterministic drafts; LLM-enhanced only when configured) ──────
export interface ConceptOption {
  id: string;
  title: string;
  centralIdea: string;
  openingHook: string;
  structure: string;
  visualApproach: string;
  shotStyle: string;
  motionStyle: string;
  musicDirection: string;
  narrationApproach: string;
  audienceEffect: string;
  complexity: "LOW" | "MEDIUM" | "HIGH";
  tooling: string[];
  costNote: string;
}

/** Deterministic, distinct creative directions derived from the brief. */
export function draftConceptOptions(brief: ProductionBrief): ConceptOption[] {
  const subject = brief.subject || brief.title;
  const tone = brief.tone || brief.visualDirection || "clean and direct";
  const dur = brief.targetDurationSec;
  return [
    {
      id: "direct-demonstration",
      title: `Direct Demonstration — ${subject}`,
      centralIdea: `Show ${subject} working, cut tight to the beat of the narration-free visuals.`,
      openingHook: `First 2s: the strongest single frame of ${subject} in motion.`,
      structure: `Hook (0-2s) → demonstration (${Math.round(dur * 0.5)}s) → detail beats (${Math.round(dur * 0.3)}s) → close (${Math.max(2, Math.round(dur * 0.2))}s)`,
      visualApproach: `${tone}; full-frame subject, minimal overlays${brief.subtitles ? ", captions for silent autoplay" : ""}`,
      shotStyle: "Wide → medium → macro inserts on action",
      motionStyle: "Cuts on motion; push-in on key detail",
      musicDirection: brief.musicPreference === "user-provided" ? "User-supplied track, ducked under captions" : "Silent or user-supplied track",
      narrationApproach: brief.narrationPreference === "none" ? "No narration — captions carry meaning" : brief.narrationPreference,
      audienceEffect: "Immediate comprehension of what it does and why it matters",
      complexity: "LOW",
      tooling: ["BEAN timeline commands", "FFmpeg render", "caption system"],
      costNote: "No provider cost with current deterministic tooling",
    },
    {
      id: "problem-solution",
      title: `Problem → Solution — ${subject}`,
      centralIdea: `Open on the friction ${subject} removes, then resolve it on screen.`,
      openingHook: "Open on the problem state; hold one beat longer than comfortable.",
      structure: `Problem (0-${Math.round(dur * 0.3)}s) → turn (${Math.round(dur * 0.3)}s) → solution in use (${Math.round(dur * 0.4)}s)`,
      visualApproach: `${tone}; contrast grade between problem and solution halves`,
      shotStyle: "Handheld problem / stable solution",
      motionStyle: "Match-cut on the turn",
      musicDirection: brief.musicPreference === "user-provided" ? "User track with a clear turn point" : "Silent or user-supplied track",
      narrationApproach: brief.narrationPreference === "none" ? "No narration — captions carry meaning" : brief.narrationPreference,
      audienceEffect: "Relief and clarity — the fix is demonstrated, not claimed",
      complexity: "MEDIUM",
      tooling: ["BEAN timeline commands", "FFmpeg render", "caption system", "color treatment via effect params"],
      costNote: "No provider cost with current deterministic tooling",
    },
    {
      id: "rhythm-montage",
      title: `Rhythm Montage — ${subject}`,
      centralIdea: `A paced montage of ${subject}'s details synced to the music's grid.`,
      openingHook: "Beat-synced first cut within 1s.",
      structure: `Intro (${Math.round(dur * 0.2)}s) → accelerating montage (${Math.round(dur * 0.6)}s) → hold on payoff (${Math.round(dur * 0.2)}s)`,
      visualApproach: `${tone}; macro inserts, speed ramps on beats`,
      shotStyle: "Fast macro inserts, 0.5-1.5s each",
      motionStyle: "Speed ramps + beat cuts",
      musicDirection: brief.musicPreference === "user-provided" ? "User track drives the cut grid" : "Silent or user-supplied track",
      narrationApproach: brief.narrationPreference === "none" ? "No narration" : brief.narrationPreference,
      audienceEffect: "Energy and craft perception",
      complexity: "MEDIUM",
      tooling: ["BEAN timeline commands", "audio waveform grid", "FFmpeg render"],
      costNote: "No provider cost with current deterministic tooling",
    },
  ];
}

// ── Script / storyboard schemas ─────────────────────────────────────────────
export const ScriptLineSchema = z.object({
  id: z.string(),
  sceneNumber: z.number().int().min(1),
  narration: z.string().max(2000).default(""),
  dialogue: z.string().max(2000).default(""),
  onScreenText: z.string().max(300).default(""),
  durationSec: z.number().min(0.5).max(120),
  visual: z.string().max(500).default(""),
  audio: z.string().max(500).default(""),
  transition: z.string().max(60).default("cut"),
  captionCue: z.string().max(300).default(""),
  reference: z.string().max(300).default(""),
});
export const ProductionScriptSchema = z.object({
  revision: z.number().int().min(1).default(1),
  targetDurationSec: z.number().min(3).max(3600),
  lines: z.array(ScriptLineSchema).min(1).max(60),
});
export type ProductionScript = z.infer<typeof ProductionScriptSchema>;

export const StoryboardSceneSchema = z.object({
  sceneKey: z.string(),
  sceneNumber: z.number().int().min(1),
  durationSec: z.number().min(0.5).max(120),
  storyPurpose: z.string().max(500).default(""),
  shotType: z.string().max(80).default(""),
  cameraDirection: z.string().max(200).default(""),
  subject: z.string().max(200).default(""),
  environment: z.string().max(200).default(""),
  lighting: z.string().max(200).default(""),
  composition: z.string().max(200).default(""),
  movement: z.string().max(200).default(""),
  visualStyle: z.string().max(200).default(""),
  narrationSegment: z.string().max(1000).default(""),
  audioCue: z.string().max(300).default(""),
  requiredAssetKind: z.enum(["user_media", "generated_image", "generated_video", "none", "captions_only"]),
  reference: z.string().max(300).default(""),
  generationInstructions: z.string().max(600).default(""),
  /** Placeholder until a real asset is attached — never a fabricated thumbnail. */
  thumbnailPending: z.literal(true).default(true),
  approval: z.enum(["PENDING", "APPROVED", "REJECTED"]).default("PENDING"),
  // ── M31 SHOWCASE STUDIO (additive — existing scenes parse unchanged) ──────
  /** On-screen headline for this scene (showcase). */
  textOverlay: z.string().max(120).default(""),
  /** Which product element this scene shows (feature name, UI area, logo …). */
  productElement: z.string().max(120).default(""),
  /** Outgoing transition name (cut / dissolve / slide …). */
  transition: z.string().max(60).default("cut"),
  /** Composition primitive applied by the showcase composer (id from compositions.ts). */
  compositionPrimitive: z.string().max(64).nullable().default(null),
  /** Phase 4: real-product demonstration plan for this scene. */
  demonstration: DemonstrationPlanSchema.nullable().default(null),
});
export const StoryboardSchema = z.object({
  scenes: z.array(StoryboardSceneSchema).min(1).max(60),
});
export type StoryboardScene = z.infer<typeof StoryboardSceneSchema>;

export function scriptDurationValid(script: ProductionScript): boolean {
  const total = script.lines.reduce((s, l) => s + l.durationSec, 0);
  return Math.abs(total - script.targetDurationSec) <= Math.max(1, script.targetDurationSec * 0.05);
}

// ── Cost gate ───────────────────────────────────────────────────────────────
export interface ProviderCapabilityStatus {
  configured: boolean;
  reason?: string;
}

/**
 * Honest cost estimate for a stage. Deterministic stages cost nothing and need
 * no approval. Provider stages return costUnknown when pricing is unavailable.
 */
export function stageCost(stage: StageDef, approvedBudgetCents: number | null, provider: ProviderCapabilityStatus): { requiresApproval: boolean; blocked: boolean; reason: string; estimatedCents: number | null; costUnknown: boolean } {
  if (!stage.requiresProvider) {
    return { requiresApproval: stage.requiresApproval, blocked: false, reason: "deterministic stage", estimatedCents: 0, costUnknown: false };
  }
  if (!provider.configured) {
    return { requiresApproval: true, blocked: true, reason: provider.reason ?? `Provider for ${stage.requiresProvider} is not configured`, estimatedCents: null, costUnknown: true };
  }
  // Provider configured: approval is mandatory before ANY paid call; budget must exist.
  if (approvedBudgetCents === null) {
    return { requiresApproval: true, blocked: true, reason: "No approved budget set — set a budget before any paid generation", estimatedCents: null, costUnknown: true };
  }
  return { requiresApproval: true, blocked: false, reason: "Awaiting explicit user approval for paid generation", estimatedCents: null, costUnknown: true };
}

// ── QA module ───────────────────────────────────────────────────────────────
export type QaState = "PASSED" | "PASSED_WITH_WARNINGS" | "FAILED" | "NEEDS_HUMAN_REVIEW" | "NOT_RUN";

export interface QaCheck { id: string; severity: "ERROR" | "WARNING" | "INFO"; state: "PASSED" | "FAILED" | "NOT_RUN"; detail: string }

export function qaOutcome(checks: QaCheck[]): { state: QaState; failed: QaCheck[]; warnings: QaCheck[]; notRun: QaCheck[] } {
  const failed = checks.filter((c) => c.state === "FAILED" && c.severity === "ERROR");
  const warnings = checks.filter((c) => c.state === "FAILED" && c.severity === "WARNING");
  const notRun = checks.filter((c) => c.state === "NOT_RUN");
  if (failed.length > 0) return { state: "FAILED", failed, warnings, notRun };
  if (notRun.length > 0) return { state: "NEEDS_HUMAN_REVIEW", failed, warnings, notRun };
  if (warnings.length > 0) return { state: "PASSED_WITH_WARNINGS", failed, warnings, notRun };
  return { state: "PASSED", failed, warnings, notRun };
}

/** Pre-render deterministic checks against the canonical sequence. */
/** Clips live FLAT on the canonical sequence (seq.clips with trackId refs). */
export function seqClips(sequence: unknown): Array<{ id: string; trackId?: string; sourceAssetId?: string | null; missingMedia?: boolean; graphicTemplateId?: string | null; timelineStartFrame: number; timelineDurationFrames: number; sourceInFrame?: number; sourceOutFrame?: number }> {
  const s = sequence as { clips?: unknown[]; tracks?: Array<{ id?: string; clips?: unknown[] }> };
  const flat = Array.isArray(s.clips) ? s.clips : (s.tracks ?? []).flatMap((t) => t.clips ?? []);
  return flat as never;
}

export function preRenderChecks(sequence: unknown, targetDurationSec?: number, targetAspect?: string): QaCheck[] {
  const seq = sequence as { fps?: { num: number; den: number }; tracks?: Array<{ id?: string; clips?: unknown[] }> };
  const checks: QaCheck[] = [];
  const clips = seqClips(sequence);
  checks.push({ id: "sequence-nonempty", severity: "ERROR", state: clips.length > 0 ? "PASSED" : "FAILED", detail: `${clips.length} clips on the timeline` });
  // NIKKI graphic clips render from their template — an empty sourceAssetId is
  // legitimate there; only real media placeholders count as missing.
  const missing = clips.filter((c) => c.missingMedia || (!c.sourceAssetId && !c.graphicTemplateId));
  checks.push({ id: "no-missing-media", severity: "ERROR", state: missing.length === 0 ? "PASSED" : "FAILED", detail: missing.length === 0 ? "all clips reference real assets" : `${missing.length} clip(s) missing media: ${missing.map((c) => c.id).join(", ")}` });
  const invalidRange = clips.filter((c) => (c.sourceOutFrame ?? 0) <= (c.sourceInFrame ?? 0) || c.timelineDurationFrames <= 0);
  checks.push({ id: "valid-clip-ranges", severity: "ERROR", state: invalidRange.length === 0 ? "PASSED" : "FAILED", detail: invalidRange.length === 0 ? "clip ranges valid" : `invalid ranges on ${invalidRange.map((c) => c.id).join(", ")}` });
  const fps = seq.fps && seq.fps.den ? seq.fps.num / seq.fps.den : 30;
  const endFrame = clips.reduce((m, c) => Math.max(m, c.timelineStartFrame + c.timelineDurationFrames), 0);
  const durSec = endFrame / Math.max(1, fps);
  if (targetDurationSec !== undefined) {
    const ok = Math.abs(durSec - targetDurationSec) <= Math.max(1, targetDurationSec * 0.05);
    checks.push({ id: "duration-matches-brief", severity: "ERROR", state: ok ? "PASSED" : "FAILED", detail: `sequence ${durSec.toFixed(2)}s vs target ${targetDurationSec}s` });
  } else {
    checks.push({ id: "duration-known", severity: "WARNING", state: "PASSED", detail: `sequence duration ${durSec.toFixed(2)}s (no brief target) ` });
  }
  const gapStarts = new Map<string, number>();
  for (const t of seq.tracks ?? []) {
    const tclips = (t.clips as Array<{ timelineStartFrame: number; timelineDurationFrames: number }> ?? []).sort((a, b) => a.timelineStartFrame - b.timelineStartFrame);
    for (let i = 1; i < tclips.length; i++) {
      if (tclips[i].timelineStartFrame < tclips[i - 1].timelineStartFrame + tclips[i - 1].timelineDurationFrames) {
        gapStarts.set(t.id ?? "track", tclips[i].timelineStartFrame);
      }
    }
  }
  checks.push({ id: "no-overlapping-clips", severity: "WARNING", state: gapStarts.size === 0 ? "PASSED" : "FAILED", detail: gapStarts.size === 0 ? "no overlaps" : `overlaps on tracks: ${[...gapStarts.keys()].join(", ")}` });
  return checks;
}
