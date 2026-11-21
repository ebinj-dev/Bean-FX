/**
 * M31 SHOWCASE STUDIO — Creative Director concept drafting (Phase 2).
 *
 * Campaign-type-aware, deterministic creative directions derived from the
 * approved product-understanding artifact + brief. Three GENUINELY different
 * directions are drafted; the user must select and approve one before any
 * consequential production begins (append-only ProductionDecision).
 *
 * No concept claims a capability the engine does not have; "required
 * capabilities" name real BEAN FX seams (deterministic motion, LAXII/JAZMII
 * when configured, NIIKI graphics, GANGZII/TTS narration).
 */
import type { ProductionBrief, ProductUnderstandingLike } from "./concept-types";
import { campaignMeta, type CampaignTypeId } from "./types";

export interface ShowcaseConcept {
  id: string;
  title: string;
  centralIdea: string;
  openingHook: string;
  productReveal: string;
  featureHighlights: string[];
  visualApproach: string;
  motionDirection: string;
  musicDirection: string;
  narrationDirection: string;
  closingCta: string;
  complexity: "LOW" | "MEDIUM" | "HIGH";
  requiredCapabilities: string[];
  costNote: string;
}

const DUR = { hook: 0.18, reveal: 0.27, features: 0.32, hero: 0.13, outro: 0.1 } as const;

function beatSplit(dur: number): { hook: number; reveal: number; features: number; hero: number; outro: number } {
  const r = (f: number) => Math.max(1, Math.round(dur * f));
  return { hook: r(DUR.hook), reveal: r(DUR.reveal), features: r(DUR.features), hero: r(DUR.hero), outro: r(DUR.outro) };
}

function topCapabilities(p: ProductUnderstandingLike | null, n: number): string[] {
  const caps = (p?.capabilities ?? []).map((c) => c.name);
  if (caps.length > 0) return caps.slice(0, n);
  return ["the product in use"];
}

function musicFor(brief: ProductionBrief): string {
  if (brief.musicPreference === "none") return "Silence (explicit user preference) — rhythm comes from cut pacing alone.";
  if (brief.musicPreference === "user-provided") return "User-supplied track; ducked under text moments, fades at head/tail via canonical clip fades.";
  return "Music generation is CONFIGURATION REQUIRED on this deployment — assemble silent or attach a user track; never fabricated.";
}

function narrationFor(brief: ProductionBrief, concept: string): string {
  if (brief.narrationPreference === "none") return "No narration — on-screen text carries the message (silent-autoplay safe).";
  if (brief.narrationPreference === "user-provided") return "User-provided voiceover; scene durations align to the provided audio.";
  return `Generated narration via the verified TTS seam (voice tongtong) when enabled — ${concept} read sparingly, never reading every visible label.`;
}

export function draftShowcaseConcepts(brief: ProductionBrief, product: ProductUnderstandingLike | null): ShowcaseConcept[] {
  const subject = product?.identity?.name || brief.subject || brief.title;
  const campaign = campaignMeta(brief.campaignType as CampaignTypeId)?.label ?? brief.campaignType;
  const tone = brief.tonePreset ?? "cinematic";
  const b = beatSplit(brief.targetDurationSec);
  const feats = topCapabilities(product, 3);
  const benefit = product?.mainBenefit || product?.purpose?.slice(0, 120) || `what ${subject} does`;

  return [
    {
      id: "hero-reveal",
      title: `Hero Reveal — ${subject}`,
      centralIdea: `A single confident reveal: ${subject} appears, demonstrates ${benefit}, and lands the CTA — premium restraint throughout.`,
      openingHook: `0–${b.hook}s: the strongest real capture of ${subject} filling frame; one beat of stillness before motion.`,
      productReveal: `${b.hook}–${b.hook + b.reveal}s: hero product reveal — scale-up from 0.92→1.0 with EASE_OUT, logo/title resolves via the cinematic-title primitive.`,
      featureHighlights: feats,
      visualApproach: `${tone} grade from the brief; real product captures dominate; overlays limited to one headline per scene.`,
      motionDirection: "Cinematic-title → hero-reveal → feature-spotlight primitives; staggered text, EASE_IN_OUT moves, frame-accurate to the timeline clock.",
      musicDirection: musicFor(brief),
      narrationDirection: narrationFor(brief, "the reveal"),
      closingCta: `End card: product name + a verified CTA line from the approved artifact — logo-reveal primitive, ${b.outro}s hold.`,
      complexity: "LOW",
      requiredCapabilities: ["BEAN timeline commands", "showcase composition primitives (deterministic keyframes)", "NIIKI graphic titles", "FFmpeg render", "M30 review"],
      costNote: "No provider cost with deterministic tooling; LAXII/JAZMII enhancement adds provider cost only after explicit approval.",
    },
    {
      id: "problem-demonstration",
      title: `Problem → Proof — ${subject}`,
      centralIdea: `Open on the friction ${subject} removes, then demonstrate the actual product solving it on screen — proof over claims.`,
      openingHook: `0–${b.hook}s: the problem state (held longer than comfortable), desaturated grade via the color treatment.`,
      productReveal: `${b.hook}–${b.hook + b.reveal}s: match-cut into ${subject} — split-screen or wipe from problem state to product state.`,
      featureHighlights: feats,
      visualApproach: "Contrast grade between problem and demonstration halves; real UI captures and screen recordings carry the proof.",
      motionDirection: "Split-screen comparison → UI-demonstration primitive with labelled cursor/click accents; cuts land on the music grid when analysis exists.",
      musicDirection: musicFor(brief),
      narrationDirection: narrationFor(brief, "the problem→solution turn"),
      closingCta: `"See it working" CTA over the end card; product identity only, no invented claims.`,
      complexity: "MEDIUM",
      requiredCapabilities: ["demonstration planning (real captures + labelled illustrative accents)", "split-screen & UI-demonstration primitives", "BEAN timeline commands", "FFmpeg render"],
      costNote: "No provider cost with deterministic tooling.",
    },
    {
      id: "rhythm-showcase",
      title: `Rhythm Showcase — ${subject}`,
      centralIdea: `A paced montage of ${subject}'s real feature moments cut to the grid — energy and craft perception.`,
      openingHook: `0–${b.hook}s: beat-synced first cut within one second.`,
      productReveal: `${b.hook}–${b.hook + b.reveal}s: rapid reveal sequence — each ${campaign.toLowerCase()} beat lands a real capture.`,
      featureHighlights: feats,
      visualApproach: "Macro-style inserts of real UI and product moments; speed ramps on transitions; safe-area-checked text for vertical variants.",
      motionDirection: "Staggered feature-spotlight primitives; EASE cuts on beat positions derived from real audio analysis when available.",
      musicDirection: musicFor(brief),
      narrationDirection: narrationFor(brief, "the montage"),
      closingCta: `Hero-moment hold (${b.hero}s) then end card + CTA.`,
      complexity: "MEDIUM",
      requiredCapabilities: ["audio grid analysis (GANGZII, when music attached)", "feature-spotlight primitive", "BEAN timeline commands", "aspect-ratio variants", "FFmpeg render"],
      costNote: "No provider cost with deterministic tooling.",
    },
  ];
}
