/**
 * BEAN FX — RIISHE post-inference safety layer.
 *
 * Extracted verbatim from the analyze route so the pipeline, tests and the
 * Phase-F benchmark all execute the SAME guard. This is the only place where
 * semantic suggestions may change a candidate's classification, and its two
 * rules are absolute:
 *  1. A semantic REMOVE over transcribed speech is accepted only for a
 *     confirmed repeated take with confidence >= 0.7 — otherwise REVIEW.
 *  2. Built-in lexicon matches are REVIEW-only by construction — inference may
 *     confirm or downgrade them, never promote them to REMOVE.
 */
import type { EvidenceCandidate } from "./autocut-analysis";
import type { RiisheSuggestion } from "./riishe-inference";

export function applySuggestions(candidates: EvidenceCandidate[], suggestions: RiisheSuggestion[], model: string): { applied: number; downgraded: number } {
  const byId = new Map(suggestions.map((s) => [s.id, s]));
  let applied = 0;
  let downgraded = 0;
  for (const c of candidates) {
    const s = byId.get(c.id);
    if (!s) continue;
    applied++;
    let action = s.action;
    if (action === "REMOVE" && !c.wordMatch && c.evidence.transcriptWordsInRange > 0 && !(c.evidence.repeatedTake && s.confidence >= 0.7)) {
      action = "REVIEW";
      downgraded++;
    }
    // Built-in lexicon matches are REVIEW-only by construction: semantic
    // inference may confirm or downgrade them, never promote them to REMOVE.
    if (action === "REMOVE" && c.builtinLexicon) {
      action = "REVIEW";
      downgraded++;
    }
    c.review = action;
    c.classificationSource = "RIISHE_INFERENCE";
    c.confidence = s.confidence;
    c.reason = `${c.builtinLexicon ? "Built-in filler lexicon match, semantically reviewed — " : ""}${s.reason}${s.riskNotes ? ` — Risk: ${s.riskNotes}` : ""}`;
  }
  void model;
  return { applied, downgraded };
}
