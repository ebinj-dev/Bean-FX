/**
 * JAZMII — deterministic B-roll shot suggestions (M7 §6B).
 *
 * Honest by construction: suggestions come from a deterministic keyword →
 * shot-type mapping over REAL project context (clip labels, caption text,
 * RIISHE words). Confidence stays null — no fake matcher scores. Rationales
 * name the trigger so the user can judge the suggestion.
 *
 * Approval gate: suggestions are PROPOSALS only. Nothing is generated or
 * inserted without an explicit user action.
 */
import type { JazmiiShotSuggestion } from "./types";
import { jazmiiProvider } from "./providers";

export interface ShotContext {
  /** Sequence frame rate for duration suggestions. */
  fps: number;
  /** Text context: caption/cue text, clip labels, section names. */
  texts: string[];
  /** Total sequence length (frames) to bound suggestion durations. */
  sequenceFrames: number;
}

interface ShotRule {
  keywords: RegExp;
  description: string;
  shotType: JazmiiShotSuggestion["shotType"];
  durationSec: number;
  buildPrompt: (subject: string) => string;
}

const RULES: ShotRule[] = [
  {
    keywords: /city|street|urban|traffic|building|downtown/i,
    description: "Urban establishing cutaway: slow skyline pan",
    shotType: "establishing",
    durationSec: 4,
    buildPrompt: (s) => `Cinematic establishing shot of ${s}, slow pan across the skyline, golden hour light, professional color grade`,
  },
  {
    keywords: /nature|forest|mountain|river|beach|desert|tree|garden/i,
    description: "Nature cutaway: slow dolly through landscape",
    shotType: "wide",
    durationSec: 4,
    buildPrompt: (s) => `Slow cinematic dolly through ${s}, natural light, shallow depth of field, professional nature documentary look`,
  },
  {
    keywords: /kitchen|food|cook|meal|recipe|restaurant|coffee/i,
    description: "Food insert: top-down preparation closeup",
    shotType: "insert",
    durationSec: 3,
    buildPrompt: (s) => `Top-down closeup insert of ${s} being prepared, warm kitchen light, shallow depth of field`,
  },
  {
    keywords: /office|work|laptop|desk|team|meeting|business/i,
    description: "Workplace cutaway: over-shoulder desk detail",
    shotType: "cutaway",
    durationSec: 3,
    buildPrompt: (s) => `Over-the-shoulder cutaway of ${s}, soft office light, shallow focus, professional documentary style`,
  },
  {
    keywords: /hand|gesture|finger|write|type|sign/i,
    description: "Hands insert: macro detail with shallow focus",
    shotType: "closeup",
    durationSec: 2.5,
    buildPrompt: (s) => `Macro closeup insert of ${s}, soft directional light, very shallow depth of field, cinematic`,
  },
  {
    keywords: /technology|screen|code|data|computer|phone/i,
    description: "Technology cutaway: screen glow with motion",
    shotType: "insert",
    durationSec: 3,
    buildPrompt: (s) => `Slow push-in on ${s} with screen glow and subtle motion blur, dark background, cinematic tech aesthetic`,
  },
  {
    keywords: /crowd|people|audience|market|festival|celebration/i,
    description: "People cutaway: candid medium shot",
    shotType: "medium",
    durationSec: 4,
    buildPrompt: (s) => `Candid medium shot of ${s}, natural motion, documentary framing, warm grade`,
  },
  {
    keywords: /weather|rain|storm|cloud|wind|sky|sun/i,
    description: "Atmosphere cutaway: sky and elements",
    shotType: "wide",
    durationSec: 3.5,
    buildPrompt: (s) => `Wide atmospheric shot of ${s}, dramatic natural light, slow motion, cinematic`,
  },
];

/** Deterministic subject extraction: longest meaningful noun phrase heuristic. */
function extractSubject(text: string): string {
  const cleaned = text.replace(/[.,;:!?"'()【】]/g, " ").trim();
  const words = cleaned.split(/\s+/).filter((w) => w.length > 2 && !/^(the|and|for|with|this|that|from|into|about|மற்றும்|ஒரு|இந்த)$/i.test(w));
  return words.slice(0, 4).join(" ") || cleaned.slice(0, 40) || "the scene";
}

/**
 * Produce up to `max` shot suggestions from context texts.
 * Deterministic: same context → same suggestions (verified by tests).
 */
export function suggestShots(ctx: ShotContext, max = 4): JazmiiShotSuggestion[] {
  const provider = jazmiiProvider(null);
  const joined = ctx.texts.join(" \u00b7 ").trim();
  if (!joined) return [];
  const suggestions: JazmiiShotSuggestion[] = [];
  const seen = new Set<string>();
  // Deterministic ids: hash of subject+rule — same context, same ids.
  const idHash = (text: string): string => {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
    return h.toString(36);
  };
  for (const rule of RULES) {
    if (suggestions.length >= max) break;
    const matched = ctx.texts.filter((t) => rule.keywords.test(t));
    if (matched.length === 0) continue;
    // Prefer the first matched text whose subject is not already covered by
    // an earlier rule — a later rule matching the same line must not steal
    // the earlier rule's cutaway slot.
    let subject: string | null = null;
    let chosenText: string | null = null;
    for (const t of matched) {
      const s = extractSubject(t);
      if (!seen.has(s)) {
        subject = s;
        chosenText = t;
        break;
      }
    }
    if (!subject || !chosenText) continue;
    seen.add(subject);
    const durationFrames = Math.max(12, Math.min(1500, Math.round(rule.durationSec * ctx.fps)));
    suggestions.push({
      id: `shot-${idHash(rule.description + subject)}`,
      description: rule.description,
      subject,
      shotType: rule.shotType,
      durationFrames: Math.min(durationFrames, Math.max(12, ctx.sequenceFrames)),
      aspectRatio: "16:9",
      source: "generate",
      providerHint: provider.id,
      prompt: rule.buildPrompt(subject),
      rationale: `Matched "${chosenText.slice(0, 40)}" (${matched.length} context line(s) on "${[...rule.keywords.source.replace(/\\[itwu]/g, "|"), ""].join("").replace(/[()]/g, "").slice(0, 60)}" — a ${rule.shotType} cutaway fits narrative coverage.`,
      confidence: null, // keyword heuristic: no real matcher → no fake score
    });
  }
  return suggestions;
}
