/**
 * BEAN FX — RIISHE server-side analysis engine.
 *
 * Everything here runs on the REAL decoded samples of the uploaded recording
 * (16 kHz mono PCM via ffmpeg) plus the REAL ASR provider. No simulated data.
 *
 * Design constraints (from the RIISHE engineering spec):
 * - Evidence-based candidates: VAD (hysteresis), energy, pause duration,
 *   sentence boundaries, semantic continuity, repeated takes. No fixed
 *   removal quota; removals scale with the actual pause.
 * - Honest states: when the level profile makes silence analysis unreliable,
 *   or when inference is unavailable, that is reported — ambiguous candidates
 *   go to REVIEW, never to REMOVE on a hunch. Speech is never classified
 *   REMOVE solely because inference failed.
 * - One canonical cut-plan representation: CutRange[] with normalized
 *   removal intervals shared by display, edited timeline and export.
 */
import { execFile } from "child_process";
import { promises as fs } from "fs";
import { createHash } from "crypto";
import path from "path";
import os from "os";
import type { CutPlanSettings, SensitivityProfile } from "@/lib/types";
import { resolveAsrProvider, transcribeChunkViaProvider } from "@/lib/asr-providers";
import { BUILTIN_FILLER_PHRASES } from "@/lib/filler-lexicon";
import { MEDIA_ROOT } from "./media-storage";

export type RiisheStageKey = keyof PipelineStages;

/** A real pipeline transition, emitted as the work happens (never invented):
 *  background jobs stream these so the UI can show live stage progress and
 *  name the exact stage that failed. */
export interface AnalysisProgressEvent {
  stage: RiisheStageKey;
  status: PipelineStageState;
  detail?: string;
  /** Coarse completion 0-100 derived from real work counts (e.g. ASR chunks). */
  progressPct?: number;
}

export interface ServerAnalysisInput {
  storagePath: string;
  settings: CutPlanSettings;
  /** RMS analysis window in ms (default 10). */
  windowMs?: number;
  /** User-defined words/phrases to consider removing (context-aware). */
  wordsToRemove?: string[];
  /** False for video media without any audio stream — speech analysis is
   *  skipped honestly instead of failing. */
  hasAudioStream?: boolean;
  /** Duration from ffprobe when no audio can be decoded (no-audio video). */
  fallbackDurationSec?: number | null;
  /** Live progress hook for background-job execution. Omitted on the
   *  synchronous path — events are optional and never affect results. */
  onProgress?: (event: AnalysisProgressEvent) => void;
}

export interface SpeechSpan {
  start: number;
  end: number;
  /** Mean RMS inside the span (linear 0..1). */
  rms: number;
}

export interface TranscriptAnalysis {
  available: boolean;
  text: string;
  /** Sentence-level segments with estimated word timestamps. */
  segments: AlignedSegment[];
  chunkCount: number;
  failedChunks: number[];
  warnings: string[];
  language: LanguageInfo;
  /** Coverage/validation report for the alignment stage (null when
   *  transcription never ran). */
  alignmentStats: AlignmentStats | null;
}

export interface LanguageInfo {
  /** Script names with character counts, e.g. { Tamil: 120, Latin: 40 }. */
  scripts: { script: string; chars: number }[];
  /** Primary script name, or "unknown" when there is no text. */
  primaryScript: string;
  /** True when two or more scripts are materially mixed (e.g. Tamil + Latin). */
  mixed: boolean;
  /** Probable language(s) — script mapping plus lexicon checks. Empty when
   *  the transcript has no usable text. Honest: never a bare script name. */
  languages: string[];
  /** Human-readable, honest description (no invented language claims). */
  description: string;
}

export interface EvidenceCandidate {
  id: string;
  start: number;
  end: number;
  duration: number;
  reason: string;
  review: "REMOVE" | "REVIEW" | "KEEP";
  confidence: number;
  classificationSource: "DETERMINISTIC" | "RIISHE_INFERENCE";
  evidence: {
    pauseSec: number;
    rms: number;
    snr: number;
    /** Transcript words inside the removable window (0 = clean silence). */
    transcriptWordsInRange: number;
    /** Pause sits inside one ongoing sentence (continuity risk). */
    intraSentence: boolean;
    /** Adjacent speech is markedly quieter than the recording's norm. */
    quietSpeechNearby: boolean;
    /** Adjacent segments look like a repeated take of the same content. */
    repeatedTake: boolean;
    floorReliable: boolean;
  };
  /** Neighbouring sentence text for semantic-continuity context. */
  prevSentence?: string | null;
  nextSentence?: string | null;
  /** True when the candidate originates from the BUILT-IN multilingual filler
   *  lexicon. Such candidates are REVIEW-only by construction: neither the
   *  deterministic stage nor semantic inference may promote them to REMOVE. */
  builtinLexicon?: boolean;
  /** Present when the candidate originates from the user's words-to-remove
   *  list (context-aware match inside the transcript). Word timings here are
   *  ESTIMATED (the ASR provider returns none) — never presented as genuine
   *  word-level alignment. */
  wordMatch?: {
    phrase: string;
    segmentId: string;
    segmentText: string;
    matchedWords: string[];
    /** Estimated: true by construction. Kept explicit for honesty. */
    estimatedTiming: true;
  };
}

/** Truthful pipeline stage states — the values the pipeline panel renders.
 *  Nothing is DONE until that stage actually completed; a stage that could
 *  not run is UNAVAILABLE (provider/config) or FAILED (ran and errored). */
export type PipelineStageState = "PENDING" | "RUNNING" | "DONE" | "UNAVAILABLE" | "FAILED";

export interface PipelineStages {
  mediaInspection: PipelineStageState;
  audioExtraction: PipelineStageState;
  audioDecoding: PipelineStageState;
  waveformFeatures: PipelineStageState;
  vad: PipelineStageState;
  speechSegmentation: PipelineStageState;
  transcription: PipelineStageState;
  wordAlignment: PipelineStageState;
  languageId: PipelineStageState;
  fillerDetection: PipelineStageState;
  repetitionDetection: PipelineStageState;
  pauseClassification: PipelineStageState;
  contentClassification: PipelineStageState;
  candidatesValidated: PipelineStageState;
  readyForReview: PipelineStageState;
}

/** The canonical cut plan: the UNION of approved removal intervals.
 *  Final duration = original − union; overlapping cuts can never
 *  double-count, and an empty union leaves the duration untouched. */
export interface CanonicalPlan {
  removals: { start: number; end: number }[];
  removedSec: number;
  finalDurationSec: number;
}

export function unionIntervals(ranges: { start: number; end: number }[], durationSec: number): { start: number; end: number }[] {
  const valid = ranges
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start && r.start >= 0)
    .map((r) => ({ start: round3(r.start), end: round3(Math.min(r.end, durationSec)) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  for (const r of valid) {
    const prev = out[out.length - 1];
    if (prev && r.start <= prev.end + 1e-6) prev.end = Math.max(prev.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

export interface ServerAnalysisResult {
  sampleRate: number;
  durationSec: number;
  noiseFloor: number;
  peak: number;
  /** False when the recording's level profile is nearly constant (e.g. tone,
   *  heavy compression) and the adaptive floor cannot separate speech from
   *  background. Candidates are then suppressed or forced to REVIEW. */
  floorReliable: boolean;
  speechSpans: SpeechSpan[];
  windowMs: number;
  candidates: EvidenceCandidate[];
  transcript: TranscriptAnalysis;
  peaks: { min: number[]; max: number[] };
  notes: string[];
  /** Truthful stage states as of this result (inference still PENDING —
   *  the route fills it in from the inference stage). */
  stages: PipelineStages;
  /** Canonical plan from the current classification (recomputed by the
   *  route after semantic suggestions are applied). */
  plan: CanonicalPlan;
}

const ASR_CHUNK_SEC = 25; // provider hard limit is 30s (error 1214)
const ASR_CONCURRENCY = 2;
const PEAK_BUCKETS = 24000;

function run(cmd: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, _so, se) => {
      if (err) reject(new Error(`${cmd} failed: ${String(se).slice(-300) || err.message}`));
      else resolve();
    });
  });
}

/** Decode to 16 kHz mono s16le raw PCM — deterministic, language-independent. */
async function decodePcm(storagePath: string): Promise<{ pcm: Int16Array; sampleRate: number }> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "beanfx-cut-"));
  try {
    const out = path.join(workDir, "audio.pcm");
    await run(
      "ffmpeg",
      ["-y", "-i", storagePath, "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "-c:a", "pcm_s16le", out],
      300_000
    );
    const buf = await fs.readFile(out);
    const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
    return { pcm, sampleRate: 16000 };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** RMS envelope with a 10 ms window on the decoded samples. */
function computeEnvelope(pcm: Int16Array, sampleRate: number, windowMs: number): { values: Float32Array; windowSec: number } {
  const winLen = Math.max(1, Math.floor((sampleRate * windowMs) / 1000));
  const frames = Math.ceil(pcm.length / winLen);
  const values = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const start = f * winLen;
    const end = Math.min(start + winLen, pcm.length);
    let sum = 0;
    for (let i = start; i < end; i++) {
      const v = pcm[i] / 32768;
      sum += v * v;
    }
    values[f] = Math.sqrt(sum / Math.max(1, end - start));
  }
  return { values, windowSec: windowMs / 1000 };
}

function percentile(values: Float32Array, p: number): number {
  const arr = Array.from(values).sort((a, b) => a - b);
  if (!arr.length) return 0;
  return arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * p)))];
}

/** 3-tap median filter — suppresses single-frame click/blip artifacts so a
 *  stray spike cannot split one real pause into two candidates. */
function medianFilter3(values: Float32Array): Float32Array {
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const a = values[Math.max(0, i - 1)];
    const b = values[i];
    const c = values[Math.min(values.length - 1, i + 1)];
    out[i] = a < b ? (b < c ? b : a < c ? c : a) : a < c ? a : b < c ? c : b;
  }
  return out;
}

/**
 * Speech detection with hysteresis (enter above hi, exit below lo) so a
 * voiced consonant gap does not fragment one utterance into many spans.
 * Sensitivity drives the enter threshold: LOW keeps more (room tone counts
 * as speech → fewer, shorter gaps), HIGH removes more (only clearly loud
 * material counts as speech → longer eligible gaps).
 */
function detectSpeechSpans(
  env: { values: Float32Array; windowSec: number },
  noiseFloor: number,
  sensitivity: SensitivityProfile
): SpeechSpan[] {
  const hiMult = { LOW: 2.3, BALANCED: 3.2, HIGH: 4.4 }[sensitivity];
  const hi = Math.max(noiseFloor * hiMult, 0.006);
  const lo = hi * 0.55;
  const minSpeechFrames = Math.max(2, Math.round(0.06 / env.windowSec));
  const hangoverFrames = Math.max(1, Math.round(0.12 / env.windowSec));
  const smoothed = { values: medianFilter3(env.values), windowSec: env.windowSec };

  const spans: SpeechSpan[] = [];
  let active = false;
  let startFrame = 0;
  let quietRun = 0;
  let sum = 0;
  let count = 0;
  const flush = (endFrame: number) => {
    if (active && count >= minSpeechFrames) {
      spans.push({ start: startFrame * env.windowSec, end: endFrame * env.windowSec, rms: sum / Math.max(1, count) });
    }
    active = false;
    sum = 0;
    count = 0;
    quietRun = 0;
  };
  for (let i = 0; i < smoothed.values.length; i++) {
    const v = smoothed.values[i];
    if (!active) {
      if (v >= hi) {
        active = true;
        startFrame = i;
        sum = v;
        count = 1;
        quietRun = 0;
      }
    } else {
      if (v >= lo) {
        sum += v;
        count++;
        quietRun = 0;
      } else {
        quietRun++;
        sum += v;
        count++;
        if (quietRun > hangoverFrames) {
          flush(i - quietRun + 1);
        }
      }
    }
  }
  flush(env.values.length);
  return spans;
}

/** Unicode script detection — deterministic and honest (no model guesses). */
export function detectLanguage(text: string): LanguageInfo {
  const ranges: [string, RegExp][] = [
    ["Tamil", /[\u0B80-\u0BFF]/g],
    ["Devanagari", /[\u0900-\u097F]/g],
    ["Latin", /[A-Za-z]/g],
    ["Arabic", /[\u0600-\u06FF]/g],
    ["CJK", /[\u4E00-\u9FFF\u3040-\u30FF]/g],
    ["Telugu", /[\u0C00-\u0C7F]/g],
    ["Kannada", /[\u0C80-\u0CFF]/g],
    ["Malayalam", /[\u0D00-\u0D7F]/g],
  ];
  const scripts = ranges
    .map(([script, re]) => ({ script, chars: (text.match(re) ?? []).length }))
    .filter((s) => s.chars > 0)
    .sort((a, b) => b.chars - a.chars);
  const total = scripts.reduce((a, s) => a + s.chars, 0);
  const primaryScript = scripts[0]?.script ?? "unknown";
  const mixed = scripts.filter((s) => s.chars / Math.max(1, total) > 0.12).length >= 2;

  /* Latin-script text alone cannot distinguish English from romanized
   * Indian languages (Tanglish), so score lexicons before naming anything.
   * Everything is word-count based on the real transcript — no guessing. */
  const ENGLISH_MARKERS = [
    "the","and","is","was","are","were","to","of","in","that","it","this","for","on","with","as","at","be","have","has","had","not","but","we","you","they","he","she","i","a","an","because","which","so","what","when","how","will","can","do","does","did","from","there","here","then","now","about","just","like","really","very",
  ];
  const TGLISH_MARKERS = [
    // Frequently romanized Tamil tokens (transliteration varies; match stems).
    "enna","epdi","eppadi","romba","illa","illai","aana","ana","alla","aama","aam","vanthu","vandhu","panra","pannra","pannu","panraanga","irukku","erukku","iruku","sollu","solli","vidu","kodu","thambi","anna","akka","machi","machan","da","er","paaru","paru","nalla","seri","aanaa","indha","andha","enna da","kapattu","purinjuko","ok va","aprom","approm","ippo","ippo thaan","kandippa","confirm aayiduchum",
  ];
  const HINDI_ROMANIZED = ["hai","nahi","kya","aur","main","mein","karo","karna","hoga","tha","thi","bhai","acha","theek","mat","kuch","kyun","kab","yahaan","wahan","abhi","liye","wala","hota","hoti"];
  const words = text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  const wordCount = words.length;
  const countHits = (list: string[]) => words.filter((w) => list.includes(w)).length;
  const englishHits = countHits(ENGLISH_MARKERS);
  const tGLISH = countHits(TGLISH_MARKERS);
  const hindiHits = countHits(HINDI_ROMANIZED);

  const langParts: string[] = [];
  const scriptNames = scripts.map((s) => s.script).join(" + ");
  if (!total || !wordCount) {
    return {
      scripts,
      primaryScript,
      mixed,
      languages: [],
      description: !total ? "No transcript text — language not detected." : "Transcript has no alphabetic words — language not detected.",
    };
  }
  if (mixed) {
    const names = scripts.filter((s) => s.chars / Math.max(1, total) > 0.12).map((s) => s.script);
    if (names.includes("Tamil") && names.includes("Latin")) {
      langParts.push("Tamil", "English/Latin-script mix (Tanglish or code-switching likely)");
    } else {
      langParts.push(...names.map((n) => `${SCRIPT_LANGUAGE[n] ?? n} (${n} script)`));
    }
  } else if (primaryScript === "Latin") {
    // Romanized-language scoring on the actual words.
    if (tGLISH >= 2 && tGLISH >= hindiHits) langParts.push("Tanglish likely — Tamil content romanized in Latin script, with English mixed in");
    else if (hindiHits >= 3 && hindiHits > englishHits) langParts.push("Hindi (romanized, Latin script)");
    else if (englishHits >= 3) langParts.push("English (Latin script)");
    else langParts.push("Latin script — language not certain (English or a romanized Indian language are possible)");
  } else if (SCRIPT_LANGUAGE[primaryScript]) {
    langParts.push(`${SCRIPT_LANGUAGE[primaryScript]} (${primaryScript} script)`);
  } else {
    langParts.push(`${primaryScript} script`);
  }

  let description: string;
  if (mixed) {
    description = `Mixed-script recording (${scriptNames}): ${langParts.join("; ")}. The original spoken language is preserved as transcribed — nothing is translated before analysis; classification must not drop either language.`;
  } else {
    description = `${langParts[0]} — detected from ${wordCount} transcript word(s), ${total} ${primaryScript}-script characters. Original language preserved; no translation applied.`;
  }
  return { scripts, primaryScript, mixed, languages: langParts, description };
}

const SCRIPT_LANGUAGE: Record<string, string> = {
  Tamil: "Tamil",
  Devanagari: "Hindi (or another Devanagari-script language)",
  Telugu: "Telugu",
  Kannada: "Kannada",
  Malayalam: "Malayalam",
  Arabic: "Arabic",
  CJK: "CJK (Chinese/Japanese)",
};

/** Sentence-terminal punctuation. A trailing ellipsis ("…", "...", ". . .")
 *  is NOT terminal — it marks a trailing-off thought that usually continues
 *  ("The reason this happened... was because the system failed."). */
function isTerminalSentence(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/(\u2026|\.\.\.|\. \. \.)$/.test(t)) return false; // ellipsis = continuation
  return /[.!?।؟。ஃ]$/.test(t);
}

/** Split a chunk of transcript text into sentence-ish units. Long pieces
 *  without terminal punctuation (unpunctuated ASR chunks) are additionally
 *  split at comma/lowercase-clause boundaries so timing and continuity
 *  evidence work at clause granularity instead of 35-second run-ons. */
function splitSentences(text: string): string[] {
  const sentences = text
    .split(/(?<=[.!?।؟。…]|[\u0B94\u0B83])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const s of sentences) {
    if (s.length <= 120) {
      out.push(s);
      continue;
    }
    // Clause boundaries: a comma followed by a lowercase word (case-sensitive
    // — "…, was because" continues; "…, We restarted" starts a new sentence).
    const pieces = s.split(/(?<=[,;])\s+(?=[a-zà-öø-ÿ])/).map((p) => p.trim()).filter(Boolean);
    let acc = "";
    for (const p of pieces) {
      if (acc && (acc.length + p.length + 1 > 160 || p.length > 160)) {
        out.push(acc);
        acc = p;
      } else {
        acc = acc ? `${acc} ${p}` : p;
      }
    }
    if (acc) out.push(acc);
  }
  return out;
}

export interface AlignedWord {
  text: string;
  start: number;
  end: number;
}

export interface AlignedSegment {
  id: string;
  start: number;
  end: number;
  text: string;
  /** Word-level timestamps, ESTIMATED by allocating words across the
   *  measured speech energy of the segment (the provider returns no word
   *  timings). Words never land inside detected silence. */
  words: AlignedWord[];
  /** ≥60% of the segment's span overlaps measured speech energy. */
  energyValidated: boolean;
  /** True when this sentence was stitched from two chunk-boundary fragments. */
  boundaryJoined: boolean;
}

export interface AlignmentStats {
  chunkCount: number;
  chunksWithText: number;
  /** Chunks the provider returned empty — silence or nothing recognized. */
  chunksSilent: number;
  sentenceCount: number;
  /** Cross-chunk sentence fragments stitched back together. */
  boundaryJoins: number;
  energyValidated: number;
  /** Segments anchored at the chunk window because no speech energy was
   *  measured there (honest fallback, flagged as not validated). */
  anchored: number;
}

/** Maps speech-time to wall-time so estimated words skip detected silence. */
class SpeechTimeline {
  private spans: { t0: number; t1: number; acc: number }[] = [];
  private total = 0;
  constructor(spans: { start: number; end: number }[]) {
    let acc = 0;
    for (const s of spans) {
      if (s.end - s.start <= 0) continue;
      this.spans.push({ t0: s.start, t1: s.end, acc });
      acc += s.end - s.start;
    }
    this.total = acc;
  }
  get duration(): number {
    return this.total;
  }
  /** speech-time → wall-time (clamped). */
  at(st: number): number {
    if (!this.spans.length || this.total <= 0) return 0;
    const clamped = Math.min(Math.max(0, st), this.total);
    for (let i = this.spans.length - 1; i >= 0; i--) {
      const s = this.spans[i];
      if (st >= s.acc) return s.t0 + Math.min(st - s.acc, s.t1 - s.t0);
    }
    return this.spans[0].t0;
  }
  /** Wall-time end of the measured span containing speech-time st — a word
   *  must never spill past its own span into a pause. */
  spanEndAt(st: number): number {
    if (!this.spans.length) return 0;
    const clamped = Math.min(Math.max(0, st), this.total);
    for (let i = this.spans.length - 1; i >= 0; i--) {
      const s = this.spans[i];
      if (clamped >= s.acc) return s.t1;
    }
    return this.spans[0].t1;
  }
}

/**
 * Align chunk texts to measured speech spans:
 * 1. per-chunk sentences,
 * 2. cross-chunk boundary joins (a fragment without terminal punctuation at
 *    the end of one chunk continues at the start of the next — one sentence,
 *    never two, so chunk boundaries no longer corrupt sentence structure),
 * 3. sentence timing estimated across the joined window's speech energy,
 * 4. word timestamps allocated along the speech timeline (skipping silence),
 * 5. per-segment energy validation stats.
 */
export function alignTranscript(
  chunkTexts: { start: number; end: number; text: string }[],
  speechSpans: SpeechSpan[],
  durationSec: number
): { segments: AlignedSegment[]; stats: AlignmentStats } {
  const stats: AlignmentStats = {
    chunkCount: chunkTexts.length,
    chunksWithText: 0,
    chunksSilent: 0,
    sentenceCount: 0,
    boundaryJoins: 0,
    energyValidated: 0,
    anchored: 0,
  };

  type Unit = { text: string; w0: number; w1: number; joined: boolean; lastOfChunk: boolean; chunkIdx: number };
  const units: Unit[] = [];
  chunkTexts.forEach((chunk, idx) => {
    if (!chunk.text.trim()) {
      stats.chunksSilent++;
      return;
    }
    stats.chunksWithText++;
    const sentences = splitSentences(chunk.text);
    if (!sentences.length) {
      stats.chunksSilent++;
      return;
    }
    sentences.forEach((text, sIdx) => {
      units.push({
        text,
        w0: chunk.start,
        w1: chunk.end,
        joined: false,
        lastOfChunk: sIdx === sentences.length - 1,
        chunkIdx: idx,
      });
    });
  });

  // Boundary joins: only when the transcript uses punctuation at all (without
  // punctuation every chunk is one fragment and joining would fuse the whole
  // transcript), and chains are capped at 2 chunks.
  const punctuationKnown = chunkTexts.some((c) => /[.!?।؟。…]/.test(c.text));
  const merged: Unit[] = [];
  for (const u of units) {
    const prev = merged[merged.length - 1];
    if (
      punctuationKnown &&
      prev &&
      prev.lastOfChunk &&
      prev.chunkIdx < u.chunkIdx &&
      u.chunkIdx - prev.chunkIdx <= 2 &&
      !isTerminalSentence(prev.text)
    ) {
      prev.text = `${prev.text} ${u.text}`;
      prev.w1 = u.w1;
      prev.lastOfChunk = u.lastOfChunk;
      prev.joined = true;
      stats.boundaryJoins++;
    } else {
      merged.push({ ...u });
    }
  }

  const segments: AlignedSegment[] = [];
  let segId = 0;
  // Sequential span consumption: transcript text is chronological, so
  // sentences consume measured speech spans in order, weighted by character
  // count. Units can never double-allocate the same span, and a
  // boundary-joined sentence naturally takes the spans on both sides of the
  // chunk boundary.
  const sortedSpans = [...speechSpans].sort((a, b) => a.start - b.start).map((s) => ({ ...s }));
  const totalSpeechAll = sortedSpans.reduce((a, s) => a + (s.end - s.start), 0);
  const totalCharsAll = merged.reduce((a, u) => a + u.text.length + 1, 0);
  const charsPerSpeechSec = totalCharsAll / Math.max(0.2, totalSpeechAll);
  let spanIdx = 0;
  let consumed = 0; // seconds already taken from sortedSpans[spanIdx]
  for (const unit of merged) {
    const w0 = Math.max(0, unit.w0);
    const w1 = Math.min(durationSec, unit.w1);
    let need = totalSpeechAll > 0 ? (unit.text.length + 1) / charsPerSpeechSec : 0;
    const unitSpans: { start: number; end: number }[] = [];
    while (need > 0.02 && spanIdx < sortedSpans.length) {
      const span = sortedSpans[spanIdx];
      const available = span.end - span.start - consumed;
      if (available <= 0.02) {
        spanIdx++;
        consumed = 0;
        continue;
      }
      const take = Math.min(available, need);
      unitSpans.push({ start: span.start + consumed, end: span.start + consumed + take });
      consumed += take;
      need -= take;
      if (span.end - span.start - consumed <= 0.02) {
        spanIdx++;
        consumed = 0;
      }
    }
    const unitSpeech = unitSpans.reduce((a, s) => a + (s.end - s.start), 0);

    if (!unitSpeech) {
      // No measured speech left for this unit — anchor honestly at its chunk
      // window start with a duration estimate (~14 spoken chars/sec).
      const est = Math.max(0.4, Math.min(Math.max(0.1, w1 - w0), unit.text.length / 14));
      const start = Math.min(w0, Math.max(0, durationSec - est));
      const end = Math.min(durationSec, start + est);
      segments.push({
        id: `seg-${++segId}`,
        start: round3(start),
        end: round3(end),
        text: unit.text.slice(0, 600),
        words: estimateWords(unit.text, start, end, null),
        energyValidated: false,
        boundaryJoined: unit.joined,
      });
      stats.anchored++;
      continue;
    }

    const start = unitSpans[0].start;
    const end = unitSpans[unitSpans.length - 1].end;
    // Energy validation: words must map onto measured speech at a physically
    // plausible speaking rate. Too fast (>40 chars/s) means text crammed
    // into unrelated energy; too slow (<4.5 chars/s) means transcript and
    // audio disagree (e.g. large untranscribed regions) and the estimated
    // timing is flagged as not validated.
    const rate = unit.text.length / Math.max(0.2, unitSpeech);
    const energyValidated = rate <= 40 && rate >= 4.5;
    if (energyValidated) stats.energyValidated++;
    segments.push({
      id: `seg-${++segId}`,
      start: round3(start),
      end: round3(end),
      text: unit.text.slice(0, 600),
      words: estimateWords(unit.text, start, end, unitSpans),
      energyValidated,
      boundaryJoined: unit.joined,
    });
  }
  stats.sentenceCount = segments.length;
  return { segments, stats };
}

/** Word timestamps by allocating words along the speech timeline
 *  proportionally to word length (min 40ms each, monotonic). A word is
 *  capped at a physically plausible duration AND clamped to the measured
 *  span containing its start, so an estimated word can never stretch
 *  across a real pause and fake "words inside the cut" evidence. */
function estimateWords(text: string, segStart: number, segEnd: number, spans: { start: number; end: number }[] | null): AlignedWord[] {
  const words = text.split(/\s+/).filter(Boolean).slice(0, 400);
  if (!words.length) return [];
  const timeline = new SpeechTimeline(spans ?? [{ start: segStart, end: segEnd }]);
  const speechDur = timeline.duration || segEnd - segStart;
  if (speechDur <= 0) return [];
  const totalChars = words.reduce((a, w) => a + w.length + 1, 0);
  const out: AlignedWord[] = [];
  let speechCursor = 0;
  for (const w of words) {
    const frac = (w.length + 1) / totalChars;
    const st = speechCursor;
    const en = Math.min(speechDur, speechCursor + frac * speechDur);
    speechCursor = en;
    const start = timeline.at(st);
    // Plausible spoken duration for this word; never past its own span.
    const maxDur = Math.min(1.6, 0.1 * w.length + 0.28);
    const end = Math.min(start + maxDur, timeline.spanEndAt(st), segEnd);
    out.push({ text: w, start: round3(Math.min(start, segEnd)), end: round3(Math.max(start + 0.04, Math.min(Math.max(end, start + 0.04), segEnd))) });
  }
  return out;
}

/** Token-level Jaccard similarity for repeated-take detection. */
function tokenSimilarity(a: string, b: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).filter(Boolean);
  const sa = new Set(norm(a));
  const sb = new Set(norm(b));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** Exported for the Phase-F benchmark and tests — the retake detector is part
 *  of the deterministic evidence layer and must be observable, not assumed. */
export function findRepeatedTake(prevText: string, nextText: string): boolean {
  if (!prevText || !nextText) return false;
  // Require substantial, comparable, HIGHLY similar statements — long
  // run-on segments of repetitive lecture prose must not flood every pause
  // with a repeated-take flag.
  if (prevText.length < 40 || nextText.length < 40) return false;
  const ratio = Math.min(prevText.length, nextText.length) / Math.max(prevText.length, nextText.length);
  if (ratio < 0.5) return false;
  return tokenSimilarity(prevText, nextText) >= 0.7;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** A next-sentence opening that continues the previous thought — the
 *  "The reason this happened… …was because the system failed." pattern.
 *  Case-SENSITIVE: a capitalized "We fixed it later." is a new sentence;
 *  only a lowercase continuation cue counts. */
function isContinuationStart(nextText: string): boolean {
  const t = nextText.trim();
  if (!t) return false;
  const first = t[0];
  // Lowercase Latin start strongly implies a mid-sentence continuation.
  if (/[a-zà-öø-ÿ]/.test(first)) return true;
  return /^(because|and|but|so|which|that|was|were|is|are|to|then|just|since|as|for|with|without|after|before|when|while|if)\b/.test(t);
}

/**
 * Build evidence-based cut candidates from silence gaps + transcript +
 * continuity rules. Removal amount scales with the actual pause (pause −
 * target), never a fixed quota. Ambiguous cases go to REVIEW.
 */
export function buildCandidates(
  env: { values: Float32Array; windowSec: number },
  speechSpans: SpeechSpan[],
  transcript: TranscriptAnalysis,
  settings: CutPlanSettings,
  durationSec: number,
  floorReliable: boolean,
  noiseFloor: number,
  notes: string[]
): EvidenceCandidate[] {
  const candidates: EvidenceCandidate[] = [];
  const segments = transcript.segments;
  // Sentence boundaries are only "known" when the transcript actually uses
  // sentence punctuation. Without it, continuation cannot be judged and long
  // pauses must not be auto-removed.
  const punctuationKnown = transcript.available && /[.!?।؟。…]/.test(transcript.text);
  const speechRms = speechSpans.map((s) => s.rms).sort((a, b) => a - b);
  const medianSpeechRms = speechRms.length ? speechRms[Math.floor(speechRms.length / 2)] : 0;

  // Gaps between consecutive speech spans (plus head/tail of the recording).
  const gaps: { start: number; end: number; rms: number }[] = [];
  const gapSum = (a: number, b: number) => {
    let sum = 0;
    let n = 0;
    const f0 = Math.max(0, Math.floor(a / env.windowSec));
    const f1 = Math.min(env.values.length, Math.ceil(b / env.windowSec));
    for (let i = f0; i < f1; i++) {
      sum += env.values[i];
      n++;
    }
    return n ? sum / n : 0;
  };
  if (speechSpans.length === 0) {
    if (floorReliable && durationSec > settings.minSilenceSec) {
      gaps.push({ start: 0, end: durationSec, rms: percentile(env.values, 0.5) });
    }
  } else {
    if (speechSpans[0].start > settings.minSilenceSec + 0.05) {
      gaps.push({ start: 0, end: speechSpans[0].start, rms: gapSum(0, speechSpans[0].start) });
    }
    for (let i = 1; i < speechSpans.length; i++) {
      const a = speechSpans[i - 1];
      const b = speechSpans[i];
      if (b.start - a.end >= settings.minSilenceSec) {
        gaps.push({ start: a.end, end: b.start, rms: gapSum(a.end, b.start) });
      }
    }
    const last = speechSpans[speechSpans.length - 1];
    if (durationSec - last.end >= settings.minSilenceSec + 0.05) {
      gaps.push({ start: last.end, end: durationSec, rms: gapSum(last.end, durationSec) });
    }
  }

  let id = 0;
  for (const gap of gaps) {
    const pauseSec = gap.end - gap.start;
    // Head/tail padding KEEPS material around speech; the removable window
    // never cuts into the padded zone.
    const start = Math.max(0, gap.start + settings.headPaddingSec);
    const end = Math.min(durationSec, gap.end - settings.tailPaddingSec);
    const removable = end - start;
    if (removable < 0.03) continue;

    // With tightening on, the removal shrinks to leave ~target pause. The
    // removed amount always equals (pause − target) — it scales with the
    // actual pause. With tightening off, the full padded span is proposed.
    // A pause whose removable part is under 0.25s is already ≈ the target
    // after padding — tightening it saves nothing perceptible and would only
    // fragment the candidate list, so it is skipped honestly.
    const keepForTarget = Math.max(0, settings.targetPauseSec - (settings.headPaddingSec + settings.tailPaddingSec));
    const cutLen = settings.tightenSentencePauses ? Math.max(0.03, removable - keepForTarget) : removable;
    if (cutLen < 0.03 || (settings.tightenSentencePauses && removable < 0.25)) continue;
    const cutStart = settings.tightenSentencePauses ? start + (removable - cutLen) / 2 : start;
    const cutEnd = cutStart + cutLen;

    // Transcript evidence: WORD timestamps inside the removable window
    // (word-level, so a segment that merely spills into the window with its
    // estimated tail does not count its whole sentence as "words in range").
    const wordCount = segments.reduce(
      (a, s) => a + s.words.filter((w) => w.start < cutEnd && w.end > cutStart).length,
      0
    );
    // Fallback when no word timings exist (anchored segments): segment overlap.
    const segmentOverlapFallback =
      !segments.some((s) => s.words.length) &&
      segments.filter((s) => s.start < cutEnd && s.end > cutStart).length > 0;

    // Continuity: neighbours are matched with a generous tolerance because
    // segment timing is estimated — a segment ending within ±1.5s of the gap
    // counts as the pause's previous sentence.
    const prevSeg = segments
      .filter((s) => s.start < gap.start && s.end > gap.start - 1.5)
      .sort((a, b) => b.end - a.end)[0];
    const nextSeg = segments
      .filter((s) => s.end > gap.end && s.start < gap.end + 1.5)
      .sort((a, b) => a.start - b.start)[0];
    // A single segment spanning the whole gap IS the sentence containing the
    // pause — the strongest continuity signal (e.g. "The reason this
    // happened… …was because the system failed." transcribed as one segment).
    // Otherwise fall back to terminal-punctuation and continuation cues.
    const intraSentence = Boolean(
      prevSeg &&
        nextSeg &&
        (prevSeg === nextSeg || !isTerminalSentence(prevSeg.text) || isContinuationStart(nextSeg.text))
    );

    // Quiet-speech guard: adjacent speech much quieter than the norm.
    const adjacentRms = Math.min(
      speechSpans.find((s) => s.end === gap.start)?.rms ?? Infinity,
      speechSpans.find((s) => s.start === gap.end)?.rms ?? Infinity
    );
    const quietSpeechNearby = Number.isFinite(adjacentRms) && medianSpeechRms > 0 && adjacentRms < medianSpeechRms * 0.35;

    // Repeated take: adjacent segments near-duplicates.
    // Repeated take: DISTINCT adjacent segments that near-duplicate each
    // other (one segment spanning the gap is continuity, not repetition).
    const repeatedTake = Boolean(prevSeg && nextSeg && prevSeg !== nextSeg && findRepeatedTake(prevSeg.text, nextSeg.text));

    const evidence = {
      pauseSec: round3(pauseSec),
      rms: round3(gap.rms),
      snr: gap.rms > 1e-9 ? Math.min(96, round3(20 * Math.log10(gap.rms / Math.max(1e-9, noiseFloor)))) : 0,
      transcriptWordsInRange: segmentOverlapFallback ? 1 : wordCount,
      intraSentence,
      quietSpeechNearby,
      repeatedTake,
      floorReliable,
    };

    // Classification (deterministic, conservative).
    let review: EvidenceCandidate["review"];
    let confidence: number;
    let reason: string;
    if (!floorReliable) {
      review = "REVIEW";
      confidence = 0.2;
      reason = `Pause ${pauseSec.toFixed(2)}s, but the recording's level profile is nearly constant — the adaptive noise floor cannot separate silence from content reliably.`;
    } else if (wordCount > 0 || segmentOverlapFallback) {
      review = "REVIEW";
      confidence = 0.25;
      reason = `${wordCount || "Transcript content"} transcribed word(s) inside the proposed range — speech may be present despite low energy (quiet speech is preserved).`;
    } else if (repeatedTake) {
      review = "REVIEW";
      confidence = 0.4;
      reason = `Pause ${pauseSec.toFixed(2)}s between segments that look like a repeated take ("${(prevSeg?.text ?? "").slice(0, 60)}"). The duplicate statement may be intentional emphasis — confirm before removing.`;
    } else if (intraSentence && pauseSec <= 3) {
      review = "KEEP";
      confidence = 0.75;
      reason = `Pause ${pauseSec.toFixed(2)}s inside an ongoing sentence${
        prevSeg && !isTerminalSentence(prevSeg.text) ? " (the previous fragment does not end a sentence" : " (the next sentence continues the previous thought"
      } — e.g. \u201C${(prevSeg?.text ?? "").slice(-45)} … ${(nextSeg?.text ?? "").slice(0, 45)}\u201D). Cutting it would break sentence continuity.`;
    } else if (intraSentence) {
      review = "REVIEW";
      confidence = 0.45;
      reason = `Pause ${pauseSec.toFixed(2)}s inside an ongoing sentence — possibly a dramatic pause. It is never removed automatically; confirm after listening.`;
    } else if (quietSpeechNearby && pauseSec < 2.5) {
      review = "KEEP";
      confidence = 0.6;
      reason = `Adjacent speech is much quieter than the recording norm — short pauses around quiet speech are kept to preserve natural rhythm.`;
    } else if (!punctuationKnown && pauseSec <= 8) {
      review = "REVIEW";
      confidence = 0.35;
      reason = `Pause ${pauseSec.toFixed(2)}s with no sentence punctuation anywhere in the transcript — sentence boundaries are unknown, so this pause cannot be classified as inter-sentence silence without review.`;
    } else {
      review = "REMOVE";
      // Confidence grows with pause length and clean evidence.
      confidence = Math.min(0.95, 0.55 + pauseSec * 0.08 + (settings.tightenSentencePauses ? 0 : 0.05));
      reason = `Inter-sentence silence ${pauseSec.toFixed(2)}s (RMS ${(gap.rms * 100).toFixed(1)}%, SNR ${evidence.snr.toFixed(1)} dB, no transcript words). Remove ${cutLen.toFixed(2)}s keeping ${settings.headPaddingSec.toFixed(2)}s head / ${settings.tailPaddingSec.toFixed(2)}s tail padding${settings.tightenSentencePauses ? `, remaining pause ≈ ${settings.targetPauseSec.toFixed(2)}s` : ""}.`;
    }
    if (!floorReliable && wordCount === 0 && !transcript.available) {
      notes.push("Silence analysis is unreliable for this input; every proposal is REVIEW until a reliable analysis or transcript is available.");
    }

    candidates.push({
      id: `sil-${++id}`,
      start: round3(cutStart),
      end: round3(cutEnd),
      duration: round3(cutEnd - cutStart),
      reason,
      review,
      confidence,
      classificationSource: "DETERMINISTIC",
      evidence,
      prevSentence: prevSeg?.text.slice(-120) ?? null,
      nextSentence: nextSeg?.text.slice(0, 120) ?? null,
    });
  }

  // Repeated-take surfacing: propose the LATER duplicate statement as REVIEW
  // (never REMOVE — removing speech needs explicit human approval).
  if (segments.length >= 2) {
    for (let i = 1; i < segments.length; i++) {
      const prev = segments[i - 1];
      const cur = segments[i];
      if (findRepeatedTake(prev.text, cur.text)) {
        const alreadyCovered = candidates.some((c) => c.start < cur.end && c.end > cur.start);
        if (!alreadyCovered) {
          candidates.push({
            id: `rep-${i}`,
            start: round3(cur.start),
            end: round3(cur.end),
            duration: round3(cur.end - cur.start),
            reason: `Possible repeated take: this statement is highly similar to the previous one ("${prev.text.slice(0, 70)}"). Human decision required — removing speech is never automatic.`,
            review: "REVIEW",
            confidence: 0.5,
            classificationSource: "DETERMINISTIC",
            evidence: {
              pauseSec: 0,
              rms: round3(speechSpans.find((s) => s.start <= cur.start && s.end >= cur.end)?.rms ?? 0),
              snr: 0,
              transcriptWordsInRange: cur.text.split(/\s+/).length,
              intraSentence: false,
              quietSpeechNearby: false,
              repeatedTake: true,
              floorReliable,
            },
            prevSentence: prev.text.slice(-120),
            nextSentence: null,
          });
        }
      }
    }
  }

  // Merge overlapping/adjacent intervals of the SAME review status so one
  // event never yields duplicate or fragmented markers. Two candidates are
  // NEVER bridged across measured speech — the merge gap must be real silence.
  const merged: EvidenceCandidate[] = [];
  for (const c of candidates.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = merged[merged.length - 1];
    const bridgeHasSpeech =
      last &&
      last.review === c.review &&
      c.start <= last.end + 0.25 &&
      speechSpans.some((s) => s.start < c.start && s.end > last.end);
    if (last && last.review === c.review && c.start <= last.end + 0.25 && !bridgeHasSpeech) {
      last.end = Math.max(last.end, c.end);
      last.duration = round3(last.end - last.start);
      last.evidence.pauseSec = round3(last.evidence.pauseSec + c.evidence.pauseSec);
      last.evidence.transcriptWordsInRange += c.evidence.transcriptWordsInRange;
      last.evidence.repeatedTake = last.evidence.repeatedTake || c.evidence.repeatedTake;
      last.reason = c.reason.length > last.reason.length ? c.reason : last.reason;
    } else {
      merged.push({ ...c });
    }
  }
  return merged;
}

/** Deterministic candidate validation (pipeline stage 11): bounds, positive
 *  duration, overlap/duplicate elimination. Returns the cleaned list and a
 *  count of the fixes applied — never silently invents or drops silently. */
export function validateCandidates(candidates: EvidenceCandidate[], durationSec: number): { valid: EvidenceCandidate[]; fixes: string[] } {
  const fixes: string[] = [];
  const cleaned = candidates
    .map((c) => {
      const start = Math.max(0, Math.min(durationSec, c.start));
      const end = Math.max(start + 0.02, Math.min(durationSec, c.end));
      if (start !== c.start || end !== c.end || c.end - c.start !== end - start) {
        fixes.push(`candidate ${c.id} clamped to media bounds`);
      }
      return { ...c, start: round3(start), end: round3(end), duration: round3(end - start) };
    })
    .filter((c) => c.duration >= 0.02);
  // Merge candidates of the same status that actually OVERLAP (the shared
  // region means no speech can sit between them, so the merge is safe).
  // Merely adjacent candidates stay separate — merging those could bridge
  // retained speech between two pauses.
  const sorted = cleaned.sort((a, b) => a.start - b.start || a.end - b.end);
  const out: EvidenceCandidate[] = [];
  for (const c of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.review === c.review && c.start < prev.end - 1e-6) {
      prev.end = Math.max(prev.end, c.end);
      prev.duration = round3(prev.end - prev.start);
      prev.evidence.pauseSec = round3(prev.evidence.pauseSec + c.evidence.pauseSec);
      prev.evidence.transcriptWordsInRange += c.evidence.transcriptWordsInRange;
      prev.evidence.repeatedTake = prev.evidence.repeatedTake || c.evidence.repeatedTake;
      fixes.push(`candidate ${c.id} merged into overlapping ${prev.id}`);
      continue;
    }
    out.push(c);
  }
  return { valid: out, fixes };
}

/** Downsampled min/max peaks for waveform drawing (kept modest for JSON). */
function computePeaksServer(pcm: Int16Array, buckets: number): { min: number[]; max: number[] } {
  const per = Math.max(1, Math.floor(pcm.length / buckets));
  const min: number[] = new Array(buckets);
  const max: number[] = new Array(buckets);
  for (let b = 0; b < buckets; b++) {
    let mn = 1;
    let mx = -1;
    const start = b * per;
    const end = Math.min(start + per, pcm.length);
    for (let i = start; i < end; i++) {
      const v = pcm[i] / 32768;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    min[b] = mn === 1 ? 0 : Math.round(mn * 1000) / 1000;
    max[b] = mx === -1 ? 0 : Math.round(mx * 1000) / 1000;
  }
  return { min, max };
}

/**
 * Waveform peaks for the editor timeline, computed from the REAL decoded
 * audio (same 16 kHz mono decode the analysis pipeline uses) and cached on
 * disk per media id — the timeline never re-decodes for rendering and never
 * draws invented data. Bucket count scales with duration (~200 points/s,
 * capped) so a 20-minute recording stays zoomable without a huge payload.
 */
export async function computeMediaWaveform(
  storagePath: string
): Promise<{ durationSec: number; sampleRate: number; min: number[]; max: number[]; pointsPerSecond: number }> {
  const { pcm, sampleRate } = await decodePcm(storagePath);
  const durationSec = pcm.length / sampleRate;
  if (durationSec <= 0) throw new Error("Decoded audio is empty — the file has no decodable audio stream.");
  const buckets = Math.min(120_000, Math.max(4_000, Math.floor(durationSec * 200)));
  const peaks = computePeaksServer(pcm, buckets);
  return { durationSec: Math.round(durationSec * 1000) / 1000, sampleRate, ...peaks, pointsPerSecond: Math.round(buckets / durationSec) };
}

/**
 * Context-aware candidates from the user's words-to-remove list.
 *
 * A user-defined word is a REMOVAL PREFERENCE, not proof that every
 * occurrence is unnecessary. Each occurrence of each phrase inside the
 * validated transcript (case-insensitive, punctuation-insensitive, any
 * script) becomes ONE candidate covering only the matched words — never the
 * whole sentence. Context inspection:
 *  - occurrence surrounded by measured silence on both sides (a standalone
 *    filler utterance) → REMOVE-leaning candidate (still requires explicit
 *    user approval to affect any output);
 *  - occurrence inside a running sentence → REVIEW (deterministic evidence
 *    cannot tell a meaningful use from a filler; the semantic stage gets the
 *    neighbouring sentences and may KEEP it);
 *  - a phrase immediately repeated (emphasis, e.g. "very very") → REVIEW.
 * Word timings are ESTIMATED allocations along measured speech energy — the
 * candidate reason says so, and wordMatch.estimatedTiming is always true.
 * Ranges overlapping an existing silence candidate are skipped (the silence
 * candidate already covers that region with stronger audio evidence).
 */
/** A phrase to match in the transcript. User-list phrases keep the existing
 *  context-aware classification; `builtin` phrases (the multilingual filler
 *  lexicon) are REVIEW-only by construction — they may flag, never REMOVE. */
export interface WordMatchPhrase {
  phrase: string;
  builtin?: boolean;
}

export function buildWordCandidates(
  transcript: TranscriptAnalysis,
  speechSpans: SpeechSpan[],
  phrases: (string | WordMatchPhrase)[],
  settings: CutPlanSettings,
  durationSec: number,
  noiseFloor: number,
  floorReliable: boolean,
  existingCandidates: EvidenceCandidate[],
  notes: string[]
): EvidenceCandidate[] {
  const normalized = phrases.map((p) => (typeof p === "string" ? { phrase: p } : p));
  const cleanPhrases = [...new Set(normalized.map((p) => p.phrase.trim()).filter((p) => p.length > 0))].slice(0, 100);
  const builtinSet = new Set(normalized.filter((p) => p.builtin).map((p) => p.phrase.trim().toLowerCase()));
  if (!cleanPhrases.length || !transcript.available || !transcript.segments.length) return [];

  const norm = (t: string) =>
    t
      .toLowerCase()
      .replace(/[.,!?;:"'`’“”()\[\]…—–-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const phraseTokens = cleanPhrases.map((p) => ({ phrase: p, builtin: builtinSet.has(p.toLowerCase()), tk: norm(p).split(" ").filter(Boolean) })).filter((p) => p.tk.length > 0);
  if (!phraseTokens.length) return [];

  const out: EvidenceCandidate[] = [];
  let occurrenceIndex = 0;
  for (const seg of transcript.segments) {
    const words = seg.words ?? [];
    if (words.length === 0) continue;
    const wTk = words.map((w) => norm(w.text));
    for (const { phrase, tk, builtin } of phraseTokens) {
      for (let i = 0; i + tk.length <= wTk.length; i++) {
        let match = true;
        for (let k = 0; k < tk.length; k++) {
          if (wTk[i + k] !== tk[k]) {
            match = false;
            break;
          }
        }
        if (!match) continue;
        const first = words[i];
        const last = words[i + tk.length - 1];
        const start = Math.max(0, round3(first.start));
        const end = Math.min(durationSec, round3(Math.max(last.end, first.start + 0.05)));
        if (end <= start) continue;
        occurrenceIndex += 1;

        // Context: measured speech around the occurrence. The unit of
        // continuity is the SPEECH SPAN containing the occurrence, not the raw
        // word edges — a word inside a longer span is part of running speech.
        const containing = speechSpans.find((s) => s.start <= first.start + 0.02 && s.end >= last.end - 0.02);
        const sStart = containing ? containing.start : first.start;
        const sEnd = containing ? containing.end : last.end;
        const prevEdge = [...speechSpans].reverse().find((s) => s.end <= sStart + 0.01);
        const nextEdge = speechSpans.find((s) => s.start >= sEnd - 0.01);
        const gapBefore = prevEdge ? sStart - prevEdge.end : sStart;
        const gapAfter = nextEdge ? nextEdge.start - sEnd : Math.max(0, durationSec - sEnd);
        // Standalone = the surrounding span is essentially the utterance
        // itself (short) and real measured silence sits on both sides.
        const standalone = gapBefore >= settings.targetPauseSec && gapAfter >= settings.targetPauseSec && sEnd - sStart <= end - start + 0.75;
        const immediateRepeat = i + tk.length < wTk.length && wTk.slice(i + tk.length, i + tk.length * 2).join(" ") === tk.join(" ");

        // Built-in lexicon matches are conservative: they may only flag for
        // review, never REMOVE — the user decides with the evidence in view.
        const review: EvidenceCandidate["review"] = builtin ? "REVIEW" : standalone && !immediateRepeat ? "REMOVE" : "REVIEW";
        const confidence = builtin ? 0.5 : standalone ? 0.75 : 0.5;
        const localSpans = speechSpans.filter((s) => s.end > first.start && s.start < last.end);
        const localRms = localSpans.length ? localSpans.reduce((a, s) => a + s.rms, 0) / localSpans.length : 0;
        const snr = floorReliable && localRms > 0 && noiseFloor > 0 ? round3(20 * Math.log10(Math.max(1e-4, localRms) / Math.max(1e-4, noiseFloor))) : 0;
        const reason = builtin
          ? `Matched the built-in multilingual filler lexicon ("${phrase}") — flagged for review only. Context: ${standalone ? "a standalone utterance with measured silence around it" : `inside running speech ("${seg.text.slice(0, 120)}")`}. Confirm or dismiss; nothing is removed automatically.`
          : standalone
          ? `Matched words-to-remove entry "${phrase}" as a standalone utterance: measured silence ≥${settings.targetPauseSec}s on both sides (before ${gapBefore.toFixed(2)}s, after ${gapAfter.toFixed(2)}s). This is an isolated filler, not part of the surrounding sentences.`
          : immediateRepeat
            ? `Matched words-to-remove entry "${phrase}" repeated back-to-back — could be emphasis or a stumble; the surrounding sentence is preserved either way.`
            : `Matched words-to-remove entry "${phrase}" INSIDE a running sentence ("${seg.text.slice(0, 120)}"). The occurrence may be a filler or a meaningful use of the same word — the sentence is never removed because of one match.`;

        out.push({
          id: `word-${occurrenceIndex}`,
          start,
          end,
          duration: round3(end - start),
          reason: `${reason} Word timing is estimated from measured speech energy (the transcription provider returns no timestamps).`,
          review,
          confidence,
          classificationSource: "DETERMINISTIC",
          evidence: {
            pauseSec: round3(Math.min(gapBefore, gapAfter)),
            rms: round3(0),
            snr,
            transcriptWordsInRange: tk.length,
            intraSentence: !standalone,
            quietSpeechNearby: false,
            repeatedTake: false,
            floorReliable,
          },
          builtinLexicon: builtin || undefined,
          wordMatch: {
            phrase,
            segmentId: seg.id,
            segmentText: seg.text,
            matchedWords: words.slice(i, i + tk.length).map((w) => w.text),
            estimatedTiming: true,
          },
        });
      }
    }
  }

  // Skip word candidates that overlap an existing silence candidate — the
  // silence candidate already covers that region with stronger evidence.
  const overlappingExisting = out.filter((w) =>
    existingCandidates.some((c) => c.start < w.end + 0.05 && c.end > w.start - 0.05)
  );
  if (overlappingExisting.length) {
    notes.push(`${overlappingExisting.length} words-to-remove match(es) overlap silence candidates and are covered by those (listed once, not duplicated).`);
  }
  const filtered = out.filter((w) => !existingCandidates.some((c) => c.start < w.end + 0.05 && c.end > w.start - 0.05));
  if (out.length) {
    notes.push(`Words-to-remove: ${out.length} occurrence match(es) found in the transcript (${cleanPhrases.length} phrase(s) configured); each is an independent candidate pending review — nothing is removed automatically.`);
  }
  return filtered;
}

/**
 * Full unified pipeline (stages 2–8 + 12): decode → envelope → floor
 * reliability → VAD → ASR on the SAME decoded PCM (exact 25s windows, no
 * seek drift) → language detection → boundary-joined alignment with word
 * timestamps → evidence candidates → deterministic validation → canonical
 * cut plan. The route adds stage 9 (semantic inference) on top.
 * Video without any audio stream is handled honestly: no decode, no fake
 * speech analysis, empty plan — the timeline still works.
 */
export async function analyzeMediaForAutocut(input: ServerAnalysisInput): Promise<ServerAnalysisResult> {
  const notes: string[] = [];
  const windowMs = Math.min(50, Math.max(5, Math.round(input.windowMs ?? 10)));

  if (input.hasAudioStream === false) {
    const durationSec = Math.max(0, input.fallbackDurationSec ?? 0);
    notes.push("This media has no audio stream — speech analysis, transcription and cut candidates do not apply. The timeline and (for video) video-only cutting still work; nothing was invented.");
    return {
      sampleRate: 0,
      durationSec,
      noiseFloor: 0,
      peak: 0,
      floorReliable: false,
      speechSpans: [],
      windowMs,
      candidates: [],
      transcript: {
        available: false,
        text: "",
        segments: [],
        chunkCount: 0,
        failedChunks: [],
        warnings: ["No audio stream in this media — transcription skipped."],
        language: detectLanguage(""),
        alignmentStats: null,
      },
      peaks: { min: [0], max: [0] },
      notes,
      stages: {
        mediaInspection: "DONE",
        audioExtraction: "UNAVAILABLE",
        audioDecoding: "UNAVAILABLE",
        waveformFeatures: "UNAVAILABLE",
        vad: "UNAVAILABLE",
        speechSegmentation: "UNAVAILABLE",
        transcription: "UNAVAILABLE",
        wordAlignment: "UNAVAILABLE",
        languageId: "UNAVAILABLE",
        fillerDetection: "UNAVAILABLE",
        repetitionDetection: "UNAVAILABLE",
        pauseClassification: "UNAVAILABLE",
        contentClassification: "UNAVAILABLE",
        candidatesValidated: "DONE",
        readyForReview: "DONE",
      },
      plan: { removals: [], removedSec: 0, finalDurationSec: round3(durationSec) },
    };
  }

  const emit = (stage: RiisheStageKey, status: PipelineStageState, detail?: string, progressPct?: number) =>
    input.onProgress?.({ stage, status, detail, progressPct });

  emit("mediaInspection", "DONE", undefined, 4);
  emit("audioDecoding", "RUNNING", undefined, 6);
  let pcm: Int16Array;
  let sampleRate: number;
  try {
    const decoded = await decodePcm(input.storagePath);
    pcm = decoded.pcm;
    sampleRate = decoded.sampleRate;
  } catch (err) {
    emit("audioDecoding", "FAILED", err instanceof Error ? err.message : "decode failed");
    throw err;
  }
  emit("audioDecoding", "DONE", `${sampleRate} Hz mono analysis PCM`, 14);
  const durationSec = pcm.length / sampleRate;
  emit("waveformFeatures", "RUNNING", undefined, 16);
  const env = computeEnvelope(pcm, sampleRate, windowMs);
  emit("waveformFeatures", "DONE", `${env.values.length} × ${windowMs}ms windows`, 24);

  let peak = 0;
  for (let i = 0; i < env.values.length; i++) if (env.values[i] > peak) peak = env.values[i];
  const noiseFloor = percentile(env.values, 0.1);
  // Floor reliability: speech/silence separation needs real dynamic spread.
  // A pure tone or heavily limited mix has peak ≈ floor and would flag the
  // whole recording as silence (the fragmented-marker failure mode).
  // Digital silence (floor exactly 0) is the most reliable case; the failure
  // mode is the opposite — peak ≈ floor (tone, heavy limiting).
  const floorReliable = peak >= 0.02 && peak / Math.max(noiseFloor, 1e-9) >= 2.0;
  if (!floorReliable) {
    notes.push(
      `Level profile nearly constant (peak ${peak.toFixed(3)} vs floor ${noiseFloor.toFixed(3)}) — silence analysis is unreliable and candidates are suppressed or forced to REVIEW.`
    );
  }

  emit("vad", "RUNNING", undefined, 26);
  const speechSpans = floorReliable ? detectSpeechSpans(env, noiseFloor, input.settings.sensitivity) : [];
  emit("vad", floorReliable ? "DONE" : "UNAVAILABLE", `${speechSpans.length} span(s)`, 30);
  emit("speechSegmentation", floorReliable ? "DONE" : "UNAVAILABLE", undefined, 32);

  // Transcription: the SAME decoded PCM is sliced into exact 25s windows, so
  // chunk boundaries and the speech-energy timeline cannot drift apart.
  let transcript: TranscriptAnalysis = {
    available: false,
    text: "",
    segments: [],
    chunkCount: 0,
    failedChunks: [],
    warnings: [],
    language: detectLanguage(""),
    alignmentStats: null,
  };
  let transcriptionFailed: string | null = null;
  try {
    const asr = await transcribePcm(pcm, sampleRate, (done, total) => {
      emit("transcription", "RUNNING", `chunk ${done}/${total}`, 32 + Math.round((done / Math.max(total, 1)) * 38));
    });
    const { segments, stats } = alignTranscript(asr.chunkTexts, speechSpans, durationSec);
    transcript = {
      available: asr.text.trim().length > 0,
      text: asr.text,
      segments,
      chunkCount: asr.chunkCount,
      failedChunks: asr.failedChunks,
      warnings: asr.warnings,
      language: detectLanguage(asr.text),
      alignmentStats: stats,
    };
    if (!transcript.available) {
      notes.push("The ASR provider returned no text for this recording (silence, non-speech content, unsupported language, or recognition failure). Nothing was invented.");
    } else {
      notes.push(
        `Transcript: ${stats.sentenceCount} sentence segment(s) from ${stats.chunksWithText} of ${stats.chunkCount} chunk(s) (${stats.chunksSilent} silent${asr.failedChunks.length ? `, ${asr.failedChunks.length} failed` : ""}); ${stats.boundaryJoins} chunk-boundary sentence(s) stitched; ${stats.energyValidated}/${stats.sentenceCount} energy-validated${stats.anchored ? `, ${stats.anchored} anchored (no measurable speech — flagged)` : ""}. Word timings are estimated along the measured speech energy; the original language is preserved untranslated.`
      );
    }
  } catch (err) {
    transcriptionFailed = err instanceof Error ? err.message : "ASR failed";
    notes.push(`Transcription unavailable: ${transcriptionFailed}. Candidates rely on audio evidence only.`);
  }

  const built = buildCandidates(env, speechSpans, transcript, input.settings, durationSec, floorReliable, noiseFloor, notes);
  const { valid: silenceCandidates, fixes } = validateCandidates(built, durationSec);
  if (fixes.length) notes.push(`Candidate validation adjusted ${fixes.length} range(s): ${fixes.slice(0, 3).join("; ")}${fixes.length > 3 ? "…" : ""}.`);

  // Words-to-remove occurrences (context-aware) — merged with the silence
  // candidates, then validated together.
  // Words to remove: the user's own list keeps the existing context-aware
  // classification. The built-in multilingual filler lexicon (English + Tamil
  // + Tanglish discourse fillers) is REVIEW-only by construction — it may
  // flag, never REMOVE; a silence candidate still overrides an overlap.
  const userPhrases = input.wordsToRemove ?? [];
  const builtinPhrases =
    input.settings.builtinFillers === false
      ? []
      : BUILTIN_FILLER_PHRASES.filter((p) => !userPhrases.some((u) => u.trim().toLowerCase() === p.toLowerCase()));
  const wordCandidates = buildWordCandidates(
    transcript,
    speechSpans,
    [...userPhrases.map((p) => ({ phrase: p })), ...builtinPhrases.map((p) => ({ phrase: p, builtin: true }))],
    input.settings,
    durationSec,
    noiseFloor,
    floorReliable,
    silenceCandidates,
    notes
  );
  const { valid: candidates, fixes: wordFixes } = validateCandidates([...silenceCandidates, ...wordCandidates], durationSec);
  if (wordFixes.length) notes.push(`Words-to-remove validation adjusted ${wordFixes.length} range(s).`);

  const peaks = computePeaksServer(pcm, Math.min(PEAK_BUCKETS, Math.max(2000, Math.floor(durationSec * 80))));

  // Canonical plan from the deterministic classification (union of REMOVE
  // intervals — overlapping cuts can never double-count). The route
  // recomputes this after semantic suggestions are applied.
  const removals = unionIntervals(candidates.filter((c) => c.review === "REMOVE").map((c) => ({ start: c.start, end: c.end })), durationSec);
  const removedSec = removals.reduce((a, r) => a + (r.end - r.start), 0);

  // Transcription stage truthfulness: DONE only when every chunk was
  // transcribed (or the provider genuinely heard no speech). Partial chunk
  // loss is UNAVAILABLE — the stage ran but the provider could not serve the
  // whole recording; the missing parts are disclosed in warnings/notes.
  // Everything failing is FAILED. Never a DONE with hidden gaps.
  let transcriptionStage: PipelineStageState;
  if (transcriptionFailed) {
    transcriptionStage = "UNAVAILABLE";
  } else if (transcript.failedChunks.length === 0) {
    transcriptionStage = "DONE";
  } else if (transcript.failedChunks.length >= transcript.chunkCount) {
    transcriptionStage = "FAILED";
  } else {
    transcriptionStage = "UNAVAILABLE";
  }

  const stages = {
    mediaInspection: "DONE" as const,
    audioExtraction: "DONE" as const,
    audioDecoding: "DONE" as const,
    waveformFeatures: "DONE" as const,
    vad: floorReliable ? ("DONE" as const) : ("UNAVAILABLE" as const),
    speechSegmentation: floorReliable ? ("DONE" as const) : ("UNAVAILABLE" as const),
    transcription: transcriptionStage,
    wordAlignment: transcript.segments.length ? ("DONE" as const) : ("UNAVAILABLE" as const),
    languageId: transcript.available ? ("DONE" as const) : ("UNAVAILABLE" as const),
    fillerDetection: transcript.available ? ("DONE" as const) : ("UNAVAILABLE" as const),
    repetitionDetection: transcript.available ? ("DONE" as const) : ("UNAVAILABLE" as const),
    pauseClassification: floorReliable ? ("DONE" as const) : ("UNAVAILABLE" as const),
    contentClassification: "PENDING" as const,
    candidatesValidated: "PENDING" as const,
    readyForReview: "PENDING" as const,
  };

  return {
    sampleRate,
    durationSec,
    noiseFloor,
    peak,
    floorReliable,
    speechSpans: speechSpans.map((s) => ({ start: round3(s.start), end: round3(s.end), rms: round3(s.rms) })),
    windowMs,
    candidates,
    transcript,
    peaks,
    notes,
    stages,
    plan: { removals, removedSec: round3(removedSec), finalDurationSec: round3(durationSec - removedSec) },
  };
}

/* ------------------------------------------------------------------ */
/* ASR service — the shared backend transcription engine.              */
/* ------------------------------------------------------------------ */

export interface AsrResult {
  text: string;
  /** Text per chunk with its source-time window. */
  chunkTexts: { start: number; end: number; text: string }[];
  chunkCount: number;
  failedChunks: number[];
  warnings: string[];
}

/** Wrap 16 kHz mono s16le samples in a canonical 44-byte WAV container. */
function wavFromPcm(pcm: Int16Array, sampleRate: number): Buffer {
  const dataBytes = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i], 44 + i * 2);
  return buf;
}

/**
 * Transcribe decoded PCM through the configured ASR provider. The provider
 * hard-limits files to 30 seconds (error 1214, "transcriptions文件时长限制为
 * 0-30秒"), so the PCM is sliced into exact 25s windows — chunk boundaries
 * are exact by construction (no ffmpeg seek drift). Failed chunks are
 * reported, never filled with invented text.
 */
/* ------------------------------------------------------------------ */
/* ASR chunk cache — successful chunks are never paid for twice.        */
/* ------------------------------------------------------------------ */
/* Keyed by provider identity + the exact WAV bytes of the chunk, so a  */
/* retry after a rate-limit (or any later re-analysis of the same       */
/* recording with the same provider) resumes from the first missing     */
/* chunk instead of re-transcribing everything. Failed chunks are NOT   */
/* cached — they are retried. Text files only (tiny).                   */

const CHUNK_CACHE_DIR = path.join(MEDIA_ROOT, "asr-chunks");

export function asrChunkCacheKey(provider: { id: string; endpoint?: string; model?: string }, wav: Buffer): string {
  return createHash("sha256").update(`${provider.id}|${provider.endpoint ?? ""}|${provider.model ?? ""}|`).update(wav).digest("hex");
}

async function readChunkCache(key: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(CHUNK_CACHE_DIR, `${key}.json`), "utf8");
    const parsed = JSON.parse(raw) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text : null;
  } catch {
    return null;
  }
}

async function writeChunkCache(key: string, text: string): Promise<void> {
  try {
    await fs.mkdir(CHUNK_CACHE_DIR, { recursive: true });
    await fs.writeFile(path.join(CHUNK_CACHE_DIR, `${key}.json`), JSON.stringify({ text, cachedAt: new Date().toISOString() }));
  } catch {
    // Cache failures must never fail the analysis — the provider is re-queried.
  }
}

export async function transcribePcm(pcm: Int16Array, sampleRate: number, onChunk?: (done: number, total: number) => void): Promise<AsrResult> {
  const provider = resolveAsrProvider();
  console.log(`[riishe] provider_resolution stage=asr selected=${provider.id} model=${provider.model ?? "provider-default"} reason=${provider.reason}`);
  const warnings: string[] = [];
  const durationSec = pcm.length / sampleRate;
  const chunkSamples = sampleRate * ASR_CHUNK_SEC;
  const numChunks = Math.max(1, Math.ceil(pcm.length / chunkSamples));
  if (numChunks > 8) {
    warnings.push(`Long recording (${Math.round(durationSec)}s) — transcribed in ${numChunks} ${ASR_CHUNK_SEC}s chunks; timing is chunk-level and estimated.`);
  }

  const windows = Array.from({ length: numChunks }, (_, i) => ({
    start: (i * chunkSamples) / sampleRate,
    end: Math.min(durationSec, ((i + 1) * chunkSamples) / sampleRate),
    samples: pcm.subarray(i * chunkSamples, Math.min(pcm.length, (i + 1) * chunkSamples)),
  }));
  const bufs = windows.map((w) => wavFromPcm(w.samples, sampleRate));

  const results: (string | null)[] = new Array(numChunks).fill(null);
  let next = 0;
  let consecutive429 = 0;
  // Long recordings pace themselves: one chunk at a time with a small gap,
  // so a 49-chunk transcription does not trip the provider's rate limit and
  // lose 3/4 of the transcript to the circuit breaker.
  const concurrency = numChunks > 12 ? 1 : ASR_CONCURRENCY;
  const paceDelayMs = numChunks > 12 ? 500 : 0;
  let chunkCacheHits = 0;
  const transcribeOne = async (index: number): Promise<boolean> => {
    const cacheKey = asrChunkCacheKey(provider, bufs[index]);
    const cached = await readChunkCache(cacheKey);
    if (cached !== null) {
      results[index] = cached;
      chunkCacheHits++;
      onChunk?.(settledCount(), numChunks);
      return false;
    }
    let lastErr: unknown;
    // Patient with 429 (provider quota): up to 5 attempts with growing
    // backoff; other errors get 3 attempts. Never fabricates text.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const text = await transcribeChunkViaProvider(provider, bufs[index]);
        results[index] = text;
        consecutive429 = 0;
        await writeChunkCache(cacheKey, text);
        onChunk?.(settledCount(), numChunks);
        return true;
      } catch (err) {
        lastErr = err;
        const is429 = err instanceof Error && err.message.includes("429");
        if (is429) {
          consecutive429++;
          // Circuit breaker: once the provider is clearly rate-limiting,
          // stop hammering it — remaining chunks are skipped honestly.
          if (consecutive429 >= 6) {
            console.error(`[asr] rate-limit circuit breaker open; aborting remaining chunks`);
            throw lastErr;
          }
        } else {
          consecutive429 = 0;
        }
        const maxAttempts = is429 ? 5 : 3;
        if (attempt < maxAttempts - 1) {
          const delay = is429 ? [2000, 6000, 15000, 30000][attempt] : [1500, 4000][attempt];
          await new Promise((r) => setTimeout(r, delay));
        } else break;
      }
    }
    console.error(`[asr] chunk ${index} failed after retries:`, lastErr instanceof Error ? lastErr.message : lastErr);
    settled.add(index);
    onChunk?.(settledCount(), numChunks);
    return true;
  };
  const settled = new Set<number>();
  const settledCount = () => {
    let n = 0;
    for (let i = 0; i < numChunks; i++) if (results[i] !== null || settled.has(i)) n++;
    return n;
  };
  try {
    const workers = Array.from({ length: Math.min(concurrency, numChunks) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= numChunks) return;
        const usedProvider = await transcribeOne(i);
        if (usedProvider && paceDelayMs) await new Promise((r) => setTimeout(r, paceDelayMs));
      }
    });
    await Promise.all(workers);
  } catch (err) {
    if (err instanceof Error && err.message.includes("429")) {
      warnings.push("The transcription provider hit its rate limit — remaining chunks were skipped rather than retried into the limit. Re-run transcription later for full coverage.");
    } else {
      throw err;
    }
  }

  const failedChunks = results.map((r, i) => (r === null ? i : -1)).filter((i) => i >= 0);
  if (failedChunks.length) {
    warnings.push(
      `${failedChunks.length} of ${numChunks} chunk(s) could not be transcribed after repeated attempts — those parts are missing from the transcript (nothing was invented).`
    );
  }
  if (chunkCacheHits > 0) {
    warnings.push(`${chunkCacheHits} of ${numChunks} chunk(s) reused from the transcription cache — previously transcribed chunks are preserved across retries; only missing chunks were re-requested.`);
  }
  const chunkTexts = windows
    .map((w, i) => ({ start: w.start, end: w.end, text: results[i] ?? "" }))
    .filter((c) => c.text.length > 0);
  const text = chunkTexts.map((c) => c.text).join("\n");
  return { text, chunkTexts, chunkCount: numChunks, failedChunks, warnings };
}

/** File-path convenience wrapper used by /api/transcribe (Captions). */
export async function transcribeWithAsr(storagePath: string, durationSec: number): Promise<AsrResult> {
  const { pcm, sampleRate } = await decodePcm(storagePath);
  void durationSec;
  return transcribePcm(pcm, sampleRate);
}

