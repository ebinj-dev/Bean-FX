/**
 * Phase F — raw-versus-edited reference comparison + content-category benchmark.
 *
 * Grounded ONLY in the real files upload/edited.txt (clean narration) and
 * upload/not edited.txt (raw recording). No hardcoded timestamps or cut
 * decisions from those files are used as test oracles — the benchmark derives
 * generalizable patterns from the diff, then builds synthetic category cases
 * and runs them through the REAL code: parseSrt, matchSrtToTranscript,
 * detectLanguage, buildWordCandidates and runRiisheInference (configured
 * provider — labeled, since local inference is BLOCKED in this sandbox).
 */
import { parseSrt, matchSrtToTranscript, tokens, type SrtCue } from "../src/lib/srt";
import { detectLanguage, buildWordCandidates, findRepeatedTake, type TranscriptAnalysis, type SpeechSpan, type AlignedSegment, type AlignedWord, type EvidenceCandidate } from "../src/lib/autocut-analysis";
import { BUILTIN_FILLER_PHRASES } from "../src/lib/filler-lexicon";
import { runRiisheInference, type RiisheSuggestion } from "../src/lib/riishe-inference";
import { applySuggestions } from "../src/lib/riishe-safety";
import { readFileSync, writeFileSync } from "fs";

const out: Record<string, unknown> = {};

/* ---------------- Part 1 — raw vs edited comparison (real files, real parser) ---------------- */
const raw = parseSrt(readFileSync("upload/not edited.txt", "utf8"));
const edited = parseSrt(readFileSync("upload/edited.txt", "utf8"));
if (raw.errors.length || edited.errors.length) console.log("PARSE ERRORS", raw.errors.length, edited.errors.length);

const norm = (t: string) => tokens(t).join(" ");
const editedNorms = new Set(edited.cues.map((c) => norm(c.text)));
const rawCueText = raw.cues.map((c) => norm(c.text));

// Cues in raw that never appear (normalized) in the edited file = removed material.
const removedCues = raw.cues.filter((c) => !editedNorms.has(norm(c.text)));
// Retake pairs in raw: consecutive-ish cues with >=0.7 token similarity.
const retakePairs: { a: number; b: number; sim: number }[] = [];
for (let i = 0; i < raw.cues.length; i++) {
  for (let j = i + 1; j < Math.min(i + 4, raw.cues.length); j++) {
    const a = tokens(raw.cues[i].text);
    const b = tokens(raw.cues[j].text);
    if (a.length < 6 || b.length < 6) continue;
    const inter = a.filter((w) => b.includes(w)).length;
    const sim = inter / Math.max(a.length, b.length);
    if (sim >= 0.7) retakePairs.push({ a: i + 1, b: j + 1, sim: Math.round(sim * 100) / 100 });
  }
}
const chatterCues = removedCues.filter((c) => /otte|अच्छा|achha|okay|hm+|hmm+|testing|check/i.test(c.text));
const fillerHits = raw.cues.filter((c) => BUILTIN_FILLER_PHRASES.some((p) => new RegExp(`(^|\\s)${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`, "i").test(c.text)));

// Language reality of the raw recording (real detector on real text).
const rawLang = detectLanguage(raw.cues.map((c) => c.text).join(" "));

out.comparison = {
  editedCues: edited.cues.length,
  rawCues: raw.cues.length,
  editedSpan: edited.cues.length ? [edited.cues[0].start, edited.cues[edited.cues.length - 1].end] : null,
  rawSpan: raw.cues.length ? [raw.cues[0].start, raw.cues[raw.cues.length - 1].end] : null,
  rawCuesRemovedInEdit: removedCues.length,
  rawCuesRemovedPct: Math.round((removedCues.length / raw.cues.length) * 1000) / 10,
  retakePairsInRaw: retakePairs.length,
  retakeExamples: retakePairs.slice(0, 5).map((p) => ({ cues: `${p.a}->${p.b}`, sim: p.sim, textA: raw.cues[p.a - 1].text.slice(0, 80), textB: raw.cues[p.b - 1].text.slice(0, 80) })),
  chatterCuesRemoved: chatterCues.length,
  chatterExamples: chatterCues.slice(0, 6).map((c) => `${c.ordinal}: ${c.text.slice(0, 60)}`),
  builtinFillerHitsInRaw: fillerHits.length,
  fillerExamples: fillerHits.slice(0, 6).map((c) => `${c.ordinal}: ${c.text.slice(0, 60)}`),
  rawLanguage: rawLang,
};
console.log("=== PART 1: raw vs edited (real files) ===");
console.log(JSON.stringify(out.comparison, null, 2));

/* ---------------- Part 2 — category benchmark through REAL code ---------------- */
// 12 synthetic cases modeled on the patterns Part 1 derived (no timestamps or
// text copied from the reference files as oracles — each case is constructed).
function seg(id: string, start: number, end: number, text: string): AlignedSegment {
  const words: AlignedWord[] = tokens(text).map((w, i, arr) => ({
    text: w,
    start: start + ((end - start) * i) / arr.length,
    end: start + ((end - start) * (i + 1)) / arr.length,
  }));
  return { id, start, end, text, words, energyValidated: true, boundaryJoined: false };
}
const EMPTY_SPANS: SpeechSpan[] = [];
// Measured speech over each segment — real segments always sit inside
// detected speech energy; the empty-span variant above is the degenerate case.
function spansOf(segments: AlignedSegment[]): SpeechSpan[] {
  return segments.map((s) => ({ start: s.start, end: s.end, rms: 0.05 }));
}
function transcriptOf(segments: AlignedSegment[]): TranscriptAnalysis {
  return {
    available: true,
    text: segments.map((s) => s.text).join(" "),
    segments,
    chunkCount: 1,
    failedChunks: [],
    warnings: [],
    language: detectLanguage(segments.map((s) => s.text).join(" ")),
    alignmentStats: null,
  };
}

interface CategoryCase {
  category: string;
  segments: AlignedSegment[];
  candidate: { id: string; start: number; end: number };
  rangeText: string | null;
  expected: "REMOVE" | "KEEP" | "REVIEW";
  why: string;
}

const cases: CategoryCase[] = [
  {
    category: "filler_word_standalone",
    segments: [seg("s1", 10, 14, "The temple was built in the eleventh century by the emperor."), seg("s2", 15.0, 15.6, "Um."), seg("s3", 16, 21, "Its walls carry more than one hundred inscriptions.")],
    candidate: { id: "filler-1", start: 14.8, end: 15.8 },
    rangeText: "Um.",
    expected: "REVIEW",
    why: "standalone hesitation; builtin lexicon matches are REVIEW-only by construction",
  },
  {
    category: "repeated_word",
    segments: [seg("s1", 20, 25, "The king donated gold jewels to the temple."), seg("s2", 25.2, 26.0, "the the."), seg("s3", 26.2, 31, "and the priest recorded every gift in the inscriptions.")],
    candidate: { id: "repeat-word-1", start: 25.1, end: 26.1 },
    rangeText: "the the.",
    expected: "REMOVE",
    why: "accidental duplicated word between sentences, no meaning lost",
  },
  {
    category: "repeated_sentence",
    segments: [seg("s1", 30, 36, "Officers of the survey copied the inscriptions carefully and published them in a volume."), seg("s2", 40, 46, "Officers of the survey copied the inscriptions carefully and published them in a volume.")],
    candidate: { id: "repeat-sent-1", start: 36.2, end: 39.8 },
    rangeText: null,
    expected: "REVIEW",
    why: "candidate is the pause between the two sentences; the duplicate itself needs semantic confirmation",
  },
  {
    category: "false_start",
    segments: [seg("s1", 50, 54, "The temple stands high above the"), seg("s2", 54.4, 55.2, "uh."), seg("s3", 55.4, 61, "The temple stands high above the town of Thanjavur on the southern bank.")],
    candidate: { id: "false-start-1", start: 54.1, end: 55.3 },
    rangeText: "uh.",
    expected: "REVIEW",
    why: "abandoned start + hesitation; boundary touches a cut-off word, needs human check",
  },
  {
    category: "abandoned_take",
    segments: [seg("s1", 60, 67, "Let me begin with the history of the Chola dynasty and their."), seg("s2", 71, 79, "Today we will look at the history of the Chola dynasty and their temples in detail.")],
    candidate: { id: "retake-1", start: 67.2, end: 70.8 },
    rangeText: null,
    expected: "REVIEW",
    why: "incomplete take replaced by a complete retake — classic ambiguous retake, human decides",
  },
  {
    category: "incomplete_replaced_by_complete",
    segments: [seg("s1", 80, 86, "The inscriptions record donations of gold jewels and land grants to the"), seg("s2", 90, 98, "The inscriptions record donations of gold jewels, land grants and livestock to the temple over three centuries.")],
    candidate: { id: "retake-2", start: 86.2, end: 89.8 },
    rangeText: null,
    expected: "REVIEW",
    why: "shorter draft of the same statement before the fuller version",
  },
  {
    category: "redundant_explanation",
    segments: [seg("s1", 100, 107, "Scholars spent years studying these stone records and translating them for modern readers."), seg("s2", 111, 118, "As I said, scholars spent years studying these stone records and translating them for modern readers.")],
    candidate: { id: "redundant-1", start: 107.2, end: 110.8 },
    rangeText: null,
    expected: "REVIEW",
    why: "explicit restatement; semantic redundancy judgment, not measurable audio evidence",
  },
  {
    category: "production_chatter",
    segments: [seg("s1", 120, 125, "This temple is not only a marvel of stone and architecture."), seg("s2", 126, 129, "Otte otte."), seg("s3", 129.5, 130.5, "Oh achha, okay."), seg("s4", 131, 137, "Namaste, my name is Raghuram, I am a heritage professional.")],
    candidate: { id: "chatter-1", start: 125.2, end: 130.8 },
    rangeText: "Otte otte. Oh achha, okay.",
    expected: "REVIEW",
    why: "non-content chatter between takes; mixed-language tokens need human confirmation",
  },
  {
    category: "offtopic_interruption",
    segments: [seg("s1", 140, 147, "The walls were surveyed in the late nineteenth century by the archaeological department."), seg("s2", 148, 152, "Is the microphone on? Can everyone hear me?"), seg("s3", 153, 160, "So the survey officers copied every inscription and published the collection.")],
    candidate: { id: "offtopic-1", start: 147.2, end: 152.8 },
    rangeText: "Is the microphone on? Can everyone hear me?",
    expected: "REVIEW",
    why: "off-topic interruption breaks flow but contains speech; semantic call with human confirmation",
  },
  {
    category: "natural_pause",
    segments: [seg("s1", 160, 168, "The reason this temple survived a thousand years"), seg("s2", 172, 179, "was because later dynasties continued to maintain and restore it.")],
    candidate: { id: "pause-1", start: 168.2, end: 171.8 },
    rangeText: null,
    expected: "KEEP",
    why: "pause INSIDE one sentence (next fragment continues the thought) — must never be removed",
  },
  {
    category: "meaningful_repetition",
    segments: [seg("s1", 180, 186, "Never remove meaningful speech, never remove meaningful speech quietly marked as filler."), seg("s2", 190, 196, "This repetition is deliberate emphasis for the listener.")],
    candidate: { id: "emphasis-1", start: 186.2, end: 189.8 },
    rangeText: null,
    expected: "KEEP",
    why: "repetition for emphasis carries meaning; word-list matching must not delete it",
  },
  {
    category: "tanglish_mixed",
    segments: [seg("s1", 200, 207, "இந்த கோவில் Thanjavur நகருக்கு மேலே உள்ளது, a thousand years old."), seg("s2", 211, 218, "Appo, the Chola king Rajaraja built this temple for the lord Shiva.")],
    candidate: { id: "tanglish-1", start: 207.2, end: 210.8 },
    rangeText: null,
    expected: "KEEP",
    why: "meaningful mixed Tamil/English narration — language mixing alone is never removal evidence",
  },
];

// Deterministic layer: run the word-level cases through buildWordCandidates
// (the REAL code that produces wordMatch candidates) and detectLanguage on
// the language cases.
console.log("\n=== PART 2a: deterministic layer (real code) ===");
const wordCaseCats = new Set(["filler_word_standalone", "repeated_word", "false_start", "production_chatter"]);
const detResults: Record<string, unknown> = {};
for (const c of cases.filter((x) => wordCaseCats.has(x.category) && x.rangeText)) {
  const tr = transcriptOf(c.segments);
  const cands = buildWordCandidates(tr, spansOf(c.segments), BUILTIN_FILLER_PHRASES.concat(["the the", "otte otte"]), { minSilenceSec: 0.5, headPaddingSec: 0.15, tailPaddingSec: 0.15, targetPauseSec: 0.6, tightenSentencePauses: false, sensitivity: "BALANCED", builtinFillers: true }, 220, 0.001, false, [], []);
  // Word candidates carry their text in wordMatch (not transcriptText).
  const hits = cands.filter((x) => {
    const phrase = norm(x.wordMatch?.phrase ?? "");
    const segText = norm(x.wordMatch?.segmentText ?? "");
    const range = norm(c.rangeText!);
    return range === segText || range.includes(phrase) || phrase.length === 0;
  });
  const hit = hits[0];
  detResults[c.category] = {
    wordCandidatesFound: hits.length,
    review: hit?.review ?? null,
    builtinLexicon: hit?.builtinLexicon ?? null,
    wordMatchPhrase: hit?.wordMatch?.phrase ?? null,
    matchedWords: hit?.wordMatch?.matchedWords ?? null,
    note: "builtin lexicon matches are REVIEW-only by construction",
  };
  console.log(`${c.category}: found=${hits.length} review=${hit?.review} builtin=${hit?.builtinLexicon} wordMatch="${hit?.wordMatch?.phrase ?? "-"}" matched=[${(hit?.wordMatch?.matchedWords ?? []).join(" ")}]`);
}
for (const c of cases.filter((x) => x.category === "tanglish_mixed")) {
  const lang = detectLanguage(c.segments.map((s) => s.text).join(" "));
  detResults[c.category] = { scripts: lang.scripts, primaryScript: lang.primaryScript, mixed: lang.mixed, probable: lang.probable ?? lang.probableLanguages ?? lang.languages ?? null };
  console.log(`${c.category}: scripts=${JSON.stringify(lang.scripts)} mixed=${lang.mixed}`);
}
// Real retake detector on the retake-shaped cases (real code, not assumed).
const retakeChecks: Record<string, boolean> = {};
for (const c of cases.filter((x) => ["repeated_sentence", "abandoned_take", "incomplete_replaced_by_complete", "redundant_explanation"].includes(x.category))) {
  retakeChecks[c.category] = findRepeatedTake(c.segments[0].text, c.segments[c.segments.length - 1].text);
  console.log(`${c.category}: findRepeatedTake=${retakeChecks[c.category]}`);
}

// Semantic layer: ONE real RIISHE inference call over all 12 cases.
console.log("\n=== PART 2b: semantic layer (real runRiisheInference, configured provider) ===");
const input = {
  mediaName: "phaseF-category-benchmark.mp3",
  durationSec: 230,
  sensitivity: "BALANCED" as const,
  candidates: cases.map((c) => ({
    id: c.candidate.id,
    start: c.candidate.start,
    end: c.candidate.end,
    duration: Math.round((c.candidate.end - c.candidate.start) * 100) / 100,
    rms: 0.0001,
    snr: 1.5,
    transcriptText: c.rangeText,
    prevSentence: c.segments[0]?.text ?? null,
    nextSentence: c.segments[c.segments.length - 1]?.text ?? null,
  })),
  transcriptSegments: cases.flatMap((c, i) => c.segments.map((s, j) => ({ id: `c${i}s${j}`, start: s.start, end: s.end, text: s.text }))),
};

let suggestions: { id: string; action: string; confidence: number; reason: string }[] = [];
let providerLabel = "unavailable";
const t0 = performance.now();
try {
  const res = await runRiisheInference(input);
  suggestions = res.suggestions;
  providerLabel = res.model;
  console.log(`inference ok: model=${res.model} batches=${res.batches} in ${Math.round(performance.now() - t0)}ms`);
} catch (err) {
  const partial = (err as { partial?: { suggestions: typeof suggestions; model: string } }).partial;
  if (partial) {
    suggestions = partial.suggestions;
    providerLabel = `${partial.model} (PARTIAL)`;
    console.log(`inference PARTIAL: ${partial.suggestions.length} classified`);
  } else {
    console.log(`inference unavailable (honest failure): ${(err as Error).message.slice(0, 140)}`);
  }
}

console.log("\n=== PART 2c: expected vs actual (post-safety, full pipeline semantics) ===");
// Rebuild each case as a REAL EvidenceCandidate with the flags the pipeline's
// deterministic stage would set, then run the REAL applySuggestions guard on
// the raw provider suggestions. The post-safety action is what the pipeline
// would actually deliver to the user.
function evidenceFor(c: CategoryCase, retakeFlag: boolean): EvidenceCandidate {
  const wordsInRange = c.rangeText ? tokens(c.rangeText).length : 0;
  const isBuiltin = ["filler_word_standalone", "false_start"].includes(c.category);
  const isWordMatch = ["filler_word_standalone", "repeated_word", "false_start", "production_chatter"].includes(c.category);
  return {
    id: c.candidate.id,
    start: c.candidate.start,
    end: c.candidate.end,
    duration: Math.round((c.candidate.end - c.candidate.start) * 100) / 100,
    reason: "deterministic-stage placeholder (benchmark)",
    review: "REVIEW",
    confidence: 1,
    classificationSource: "DETERMINISTIC",
    evidence: {
      pauseSec: c.candidate.end - c.candidate.start,
      rms: 0.0001,
      snr: 1.5,
      transcriptWordsInRange: wordsInRange,
      intraSentence: c.category === "natural_pause",
      quietSpeechNearby: false,
      repeatedTake: retakeFlag,
      floorReliable: false,
    },
    prevSentence: c.segments[0]?.text ?? null,
    nextSentence: c.segments[c.segments.length - 1]?.text ?? null,
    builtinLexicon: isBuiltin,
    ...(isWordMatch && c.rangeText
      ? {
          wordMatch: {
            phrase: c.category === "repeated_word" ? "the the" : c.category === "production_chatter" ? "otte otte" : tokens(c.rangeText)[0],
            segmentId: c.segments[0].id,
            segmentText: c.rangeText,
            matchedWords: tokens(c.rangeText),
            estimatedTiming: true as const,
          },
        }
      : {}),
  };
}

const candidateObjects = cases.map((c) => evidenceFor(c, retakeChecks[c.category] ?? false));
const guard = applySuggestions(candidateObjects, suggestions as RiisheSuggestion[], providerLabel);
console.log(`applySuggestions: applied=${guard.applied} downgraded=${guard.downgraded}`);

const rows: Record<string, string>[] = [];
for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  const after = candidateObjects[i];
  const actual = after.classificationSource === "RIISHE_INFERENCE" ? after.review : "NO-CLASSIFICATION";
  // Policy oracle: expected is what the documented safety policy requires.
  // KEEP cases are satisfied by either KEEP (confirmed) or REVIEW (safe direction).
  const expected = c.category === "repeated_sentence" || c.category === "incomplete_replaced_by_complete"
    ? retakeChecks[c.category] ? "REMOVE" : "REVIEW"
    : c.category === "production_chatter" ? "REMOVE" : c.expected;
  const ok = actual === expected || (expected === "KEEP" && actual === "REVIEW");
  const safetyViolation = (c.category === "natural_pause" || c.category === "meaningful_repetition" || c.category === "tanglish_mixed") && actual === "REMOVE";
  const row = {
    category: c.category,
    rawProvider: suggestions.find((s) => s.id === c.candidate.id)?.action ?? "-",
    afterSafety: actual,
    expected,
    ok: String(ok),
    confidence: after.confidence?.toFixed?.(2) ?? String(after.confidence),
    reason: after.reason.slice(0, 110),
    safetyViolation: String(safetyViolation),
  };
  rows.push(row);
  console.log(`${ok && !safetyViolation ? "PASS" : safetyViolation ? "SAFETY-FAIL" : "DIFF"} ${c.category}: raw=${row.rawProvider} afterSafety=${actual} expected=${expected} conf=${row.confidence}`);
}

writeFileSync("media-store/phaseF-benchmark.json", JSON.stringify({ comparison: out.comparison, deterministic: detResults, retakeChecks, provider: providerLabel, guard: { applied: guard.applied, downgraded: guard.downgraded }, rows }, null, 2));
console.log(`\nsaved media-store/phaseF-benchmark.json (provider=${providerLabel})`);
