/**
 * M10 — Explainable Content Scorecard (§7).
 *
 * Documented model (m10-scorecard-1.0): eight dimensions; four are scored
 * DETERMINISTICALLY from measured evidence with explicit formulas (below),
 * four are AI ASSESSMENTS (brief.ts scoreSubjectiveDimensions) over the same
 * evidence. Missing evidence ⇒ score null + missingData — never invented.
 * The disclaimer is part of the persisted payload: creative evaluation, NOT a
 * prediction of virality/revenue/retention.
 *
 * Deterministic formulas (all inputs are measured values):
 *  audio-quality: start 5; −2 if |LUFS−(−14)| > 2 dB; −1 more if > 4 dB;
 *    −2 if clipping suspected; −1 if |imbalance| > 3 dB; floor 1. No
 *    inspection ⇒ null.
 *  caption-quality: srt measured: 5 if avgCps ≤ 11; 4 ≤ 13; 3 ≤ 16; 2 ≤ 20;
 *    1 above; −1 if >5 caption gaps > 3 s. Inline captions only ⇒ 3 with
 *    limited-confidence note. No captions ⇒ null.
 *  pacing-consistency: units ≥ 3: coefficient of variation cv = stdev/mean of
 *    unit durations: 5 if cv ≤ 0.35; 4 ≤ 0.6; 3 ≤ 0.9; 2 ≤ 1.3; 1 above.
 *    Fewer than 3 units ⇒ null.
 *  technical-export-readiness: M9 export variants for the project: any
 *    COMPLETED with ok validation ⇒ 5; only failures ⇒ 2; none ⇒ null
 *    (no invented readiness).
 */
import { db } from "@/lib/db";
import { SCORECARD_DISCLAIMER, SCORECARD_MODEL_VERSION, type Scorecard, type ScorecardDimension } from "./contracts";
import type { MeasuredContext } from "./context";
import { scoreSubjectiveDimensions, type DeterministicDimension, type LlmOptions } from "./brief";

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1));
}

function audioQualityDimension(ctx: MeasuredContext): DeterministicDimension {
  const insp = ctx.audio?.inspection ?? null;
  if (!insp) {
    return {
      key: "audio-quality",
      score: null,
      basis: "deterministic",
      evidence: [],
      explanation: "No GANGZII inspection available for the narration audio — audio quality is unscored rather than guessed.",
      confidence: null,
      missingData: ["run a GANGZII AUDIO analysis on the narration source"],
      suggestions: ["Run GANGZII analysis from the editor panel to unlock this dimension."],
    };
  }
  let score = 5;
  const ev: string[] = [`integratedLufs=${insp.integratedLufs}`, `clippingSuspected=${insp.clippingSuspected}`, `channelImbalanceDb=${insp.channelImbalanceDb}`];
  const delta = insp.integratedLufs === null ? 0 : Math.abs(insp.integratedLufs - -14);
  if (delta > 4) score -= 2;
  else if (delta > 2) score -= 1;
  if (insp.clippingSuspected) score -= 2;
  if (insp.channelImbalanceDb !== null && Math.abs(insp.channelImbalanceDb) > 3) score -= 1;
  score = Math.max(1, score);
  return {
    key: "audio-quality",
    score,
    basis: "deterministic",
    evidence: ev,
    explanation: "Documented model: 5 − loudness deviation penalty (|Δ|>2 dB → −1, >4 dB → −2) − clipping (−2) − imbalance >3 dB (−1). Measured inputs shown in evidence.",
    confidence: 0.9,
    missingData: [],
    suggestions: score < 5 ? ["GANGZII loudness/balance pass toward −14 LUFS (non-destructive preview)."] : [],
  };
}

function captionQualityDimension(ctx: MeasuredContext): DeterministicDimension {
  const c = ctx.captions;
  if (!c) {
    return {
      key: "caption-quality",
      score: null,
      basis: "deterministic",
      evidence: [],
      explanation: "No captions exist — caption quality is unscored rather than guessed.",
      confidence: null,
      missingData: ["no SRT assets and no inline caption clips"],
      suggestions: [],
    };
  }
  if (c.sourceKind === "clip-captions") {
    return {
      key: "caption-quality",
      score: 3,
      basis: "mixed",
      evidence: [`inline caption clips: ${c.cueCount}`],
      explanation: "Only inline caption clips exist (no timed SRT) — timing/readability cannot be measured, so a neutral mid score is recorded with LOW information rather than a guess at quality.",
      confidence: 0.3,
      missingData: ["no timed captions (SRT) — cue speed and coverage unmeasured"],
      suggestions: ["Export/attach timed captions (RIISHE) to enable measured scoring."],
    };
  }
  const avg = c.avgCps ?? 0;
  let score = avg <= 11 ? 5 : avg <= 13 ? 4 : avg <= 16 ? 3 : avg <= 20 ? 2 : 1;
  if ((c.gapsOver3Sec ?? 0) > 5) score = Math.max(1, score - 1);
  return {
    key: "caption-quality",
    score,
    basis: "deterministic",
    evidence: [`avgCps=${c.avgCps}`, `maxCps=${c.maxCps}`, `cuesOver13Cps=${c.overThirteenCps}`, `gapsOver3Sec=${c.gapsOver3Sec}`, `cueCount=${c.cueCount}`],
    explanation: "Documented model: 5 if avg ≤11 chars/s; 4 ≤13; 3 ≤16; 2 ≤20; else 1 (13 chars/s is a readability GUIDELINE, not a platform rule); −1 if >5 caption gaps exceed 3 s.",
    confidence: 0.85,
    missingData: [],
    suggestions: score < 4 ? ["Split/extend fast cues (see the caption-timing findings)."] : [],
  };
}

function pacingDimension(ctx: MeasuredContext): DeterministicDimension {
  const units = ctx.scenes ? ctx.scenes.map((s) => s.durationSec) : null;
  if (!units || units.length < 3) {
    return {
      key: "pacing-consistency",
      score: null,
      basis: "deterministic",
      evidence: [],
      explanation: "Fewer than 3 scene units (no Studio plan) — pacing distribution is unscored rather than guessed.",
      confidence: null,
      missingData: ["create a Studio plan (scene durations) or add ≥3 clips"],
      suggestions: [],
    };
  }
  const mean = units.reduce((a, b) => a + b, 0) / units.length;
  const cv = mean > 0 ? stdev(units) / mean : 0;
  const score = cv <= 0.35 ? 5 : cv <= 0.6 ? 4 : cv <= 0.9 ? 3 : cv <= 1.3 ? 2 : 1;
  return {
    key: "pacing-consistency",
    score,
    basis: "deterministic",
    evidence: [`units=${units.length}`, `meanSec=${Math.round(mean * 10) / 10}`, `cv=${Math.round(cv * 100) / 100}`],
    explanation: "Documented model: coefficient of variation (stdev/mean) of unit durations — 5 if cv ≤0.35; 4 ≤0.6; 3 ≤0.9; 2 ≤1.3; else 1. Measured durations; evenness is descriptive, not a quality verdict.",
    confidence: 0.7,
    missingData: [],
    suggestions: [],
  };
}

async function exportReadinessDimension(userId: string, ctx: MeasuredContext): Promise<DeterministicDimension> {
  const variants = await db.exportVariant.findMany({ where: { userId, projectId: ctx.projectId }, take: 20, orderBy: { createdAt: "desc" } });
  const completed = variants.filter((v) => v.status === "COMPLETED" && v.validationJson?.includes('"ok":true'));
  const failed = variants.filter((v) => v.status === "FAILED");
  if (variants.length === 0) {
    return {
      key: "technical-export-readiness",
      score: null,
      basis: "deterministic",
      evidence: [],
      explanation: "No export variant has been built for this project — readiness is unscored rather than guessed.",
      confidence: null,
      missingData: ["run an export variant (Publishing ▸ Exports) to measure readiness"],
      suggestions: [],
    };
  }
  const score = completed.length > 0 ? 5 : failed.length > 0 ? 2 : 3;
  return {
    key: "technical-export-readiness",
    score,
    basis: "deterministic",
    evidence: [`completedVariants=${completed.length}`, `failedVariants=${failed.length}`],
    explanation: "Documented model: 5 when at least one M9 variant completed with ok conformance validation; 2 when only failures exist; 3 otherwise. Based on real ffprobe conformance reports.",
    confidence: 0.9,
    missingData: [],
    suggestions: completed.length === 0 ? ["Retry the failed variant and review its validation report."] : [],
  };
}

/** Assemble the full scorecard (deterministic + AI dims). */
export async function buildScorecard(userId: string, ctx: MeasuredContext, language: "en" | "ta", opts: LlmOptions & { scorecardUnavailable?: true } = {}): Promise<{ scorecard: Scorecard; model: string | null }> {
  const deterministic: DeterministicDimension[] = [
    audioQualityDimension(ctx),
    captionQualityDimension(ctx),
    pacingDimension(ctx),
    await exportReadinessDimension(userId, ctx),
  ];

  let subjective: ScorecardDimension[] = [];
  let model: string | null = null;
  if (!opts.scorecardUnavailable) {
    try {
      const r = await scoreSubjectiveDimensions(ctx, language, deterministic, { provider: opts.provider });
      subjective = r.dimensions;
      model = r.model;
    } catch {
      // Honest degradation: subjective dimensions unscored, deterministic kept.
      subjective = ["hook-clarity", "story-coherence", "visual-consistency", "ending-cta-clarity"].map((key) => ({
        key: key as ScorecardDimension["key"],
        score: null,
        basis: "ai-assessment" as const,
        evidence: [],
        explanation: "AI assessment unavailable (provider failure) — recorded honestly as unscored; deterministic dimensions above are unaffected.",
        confidence: null,
        missingData: ["LLM provider unavailable for this run"],
        suggestions: [],
      }));
    }
  } else {
    subjective = ["hook-clarity", "story-coherence", "visual-consistency", "ending-cta-clarity"].map((key) => ({
      key: key as ScorecardDimension["key"],
      score: null,
      basis: "ai-assessment" as const,
      evidence: [],
      explanation: "This run was deterministic-only (no provider requested) — subjective dimensions are unscored rather than guessed.",
      confidence: null,
      missingData: ["deterministic-only run"],
      suggestions: [],
    }));
  }

  const ordered: ScorecardDimension[] = [
    subjective.find((d) => d.key === "hook-clarity")!,
    subjective.find((d) => d.key === "story-coherence")!,
    deterministic.find((d) => d.key === "pacing-consistency")!,
    deterministic.find((d) => d.key === "audio-quality")!,
    deterministic.find((d) => d.key === "caption-quality")!,
    subjective.find((d) => d.key === "visual-consistency")!,
    subjective.find((d) => d.key === "ending-cta-clarity")!,
    deterministic.find((d) => d.key === "technical-export-readiness")!,
  ];

  const scored = ordered.filter((d) => d.score !== null).length;
  const scorecard: Scorecard = {
    modelVersion: SCORECARD_MODEL_VERSION,
    dimensions: ordered,
    overallNote: `${SCORECARD_DISCLAIMER} ${scored}/8 dimensions scored for this run; unscored dimensions list their missing data.`,
  };
  return { scorecard, model };
}
