/**
 * MY AI — typed engine registry + intent routing (M7 §10).
 *
 * Deterministic intent routing across the five BEAN FX engines (no LLM —
 * the dedicated orchestration milestone M8 will sit on this typed surface).
 * Every proposal is DATA: either timeline COMMANDS (applied through the M1
 * engine, re-validated, undoable) or a GENERATION REQUEST (engine + params)
 * that REQUIRES explicit user approval before any job is created. The router
 * never executes anything and never invents capabilities: when an engine's
 * provider is unconfigured, the proposal carries the honest unavailable
 * state and no job can be started from it.
 */
import type { Command } from "@/lib/editor/commands";
import { proposeNikki } from "@/lib/nikki/proposal";
import { suggestShots } from "@/lib/jazmii/shots";
import { jazmiiProviderIds } from "@/lib/jazmii/providers";
import { laxiiProviderIds } from "@/lib/laxii/providers";
import { JazmiiGenerateParamsSchema, JazmiiShotSuggestionSchema } from "@/lib/jazmii/types";
import { LaxiiGenerateParamsSchema } from "@/lib/laxii/types";

export interface AIContext {
  fps: number;
  sequenceFrames: number;
  atFrame: number;
  /** Context texts (clip labels, caption text, section names). */
  texts: string[];
  selectedClipId?: string | null;
  selectedGraphicStyle?: import("@/lib/nikki/types").NikkiGraphicStyle | null;
  newId: (kind: string) => string;
}

/** A generation request that needs explicit approval (never auto-executed). */
export interface GenerationProposal {
  engine: "JAZMII" | "LAXII";
  operation: string;
  params: Record<string, unknown>;
  /** Human-facing summary of what will be created and its cost class. */
  summary: string;
  /** Honest provider state at proposal time. */
  providerAvailable: boolean;
  unavailableReason?: string;
}

export interface AIProposal {
  engine: string;
  intent: string;
  confidence: number;
  explanation: string;
  caveats: string[];
  /** Timeline commands (applied via the session, M1-validated). */
  commands?: Command[];
  /** Shot suggestions (JAZMII) — approval-gated per item. */
  shotSuggestions?: unknown[];
  /** Generation requests — approval-gated before any job is created. */
  generationRequests?: GenerationProposal[];
}

interface EngineRule {
  engine: string;
  patterns: RegExp[];
  confidence: number;
  build: (instruction: string, ctx: AIContext) => Omit<AIProposal, "engine" | "intent" | "confidence">;
}

const jazmiiVideoAvailable = jazmiiProviderIds().length > 0;
const laxiiImageAvailable = laxiiProviderIds().length > 0;

function generationRequest(engine: "JAZMII" | "LAXII", operation: string, params: Record<string, unknown>, summary: string): GenerationProposal {
  const available = engine === "JAZMII" ? jazmiiVideoAvailable : laxiiImageAvailable;
  return {
    engine,
    operation,
    params,
    summary,
    providerAvailable: available,
    unavailableReason: available ? undefined : `No ${engine} generation provider is configured on this deployment — the request cannot be executed.`,
  };
}

const RULES: EngineRule[] = [
  {
    engine: "JAZMII",
    patterns: [/b-roll/i, /cutaway/i, /footage for/i, /suggest (relevant )?footage/i, /shot suggestion/i, /video generation/i],
    confidence: 0.86,
    build: (ins, ctx) => {
      const suggestions = suggestShots({ fps: ctx.fps, texts: ctx.texts, sequenceFrames: ctx.sequenceFrames });
      const genMatch = ins.match(/generate .*video/i);
      return {
        explanation: suggestions.length
          ? `JAZMII matched the context to ${suggestions.length} shot suggestion(s); review and approve each one — nothing is generated or inserted automatically.`
          : "JAZMII found no matching shot context. Provide clip labels or captions describing the scene, or give an explicit generation prompt.",
        caveats: ["Suggestions are deterministic keyword matches — confidence is intentionally null (no fake scores)."],
        shotSuggestions: suggestions.map((s) => JazmiiShotSuggestionSchema.parse(s)),
        generationRequests: genMatch
          ? [generationRequest("JAZMII", "textToVideo", { prompt: ins.slice(0, 2000), quality: "speed", size: "1920x1080", fps: "30", durationSec: "5" }, "Generate a 5 s 1920×1080 speed-quality video with the configured provider (metered).")]
          : [],
      };
    },
  },
  {
    engine: "LAXII",
    patterns: [/background image/i, /cinematic background/i, /thumbnail/i, /illustration/i, /generate (an? )?image/i, /visual alternatives?/i, /three .*alternatives/i, /title artwork/i],
    confidence: 0.88,
    build: (ins, ctx) => {
      const threeVariations = /\b(three|3)\b.*alternatives?/i.test(ins);
      const isThumb = /thumbnail|artwork/i.test(ins);
      const params = {
        prompt: ins.replace(/^(generate|create|make)\s+(an?\s+)?(thumbnail|image|background)/i, "Professional artwork:").slice(0, 2000),
        mode: "generate" as const,
        size: isThumb ? ("1152x864" as const) : ("1344x768" as const),
        count: threeVariations ? 3 : 1,
        aspect: isThumb ? ("16:9" as const) : ("original" as const),
      };
      const parsed = LaxiiGenerateParamsSchema.safeParse(params);
      return {
        explanation: threeVariations
          ? "LAXII proposes 3 image alternatives (sequential provider calls, each registered with provenance; originals preserved)."
          : isThumb
            ? "LAXII proposes thumbnail artwork in a 16:9-adapted child asset; text overlays should be added with NIIKI graphics (editable), not burned into the image."
            : "LAXII proposes one generated image, registered with full provenance.",
        caveats: ["The image provider does NOT support transparency or negative prompts (honest capability list).", "No external processing happens until you approve this request."],
        generationRequests: parsed.success
          ? [generationRequest("LAXII", "textToImage", parsed.data, `Generate ${parsed.data.count} image(s) at ${parsed.data.size} with the configured provider (metered).`)]
          : [],
      };
    },
  },
  {
    engine: "NIIKI",
    patterns: [/word by word/i, /lower third/i, /kinetic caption/i, /animate (this )?title/i, /highlight/i],
    confidence: 0.9,
    build: (ins, ctx) => {
      const p = proposeNikki(ins, {
        seqFps: { num: Math.round(ctx.fps), den: 1 },
        seqWidth: 1280,
        seqHeight: 720,
        newId: (kind) => ctx.newId(`nikki-${kind}`),
        atFrame: ctx.atFrame,
        availableFrames: Math.max(24, ctx.sequenceFrames - ctx.atFrame),
        selectedGraphicClipId: ctx.selectedClipId ?? null,
        selectedGraphicStyle: ctx.selectedGraphicStyle ?? null,
      });
      return p
        ? { explanation: p.explanation, caveats: p.caveats, commands: p.commands }
        : { explanation: "NIIKI did not match this instruction.", caveats: [] };
    },
  },
];

/** Route an instruction to the best engine; null when nothing matches. */
export function routeIntent(instruction: string, ctx: AIContext): AIProposal | null {
  const text = instruction.trim();
  if (!text) return null;
  for (const rule of RULES) {
    if (rule.patterns.some((re) => re.test(text))) {
      const built = rule.build(text, ctx);
      // Validate any JAZMII generation params that came from free text.
      const requests = (built.generationRequests ?? []).map((r) => {
        if (r.engine === "JAZMII") {
          const p = JazmiiGenerateParamsSchema.safeParse({ prompt: String(r.params.prompt ?? text), ...r.params });
          if (p.success) r.params = p.data;
        }
        return r;
      });
      return { engine: rule.engine, intent: rule.patterns.find((re) => re.test(text))?.source.slice(0, 40) ?? "match", confidence: rule.confidence, ...built, generationRequests: requests };
    }
  }
  return null;
}

/** Engine capability registry (M8 groundwork — descriptors only). */
export const AI_ENGINE_REGISTRY = {
  version: 1,
  deterministic: true,
  usesLLM: false,
  engines: [
    { id: "RIISHE", domain: "captions", note: "pre-existing (M4)" },
    { id: "GANGZII", domain: "audio", note: "pre-existing (M5)" },
    { id: "NIIKI", domain: "motion-graphics", note: "pre-existing (M6)" },
    {
      id: "JAZMII",
      domain: "video-creative",
      providers: jazmiiProviderIds(),
      operations: ["textToVideo", "imageToVideo", "video-analysis", "shot-suggestions"],
    },
    {
      id: "LAXII",
      domain: "image-creative",
      providers: laxiiProviderIds(),
      operations: ["textToImage", "imageToImage", "aspect-adaptation", "thumbnails", "variations"],
    },
  ],
  route: routeIntent,
} as const;
