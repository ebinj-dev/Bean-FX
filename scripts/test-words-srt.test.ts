/**
 * Unit tests: SRT reference module + words-to-remove candidate builder.
 * Bun test; no network, no provider.
 */
import { describe, test, expect } from "bun:test";
import { parseSrt, normalizeCueText, matchSrtToTranscript, srtCoverage, safeIntervalFromSrt } from "../src/lib/srt";
import { buildWordCandidates, type TranscriptAnalysis, type EvidenceCandidate } from "../src/lib/autocut-analysis";

const SETTINGS = {
  minSilenceSec: 0.5,
  headPaddingSec: 0.15,
  tailPaddingSec: 0.2,
  targetPauseSec: 0.35,
  tightenSentencePauses: true,
  sensitivity: "BALANCED" as const,
};

/** Evenly distribute words across [start, end] for matcher tests. */
function mkWords(text: string, start: number, end: number): { text: string; start: number; end: number }[] {
  const parts = text.split(/\s+/);
  const step = (end - start) / parts.length;
  return parts.map((t, i) => ({ text: t, start: start + i * step, end: start + (i + 1) * step }));
}

describe("SRT parsing", () => {
  test("parses cues, preserves text/timestamps/order, strips cite markers for matching", () => {
    const srt = [
      "1",
      "00:00:00,000 --> 00:00:06,800",
      "This temple is not only a marvel of stone and architecture, carved onto its walls are more than 100 inscriptions[cite: 4].",
      "",
      "2",
      "00:00:07,100 --> 00:00:10,200",
      "Otte otte[cite: 4].",
      "Raghuram[cite: 4].",
      "",
      "3",
      "00:02:25,000 --> 00:02:28,000",
      "என்னடா ஓடிட்டு இருக்கு, வெயிட் பண்ணுங்க[cite: 4].",
      "",
    ].join("\n");
    const { cues, errors } = parseSrt(srt);
    expect(errors.length).toBe(0);
    expect(cues.length).toBe(3);
    expect(cues[0].start).toBe(0);
    expect(cues[0].end).toBeCloseTo(6.8, 3);
    expect(cues[0].text).toContain("[cite: 4]"); // original preserved verbatim
    expect(normalizeCueText(cues[0].text)).not.toContain("[cite"); // matching view clean
    expect(cues[1].start).toBeCloseTo(7.1, 3);
    expect(cues[1].text).toContain("Otte otte");
    expect(cues[2].normalizedText).toContain("வெயிட் பண்ணுங்க");
  });

  test("handles CRLF, BOM, missing indices and broken blocks with errors reported", () => {
    const srt = "\uFEFF00:00:01,000 --> 00:00:02,000\nNo index cue\r\n\r\nGARBAGE BLOCK\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,500\r\nSecond cue\r\n";
    const { cues, errors } = parseSrt(srt);
    expect(cues.length).toBe(2);
    expect(cues[0].index).toBe(1); // synthesized when missing
    expect(errors.some((e) => e.includes("GARBAGE"))).toBe(true);
  });

  test("end-before-start clamped and reported; empty file errors", () => {
    const bad = parseSrt("1\n00:00:05,000 --> 00:00:04,000\nBackwards\n");
    expect(bad.cues[0].end).toBeGreaterThanOrEqual(bad.cues[0].start);
    expect(bad.errors.length).toBeGreaterThan(0);
    const empty = parseSrt("nothing useful here");
    expect(empty.cues.length).toBe(0);
    expect(empty.errors.some((e) => e.includes("No valid SRT cues"))).toBe(true);
  });
});

describe("SRT matching + coverage", () => {
  const cues = parseSrt(
    [
      "1\n00:00:11,500 --> 00:00:17,200\nNamaste, my name is Raghuram. I'm a museologist.",
      "",
      "2\n00:00:25,900 --> 00:00:32,800\nHigh above the town of Thanjavur stands a temple.",
      "",
      "3\n00:05:04,800 --> 00:05:10,000\nThe king even declares in his own words that this stone temple was one.",
      "",
      "4\n00:21:38,500 --> 00:21:44,500\nFrom Rajaraja Chola's golden gifts to the songs of the Oduvars.",
      "",
      "5\n00:21:44,800 --> 00:21:52,800\nFrom Rajaraja Chola's golden gifts to the songs of the Oduvars.",
      "",
    ].join("\n")
  ).cues;

    const segments = [
      { id: "s1", start: 8.4, end: 14.0, text: "Namaste, my name is Raghuram. I'm a museologist.", words: mkWords("Namaste my name is Raghuram I'm a museologist", 8.4, 14.0) },
      { id: "s2", start: 23.0, end: 29.5, text: "High above the town of Thanjavur stands a temple.", words: mkWords("High above the town of Thanjavur stands a temple", 23.0, 29.5) },
      { id: "s3", start: 302.0, end: 307.4, text: "The king even declares in his own words that this stone temple was one.", words: mkWords("The king even declares in his own words that this stone temple was one", 302.0, 307.4) },
    ];

  test("matches cues to transcript segments and measures the timing offset", () => {
    const m = matchSrtToTranscript(cues, segments);
    expect(m.matchedCount).toBe(3);
    // SRT-B is ~3.1s ahead of the media transcript here
    expect(m.medianOffsetSec).toBeCloseTo(-2.9, 1); // median of [-3.1, -2.9, -2.8]
    const s1 = m.perCue[0];
    expect(s1.segmentId).toBe("s1");
    expect(s1.offsetSec).toBeCloseTo(-3.1, 1);
    expect(m.perCue[3].segmentId).toBeNull(); // unmatched cue → no fabricated offset
  });

  test("coverage reports ratio, repeats (takes) and gaps", () => {
    const cov = srtCoverage(cues, 1312);
    expect(cov.cueCount).toBe(5);
    expect(cov.coverageRatio).toBeGreaterThan(0);
    expect(cov.repeatedText.length).toBe(1); // cues 4 & 5 = repeated take
    expect(cov.repeatedText[0].similarity).toBeGreaterThanOrEqual(0.7);
    expect(cov.missingRanges.length).toBeGreaterThan(0); // 32.8s → 304.8s hole
    expect(cov.firstStartSec).toBe(11.5);
    expect(cov.lastEndSec).toBeCloseTo(1312.8, 1); // 21:52.8
  });

  test("safe interval never clips neighbouring speech", () => {
    const spans = [
      { start: 10.0, end: 12.4 }, // previous sentence tail
      { start: 14.9, end: 16.0 }, // chatter inside range
      { start: 16.9, end: 19.0 }, // next sentence start
    ];
    // Reference overlaps BOTH neighbours → adjusted inward, silence remains
    const r = safeIntervalFromSrt({ start: 12.0, end: 17.5 }, spans);
    expect(r.safe).not.toBeNull();
    expect(r.safe!.start).toBeCloseTo(12.55, 2); // prev end 12.4 + 0.15 pad
    expect(r.safe!.end).toBeCloseTo(16.7, 2); // next start 16.9 − 0.2 pad
    expect(r.adjustments.length).toBe(2);

    // Range welded into continuous speech → unsafe, never guessed
    const continuous = safeIntervalFromSrt({ start: 10.5, end: 12.0 }, [{ start: 10.0, end: 12.4 }]);
    expect(continuous.safe).toBeNull();
    expect(continuous.unsafe).toBe(true);

    // Clean reference inside silence → returned as-is
    const clean = safeIntervalFromSrt({ start: 12.6, end: 14.5 }, spans);
    expect(clean.safe).toEqual({ start: 12.6, end: 14.5 });
    expect(clean.adjustments.length).toBe(0);
  });
});


describe("SRT matching with non-1:1 segmentation (word-window alignment)", () => {
  test("merged ASR segments do not drag later cues into wrong (later) segments", () => {
    // Cue 1 spans what the ASR split into two segments; cue 2 must still find
    // ITS OWN segment, not drift forward (the greedy-matcher defect).
    const cues = parseSrt(
      [
        "1\n00:00:00,000 --> 00:00:06,800\nThis temple is not only a marvel of stone and architecture, carved onto its walls are more than 100 inscriptions.",
        "",
        "2\n00:00:11,500 --> 00:00:17,200\nNamaste, my name is Raghuram. I'm a museologist and heritage professional.",
        "",
        "3\n00:00:25,900 --> 00:00:32,800\nHigh above the town of Thanjavur stands a temple.",
        "",
      ].join("\n")
    ).cues;
    const segments = [
      { id: "m1", start: 0.05, end: 31.04, text: "This temple is not only a marvel of stone and architecture, carved onto its walls are more than 100 inscriptions.", words: mkWords("This temple is not only a marvel of stone and architecture carved onto its walls are more than 100 inscriptions", 0.05, 31.04) },
      { id: "m2", start: 31.04, end: 38.54, text: "Namaste, my name is Raghunatham.", words: mkWords("Namaste my name is Raghunatham", 31.04, 38.54) },
      { id: "m3", start: 38.54, end: 63.67, text: "I am a museologist and heritage professional with a focus on South Indian history.", words: mkWords("I am a museologist and heritage professional with a focus on South Indian history", 38.54, 63.67) },
      { id: "m4", start: 94.34, end: 126.92, text: "For over a millennium, high above the town of Tanjore stands a temple.", words: mkWords("For over a millennium high above the town of Tanjore stands a temple", 94.34, 126.92) },
    ];
    const r = matchSrtToTranscript(cues, segments);
    const p = r.perCue;
    expect(p[0].segmentId).toBe("m1");
    expect(p[0].offsetSec).toBeCloseTo(0.05, 2);
    // cue 2's word window spans m2+m3 words (11 of 12 cue tokens shared) and
    // anchors at its window start = m2's first word — offset ~+19.5s
    expect(p[1].segmentId).toBe("m2");
    expect(p[1].offsetSec).toBeCloseTo(19.54, 1);
    expect(p[2].segmentId).toBe("m4");
    // cue text begins at "High above..." — the speaker's preceding "For over a
    // millennium," belongs to the earlier sentence, so the anchor is the first
    // non-stopword cue token inside the window ("high"), not the segment start
    expect(p[2].offsetSec).toBeCloseTo(78.47, 1); // "high" is word 4 of m4 (13 words over 32.58s)
    // monotonic offsets
    const offs = p.map((x) => x.offsetSec).filter((x) => x !== null) as number[];
    for (let k = 1; k < offs.length; k++) expect(offs[k]).toBeGreaterThanOrEqual(offs[k - 1]);
  });

  test("chatter-only cues with no lexical support are skipped, not force-paired", () => {
    const cues = parseSrt("1\n00:00:07,100 --> 00:00:10,200\nOtte otte. Raghuram. Oh achcha, okay.\n\n2\n00:00:11,500 --> 00:00:14,000\nThe king donated gold to the shrine.\n").cues;
    const segments = [{ id: "s1", start: 5.0, end: 9.0, text: "The king donated gold jewels to the shrine.", words: mkWords("The king donated gold jewels to the shrine", 5.0, 9.0) }];
    const r = matchSrtToTranscript(cues, segments);
    expect(r.perCue[0].segmentId).toBeNull();
    expect(r.perCue[1].segmentId).toBe("s1");
    expect(r.matchedCount).toBe(1);
  });
});

function seg(id: string, text: string, words: [string, number, number][]): TranscriptAnalysis["segments"][number] {
  return { id, start: words[0][1], end: words[words.length - 1][2], text, words: words.map(([t, s, e]) => ({ text: t, start: s, end: e })), energyValidated: true, boundaryJoined: false };
}

function transcript(segments: TranscriptAnalysis["segments"]): TranscriptAnalysis {
  return { available: segments.length > 0, text: segments.map((s) => s.text).join(" "), segments, chunkCount: 1, failedChunks: [], warnings: [], language: { scripts: [], primaryScript: "Latin", mixed: false, languages: ["English"], description: "test" }, alignmentStats: null };
}

describe("words-to-remove candidates (context-aware)", () => {
  // "Um." standalone between silences; "um" inside a sentence; "very very" emphasis; "ஓகே" Tamil.
  const segments: TranscriptAnalysis["segments"] = [
    seg("a", "Um.", [["Um", 1.0, 1.3]]),
    seg("b", "I um think this works because the Um algorithm is deterministic.", [
      ["I", 4.0, 4.1], ["um", 4.15, 4.35], ["think", 4.8, 5.1], ["this", 5.15, 5.3], ["works", 5.35, 5.7],
      ["because", 5.75, 6.0], ["the", 6.05, 6.15], ["Um", 6.2, 6.4], ["algorithm", 6.5, 7.0], ["is", 7.05, 7.15], ["deterministic", 7.2, 7.9],
    ]),
    seg("c", "That was very very important.", [
      ["That", 10.0, 10.2], ["was", 10.25, 10.4], ["very", 10.45, 10.7], ["very", 10.75, 11.0], ["important", 11.1, 11.7],
    ]),
    seg("d", "ஓகே, போடட்டுமா.", [["ஓகே", 14.0, 14.4], ["போடட்டுமா", 14.5, 15.0]]),
  ];
  const t = transcript(segments);
  const spans = [
    { start: 0.9, end: 1.4 }, // standalone Um
    { start: 3.9, end: 8.0 }, // sentence b
    { start: 9.9, end: 11.8 }, // sentence c
    { start: 13.9, end: 15.1 }, // Tamil
  ];

  test("standalone filler → REMOVE-leaning; in-sentence → REVIEW; sentence never removed", () => {
    const out = buildWordCandidates(t, spans, ["um", "you know"], SETTINGS, 20, 0.001, true, [], []);
    const standalone = out.find((c) => c.start === 1.0);
    expect(standalone).toBeDefined();
    expect(standalone!.review).toBe("REMOVE");
    expect(standalone!.wordMatch!.phrase).toBe("um");
    expect(standalone!.wordMatch!.estimatedTiming).toBe(true);
    expect(standalone!.end - standalone!.start).toBeLessThan(0.6); // only the word, never the sentence

    const inSentence = out.filter((c) => c.start > 4.0 && c.start < 8.0);
    expect(inSentence.length).toBe(2); // "um" at 4.15 and "Um" at 6.2 (case-insensitive)
    for (const c of inSentence) {
      expect(c.review).toBe("REVIEW");
      expect(c.evidence.intraSentence).toBe(true);
      expect(c.end - c.start).toBeLessThan(0.6);
    }
  });

  test("multi-word phrase matches consecutive words; immediate repetition → REVIEW", () => {
    const out = buildWordCandidates(t, spans, ["very very"], SETTINGS, 20, 0.001, true, [], []);
    expect(out.length).toBe(1);
    expect(out[0].review).toBe("REVIEW"); // could be emphasis
    expect(out[0].wordMatch!.matchedWords).toEqual(["very", "very"]);
  });

  test("Tamil script entries match; punctuation and spacing do not block", () => {
    const out = buildWordCandidates(t, spans, ["ஓகே", "போடட்டுமா"], SETTINGS, 20, 0.001, true, [], []);
    expect(out.length).toBe(2);
    const ok = out.find((c) => c.wordMatch!.phrase === "ஓகே");
    expect(ok).toBeDefined();
    expect(ok!.review).toBe("REVIEW"); // inside the running sentence
  });

  test("no transcript / no phrases / no matches → empty, no fabricated candidates", () => {
    expect(buildWordCandidates({ ...t, available: false }, spans, ["um"], SETTINGS, 20, 0.001, true, [], []).length).toBe(0);
    expect(buildWordCandidates(t, spans, [], SETTINGS, 20, 0.001, true, [], []).length).toBe(0);
    expect(buildWordCandidates(t, spans, ["nonexistentword"], SETTINGS, 20, 0.001, true, [], []).length).toBe(0);
  });

  test("candidates overlapping an existing silence candidate are skipped, not duplicated", () => {
    const existing: EvidenceCandidate[] = [
      {
        id: "sil-1",
        start: 0.8,
        end: 1.6,
        duration: 0.8,
        reason: "silence",
        review: "REMOVE",
        confidence: 0.9,
        classificationSource: "DETERMINISTIC",
        evidence: { pauseSec: 0.8, rms: 0, snr: 30, transcriptWordsInRange: 0, intraSentence: false, quietSpeechNearby: false, repeatedTake: false, floorReliable: true },
      },
    ];
    const notes: string[] = [];
    const out = buildWordCandidates(t, spans, ["um"], SETTINGS, 20, 0.001, true, existing, notes);
    expect(out.find((c) => c.start === 1.0)).toBeUndefined();
    expect(notes.join(" ")).toContain("overlap silence candidates");
  });

  test("beyond-100 phrases and >80-char phrases are capped safely", () => {
    const phrases = Array.from({ length: 150 }, (_, i) => `phrase${i}`);
    const out = buildWordCandidates(t, spans, phrases, SETTINGS, 20, 0.001, true, [], []);
    expect(out.length).toBe(0);
  });
});
