import { describe, expect, test } from "bun:test";
import { BUILTIN_FILLER_PHRASES } from "../src/lib/filler-lexicon";
import {
  buildWordCandidates,
  type EvidenceCandidate,
  type SpeechSpan,
  type TranscriptAnalysis,
} from "../src/lib/autocut-analysis";

const SETTINGS = {
  minSilenceSec: 0.5,
  headPaddingSec: 0.15,
  tailPaddingSec: 0.2,
  targetPauseSec: 0.35,
  tightenSentencePauses: true,
  sensitivity: "BALANCED" as const,
};

function makeTranscript(texts: { text: string; words: [string, number, number][] }[]): TranscriptAnalysis {
  return {
    available: true,
    text: texts.map((t) => t.text).join(" "),
    segments: texts.map((t, i) => ({
      id: `seg-${i}`,
      start: t.words[0][1],
      end: t.words[t.words.length - 1][2],
      text: t.text,
      words: t.words.map(([w, s, e]) => ({ text: w, start: s, end: e })),
      energyValidated: true,
      boundaryJoined: false,
    })),
    chunkCount: 1,
    failedChunks: [],
    warnings: [],
    language: {
      scripts: [{ script: "Latin", chars: 40 }],
      primaryScript: "Latin",
      mixed: false,
      languages: ["English (Latin script)"],
      description: "English (Latin script)",
    },
    alignmentStats: null,
  };
}

const SPANS: SpeechSpan[] = [
  { start: 1.0, end: 3.0, rms: 0.08 },
  { start: 3.6, end: 6.0, rms: 0.08 },
];
// A filler in its own short span with measured silence on both sides —
// the geometry that classifies a user-list match as standalone.
const SPANS_SOLO: SpeechSpan[] = [
  { start: 1.0, end: 1.3, rms: 0.08 },
  { start: 2.0, end: 4.0, rms: 0.08 },
];

describe("built-in multilingual filler lexicon", () => {
  test("covers English, Tamil script and romanized Tanglish fillers", () => {
    for (const p of ["um", "you know", "ஏதோ", "appo", "i mean"]) {
      expect(BUILTIN_FILLER_PHRASES).toContain(p);
    }
    expect(BUILTIN_FILLER_PHRASES.length).toBeGreaterThanOrEqual(14);
  });

  test("builtin matches are REVIEW-only even when standalone", () => {
    // A standalone "um" with real silence around it would be REMOVE for a
    // user-list entry — from the built-in lexicon it must stay REVIEW.
    const t = makeTranscript([{ text: "um", words: [["um", 1.0, 1.3]] }]);
    const out = buildWordCandidates(t, SPANS, [{ phrase: "um", builtin: true }], SETTINGS, 20, 0.001, true, [], []);
    expect(out.length).toBe(1);
    expect(out[0].review).toBe("REVIEW");
    expect(out[0].reason).toContain("built-in multilingual filler lexicon");
    expect(out[0].confidence).toBe(0.5);
  });

  test("user-list phrases keep the existing context-aware classification", () => {
    const t = makeTranscript([{ text: "um", words: [["um", 1.0, 1.3]] }]);
    const out = buildWordCandidates(t, SPANS_SOLO, ["um"], SETTINGS, 20, 0.001, true, [], []);
    expect(out.length).toBe(1);
    // standalone + silence both sides → REMOVE as before (unchanged behavior)
    expect(out[0].review).toBe("REMOVE");
  });

  test("Tamil script and Tanglish romanizations are matched case-insensitively", () => {
    const t = makeTranscript([
      { text: "ஏதோ ஒன்று நடக்கிறது", words: [["ஏதோ", 1.0, 1.3], ["ஒன்று", 1.3, 1.6], ["நடக்கிறது", 1.6, 2.0]] },
    ]);
    const out = buildWordCandidates(t, SPANS, [{ phrase: "ஏதோ", builtin: true }], SETTINGS, 20, 0.001, true, [], []);
    expect(out.length).toBe(1);
    expect(out[0].review).toBe("REVIEW");

    const t2 = makeTranscript([{ text: "APPO naan sonnen", words: [["APPO", 1.0, 1.3], ["naan", 1.3, 1.5], ["sonnen", 1.5, 1.9]] }]);
    const out2 = buildWordCandidates(t2, SPANS, [{ phrase: "appo", builtin: true }], SETTINGS, 20, 0.001, true, [], []);
    expect(out2.length).toBe(1);
    expect(out2[0].wordMatch?.matchedWords).toEqual(["APPO"]);
  });

  test("builtin matching accepts plain strings too (backward compatible)", () => {
    const t = makeTranscript([{ text: "um", words: [["um", 1.0, 1.3]] }]);
    const mixed = buildWordCandidates(t, SPANS_SOLO, ["um", { phrase: "you know", builtin: true }], SETTINGS, 20, 0.001, true, [], []);
    expect(mixed.length).toBe(1); // only "um" occurs in the transcript
    expect(mixed[0].review).toBe("REMOVE"); // plain string → user-list behavior
  });

  test("no transcript → no filler candidates (honest)", () => {
    const t = makeTranscript([{ text: "um", words: [["um", 1.0, 1.3]] }]);
    expect(buildWordCandidates({ ...t, available: false }, SPANS, [{ phrase: "um", builtin: true }], SETTINGS, 20, 0.001, true, [], []).length).toBe(0);
  });

  test("builtin candidates overlapping silence candidates are suppressed", () => {
    const t = makeTranscript([{ text: "um", words: [["um", 1.0, 1.3]] }]);
    const existing: EvidenceCandidate[] = [
      {
        id: "silence-1",
        start: 0.9,
        end: 1.5,
        duration: 0.6,
        reason: "silence",
        review: "REMOVE",
        confidence: 0.9,
        classificationSource: "DETERMINISTIC",
        evidence: {
          pauseSec: 0.6,
          rms: 0,
          snr: 10,
          transcriptWordsInRange: 0,
          intraSentence: false,
          quietSpeechNearby: false,
          repeatedTake: false,
          floorReliable: true,
        },
      },
    ];
    expect(buildWordCandidates(t, SPANS, [{ phrase: "um", builtin: true }], SETTINGS, 20, 0.001, true, existing, []).length).toBe(0);
  });
});
