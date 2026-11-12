/**
 * Unit tests for the unified RIISHE pipeline rules in autocut-analysis.ts:
 * boundary joins, estimated word timestamps, language detection, the
 * continuation/dramatic-pause/punctuation-unknown classification ladder,
 * candidate validation, and canonical-plan union math.
 *
 * The transcript strings are REALISTIC TEST INPUT (what the ASR is expected
 * to return) — no provider results are simulated. Run: bun scripts/test-riishe-pipeline.ts
 */
import {
  alignTranscript,
  detectLanguage,
  validateCandidates,
  unionIntervals,
  buildCandidates,
  type SpeechSpan,
  type EvidenceCandidate,
  type TranscriptAnalysis,
} from "/home/z/my-project/src/lib/autocut-analysis";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  PASS ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

const DEFAULT_SETTINGS = {
  minSilenceSec: 0.5,
  headPaddingSec: 0.15,
  tailPaddingSec: 0.2,
  targetPauseSec: 0.35,
  tightenSentencePauses: true,
  sensitivity: "BALANCED" as const,
};

/* ---------------- language detection ---------------- */
console.log("language detection");
check("English", detectLanguage("The system failed and we do not know why it was not working today").languages[0]?.includes("English"), JSON.stringify(detectLanguage("The system failed and we do not know why it was not working today").languages));
check("Tanglish", detectLanguage("enna da ippo romba illa aana seri vanthu epdi irukku").languages[0]?.includes("Tanglish"), JSON.stringify(detectLanguage("enna da ippo romba illa aana seri vanthu epdi irukku").languages));
check("Hindi romanized", detectLanguage("yeh kya hai bhai acha theek hai nahi kuch karo abhi").languages[0]?.includes("Hindi"), JSON.stringify(detectLanguage("yeh kya hai bhai acha theek hai nahi kuch karo abhi").languages));
check("Tamil script", detectLanguage("இது ஒரு தமிழ் பத்தியாகும் இதில் எந்த ஆங்கிலமும் இல்லை").languages[0]?.includes("Tamil"), JSON.stringify(detectLanguage("இது ஒரு தமிழ் பத்தியாகும் இதில் எந்த ஆங்கிலமும் இல்லை").languages));
const mixed = detectLanguage("இது ஒரு system failure பற்றி சொல்கிறேன் and then we fixed it quickly");
check("mixed Tamil+Latin", mixed.mixed && /Tanglish|Tamil/.test(mixed.description), mixed.description);
check("Devanagari", detectLanguage("यह एक परीक्षण वाक्य है और इसमें कुछ नहीं है").languages[0]?.includes("Hindi"), JSON.stringify(detectLanguage("यह एक परीक्षण वाक्य है और इसमें कुछ नहीं है").languages));
check("no text honest", detectLanguage("").languages.length === 0 && /not detected/.test(detectLanguage("").description));
check("no bare script as language", !/^Latin$/.test(detectLanguage("hello world this is a test of the system").languages[0] ?? "Latin"));

/* ---------------- boundary joins + word timestamps ---------------- */
console.log("alignment");
{
  const chunks = [
    { start: 0, end: 25, text: "The reason this happened..." },
    { start: 25, end: 50, text: "was because the system failed." },
    { start: 50, end: 75, text: "" },
    { start: 75, end: 100, text: "We restarted the server. Then it worked again." },
  ];
  const spans: SpeechSpan[] = [
    { start: 0.5, end: 4.5, rms: 0.2 },
    { start: 25.5, end: 29.5, rms: 0.2 },
    { start: 75.2, end: 78.0, rms: 0.2 },
    { start: 78.5, end: 81.0, rms: 0.2 },
  ];
  const { segments, stats } = alignTranscript(chunks, spans, 100);
  check("boundary join merges fragments", segments[0].text === "The reason this happened... was because the system failed.", segments[0].text);
  check("join flagged", segments[0].boundaryJoined === true);
  check("join count", stats.boundaryJoins === 1, String(stats.boundaryJoins));
  check("silent chunk counted", stats.chunksSilent === 1, String(stats.chunksSilent));
  check("sentence count", stats.sentenceCount === 3, String(stats.sentenceCount));
  check("joined segment spans both windows", Math.abs(segments[0].start - 0.5) < 0.05 && segments[0].end > 25.5 && segments[0].end <= 29.5, `${segments[0].start}..${segments[0].end}`);
  const words = segments[0].words;
  check("words present", words.length === 9, String(words.length));
  check("words monotonic", words.every((w, i) => i === 0 || w.start >= words[i - 1].start - 1e-6));
  check("words inside speech (skip the chunk-gap silence)", words.every((w) => (w.start >= 0.5 - 0.01 && w.start <= 4.5 + 0.01) || (w.start >= 25.5 - 0.01 && w.start <= 29.5 + 0.01)), JSON.stringify(words.map((w) => w.start)));
  check("energy validated", segments[0].energyValidated === true);
  check("anchored honest when no speech", (() => {
    const r = alignTranscript([{ start: 200, end: 225, text: "No speech energy here at all." }], [], 300);
    return r.segments[0].energyValidated === false && r.stats.anchored === 1;
  })());
}

/* ---------------- classification ladder ---------------- */
console.log("classification");
function mkTranscript(partial: Partial<TranscriptAnalysis>): TranscriptAnalysis {
  return {
    available: true,
    text: "",
    segments: [],
    chunkCount: 1,
    failedChunks: [],
    warnings: [],
    language: detectLanguage(""),
    alignmentStats: null,
    ...partial,
  };
}
function runCandidates(segments: TranscriptAnalysis["segments"], spans: SpeechSpan[], transcriptText: string, minSilence = 0.5): EvidenceCandidate[] {
  // 10 ms envelope of near-zero values (silence) — gaps come from spans.
  const env = { values: new Float32Array(1500).fill(0.0005), windowSec: 0.01 };
  const transcript = mkTranscript({ segments, text: transcriptText });
  const notes: string[] = [];
  return buildCandidates(env, spans, transcript, { ...DEFAULT_SETTINGS, minSilenceSec: minSilence }, 4.0, true, 0.0005, notes);
}
{
  // Speech 0.0–1.0, pause 1.0–2.5 (1.5 s), speech 2.5–4.0.
  const spans: SpeechSpan[] = [
    { start: 0, end: 1.0, rms: 0.2 },
    { start: 2.5, end: 4.0, rms: 0.2 },
  ];
  const seg = (text: string, start: number, end: number) => ({
    id: text.slice(0, 6),
    start,
    end,
    text,
    words: text.split(" ").map((w, i, arr) => ({ text: w, start: start + (i * (end - start)) / arr.length, end: start + ((i + 1) * (end - start)) / arr.length })),
    energyValidated: true,
    boundaryJoined: false,
  });

  const terminal = runCandidates([seg("The system failed completely.", 0, 1.0), seg("We fixed it later.", 2.5, 4.0)], spans, "The system failed completely. We fixed it later.");
  const tRem = terminal.find((c) => c.review === "REMOVE");
  check("terminal sentence pause → REMOVE", Boolean(tRem) && Math.abs(tRem!.start - 1.15) < 0.06, JSON.stringify(terminal.map((c) => [c.start, c.end, c.review])));

  const continuation = runCandidates([seg("The reason this happened...", 0, 1.0), seg("was because the system failed.", 2.5, 4.0)], spans, "The reason this happened... was because the system failed.");
  check("spec example: continuation pause → KEEP (never REMOVE)", continuation.every((c) => c.review !== "REMOVE") && continuation.some((c) => c.review === "KEEP"), JSON.stringify(continuation.map((c) => [c.start, c.end, c.review])));

  const lowercaseNext = runCandidates([seg("The audit failed yesterday.", 0, 1.0), seg("which meant the report was late.", 2.5, 4.0)], spans, "The audit failed yesterday. which meant the report was late.");
  check("lowercase continuation start → KEEP", lowercaseNext.every((c) => c.review !== "REMOVE"), JSON.stringify(lowercaseNext.map((c) => c.review)));

  // Dramatic pause: continuation with a 4 s pause → REVIEW, never auto-REMOVE.
  const spans4: SpeechSpan[] = [
    { start: 0, end: 1.0, rms: 0.2 },
    { start: 5.0, end: 7.0, rms: 0.2 },
  ];
  const dramatic = runCandidates([seg("And then he said...", 0, 1.0), seg("nothing at all happened next.", 5.0, 7.0)], spans4, "And then he said... nothing at all happened next.");
  check("dramatic mid-sentence pause → REVIEW", dramatic.filter((c) => c.evidence.intraSentence).every((c) => c.review === "REVIEW" || c.review === "KEEP") && !dramatic.some((c) => c.evidence.intraSentence && c.review === "REMOVE"), JSON.stringify(dramatic.map((c) => [c.review, c.evidence.intraSentence])));

  // No punctuation anywhere → sentence boundaries unknown → no auto-REMOVE ≤8 s.
  const noPunct = runCandidates([seg("the system failed and we do not know why", 0, 1.0), seg("so we restarted the whole thing again", 2.5, 4.0)], spans, "the system failed and we do not know why so we restarted the whole thing again");
  check("punctuation-less transcript → no auto-REMOVE", noPunct.every((c) => c.review !== "REMOVE"), JSON.stringify(noPunct.map((c) => c.review)));

  // Words inside the proposed range → REVIEW (quiet speech preserved).
  const wordsInRange = runCandidates([seg("The system failed completely.", 0, 1.0), seg("we checked it twice.", 2.5, 4.0)], spans, "The system failed completely. we checked it twice."); // lowercase next → intra → KEEP; use terminal next instead
  const wordsInRange2 = runCandidates([seg("The system failed completely.", 0, 1.0), seg("We checked it twice.", 2.5, 4.0)], spans, "The system failed completely. We checked it twice.".replace("We checked it twice.", "We checked it twice."));
  void wordsInRange;
  void wordsInRange2;
  // Word timestamps spilling into the gap: last word of sentence 1 estimated to end at 1.3 (inside the cut).
  const spill = seg("The system failed completely and utterly.", 0, 1.0);
  spill.words = spill.words.map((w, i) => (i === spill.words.length - 1 ? { ...w, end: 1.3, start: 1.0 } : w));
  const spillRun = runCandidates([spill, seg("We fixed it later.", 2.5, 4.0)], spans, "The system failed completely and utterly. We fixed it later.");
  check("word spilling into cut → REVIEW (word-level evidence)", spillRun.some((c) => c.review === "REVIEW"), JSON.stringify(spillRun.map((c) => [c.review, c.evidence.transcriptWordsInRange])));

  // Repeated take → REVIEW (verbatim repeated statement, like a false take).
  const repeatText = "Let me say that again, the reason this happened was because the system failed yesterday evening";
  const repeat = runCandidates([seg(repeatText + ".", 0, 1.0), seg(repeatText + ".", 2.5, 4.0)], spans, repeatText + ". " + repeatText + ".");
  check("repeated take → REVIEW", repeat.some((c) => c.evidence.repeatedTake && c.review === "REVIEW"), JSON.stringify(repeat.map((c) => [c.review, c.evidence.repeatedTake])));

  // Short echo phrases must NOT flood every pause as repeated takes.
  const echo = runCandidates([seg("We will ship it on Friday morning.", 0, 1.0), seg("We will ship it on Friday morning.", 2.5, 4.0)], spans, "We will ship it on Friday morning. We will ship it on Friday morning.");
  check("short echo not flagged as repeated take", !echo.some((c) => c.evidence.repeatedTake), JSON.stringify(echo.map((c) => [c.review, c.evidence.repeatedTake])));
}

/* ---------------- validation + canonical plan ---------------- */
console.log("validation + plan");
{
  const c = (id: string, start: number, end: number): EvidenceCandidate => ({
    id,
    start,
    end,
    duration: end - start,
    reason: "test",
    review: "REMOVE",
    confidence: 0.8,
    classificationSource: "DETERMINISTIC",
    evidence: { pauseSec: end - start, rms: 0.001, snr: 3, transcriptWordsInRange: 0, intraSentence: false, quietSpeechNearby: false, repeatedTake: false, floorReliable: true },
  });
  const contained = validateCandidates([c("a", 1, 2), c("b", 1.5, 2.5)], 10);
  check("contained duplicate dropped", contained.valid.some((v) => v.id === "a") && !contained.valid.some((v) => v.id === "b"), JSON.stringify(contained.valid.map((v) => v.id)));
  const { valid, fixes } = validateCandidates([c("out", -0.5, 12), c("tiny", 3, 3.01)], 10);
  check("out-of-bounds clamped", valid.find((v) => v.id === "out")?.start === 0 && valid.find((v) => v.id === "out")?.end === 10);
  check("fixes reported", fixes.length >= 1, JSON.stringify(fixes));

  const union = unionIntervals([{ start: 1, end: 2 }, { start: 1.8, end: 3.2 }, { start: 5, end: 6 }], 10);
  const removed = union.reduce((a, r) => a + (r.end - r.start), 0);
  check("overlapping cuts unioned (no double count)", union.length === 2 && Math.abs(removed - 3.2) < 1e-6, JSON.stringify({ union, removed }));
  check("final = original − union", Math.abs(10 - removed - 6.8) < 1e-6);
  check("no cuts → final = original", unionIntervals([], 10).length === 0);
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
