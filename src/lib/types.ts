/**
 * BEAN FX — Shared contracts.
 *
 * All timestamps are SECONDS (float) unless explicitly suffixed with `Ms`.
 * Cut ranges use half-open intervals [start, end) — end is exclusive.
 * Every range must satisfy: 0 <= start < end <= mediaDuration.
 */

export type SensitivityProfile = "LOW" | "BALANCED" | "HIGH";

/** Client-side session user shape (matches /api/auth/me). */
export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  createdAt?: string;
}

export type CutReviewStatus = "PROPOSED" | "KEEP" | "REMOVE" | "REVIEW" | "APPROVED" | "REJECTED";

/** Persisted per-candidate decision values (P3 decision persistence). */
export type CutDecisionValue = "APPROVE" | "REJECT" | "KEEP";

/** One persisted decision as returned by /api/autocut/decisions. */
export interface SavedDecisionView {
  candidateId: string;
  decision: CutDecisionValue;
  createdAt: string;
  updatedAt: string;
}

/** One completed analysis of a media asset (reopen list entry). */
export interface AnalysisListItem {
  jobId: string;
  createdAt: string;
}

/** Where a cut suggestion came from. */
export type CutSource = "SILENCE_ANALYSIS" | "RIISHE_INFERENCE" | "WORDS_TO_REMOVE" | "MANUAL";

/** One occurrence of a user-defined words-to-remove entry inside the
 *  transcript (context-aware; word timings are ESTIMATED). */
export interface WordMatchInfo {
  phrase: string;
  segmentId: string;
  segmentText: string;
  matchedWords: string[];
  estimatedTiming: true;
}

/** Combined-evidence fields produced by the server-side RIISHE analysis. */
export interface CutEvidence {
  pauseSec: number;
  rms: number;
  snr: number;
  transcriptWordsInRange: number;
  intraSentence: boolean;
  quietSpeechNearby: boolean;
  repeatedTake: boolean;
  floorReliable: boolean;
}

/** Language detection result (script mapping + lexicon checks, honest —
 *  never a bare script name pretending to be a language). */
export interface LanguageInfo {
  scripts: { script: string; chars: number }[];
  primaryScript: string;
  mixed: boolean;
  /** Probable language(s), e.g. "English (Latin script)" or
   *  "Tanglish likely — Tamil content romanized in Latin script". */
  languages: string[];
  description: string;
}

/** Truthful pipeline stage states (rendered by the pipeline panel).
 *  The fifteen stages mirror the RIISHE orchestration order: every entry is
 *  backed by a real subsystem that ran (or honestly did not run) — a stage
 *  that could not run is UNAVAILABLE, one that errored is FAILED, and DONE
 *  always means that stage genuinely completed in the reported action. */
export type RiisheStageState = "PENDING" | "RUNNING" | "DONE" | "UNAVAILABLE" | "FAILED";

export interface RiisheStageReport {
  /** 1 · ffprobe inspection and ownership validation of the uploaded media. */
  mediaInspection: RiisheStageState;
  /** 2 · audio-stream extraction (video inputs) — UNAVAILABLE when there is no audio. */
  audioExtraction: RiisheStageState;
  /** 3 · decode + normalization to the analysis PCM (16 kHz mono). */
  audioDecoding: RiisheStageState;
  /** 4 · waveform peak envelope + RMS feature extraction. */
  waveformFeatures: RiisheStageState;
  /** 5 · voice activity detection (energy VAD with hysteresis). */
  vad: RiisheStageState;
  /** 6 · speech segmentation from the VAD spans. */
  speechSegmentation: RiisheStageState;
  /** 7 · ASR (provider-backed; UNAVAILABLE when no provider is configured). */
  transcription: RiisheStageState;
  /** 8 · word-level timestamp alignment against measured speech energy. */
  wordAlignment: RiisheStageState;
  /** 9 · language identification from the actual transcript. */
  languageId: RiisheStageState;
  /** 10 · multilingual filler / unwanted-word detection (list matching + semantic). */
  fillerDetection: RiisheStageState;
  /** 11 · repetition and false-start identification. */
  repetitionDetection: RiisheStageState;
  /** 12 · pause / silence classification (deterministic, energy-based). */
  pauseClassification: RiisheStageState;
  /** 13 · content-aware classification (semantic inference when available). */
  contentClassification: RiisheStageState;
  /** 14 · evidence-backed KEEP/REMOVE/REVIEW candidates validated (bounds/overlap). */
  candidatesValidated: RiisheStageState;
  /** 15 · final review plan assembled for human approval. */
  readyForReview: RiisheStageState;
}

export interface RiisheAlignmentStats {
  chunkCount: number;
  chunksWithText: number;
  chunksSilent: number;
  sentenceCount: number;
  boundaryJoins: number;
  energyValidated: number;
  anchored: number;
}

export interface RiisheAlignedSegment {
  id: string;
  start: number;
  end: number;
  text: string;
  /** Estimated word timestamps (the ASR provider returns none) — words are
   *  allocated along the measured speech energy and skip detected silence. */
  words: { text: string; start: number; end: number }[];
  energyValidated: boolean;
  boundaryJoined: boolean;
}

export interface RiisheCanonicalPlan {
  removals: { start: number; end: number }[];
  removedSec: number;
  finalDurationSec: number;
}

/** Server-side RIISHE analysis response (canonical cut-plan source). */
/** SRT reference report — produced only when an SRT is attached to the
 *  analysis. SRT timing is NEVER treated as verified audio timing; offsets
 *  are measured against the actual ASR transcript of the media. */
export interface RiisheSrtReport {
  available: boolean;
  originalName: string;
  cueCount: number;
  parseErrors: string[];
  coverage: {
    coveredSec: number;
    coverageRatio: number | null;
    firstStartSec: number | null;
    lastEndSec: number | null;
    missingRanges: { start: number; end: number; duration: number }[];
    duplicates: { a: number; b: number; start: number; end: number }[];
    repeatedText: { a: number; b: number; similarity: number; text: string }[];
  };
  /** Matching against the actual transcript (null when no transcript). */
  matching: {
    matchedCount: number;
    medianOffsetSec: number | null;
    driftSec: number | null;
    /** Per-cue offsets for the matched subset (cue ordinal + offset). */
    samples: { ordinal: number; start: number; offsetSec: number; similarity: number }[];
  } | null;
}

export interface RiisheAnalyzeResult {
  ok: boolean;
  mediaId: string;
  originalName: string;
  durationSec: number;
  sampleRate: number;
  analysis: {
    noiseFloor: number;
    peak: number;
    floorReliable: boolean;
    speechSpanCount: number;
    windowMs: number;
  };
  candidates: {
    id: string;
    start: number;
    end: number;
    duration: number;
    reason: string;
    review: "REMOVE" | "REVIEW" | "KEEP";
    confidence: number;
    classificationSource: "DETERMINISTIC" | "RIISHE_INFERENCE";
    evidence: CutEvidence;
    wordMatch?: WordMatchInfo;
  }[];
  transcript: {
    available: boolean;
    text: string;
    segments: RiisheAlignedSegment[];
    chunkCount: number;
    failedChunks: number[];
    warnings: string[];
    language: LanguageInfo;
    alignmentStats: RiisheAlignmentStats | null;
  };
  peaks: { min: number[]; max: number[] };
  notes: string[];
  /** Truthful pipeline stage states for this completed action. */
  stages: RiisheStageReport;
  /** SRT reference report when an SRT was attached to this analysis. */
  srt?: RiisheSrtReport | null;
  /** Canonical plan: union of the server's REMOVE intervals —
   *  finalDurationSec = durationSec − removedSec, never double-counted. */
  plan: RiisheCanonicalPlan;
  /** True when the expensive decode/transcribe work was reused from cache. */
  fromCache?: boolean;
  /** Present only when semantic inference genuinely ran. */
  inference: { model: string; summary: string | null; candidatesClassified: number; downgraded: number } | null;
  inferenceNote: string | null;
}

export interface AudioEvidence {
  /** Average RMS of the range, 0..1 normalized. */
  rms: number;
  /** Estimated noise floor of the recording, 0..1. */
  noiseFloor: number;
  /** Ratio of rms to noise floor. */
  snr: number;
  /** Analysis window used, milliseconds. */
  windowMs: number;
}

export interface TranscriptContext {
  text: string;
  /** -1 when the range contains no speech in the transcript. */
  wordCount: number;
  snippet: string;
}

export interface CutRange {
  /** Stable ID. */
  id: string;
  /** Half-open range [start, end) in seconds. */
  start: number;
  end: number;
  /** Duration in seconds (end - start). */
  duration: number;
  reason: string;
  source: CutSource;
  review: CutReviewStatus;
  /** Padding applied at head/tail when derived from a longer silent span. */
  paddingApplied: { head: number; tail: number };
  /** Deterministic audio evidence measured from the actual samples. */
  audioEvidence?: AudioEvidence;
  /** Transcript context if a validated transcript exists for this media. */
  transcriptContext?: TranscriptContext;
  /** Present only when RIISHE inference genuinely ran. */
  inference?: {
    model: string;
    confidence: number;
    notes: string;
  };
  /** Combined-evidence record from the server-side analysis (VAD, continuity,
   *  quiet speech, repeated takes). Drives REVIEW/KEEP fallback rules. */
  combinedEvidence?: CutEvidence;
  /** Present when the candidate came from the user's words-to-remove list. */
  wordMatch?: WordMatchInfo;
  validationError?: string;
}

export interface CutPlanSettings {
  minSilenceSec: number;
  headPaddingSec: number;
  tailPaddingSec: number;
  targetPauseSec: number;
  tightenSentencePauses: boolean;
  sensitivity: SensitivityProfile;
  /** Flag matches from the built-in multilingual filler lexicon as REVIEW
   *  candidates (default true). REVIEW-only by construction — never REMOVE. */
  builtinFillers?: boolean;
}

export interface CutPlanSummary {
  originalDurationSec: number;
  proposedRemovedSec: number;
  approvedRemovedSec: number;
  appliedRemovedSec: number;
  finalEstimatedSec: number;
  proposedCount: number;
  approvedCount: number;
  appliedCount: number;
  keptPercent: number;
  removedPercent: number;
}

export interface MediaMeta {
  notes?: string | null;
  id: string;
  originalName: string;
  kind: "AUDIO" | "VIDEO" | "SUBTITLE" | "IMAGE";
  mimeType: string;
  sizeBytes: number;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  sampleRate: number | null;
  channels: number | null;
  role: string | null;
  createdAt: string;
  // ── M3 pipeline state (additive, optional for backwards compatibility) ──
  /** PENDING | PROCESSING | READY | FAILED — deep ffprobe runs in the worker. */
  probeStatus?: string | null;
  probeError?: string | null;
  /** NONE | QUEUED | PROCESSING | READY | FAILED | UNSUPPORTED */
  proxyStatus?: string | null;
  /** True when the server recognized identical bytes and reused the stored original. */
  deduplicated?: boolean;
}

/** A transcript segment with estimated or provider-provided timing. */
export interface TranscriptSegment {
  id: string;
  start: number;
  end: number;
  text: string;
  /** "estimated" = aligned by BEAN FX from real ASR text + measured speech energy. */
  timingSource: "estimated" | "provider";
  language?: string;
  /** Estimated word timestamps allocated along measured speech energy. */
  words?: { text: string; start: number; end: number }[];
  energyValidated?: boolean;
  boundaryJoined?: boolean;
}

export interface TranscriptResult {
  segments: TranscriptSegment[];
  text: string;
  provider: string;
  /** Honest statement of the provider's timing granularity. */
  timingGranularity: "word" | "segment" | "none";
  warnings: string[];
}

/** Job state machine (spec §14.1). */
export type JobStatus = "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED";

export interface JobView {
  id: string;
  type: string;
  status: JobStatus;
  progress: number;
  stage: string | null;
  message: string | null;
  exportId: string | null;
  error: string | null;
}

export interface ExportView {
  id: string;
  kind: string;
  format: string;
  filename: string;
  sizeBytes: number;
  durationSec: number | null;
  mediaId: string | null;
  params: Record<string, unknown> | null;
  createdAt: string;
}

export const AUDIO_EXPORT_FORMATS = ["mp3", "wav", "m4a", "aac", "flac"] as const;
export type AudioExportFormat = (typeof AUDIO_EXPORT_FORMATS)[number];

/** Analysis window: configurable; 10 ms default (capability strip claim). */
export const ANALYSIS_WINDOW_MS_DEFAULT = 10;
