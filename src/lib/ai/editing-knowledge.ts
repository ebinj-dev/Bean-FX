/**
 * M48-E — shared editing-knowledge retrieval layer.
 *
 * One structured, versioned knowledge system for EVERY BEAN FX agent (§14):
 * agents retrieve the knowledge relevant to their task instead of pasting
 * documents into prompts. Sources:
 *   - style recipes   (scripts/ai-editing/style-recipes.json — 41, validated)
 *   - editing grammar (docs/ai-editing/EDITING_GRAMMAR_AND_TECHNIQUES.md — 51 classified techniques)
 *   - trend feed      (scripts/ai-editing/editing-trends.json — verified-source entries)
 *   - capability truth (docs/M48_EDITOR_CAPABILITY_INVENTORY.md statuses)
 *
 * Retrieval is pure and deterministic: keyword scoring over titles/purposes/
 * cutting lists/quality checks, with an explicit capability truth for the
 * queried domain so an agent never advertises an unavailable capability.
 * Project/user data NEVER enters this layer — shared knowledge only.
 */
import { loadStyleRecipes } from "./styles";

export interface RetrievedKnowledge {
  query: string;
  domain: string;
  recipes: Array<{ id: string; name: string; family: string; purpose: string; promptExample: string }>;
  grammar: string[];
  trends: Array<{ id: string; name: string; confidence: string; sources: string[] }>;
  capabilityTruth: string[];
}

interface TrendEntry {
  id: string;
  name: string;
  category: string;
  description: string;
  confidence: string;
  sources: string[];
  capabilityRequirements?: string[];
  bestContentTypes?: string[];
  risksAndAntiPatterns?: string[];
}

const DOMAIN_KEYWORDS: Record<string, string[]> = {
  color: ["color", "colour", "grade", "grading", "lut", "tone", "contrast", "saturation", "temperature"],
  audio: ["audio", "sound", "music", "ducking", "loudness", "mix", "beat", "sfx", "narration", "voice"],
  caption: ["caption", "subtitle", "transcript", "translation", "srt", "vtt", "tamil", "tanglish", "hindi"],
  pacing: ["pacing", "rhythm", "cuts", "cutting", "tempo", "speed", "slow", "fast", "montage"],
  story: ["story", "narrative", "structure", "arc", "hook", "ending", "emotion"],
  delivery: ["export", "delivery", "youtube", "instagram", "tiktok", "shorts", "reels", "publish", "aspect", "vertical"],
  vfx: ["vfx", "effect", "motion", "graphic", "title", "mask", "key", "chroma", "animation", "typography"],
};

const CAPABILITY_TRUTH: Record<string, string[]> = {
  color: [
    "EXECUTABLE: brightness/contrast/saturation/exposure/temperature/tint/highlights/shadows/whites/blacks/vignette/grayscale — preview+export parity via the shared filter registry",
    "APPROXIMATE-PREVIEW (disclosed): highlights/shadows/whites/blacks are brightness approximations",
    "NOT IMPLEMENTED (do not advertise): LUT import, ACES/ICC color management, HDR/HLG/PQ transforms, scopes exist for preview QC but color management is roadmap",
  ],
  audio: [
    "EXECUTABLE: clip volume/pan/fades/volume automation keyframes, track fader/mute/solo, GANGZII offline processing (noise/hum/deess/click/DC/loudness/trim/compressor/limiter)",
    "EXECUTABLE (preview parity): fades now visible in the monitor picture as well as audio",
    "NOT IMPLEMENTED (do not advertise): live EQ/compressor/limiter/ducking in the engine, audio-track crossfade rendering, stem export, source separation (CONDITIONAL), diarization (LICENSE/TERMS-BLOCKED)",
  ],
  caption: [
    "EXECUTABLE: caption tracks + styling + SRT import; transcript approve → SRT asset",
    "PARTIAL (disclosed): transcription timing is phrase/chunk-level (energy-estimated), NOT word-level",
    "LANGUAGE STATUS (do not change honestly): English tested; Tamil/Tanglish UNVERIFIED until native-speaker validation passes (M47.4 pack exists)",
    "NOT IMPLEMENTED: diarization/speaker identification, automatic translation",
  ],
  pacing: [
    "EXECUTABLE: razor/trim/roll/slip/slide/ripple/insert/overwrite/append/lift/extract/close-gaps/speed ramps — all canonical reversible commands",
    "EXECUTABLE: timeline I/O range as a render range; GO TO timecode incl. drop-frame; next/prev edit point and marker navigation",
    "NOT IMPLEMENTED (do not advertise): ripple-trim as a dedicated mode, extend edit, split A/V edges, multicam sync",
  ],
  story: [
    "EXECUTABLE: style recipes (41) with structure/shot-selection/pacing guidance; RIISHE plans via the canonical approval-gated planner",
    "PRINCIPLE: structure is narrated — RIISHE never auto-generates content; the user approves every plan",
  ],
  delivery: [
    "EXECUTABLE: render mp4/mov/wav/mp3 with real ffprobe QC gates; batch export + aspect variants (7+ profiles) from TIMELINE_RENDER or VIDEO masters; publishing suite (thumbnails/metadata/brand/package)",
    "DELIVERY SPEC (verified source): YouTube upload encoding standard (see trends)",
    "NOT IMPLEMENTED (do not advertise): SRT sidecar generation at render time (roadmap), platform API publishing",
  ],
  vfx: [
    "EXECUTABLE: chroma key, rect/ellipse masks with feather/invert, motion blur, NIIKI graphics (templates/keyframes/proposals), transform keyframes (x/y/scale/rotation/opacity), stabilization (real libvidstab)",
    "PARTIAL (disclosed): 10-frame stepped animation export for most filters; picture-fade preview now at parity",
    "NOT IMPLEMENTED (do not advertise): motion tracking, optical-flow interpolation, blend modes, adjustment layers, nesting, true 3D",
  ],
};

const GRAMMAR_INDEX: Array<{ topic: string; keywords: string[] }> = [
  { topic: "cut on action / continuity editing — cut during movement so the eye follows", keywords: ["continuity", "cut on action", "flow"] },
  { topic: "J-cut / L-cut — audio leads or trails the picture (≤ 12-frame pre-roll)", keywords: ["j-cut", "l-cut", "audio lead", "dialogue"] },
  { topic: "match cut / match on movement — bridge scenes by graphic or motion similarity", keywords: ["match", "bridge", "direction flow"] },
  { topic: "montage (metric/rhythmic/tonal) — fixed-interval, rhythm-led or mood-led assembly", keywords: ["montage", "trailer", "acceleration"] },
  { topic: "beat synchronization — cuts locked to the music's markers (±1 frame)", keywords: ["beat", "music", "sync", "rhythm"] },
  { topic: "reaction cut — hold the reaction AFTER the punchline; dead air is the joke", keywords: ["comedy", "punchline", "reaction"] },
  { topic: "suspense timing — decelerate into the turn, silence before shock", keywords: ["suspense", "horror", "dread", "silence"] },
  { topic: "speed ramp / time remap — piecewise playbackSpeed segments between keyframes", keywords: ["speed ramp", "slow motion", "remap", "replay"] },
];

let trendsCache: { file: { entries: TrendEntry[] }; mtimeMs: number } | null = null;

function loadTrends(): TrendEntry[] {
   
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const file = path.join(process.cwd(), "scripts", "ai-editing", "editing-trends.json");
  const stat = fs.statSync(file);
  if (trendsCache && trendsCache.mtimeMs === stat.mtimeMs) return trendsCache.file.entries;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { entries: TrendEntry[] };
  trendsCache = { file: parsed, mtimeMs: stat.mtimeMs };
  return parsed.entries;
}

function detectDomains(query: string): string[] {
  const q = query.toLowerCase();
  const hits: string[] = [];
  for (const [domain, words] of Object.entries(DOMAIN_KEYWORDS)) {
    if (words.some((w) => q.includes(w))) hits.push(domain);
  }
  return hits.length > 0 ? hits : ["story"];
}

function scoreRecipe(r: { id: string; name: string; family: string; purpose: string; suitableFor: string[]; cutting: string[]; notFor: string[]; promptExample: string }, q: string): number {
  const hay = [r.id, r.name, r.family, r.purpose, ...r.suitableFor, ...r.cutting].join(" ").toLowerCase();
  const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  let score = 0;
  for (const w of words) if (hay.includes(w)) score += 2;
  if (r.notFor.some((n) => n.toLowerCase().includes(q.toLowerCase()) && q.length > 8)) score -= 3;
  return score;
}

/** Retrieve the knowledge an agent needs for a natural-language task query. */
export function retrieveEditingKnowledge(query: string, opts?: { limit?: number }): RetrievedKnowledge {
  const q = (query ?? "").trim();
  const domains = detectDomains(q);
  const limit = opts?.limit ?? 4;
  const file = loadStyleRecipes();
  const scored = file.recipes
    .map((r) => ({ r, s: scoreRecipe(r, q) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .filter((x) => x.s > 0)
    .map((x) => ({ id: x.r.id, name: x.r.name, family: x.r.family, purpose: x.r.purpose, promptExample: x.r.promptExample }));
  const qLower = q.toLowerCase();
  const grammar = GRAMMAR_INDEX.filter((g) => g.keywords.some((k) => qLower.includes(k))).map((g) => g.topic);
  const trends = loadTrends()
    .filter((t) => {
      const hay = [t.id, t.name, t.category, t.description, ...(t.bestContentTypes ?? [])].join(" ").toLowerCase();
      return qLower.split(/\s+/).some((w) => w.length > 3 && hay.includes(w)) || domains.some((d) => d === "delivery" && t.category === "platform-specification");
    })
    .slice(0, 3)
    .map((t) => ({ id: t.id, name: t.name, confidence: t.confidence, sources: t.sources }));
  return {
    query: q,
    domain: domains.join("+"),
    recipes: scored,
    grammar,
    trends,
    capabilityTruth: domains.flatMap((d) => CAPABILITY_TRUTH[d] ?? []),
  };
}

/** All recipe ids (for capability-mapping tests and agent discovery). */
export function recipeIds(): string[] {
  return loadStyleRecipes().recipes.map((r) => r.id);
}
