/**
 * M10 — Creative brief + subjective assessments via MY AI (§3/§7).
 *
 * The LLM produces INTERPRETATION ONLY. The prompt supplies the MEASURED
 * context (from creative/context.ts) and hard rules: never invent footage,
 * dialogue, scenes, facts or audience demographics; copy a supplied audience
 * verbatim or return null; keep the user's language (en/ta) and terminology;
 * separate observed facts from interpretation. Output is schema-validated
 * (chatValidated: one informed repair, then honest failure). Provider seam
 * (opts.provider) keeps tests fixture-driven without faking live results.
 */
import { chatValidated } from "@/lib/my-ai/gateway/structured";
import { llmProvider, type LLMProvider } from "@/lib/my-ai/gateway/provider";
import { z } from "zod";
import { CreativeBriefSchema, CreativeBrief, ScorecardDimensionSchema, ScorecardDimension, AssistantDecisionSchema, AssistantDecision, EvidenceLabelId } from "./contracts";
import type { MeasuredContext } from "./context";

export interface LlmOptions {
  provider?: LLMProvider;
}

function languageRule(language: "en" | "ta"): string {
  return language === "ta"
    ? "Write ALL human-facing text in TAMIL (Tamil script). Keep technical terms the source uses as-is. Preserve the creator's terminology."
    : "Write ALL human-facing text in ENGLISH. Preserve the creator's terminology and proper nouns.";
}

function contextDigest(ctx: MeasuredContext): string {
  return JSON.stringify(
    {
      projectName: ctx.projectName,
      durationSec: ctx.durationSec,
      clipCounts: { video: ctx.videoClipCount, audio: ctx.audioClipCount, graphic: ctx.graphicClipCount, captionClips: ctx.captionClipCount },
      gaps: ctx.gaps,
      overlaps: ctx.overlaps,
      transitions: ctx.transitionCount,
      audio: ctx.audio?.inspection
        ? {
            durationSec: ctx.audio.inspection.durationSec,
            silenceFraction: ctx.audio.inspection.silenceFraction,
            integratedLufs: ctx.audio.inspection.integratedLufs,
            classification: ctx.audio.inspection.levelsClassification,
          }
        : null,
      transcript: ctx.transcript
        ? { available: ctx.transcript.available, language: ctx.transcript.languageDescription, script: ctx.transcript.primaryScript, excerpt: ctx.transcript.text.slice(0, 1500) }
        : null,
      captions: ctx.captions,
      scenes: ctx.scenes?.slice(0, 12),
      suppliedAudience: ctx.suppliedAudience,
      publishing: ctx.publishing,
      missingEvidence: ctx.missingEvidence,
    },
    null,
    1,
  );
}

const BRIEF_SYSTEM = [
  "You are the BEAN FX AI Creative Director. You describe a video the creator ALREADY MADE, using ONLY the provided measured context.",
  "HARD RULES:",
  "- NEVER invent footage, dialogue, scenes, facts, statistics, sources or names that are not in the context.",
  "- NEVER assume an audience demographic. audience MUST be null unless the context's suppliedAudience is non-empty — then copy it VERBATIM.",
  "- Separate OBSERVED content (facts from the context) from your INTERPRETATION; both arrays are required and must not overlap.",
  "- missingElements lists what the context could NOT establish (e.g. no transcript → story beats unknown).",
  languageRule("en"),
  "Respond with ONLY a JSON object with keys: mainSubject, mainMessage, storyStructure, openingHook {summary, evidenceSec, basis}, supportingPoints[], importantScenes [{index,note}], endingAndCta, missingElements[], observed[], interpreted[], audience.",
].join(" ");

/** Generate the creative brief (interpretation over measured context). */
export async function generateCreativeBrief(ctx: MeasuredContext, language: "en" | "ta", opts: LlmOptions = {}): Promise<{ brief: CreativeBrief; model: string }> {
  const provider = opts.provider ?? llmProvider();
  const result = await chatValidated<CreativeBrief>(ctx.projectId, CreativeBriefSchema, [
    { role: "system", content: BRIEF_SYSTEM.replace(languageRule("en"), languageRule(language)) },
    { role: "user", content: `Measured project context (JSON):\n${contextDigest(ctx)}\n\nProduce the creative brief JSON. language=${language}` },
  ], { provider, temperature: 0.5, maxTokens: 2000, purpose: "creative-brief" });
  const brief = result.data;
  // Hard honesty guard: audience may ONLY come from the user's own brief.
  if (!ctx.suppliedAudience) brief.audience = null;
  else if (brief.audience) brief.audience = ctx.suppliedAudience;
  // Opening-hook basis must not claim measurement the context lacks.
  if (brief.openingHook.basis === "measured" && !ctx.transcript?.available && !ctx.audio?.inspection) {
    brief.openingHook.basis = "ai-interpretation" as EvidenceLabelId;
  }
  return { brief, model: result.model };
}

const SUBJECTIVE_SYSTEM = [
  "You are the BEAN FX AI Creative Director scoring SUBJECTIVE creative dimensions of an existing video.",
  "HARD RULES:",
  "- Use ONLY the provided measured context and deterministic sub-scores.",
  "- Score 1-5. When the context lacks the evidence a dimension needs, score MUST be null and missingData must say why.",
  "- You are NOT predicting virality, revenue or audience retention. Describe creative quality only.",
  "- basis must be \"ai-assessment\" unless you are directly echoing deterministic measurements (then \"mixed\").",
  languageRule("en"),
  "Respond with ONLY a JSON object {\"dimensions\":[…]} containing EXACTLY FOUR objects, in this order: hook-clarity, story-coherence, visual-consistency, ending-cta-clarity. Each object: key, score, basis, evidence[], explanation, confidence, missingData[], suggestions[].",
].join(" ");

export interface DeterministicDimension {
  key: ScorecardDimension["key"];
  score: number | null;
  basis: "deterministic" | "ai-assessment" | "mixed";
  evidence: string[];
  explanation: string;
  confidence: number | null;
  missingData: string[];
  suggestions: string[];
}

/** Score the four SUBJECTIVE dimensions (hook, story, visual consistency, ending). */
export async function scoreSubjectiveDimensions(
  ctx: MeasuredContext,
  language: "en" | "ta",
  deterministic: DeterministicDimension[],
  opts: LlmOptions = {},
): Promise<{ dimensions: ScorecardDimension[]; model: string | null }> {
  const aiKeys: ScorecardDimension["key"][] = ["hook-clarity", "story-coherence", "visual-consistency", "ending-cta-clarity"];
  // No transcript AND no scenes AND no clips → nothing to interpret: honest nulls.
  const hasAnyInterpretiveEvidence = Boolean(ctx.transcript?.available) || Boolean(ctx.scenes) || ctx.clipCount > 0;
  if (!hasAnyInterpretiveEvidence) {
    return {
      dimensions: aiKeys.map((key) => ({
        key,
        score: null,
        basis: "ai-assessment" as const,
        evidence: [],
        explanation: "No interpretive evidence exists (no transcript, no scenes, no clips).",
        confidence: null,
        missingData: ["no transcript / scenes / clips to assess"],
        suggestions: [],
      })),
      model: null,
    };
  }
  const provider = opts.provider ?? llmProvider();
  const FourSchema = z.object({ dimensions: z.array(ScorecardDimensionSchema).min(4).max(4) });
  const result = await chatValidated<{ dimensions: ScorecardDimension[] }>(ctx.projectId, FourSchema, [
    { role: "system", content: SUBJECTIVE_SYSTEM.replace(languageRule("en"), languageRule(language)) },
    {
      role: "user",
      content: `Measured context:\n${contextDigest(ctx)}\n\nDeterministic dimensions already scored (do not re-score these):\n${JSON.stringify(deterministic.filter((d) => d.basis === "deterministic").map((d) => ({ key: d.key, score: d.score, evidence: d.evidence })), null, 1)}\n\nReturn JSON {"dimensions":[4 objects]} for keys hook-clarity, story-coherence, visual-consistency, ending-cta-clarity. language=${language}`,
    },
  ], { provider, temperature: 0.4, maxTokens: 1800, purpose: "creative-scorecard-subjective" });
  const byKey = new Map(result.data.dimensions.map((d) => [d.key, d]));
  const dimensions = aiKeys.map((key) => {
    const d = byKey.get(key) ?? null;
    if (!d) {
      return { key, score: null, basis: "ai-assessment" as const, evidence: [], explanation: "The model did not return this dimension — recorded honestly as unscored.", confidence: null, missingData: ["model omitted this dimension"], suggestions: [] };
    }
    if (d.score !== null && d.score < 1) {
      return { ...d, score: null, missingData: [...d.missingData, "model returned an out-of-range score — suppressed"], explanation: d.explanation + " (score suppressed: out of range)" };
    }
    return d;
  });
  return { dimensions, model: result.model };
}


const ASSISTANT_SYSTEM = [
  "You are the BEAN FX Creator Assistant router. Given the creator's message and a bounded project summary, decide the intent.",
  "Intents: review-project, improve-opening, find-pauses, improve-captions, suggest-broll, compare-thumbnails, strengthen-ending, prepare-export, show-improvements, general-question.",
  "scope is which analysis to run (full | retention | scorecard | brief) or null. needsFreshReview=true only when the creator asks for a NEW review while an up-to-date one may not exist.",
  languageRule("en"),
  "For general-question, write a SHORT helpful reply grounded ONLY in the summary — never invent project facts.",
  "Respond with ONLY JSON: {intent, scope, language, reply, needsFreshReview}.",
].join(" ");

/** Classify one assistant message (typed decision). */
export async function decideAssistantIntent(
  message: string,
  ctx: MeasuredContext,
  language: "en" | "ta",
  opts: LlmOptions = {},
): Promise<AssistantDecision> {
  const provider = opts.provider ?? llmProvider();
  const result = await chatValidated<AssistantDecision>(ctx.projectId, AssistantDecisionSchema, [
    { role: "system", content: ASSISTANT_SYSTEM.replace(languageRule("en"), languageRule(language)) },
    { role: "user", content: `Creator message: ${message.slice(0, 800)}\n\nProject summary:\n${contextDigest(ctx).slice(0, 3000)}\n\nlanguage=${language}` },
  ], { provider, temperature: 0.3, maxTokens: 800, purpose: "creative-assistant-router" });
  const decision = result.data;
  decision.language = language;
  return decision;
}
