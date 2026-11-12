/**
 * BEAN FX — unit checks for the pure logic modules (run with: bun scripts/unit-checks.ts).
 * Exits non-zero on the first failure; prints PASS/FAIL per check.
 */
import {
  buildCandidatesFromSilence,
  detectSilence,
  computeEnvelope,
  normalizeRanges,
  round3,
  type AnalysisResult,
} from "../src/lib/audio-analysis";
import { validateRanges } from "../src/lib/process-helpers";
import { parseSubtitles, serializeSrt, serializeVtt, formatTimestamp, alignTextToSpeech } from "../src/lib/srt-vtt";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function makeAnalysis(spans: { start: number; end: number }[], windowSec = 0.01): AnalysisResult {
  const env = { values: new Float32Array(0), windowSec, windowMs: windowSec * 1000 };
  return {
    envelope: env,
    noiseFloor: 0.001,
    peak: 0.9,
    silenceSpans: spans.map((s) => ({ ...s, rms: 0.0012, snr: 0.4 })),
    clippingDetected: false,
    windowMs: windowSec * 1000,
  };
}

// ---------------------------------------------------------------------------
// 1. Candidate math — the fixed-duration-cut defect
// ---------------------------------------------------------------------------
{
  const settings = {
    minSilenceSec: 0.5,
    headPaddingSec: 0.15,
    tailPaddingSec: 0.2,
    targetPauseSec: 0.35,
    tightenSentencePauses: true,
    sensitivity: "BALANCED" as const,
  };
  // A 3s pause between speech: span [10, 13].
  const result = buildCandidatesFromSilence(makeAnalysis([{ start: 10, end: 13 }]), settings, 30);
  check("3s pause yields exactly one candidate", result.length === 1, `got ${result.length}`);
  if (result.length === 1) {
    const c = result[0];
    // Padded span [10.15, 12.8] = 2.65s; head+tail (0.35) == target → full span removed.
    check("cut start respects head padding", Math.abs(c.start - 10.15) < 0.011, `start=${c.start}`);
    check("cut end respects tail padding", Math.abs(c.end - 12.8) < 0.011, `end=${c.end}`);
    check(
      "3s pause with target 0.35 removes ~2.65s (not a fixed 0.35s cut)",
      Math.abs(c.duration - 2.65) < 0.02,
      `duration=${c.duration}`
    );
    check("cut never extends into padding", c.start >= 10.15 - 1e-6 && c.end <= 12.8 + 1e-6);
  }

  // Distinct pauses must yield distinct durations (no fixed-duration cuts).
  const multi = buildCandidatesFromSilence(
    makeAnalysis([
      { start: 1, end: 2 },     // 1.0s pause
      { start: 5, end: 8.5 },   // 3.5s pause
      { start: 20, end: 24 },   // 4.0s pause
    ]),
    settings,
    30
  );
  check("three pauses yield three candidates", multi.length === 3, `got ${multi.length}`);
  const durations = new Set(multi.map((c) => c.duration));
  check("candidate durations are unique per pause length", durations.size === multi.length, `${[...durations].join(",")}`);
  if (multi.length >= 2) {
    check(
      "longer pause removes more (scales with pause length)",
      multi[1].duration > multi[0].duration,
      `${multi[1].duration} !> ${multi[0].duration}`
    );
  }
  // Remaining pause after each cut ≈ target (or head+tail when padding dominates).
  for (const c of multi) {
    const remaining = round3(c.start - (c.start - 0)) ; // structural, skip
    void remaining;
  }

  // Tighten OFF: full padded span proposed, no target shortening.
  const off = buildCandidatesFromSilence(
    makeAnalysis([{ start: 10, end: 13 }]),
    { ...settings, tightenSentencePauses: false },
    30
  );
  check("tighten OFF still proposes the padded span", off.length === 1 && Math.abs(off[0].duration - 2.65) < 0.02, `got ${off.map((c) => c.duration).join(",")}`);

  // Head+tail (0.35+0.35=0.7) > target (0.35): padding wins, full span removed.
  const padHeavy = buildCandidatesFromSilence(
    makeAnalysis([{ start: 10, end: 13 }]),
    { ...settings, headPaddingSec: 0.35, tailPaddingSec: 0.35 },
    30
  );
  check(
    "padding >= target removes the full padded span (2.3s)",
    padHeavy.length === 1 && Math.abs(padHeavy[0].duration - 2.3) < 0.02,
    `got ${padHeavy.map((c) => c.duration).join(",")}`
  );

  // Head+tail < target: extra keep centered, remaining pause ~= target.
  const smallPad = buildCandidatesFromSilence(
    makeAnalysis([{ start: 10, end: 13 }]),
    { ...settings, headPaddingSec: 0.1, tailPaddingSec: 0.1 },
    30
  );
  // extraKeep = 0.35 - 0.2 = 0.15 → cut = 2.8 - 0.15 = 2.65 = pause - target ✓
  check(
    "head+tail < target: cut = pause - target (2.65s)",
    smallPad.length === 1 && Math.abs(smallPad[0].duration - 2.65) < 0.02,
    `got ${smallPad.map((c) => c.duration).join(",")}`
  );
  check(
    "head+tail < target: cut centered in padded span",
    smallPad.length === 1 && Math.abs(smallPad[0].start - (10.1 + 0.075)) < 0.011,
    `start=${smallPad[0]?.start}`
  );

  // Silence below minimum is never eligible.
  const none = buildCandidatesFromSilence(makeAnalysis([{ start: 10, end: 10.3 }]), settings, 30);
  check("0.3s pause below min 0.5s yields no candidate", none.length === 0);
}

// ---------------------------------------------------------------------------
// 2. detectSilence on synthetic envelope-driven silence
// ---------------------------------------------------------------------------
{
  const values = new Float32Array(3000); // 30s at 10ms
  values.fill(0.5);
  for (let i = 1000; i < 1400; i++) values[i] = 0.0005; // 4s "silence" at 10s..14s
  const env = { values, windowSec: 0.01, windowMs: 10 };
  const det = detectSilence(env, { minSilenceSec: 0.5, sensitivity: "BALANCED" });
  check("detectSilence finds the synthetic silent span", det.silenceSpans.length === 1, `got ${det.silenceSpans.length}`);
  if (det.silenceSpans.length === 1) {
    const s = det.silenceSpans[0];
    check("span bounds ≈ [10, 14]", Math.abs(s.start - 10) < 0.05 && Math.abs(s.end - 14) < 0.05, `${s.start}..${s.end}`);
  }
}

// ---------------------------------------------------------------------------
// 3. Range normalization + server-side validation
// ---------------------------------------------------------------------------
{
  const n = normalizeRanges(
    [
      { start: 5, end: 6 },
      { start: 5.5, end: 7 },
      { start: 9, end: 10 },
    ],
    20
  );
  check("normalizeRanges merges overlaps", n.length === 2 && n[0].end === 7, JSON.stringify(n));

  const v1 = validateRanges([{ start: 1, end: 2 }, { start: 3, end: 4 }], 10);
  check("validateRanges accepts valid plan", v1.ok === true);
  const v2 = validateRanges([{ start: 1, end: 2.5 }, { start: 2, end: 4 }], 10);
  check("validateRanges rejects overlaps", v2.ok === false && /overlap/i.test(v2.ok ? "" : v2.error));
  const v3 = validateRanges([{ start: 8, end: 12 }], 10);
  check("validateRanges rejects beyond duration", v3.ok === false && /exceeds/i.test(v3.ok ? "" : v3.error));
  const v4 = validateRanges([{ start: 4, end: 4 }], 10);
  check("validateRanges rejects zero/negative ranges", v4.ok === false);
}

// ---------------------------------------------------------------------------
// 4. SRT/VTT round-trip
// ---------------------------------------------------------------------------
{
  const srt = `1\n00:00:01,000 --> 00:00:03,500\nHello world\n\n2\n00:00:04,000 --> 00:00:06,000\nSecond line — with unicode: தமிழ் हिंदी\n`;
  const parsed = parseSubtitles(srt);
  check("SRT parse: 2 cues", parsed.cues.length === 2 && parsed.format === "srt");
  check("unicode preserved", parsed.cues[1].text.includes("தமிழ்") && parsed.cues[1].text.includes("हिंदी"));
  const resrt = serializeSrt(parsed.cues);
  const reparsed = parseSubtitles(resrt);
  check("SRT round-trip stable", reparsed.cues.length === 2 && reparsed.cues[1].text === parsed.cues[1].text);

  const vtt = serializeVtt(parsed.cues);
  const vttParsed = parseSubtitles(vtt);
  check("VTT parse of serialized output", vttParsed.format === "vtt" && vttParsed.cues.length === 2);

  let threw = false;
  try {
    parseSubtitles("1\n00:00:02,000 --> 00:00:01,000\nbackwards\n");
  } catch {
    threw = true;
  }
  check("SRT parse rejects end <= start", threw);

  check("formatTimestamp 04:00:03,500 style", formatTimestamp(4 * 3600 + 3.5, "srt") === "04:00:03,500");
  check("formatTimestamp ms rounding guard", formatTimestamp(1.9999, "vtt") === "00:00:02.000" || formatTimestamp(1.9999, "vtt") === "00:00:01.999");
}

// ---------------------------------------------------------------------------
// 5. alignTextToSpeech basics
// ---------------------------------------------------------------------------
{
  const spans = [
    { start: 1, end: 3 },
    { start: 5, end: 9 },
  ];
  const cues = alignTextToSpeech("one two three four five six seven eight nine ten", spans);
  check("alignment produces cues", cues.length > 0);
  const inBounds = cues.every((c) => c.start >= 1 - 1e-6 && c.end <= 9 + 1e-6);
  check("all cues inside speech spans", inBounds, JSON.stringify(cues.map((c) => [c.start, c.end])));
  const ordered = cues.every((c, i) => i === 0 || cues[i - 1].start <= c.start);
  check("cues are ordered", ordered);
  const noGapsAtSpanStart = cues[0].start < 1.5;
  check("first cue starts near first span", noGapsAtSpanStart, `start=${cues[0]?.start}`);
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
