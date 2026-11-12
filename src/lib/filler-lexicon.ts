/**
 * BEAN FX — built-in multilingual filler lexicon (deterministic, REVIEW-only).
 *
 * This is NOT a model: it is a small, auditable phrase list matched with the
 * same context-aware word machinery as the user's words-to-remove list.
 * Matches are always classification REVIEW — the evidence and transcript are
 * shown, the human decides, and nothing is ever removed automatically.
 *
 * The list is intentionally conservative and extensible:
 * - English: canonical hesitation fillers and discourse markers.
 * - Tamil (native script) and romanized Tanglish: common discourse fillers.
 *   These are heuristic discourse markers, not a linguistic claim — users can
 *   extend or override everything through the words-to-remove UI, which
 *   accepts any script.
 *
 * Polysemous words ("like", "actually" mid-sentence use, "seri" = "ok") are
 * deliberately excluded from REMOVE behavior by the REVIEW-only rule and, in
 * the user's own list, by the existing in-sentence guard.
 */

export const BUILTIN_FILLER_PHRASES: string[] = [
  // English hesitation fillers
  "um",
  "uh",
  "erm",
  "hmm",
  "uhh",
  "hmmmm",
  // English discourse fillers
  "you know",
  "i mean",
  "sort of",
  "kind of",
  // Tamil discourse fillers (native script)
  "ஏதோ",
  "என்னவோ",
  "அப்போ",
  "அப்படேனு",
  // Romanized Tanglish discourse fillers
  "eatho",
  "ennavo",
  "appo",
  "appadeinu",
];
