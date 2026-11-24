/**
 * M42-G — Editing style engine.
 *
 * Loads the machine-readable playbook (scripts/ai-editing/style-recipes.json),
 * validates every recipe against the REAL editor vocabularies (EffectType,
 * KeyframeProperty, TransitionKind) so a recipe referencing a non-existent
 * capability fails loudly, matches user prompts to styles, validates style
 * combinations, and resolves each recipe's `needs` against the M42-D model
 * registry into SUPPORTED / PARTIAL / DISCLOSED-GAP — never fabricating a
 * capability.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { EffectType, KeyframeProperty, TransitionKind } from "@/lib/editor/model";
import { MODEL_CAPABILITIES, probeModelRegistry, type ModelCapability } from "@/lib/ai/models";

export interface StyleTransition { kind: string; durationFrames?: [number, number]; use?: string; onlyBetweenScenes?: boolean; onlyBetweenChapters?: boolean; onlyBetweenSections?: boolean }
export interface StyleRecipe {
  id: string;
  name: string;
  family: string;
  purpose: string;
  suitableFor: string[];
  emotion: string;
  aspect: string[];
  structure: string[];
  shotSelection: string;
  pacing: { avgShotSec: [number, number]; shotsPerMin: [number, number]; acceleration?: string };
  cutting: string[];
  transitions: StyleTransition[];
  motion: Record<string, { param?: string; from?: number; to?: number; interpolation?: string; keyframes?: unknown[]; note?: string; use?: string; typicalDurationSec?: [number, number] }>;
  color: { effects?: Array<{ type: string; amount: [number, number] }>; note?: string };
  audio: Record<string, unknown>;
  captions: Record<string, unknown>;
  needs: string[];
  qualityChecks: string[];
  notFor: string[];
  promptExample: string;
}

interface RecipeFile { version: string; recipes: StyleRecipe[] }

let cache: { file: RecipeFile; mtimeMs: number } | null = null;

export function loadStyleRecipes(): RecipeFile {
  const file = path.join(process.cwd(), "scripts", "ai-editing", "style-recipes.json");
  const stat = require("node:fs").statSync(file);
  if (cache && cache.mtimeMs === stat.mtimeMs) return cache.file;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as RecipeFile;
  validateRecipes(parsed);
  cache = { file: parsed, mtimeMs: stat.mtimeMs };
  return parsed;
}

/** Validate recipes against the real editor vocabularies (M42-C rule). */
export function validateRecipes(file: RecipeFile): void {
  const ids = new Set<string>();
  for (const r of file.recipes) {
    if (ids.has(r.id)) throw new Error(`duplicate recipe id: ${r.id}`);
    ids.add(r.id);
    for (const t of r.transitions ?? []) {
      if (!TransitionKind.options.includes(t.kind as never)) throw new Error(`${r.id}: transition kind "${t.kind}" is not a TransitionKind member`);
    }
    for (const block of Object.values(r.motion ?? {})) {
      // "playbackSpeed" is the documented exception — speed ramps execute via
      // the real ChangePlaybackSpeed command (a clip field, not a keyframe).
      if (block.param && block.param !== "playbackSpeed" && !KeyframeProperty.options.includes(block.param as never)) throw new Error(`${r.id}: motion param "${block.param}" is not a KeyframeProperty member`);
    }
    for (const c of r.color?.effects ?? []) {
      if (!EffectType.options.includes(c.type as never)) throw new Error(`${r.id}: color effect "${c.type}" is not an EffectType member`);
    }
    // needs[] entries may be (a) registry capability ids — resolved against
    // the M42-D registry, or (b) free-text asset/tool requirements (music bed,
    // VO copy…) — always DISCLOSED, never silently assumed available. Both are
    // honest; neither is fabricated.
    for (const n of r.needs ?? []) {
      if (typeof n !== "string" || n.length < 3) throw new Error(`${r.id}: needs entries must be descriptive strings`);
    }
    if ((r.qualityChecks ?? []).length < 3) throw new Error(`${r.id}: needs >= 3 qualityChecks`);
  }
}

/** Prompt → ranked styles (deterministic keyword scoring; LLM refinement happens upstream when configured). */
const INTENT_KEYWORDS: Record<string, string[]> = {
  trailer: ["trailer", "teaser", "promo", "cinematic trailer"],
  reel: ["reel", "tiktok", "short", "vertical", "instagram", "social"],
  documentary: ["documentary", "interview", "testimony", "story"],
  storytelling: ["cinematic", "story", "narrative", "film"],
  wedding: ["wedding", "emotional highlight", "bride", "ceremony"],
  gaming: ["gaming", "gameplay", "kill", "montage fast", "hype"],
  product: ["product", "ad", "advertisement", "commercial", "unboxing"],
  tutorial: ["tutorial", "how-to", "how to", "explainer", "lesson", "course"],
  music: ["music video", "beat", "rhythm", "synchronize", "lyric"],
  sports: ["sports", "match", "highlights", "replay", "fitness"],
  podcast: ["podcast", "conversation", "silences", "punch in"],
  reframe: ["9:16", "vertical version", "reframe", "aspect"],
};

/** Whole-word keyword hit (substring matches like "ad" in "adjustments" are false positives — live-demo defect). */
function wordHit(lower: string, kw: string): boolean {
  const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(lower);
}

export function matchStyles(prompt: string): Array<{ recipe: StyleRecipe; score: number; matchedOn: string[] }> {
  const file = loadStyleRecipes();
  const lower = prompt.toLowerCase();
  const scored = file.recipes.map((recipe) => {
    let score = 0;
    const matchedOn: string[] = [];
    for (const [intent, kws] of Object.entries(INTENT_KEYWORDS)) {
      const hit = kws.some((k) => wordHit(lower, k));
      if (hit && (recipe.id.startsWith(intent) || recipe.family === intent)) {
        score += 3;
        matchedOn.push(intent);
      }
    }
    for (const kw of ["trailer", "reel", "wedding", "gaming", "product", "documentary", "captions", "vertical", "silences", "beat", "music", "montage", "cinematic", "tutorial", "podcast", "sports", "advertisement"]) {
      if (wordHit(lower, kw) && JSON.stringify(recipe).toLowerCase().includes(kw)) {
        score += 1;
        matchedOn.push(kw);
      }
    }
    if (lower.includes(recipe.promptExample.toLowerCase().slice(0, 24))) score += 5;
    return { recipe, score, matchedOn };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
}

/** Style combination validation (one structure family + delivery/finish layers). */
const STRUCTURE_FAMILIES = new Set(["cinematic", "documentary", "event", "gaming", "commercial", "educational", "music", "sports"]);
export function combineStyles(ids: string[]): { ok: boolean; reason?: string; recipes: StyleRecipe[] } {
  const file = loadStyleRecipes();
  const recipes = ids.map((id) => file.recipes.find((r) => r.id === id)).filter(Boolean) as StyleRecipe[];
  if (recipes.length !== ids.length) return { ok: false, reason: "unknown style id", recipes: [] };
  const structureCount = recipes.filter((r) => STRUCTURE_FAMILIES.has(r.family)).length;
  if (structureCount > 1) return { ok: false, reason: `more than one structure style (${recipes.filter((r) => STRUCTURE_FAMILIES.has(r.family)).map((r) => r.id).join(", ")}) — pick one narrative structure and add delivery/finish layers`, recipes: [] };
  if (recipes.some((r) => r.id === "wedding-highlight") && recipes.some((r) => r.id === "gaming-highlight")) {
    return { ok: false, reason: "wedding-highlight and gaming-highlight pacing/emotion are incompatible", recipes: [] };
  }
  return { ok: true, recipes };
}

export interface StyleCapabilityReport {
  styleId: string;
  supported: string[];
  partial: Array<{ capability: string; why: string }>;
  disclosedGaps: Array<{ capability: string; readyModels: number; reason: string }>;
}

/** Resolve a recipe's needs[] against the M42-D registry (honest). */
export function styleCapabilities(styleId: string): StyleCapabilityReport | null {
  const file = loadStyleRecipes();
  const recipe = file.recipes.find((r) => r.id === styleId);
  if (!recipe) return null;
  const reg = probeModelRegistry();
  const supported: string[] = [];
  const partial: Array<{ capability: string; why: string }> = [];
  const disclosedGaps: Array<{ capability: string; readyModels: number; reason: string }> = [];
  for (const need of recipe.needs) {
    if (MODEL_CAPABILITIES.includes(need as ModelCapability)) {
      const capable = reg.models.filter((m) => m.capabilities.includes(need as ModelCapability));
      const ready = capable.filter((m) => m.ready);
      if (ready.length > 0) supported.push(need);
      else if (capable.length > 0) partial.push({ capability: need, why: `registered but not ready: ${capable.map((m) => m.readyReason).join("; ")}` });
      else disclosedGaps.push({ capability: need, readyModels: 0, reason: `no registered model/tool provides "${need}" — the plan will disclose this and propose the closest supported alternative` });
    } else {
      disclosedGaps.push({ capability: need, readyModels: 0, reason: "user-provided asset or external tool required — BEAN FX will not generate or assume this content" });
    }
  }
  return { styleId, supported, partial, disclosedGaps };
}

/** "Show me three different styles" — three distinct, meaningfully different plans. */
export function styleAlternatives(prompt: string): Array<{ recipe: StyleRecipe; report: StyleCapabilityReport | null }> {
  const matches = matchStyles(prompt);
  const pool = matches.length >= 3 ? matches : [...matches, ...loadStyleRecipes().recipes.filter((r) => !matches.some((m) => m.recipe.id === r.id)).map((recipe) => ({ recipe, score: 0, matchedOn: [] }))].filter((v, i, a) => a.findIndex((x) => x.recipe.id === v.recipe.id) === i);
  return pool.slice(0, 3).map((m) => ({ recipe: m.recipe, report: styleCapabilities(m.recipe.id) }));
}
