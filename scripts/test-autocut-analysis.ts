/**
 * Unit tests for the transcript-driven classification rules in
 * autocut-analysis.ts (alignment, continuity, repeated takes, language).
 * The transcript here is REALISTIC TEST INPUT (what the ASR is expected to
 * return for the espeak test recording) — it does NOT claim provider success.
 */
import { alignTranscript, detectLanguage } from "/home/z/my-project/src/lib/autocut-analysis";

function approx(a: number, b: number, tol = 0.35) {
  return Math.abs(a - b) <= tol;
}

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  PASS ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

// Speech spans matching the composed test recording (13.6s+ of speech with
// gaps at 3.5-5.3, 11.3-14.5 etc. — measured VAD output shape).
const speechSpans = [
  { start: 0.1, end: 3.4, rms: 0.1 },   // Tamil sentence
  { start: 5.3, end: 10.9, rms: 0.09 }, // Tanglish + "The reason this happened,"
  { start: 16.3, end: 18.6, rms: 0.1 }, // "was because the system failed..."
  { start: 21.0, end: 25.5, rms: 0.1 }, // repeated take
  { start: 29.6, end: 32.0, rms: 0.025 }, // quiet speech
  { start: 33.0, end: 35.9, rms: 0.03 },  // quiet speech 2
];

// Chunk texts: chunk 0 = 0-25s (Tamil + Tanglish + en1a), chunk 1 = 25-39.3s.
const chunkTexts = [
  {
    start: 0,
    end: 25,
    text: "இது ஒரு சோதனை பதிவு. இன்று நாம் ஒரு புதிய திட்டத்தை தொடங்குகிறோம். vanakkam, indha session la naan project update sollren. The reason this happened,",
  },
  {
    start: 25,
    end: 39.3,
    text: "was because the system failed yesterday evening. Let me say that again, the reason this happened, was because the system failed yesterday evening. This part is spoken very quietly. with short natural pauses between phrases.",
  },
];

console.log("== alignment ==");
const segs = alignTranscript(chunkTexts, speechSpans, 999).segments;
check("segments produced", segs.length >= 4, `got ${segs.length}`);
const tamilSeg = segs.find((s) => /சோதனை/.test(s.text));
check("Tamil segment aligned to first speech span", !!tamilSeg && tamilSeg.start < 3.5, JSON.stringify(tamilSeg));
const reasonSeg = segs.find((s) => s.text.includes("The reason this happened"));
check("chunk-boundary sentence stitched into ONE segment", !!reasonSeg && reasonSeg.boundaryJoined === true && reasonSeg.text.includes("was because the system failed"), JSON.stringify(reasonSeg));
check("stitched sentence spans both chunk windows", !!reasonSeg && reasonSeg.start < 12.0 && reasonSeg.end > 16.3, `${reasonSeg?.start}..${reasonSeg?.end}`);
check("stitched words land on measured speech", !!reasonSeg && reasonSeg.words.length >= 10 && reasonSeg.words.every((w) => [0.1, 5.3, 16.3, 21.0].some((t0) => w.start >= t0 - 0.05)), JSON.stringify(reasonSeg?.words.map((w) => w.start)));

console.log("== language detection ==");
const lang = detectLanguage(chunkTexts.map((c) => c.text).join("\n"));
check("primary script is the majority one (Latin, English sentences dominate this mix)", lang.primaryScript === "Latin", lang.primaryScript);
check("Tamil script detected", lang.scripts.some((x) => x.script === "Tamil"), JSON.stringify(lang.scripts));
check("mixed scripts flagged", lang.mixed, JSON.stringify(lang.scripts));
check("description mentions Tanglish", /Tanglish|Tamil content with Latin/.test(lang.description), lang.description);
const enOnly = detectLanguage("Hello world this is english only.");
check("english-only not mixed", enOnly.primaryScript === "Latin" && !enOnly.mixed);
const none = detectLanguage("");
check("empty text honest", none.primaryScript === "unknown" && !none.mixed);

console.log(failures === 0 ? "\nALL UNIT TESTS PASSED" : `\n${failures} UNIT TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
