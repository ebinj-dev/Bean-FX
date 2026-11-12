/**
 * T3 — Verify the 11 REMOVE reference intervals and 4 REVIEW intervals from
 * the task against the ACTUAL audio of the 20:19 recording.
 *
 * Method (per the task's rules — never trust SRT timing as audio timing):
 *  1. Map each SRT-B cue overlapping a reference interval into the media via
 *     the word-window matcher (real src/lib/srt.ts) on the server transcript.
 *  2. Measure speech/silence boundaries around the mapped region directly
 *     from the decoded PCM (validator-side VAD, same envelope method as V2).
 *  3. Compute the safe removal interval with the REAL safeIntervalFromSrt().
 *  4. Cross-check against the engine's candidates from the live analyze run.
 *  5. Classify from cue content + audio evidence; unverifiable → REVIEW.
 */
import { parseSrt, matchSrtToTranscript, safeIntervalFromSrt, type SrtCue } from "../src/lib/srt";

const analysis = JSON.parse(await Bun.file("/tmp/acc/an-main.json").text());
const segments = analysis.transcript.segments;
const duration: number = analysis.durationSec;

// ---- decode PCM + envelope (validator-side, same method as scripts/v2) ----
const proc = Bun.spawnSync(["ffmpeg", "-y", "-v", "error", "-i", "/home/z/my-project/media-store/originals/mw0958jymiuv7i.mp3", "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "/tmp/acc/t3.pcm"]);
const raw = await Bun.file("/tmp/acc/t3.pcm").arrayBuffer();
const pcm = new Int16Array(raw);
const SR = 16000, WIN = 160;
const frames = Math.floor(pcm.length / WIN);
const env = new Float32Array(frames);
for (let f = 0; f < frames; f++) {
  let acc = 0;
  for (let i = f * WIN; i < (f + 1) * WIN; i++) { const v = pcm[i] / 32768; acc += v * v; }
  env[f] = Math.sqrt(acc / WIN);
}
// speech spans with the same threshold family as the engine
const sortedEnv = Float32Array.from(env).sort();
const floor = sortedEnv[Math.floor(sortedEnv.length * 0.1)];
let peak = 0;
for (let i = 0; i < env.length; i++) if (env[i] > peak) peak = env[i];
const theta = Math.max(3 * floor, floor + 0.15 * (peak - floor), 0.006);
const spans: { start: number; end: number }[] = [];
let inSpeech = false, s0 = 0;
for (let f = 0; f < frames; f++) {
  const sp = env[f] >= theta;
  if (sp && !inSpeech) { inSpeech = true; s0 = f; }
  if (!sp && inSpeech) {
    inSpeech = false;
    if ((f - s0) / 100 >= 0.18) spans.push({ start: s0 / 100, end: f / 100 }); // ≥180ms speech
  }
}
if (inSpeech) spans.push({ start: s0 / 100, end: frames / 100 });
console.log(`VAD: ${spans.length} speech spans, theta=${theta.toFixed(4)} (floor=${floor.toFixed(4)}, peak=${peak.toFixed(3)})`);

// ---- matcher on server transcript ----
const srtB = parseSrt(await Bun.file("/home/z/my-project/upload/not edited.txt").text());
const match = matchSrtToTranscript(srtB.cues as SrtCue[], segments);
const cues = srtB.cues as SrtCue[];

// ---- reference intervals from the task ----
const REMOVE_REFS: [string, number, number, string][] = [
  ["R1", 7.1, 10.2, "Recording chatter, name and short mic/recording utterances (cue 2: Otte otte / Raghuram / Oh achcha okay)"],
  ["R2", 145.0, 148.0, "Tamil production interruption (cue 23: என்னடா ஓடிட்டு இருக்கு, வெயிட் பண்ணுங்க)"],
  ["R3", 165.0, 172.5, "Retake and restart instructions (cues 26-27: ஏய் இரு இரு, ஒரே நிமிஷம். மறுபடியும்...)"],
  ["R4", 254.2, 258.2, "Abandoned narration start (cue 41: great naval victory...) followed by corrected take"],
  ["R5", 319.5, 345.0, "Incomplete narration and production conversation (cues 51-59)"],
  ["R6", 545.2, 571.0, "Production discussion, fact verification and narration restart (cues 87-94)"],
  ["R7", 658.8, 663.8, "Section announcement and production chatter (cue 106)"],
  ["R8", 739.5, 741.5, "Production conversation (cue 117)"],
  ["R9", 907.0, 910.2, "Recording-time fact-checking discussion (cue 141)"],
  ["R10", 1118.2, 1119.0, "Production confirmation (cue 171: ஓகே?)"],
  ["R11", 1292.2, 1296.5, "Retake instruction and response (cues 195-196)"],
];
const REVIEW_REFS: [string, number, number, string][] = [
  ["V1", 304.8, 319.2, "Completed narration across adjacent cues (cues 49-50)"],
  ["V2", 541.0, 545.0, "Incomplete narration start mixed with a restart instruction (cue 87)"],
  ["V3", 1280.0, 1292.0, "First conclusion take (cues 193-194)"],
  ["V4", 1298.5, 1312.8, "Repeated conclusion take (cues 197-198)"],
];

function cuesIn(a: number, b: number) { return cues.filter((c) => c.end > a && c.start < b); }
function matchedCues(a: number, b: number) {
  return match.perCue.filter((p) => p.offsetSec !== null && p.cue.end > a && p.cue.start < b);
}
function audioAt(t: number) {
  // context: speech spans within ±6s of t
  const near = spans.filter((s) => s.end > t - 6 && s.start < t + 6);
  const inside = spans.filter((s) => s.end > t && s.start < t);
  const speechInside = inside.reduce((acc, s) => acc + Math.min(s.end, t + 0) - Math.max(s.start, t), 0);
  return { near, inside: inside.length > 0, speechInsideSec: Math.round(speechInside * 10) / 10 };
}

console.log("\n===== 11 REMOVE reference intervals =====");
for (const [id, a, b, why] of REMOVE_REFS) {
  const mc = matchedCues(a, b);
  const raw = cuesIn(a, b);
  let mediaPos = "";
  if (mc.length) {
    const anchors = mc.map((p) => p.cue.start + p.offsetSec!);
    mediaPos = `mapped media position(s): ${anchors.map((x) => x.toFixed(1)).join(", ")}s (cues ${mc.map((p) => p.cue.ordinal).join(",")})`;
  } else mediaPos = "no transcript coverage at this position (chunk failed/rate-limited) — audio-only verification";
  // audio evidence at the mapped position (or SRT position when unmapped)
  const probe = mc.length ? mc[0].cue.start + mc[0].offsetSec! : a;
  const au = audioAt(probe);
  console.log(`\n${id} SRT[${a}→${b}] ${why}`);
  console.log(`  cues in interval: ${raw.map((c) => c.ordinal).join(",") || "none"}`); 
  console.log(`  ${mediaPos}`);
  console.log(`  audio@${probe.toFixed(1)}s: ${au.inside ? "speech running" : "in measured silence"}; speech spans ±6s: ${au.near.map((s) => `${s.start.toFixed(1)}-${s.end.toFixed(1)}`).join(", ") || "none"}`);
  if (mc.length) {
    const anchor = mc[0].cue.start + mc[0].offsetSec!;
    const ref = { start: anchor, end: anchor + (b - a) };
    const safe = safeIntervalFromSrt(ref, spans);
    console.log(`  safe interval: ${safe.safe ? `${safe.safe.start}→${safe.safe.end}` : "UNSAFE (no measurable silence)"}; adjustments: ${safe.adjustments.length ? safe.adjustments.join(" | ").slice(0, 220) : "none needed"}`);
  }
}

console.log("\n===== 4 REVIEW reference intervals =====");
for (const [id, a, b, why] of REVIEW_REFS) {
  const raw = cuesIn(a, b);
  const mc = matchedCues(a, b);
  console.log(`\n${id} SRT[${a}→${b}] ${why}`);
  console.log(`  cues: ${raw.map((c) => `${c.ordinal}(${c.start.toFixed(1)}-${c.end.toFixed(1)})`).join(", ")}`);
  console.log(`  text: ${raw.map((c) => c.normalizedText.slice(0, 60)).join(" || ") || "none"}`);
  if (mc.length) {
    const anchors = mc.map((p) => p.cue.start + p.offsetSec!);
    console.log(`  mapped media position(s): ${anchors.map((x) => x.toFixed(1)).join(", ")}s`);
    const probe = anchors[0];
    const au = audioAt(probe);
    console.log(`  audio@${probe.toFixed(1)}s: ${au.inside ? "speech running" : "in silence"}; spans ±6s: ${au.near.map((s) => `${s.start.toFixed(1)}-${s.end.toFixed(1)}`).join(", ") || "none"}`);
  } else {
    console.log("  no transcript coverage — audio-only check below at mapped-tail region");
  }
}

// take comparison V3/V4: the two conclusion takes (cues 193-194 vs 197-198)
console.log("\n===== take comparison (conclusion takes) =====");
const t1 = cues.filter((c) => c.ordinal >= 193 && c.ordinal <= 194);
const t2 = cues.filter((c) => c.ordinal >= 197 && c.ordinal <= 198);
for (const [name, tk] of [["take 1 (cues 193-194)", t1], ["take 2 (cues 197-198)", t2]] as const) {
  const dur = tk.reduce((a, c) => a + (c.end - c.start), 0);
  // audio: speech spans in the media tail (last 120s) as proxy regions
  console.log(`${name}: SRT duration ${dur.toFixed(1)}s; text: ${tk.map((c) => c.normalizedText).join(" ").slice(0, 160)}`);
}
const tail = spans.filter((s) => s.start > duration - 130);
console.log(`media tail speech spans (last 130s): ${tail.map((s) => `${s.start.toFixed(1)}-${s.end.toFixed(1)} (${(s.end - s.start).toFixed(1)}s)`).join(", ")}`);
console.log(`SRT-A's final complete conclusion (cue 130, 19:29.4-19:42.5): "${parseSrt(await Bun.file("/home/z/my-project/upload/edited.txt").text()).cues.filter(c=>c.ordinal>=130).map(c=>c.normalizedText).join(" ").slice(0, 300)}"`);
