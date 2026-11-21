/**
 * M31 SHOWCASE STUDIO — original BEAN FX product-to-video capability.
 *
 * PRODUCT-DESIGN inspiration: BrAG (github.com/latent-spaces/brag) was reviewed
 * at the CONCEPT level only (product-aware understanding → creative direction →
 * launch film → poster/share-copy). NO BrAG source, agent skills, prompts,
 * schemas, scripts, bundled audio/media or UI was copied, vendored or imported;
 * BrAG is not a runtime dependency; no Hyperframes/Remotion was introduced.
 * Everything here runs on the EXISTING verified BEAN FX stack: the M31
 * Production engine (state machine, approvals, cost gate), the canonical
 * timeline command architecture, and the real provider seams (MY AI gateway,
 * LAXII image providers, JAZMII video providers, NIIKI graphics, GANGZII/TTS).
 *
 * Honesty rules (enforced):
 * - The product-understanding artifact contains ONLY claims traceable to a
 *   recorded source; anything else lands in unverifiedClaims.
 * - Illustrative (simulated) product interactions are labelled `illustrative`
 *   in production metadata — never presented as real captured behavior.
 * - Private data (tokens, emails, hostnames, customer records) is excluded
 *   and logged in `exclusions`, never shipped to providers.
 */
import { z } from "zod";

// ── Campaign types (Phase 2) ────────────────────────────────────────────────
export const CAMPAIGN_TYPES = [
  { id: "product-launch", label: "PRODUCT LAUNCH", providerNeeds: [] as string[], note: "Executable with user media + deterministic motion; LAXII/JAZMII enhance when configured." },
  { id: "app-showcase", label: "APP SHOWCASE", providerNeeds: [] as string[], note: "Executable with screenshots/screen recordings + UI demonstration primitives." },
  { id: "website-promo", label: "WEBSITE PROMO", providerNeeds: [] as string[], note: "Executable with authorized site captures; URL text is used as evidence only." },
  { id: "startup-intro", label: "STARTUP INTRO", providerNeeds: [] as string[], note: "Executable with user media + title/CTA primitives." },
  { id: "brand-commercial", label: "BRAND COMMERCIAL", providerNeeds: [] as string[], note: "Executable; shares the verified commercial pipeline." },
  { id: "feature-demonstration", label: "FEATURE DEMONSTRATION", providerNeeds: [] as string[], note: "Executable with real UI captures + demonstration planning." },
  { id: "social-promo", label: "SOCIAL MEDIA PROMO", providerNeeds: [] as string[], note: "Executable; vertical/square safe-area checks enforced." },
  { id: "cinematic-trailer", label: "CINEMATIC PRODUCT TRAILER", providerNeeds: ["video"], note: "Full execution requires a configured video-generation provider (JAZMII) — CONFIGURATION REQUIRED. Without one it still assembles from user media, but generated shots are recorded as blocked." },
] as const;
export type CampaignTypeId = (typeof CAMPAIGN_TYPES)[number]["id"];
export const CampaignTypeIdSchema = z.enum(["product-launch", "app-showcase", "website-promo", "startup-intro", "brand-commercial", "feature-demonstration", "social-promo", "cinematic-trailer"]);

export function campaignMeta(id: CampaignTypeId) {
  return CAMPAIGN_TYPES.find((c) => c.id === id) ?? null;
}

// ── Showcase inputs (Phase 1) ───────────────────────────────────────────────
export const ShowcaseInputsSchema = z.object({
  productName: z.string().max(120).default(""),
  description: z.string().max(4000).default(""),
  featureList: z.string().max(4000).default(""),
  websiteUrl: z.string().max(400).default(""),
  screenshotMediaIds: z.array(z.string().max(64)).max(12).default([]),
  demoVideoMediaIds: z.array(z.string().max(64)).max(4).default([]),
  projectId: z.string().max(64).nullable().default(null),
}).strict();
export type ShowcaseInputs = z.infer<typeof ShowcaseInputsSchema>;

// ── Product-understanding artifact (Phase 1) ────────────────────────────────
export const ProductCapabilitySchema = z.object({
  name: z.string().max(200),
  evidence: z.string().max(500),
});
export const SourceEvidenceSchema = z.object({
  kind: z.enum(["user-stated", "website", "project", "screenshot", "demo-video", "feature-list"]),
  ref: z.string().max(300),
  evidence: z.string().max(800),
});
export type SourceEvidence = z.infer<typeof SourceEvidenceSchema>;
export const ProductUnderstandingSchema = z.object({
  generatedAt: z.string(),
  /** Deterministic core; `llm-assisted` adds structure extracted strictly
   *  FROM the recorded evidence (never new claims). User-approved on the board. */
  basis: z.enum(["deterministic", "llm-assisted"]),
  inputsUsed: z.array(z.string().max(60)).max(20),
  identity: z.object({ name: z.string().max(120), tagline: z.string().max(200).default("") }),
  purpose: z.string().max(1000).default(""),
  audience: z.string().max(500).default(""),
  problem: z.string().max(500).default(""),
  mainBenefit: z.string().max(500).default(""),
  capabilities: z.array(ProductCapabilitySchema).max(6),
  differentiators: z.array(z.string().max(300)).max(5).default([]),
  workflow: z.array(z.string().max(200)).max(6).default([]),
  brand: z.object({
    colors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(6).default([]),
    typographyNote: z.string().max(300).default(""),
    logoMediaId: z.string().max(64).nullable().default(null),
    notes: z.string().max(500).default(""),
  }),
  visualReferences: z.array(z.object({ mediaId: z.string().max(64).nullable(), kind: z.enum(["screenshot", "demo-frame", "project-asset", "generated"]), note: z.string().max(300) })).max(12).default([]),
  sources: z.array(SourceEvidenceSchema).max(40),
  unverifiedClaims: z.array(z.string().max(300)).max(20).default([]),
  exclusions: z.array(z.string().max(300)).max(20).default([]),
  approval: z.enum(["PENDING", "APPROVED", "REJECTED"]).default("PENDING"),
});
export type ProductUnderstanding = z.infer<typeof ProductUnderstandingSchema>;

// ── Demonstration planning (Phase 4) ────────────────────────────────────────
export const DemonstrationPlanSchema = z.object({
  sourceMediaId: z.string().max(64),
  /** Simulated cursor/typing/etc. on top of a REAL capture — labelled, never
   *  presented as genuine product behavior. */
  illustrative: z.boolean().default(false),
  /** Private data that must be masked/replaced before public release. */
  maskNotes: z.array(z.string().max(300)).max(10).default([]),
  ownerActionRequired: z.boolean().default(false),
  note: z.string().max(400).default(""),
});
export type DemonstrationPlan = z.infer<typeof DemonstrationPlanSchema>;

// ── Share copy (Phase 9) ────────────────────────────────────────────────────
export const SHARE_PLATFORMS = ["youtube", "instagram", "tiktok", "linkedin", "x", "whatsapp"] as const;
export const ShareCopySchema = z.object({
  generatedAt: z.string(),
  basis: z.enum(["deterministic", "llm-assisted"]),
  items: z.array(z.object({
    platform: z.enum(SHARE_PLATFORMS),
    text: z.string().max(2200),
    withinLimits: z.boolean(),
  })).max(6),
});
export type ShareCopy = z.infer<typeof ShareCopySchema>;

// ── Poster (Phase 9) ────────────────────────────────────────────────────────
export const PosterPlanSchema = z.object({
  exportFileId: z.string().max(64),
  sourceFrameSec: z.number().min(0),
  sceneKey: z.string().max(64).nullable().default(null),
  title: z.string().max(120).default(""),
  overlayApplied: z.boolean().default(false),
  checks: z.array(z.object({ id: z.string().max(64), state: z.enum(["PASSED", "FAILED", "NOT_RUN"]), detail: z.string().max(300) })).max(10),
});
export type PosterPlan = z.infer<typeof PosterPlanSchema>;
