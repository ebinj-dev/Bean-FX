import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import path from "path";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { pathExists, MEDIA_ROOT } from "@/lib/media-storage";
import { jobManager } from "@/lib/job-runner";
import {
  analyzeMediaForAutocut,
  validateCandidates,
  unionIntervals,
  type AnalysisProgressEvent,
  type EvidenceCandidate,
  type RiisheStageKey,
  type ServerAnalysisResult,
} from "@/lib/autocut-analysis";
import { resolveAsrProvider } from "@/lib/asr-providers";
import { runRiisheInference, isProviderUnavailable, type RiisheSuggestion } from "@/lib/riishe-inference";
import { applySuggestions } from "@/lib/riishe-safety";
import { parseSrt, matchSrtToTranscript, srtCoverage } from "@/lib/srt";
import { promises as fs } from "fs";
import type { CutPlanSettings, RiisheSrtReport } from "@/lib/types";

export const runtime = "nodejs";

/**
 * THE unified RIISHE pipeline — the only analysis path in BEAN FX.
 *
 * One action runs every stage: media validation → audio extraction/decoding →
 * VAD → backend transcription (shared ASR engine) → language detection →
 * sentence/word alignment → audio+speech evidence → content-flow analysis →
 * semantic inference (when the provider is available) → KEEP/REMOVE/REVIEW
 * classification → candidate validation → canonical cut plan → ready for
 * review. Every stage is reported truthfully; an unavailable provider is
 * reported, never faked, and the deterministic classification stands.
 *
 * A short-lived in-process cache keyed by mediaId+settings lets a re-run of
 * the same analysis (e.g. the RIISHE re-run button) reuse the expensive
 * decode/transcribe work and only redo inference + validation.
 */

const settingsSchema = z.object({
  minSilenceSec: z.number().min(0.1).max(10).default(0.5),
  headPaddingSec: z.number().min(0).max(2).default(0.15),
  tailPaddingSec: z.number().min(0).max(2).default(0.2),
  targetPauseSec: z.number().min(0.05).max(3).default(0.35),
  tightenSentencePauses: z.boolean().default(true),
  builtinFillers: z.boolean().default(true),
  sensitivity: z.enum(["LOW", "BALANCED", "HIGH"]).default("BALANCED"),
  windowMs: z.number().int().min(5).max(50).default(10),
});

const DEFAULT_SETTINGS = {
  minSilenceSec: 0.5,
  headPaddingSec: 0.15,
  tailPaddingSec: 0.2,
  targetPauseSec: 0.35,
  tightenSentencePauses: true,
  builtinFillers: true,
  sensitivity: "BALANCED" as const,
};

const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX = 4;
const analysisCache = new Map<string, { result: ServerAnalysisResult; ts: number }>();

function cacheGet(key: string): ServerAnalysisResult | null {
  const hit = analysisCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    analysisCache.delete(key);
    return null;
  }
  // Clone the parts inference mutates so concurrent re-runs start from the
  // pristine deterministic classification.
  return { ...hit.result, candidates: hit.result.candidates.map((c) => ({ ...c })), stages: { ...hit.result.stages } };
}

function cachePut(key: string, result: ServerAnalysisResult): void {
  // A rate-limited (partial) transcription is never cached — the next action
  // must retry the missing chunks against the provider.
  if (result.transcript.failedChunks.length > 0) return;
  if (analysisCache.size >= CACHE_MAX) {
    const oldest = [...analysisCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) analysisCache.delete(oldest[0]);
  }
  analysisCache.set(key, { result, ts: Date.now() });
}

/** Apply semantic suggestions to the deterministic candidates with safety
 *  guardrails: a semantic REMOVE over transcribed words is only accepted for
 *  confirmed repeated takes with solid confidence — otherwise it degrades to
 *  REVIEW (speech is never removed on a shaky semantic opinion). Word-candidates
 *  from the user's words-to-remove list are exempt: they exist precisely to
 *  let the user remove specific matched words, the semantic stage judged them
 *  in context, and they still need explicit approval to affect any output. */
// applySuggestions — the post-inference safety layer — lives in
// @/lib/riishe-safety (shared with tests and the Phase-F benchmark).

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  const body = await req.json().catch(() => null);
  const parsed = z
    .object({
      mediaId: z.string().min(1),
      settings: settingsSchema.optional(),
      /** User-defined words/phrases to consider removing (context-aware). */
      wordsToRemove: z.array(z.string().min(1).max(80)).max(100).optional(),
      /** Optional SRT reference (an owned SUBTITLE media asset). */
      srtMediaId: z.string().min(1).optional(),
    })
    .safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: `Invalid analyze request: ${parsed.error.issues.map((i) => i.message).join("; ")}` }, { status: 400 });
  }

  const asset = await db.mediaAsset.findUnique({ where: { id: parsed.data.mediaId } });
  if (!asset || asset.userId !== user.id) {
    return NextResponse.json({ error: "Media not found." }, { status: 404 });
  }
  if (!(await pathExists(asset.storagePath))) {
    return NextResponse.json({ error: "Media file is missing from storage." }, { status: 410 });
  }

  // Optional SRT reference — must be an owned SUBTITLE asset.
  let srtReport: RiisheSrtReport | null = null;
  let srtCues: ReturnType<typeof parseSrt>["cues"] | null = null;
  if (parsed.data.srtMediaId) {
    const srtAsset = await db.mediaAsset.findUnique({ where: { id: parsed.data.srtMediaId } });
    if (!srtAsset || srtAsset.userId !== user.id) {
      return NextResponse.json({ error: "SRT reference not found." }, { status: 404 });
    }
    if (srtAsset.kind !== "SUBTITLE") {
      return NextResponse.json({ error: "The referenced SRT media is not a subtitle file." }, { status: 400 });
    }
    try {
      const content = await fs.readFile(srtAsset.storagePath, "utf8");
      const parsedSrt = parseSrt(content);
      if (!parsedSrt.cues.length) {
        return NextResponse.json({ error: `The SRT file could not be parsed: ${parsedSrt.errors[0] ?? "no cues"}` }, { status: 400 });
      }
      srtCues = parsedSrt.cues;
      srtReport = {
        available: true,
        originalName: srtAsset.originalName,
        cueCount: parsedSrt.cues.length,
        parseErrors: parsedSrt.errors.slice(0, 10),
        coverage: {
          coveredSec: 0,
          coverageRatio: null,
          firstStartSec: null,
          lastEndSec: null,
          missingRanges: [],
          duplicates: [],
          repeatedText: [],
        },
        matching: null,
      };
    } catch {
      return NextResponse.json({ error: "The SRT file could not be read from storage." }, { status: 410 });
    }
  }

  const wordsToRemove = (parsed.data.wordsToRemove ?? []).map((w) => w.trim()).filter(Boolean);
  const settings = { ...DEFAULT_SETTINGS, ...(parsed.data.settings ?? {}) };
  const cacheKey = `${asset.id}:${createHash("sha256")
    .update(JSON.stringify({ settings, words: wordsToRemove, srt: parsed.data.srtMediaId ?? null }))
    .digest("hex")
    .slice(0, 16)}`;

  // Duplicate-job guard: an active analysis for the SAME media returns the
  // existing job instead of spawning a second identical run.
  const activeJob = await db.job.findFirst({
    where: {
      userId: user.id,
      type: ANALYSIS_JOB_TYPE,
      status: { in: ["QUEUED", "PROCESSING"] },
      paramsJson: { contains: `"mediaId":"${asset.id}"` },
    },
  });
  if (activeJob) {
    return NextResponse.json({ ok: true, jobId: activeJob.id, reused: true });
  }

  // Background-job pattern (the same infrastructure the apply flow uses):
  // the POST validates, enqueues, and returns immediately — the multi-minute
  // pipeline runs server-side and survives client disconnects and gateway
  // timeouts. The client polls /api/jobs/[id] and fetches the result when
  // the job completes.
  const jobId = await jobManager.createJob(user.id, ANALYSIS_JOB_TYPE, { mediaId: asset.id });
  void runAnalysisJob({ jobId, asset, settings, wordsToRemove, cacheKey, srtCues, srtReport }).catch((err) => {
    console.error(`[autocut-analyze] job ${jobId} crashed outside its own error handler:`, err instanceof Error ? err.message : err);
  });
  return NextResponse.json({ ok: true, jobId });
}

/** Module-level human-readable stage labels (1-15) used for live job progress. */
export const RIISHE_STAGE_LABELS: Record<RiisheStageKey, string> = {
  mediaInspection: "Media inspection (FFprobe)",
  audioExtraction: "Audio extraction",
  audioDecoding: "Audio decoding + normalization",
  waveformFeatures: "Waveform & feature extraction",
  vad: "Voice activity detection",
  speechSegmentation: "Speech segmentation",
  transcription: "Speech recognition (ASR)",
  wordAlignment: "Word-level alignment",
  languageId: "Language identification",
  fillerDetection: "Filler / unwanted-word detection",
  repetitionDetection: "Repetitions & false starts",
  pauseClassification: "Pause & silence classification",
  contentClassification: "Content-aware classification",
  candidatesValidated: "Evidence-backed candidates validated",
  readyForReview: "Final review plan",
};

const ANALYSIS_JOB_TYPE = "autocut-analysis";
const RESULTS_DIR = path.join(MEDIA_ROOT, "analysis-results");

/** Stage-aware, honest failure message. The failed stage comes from the last
 *  real progress event — never guessed. Analysis is always retryable: it is
 *  idempotent, the original media is never modified, and completed ASR
 *  chunks are preserved on disk for the retry. */
function analysisErrorMessage(stage: RiisheStageKey | "inference", message: string): string {
  const m = message.trim();
  if (stage === "audioDecoding" || stage === "audioExtraction") return `Audio preprocessing failed: ${m} The original media is intact — retry is safe.`;
  if (stage === "transcription")
    return `Transcription failed: ${m} Previously transcribed chunks are preserved — retrying the analysis resumes from the first missing chunk instead of starting over.`;
  if (stage === "vad" || stage === "speechSegmentation") return `VAD failed: ${m}`;
  if (stage === "contentClassification" || stage === "inference") return `Semantic inference failed: ${m} Deterministic classification remains available.`;
  const label = RIISHE_STAGE_LABELS[stage];
  return `Analysis failed during "${label}": ${m} The original media is intact — retry is safe.`;
}

/** Runs the full analysis pipeline for a persisted job: decode → VAD → ASR
 *  (with chunk-cache resume) → alignment → evidence → semantic inference →
 *  validation → plan. Streams real stage progress into the job record and
 *  stores the result payload for the result endpoint. */
async function runAnalysisJob(args: {
  jobId: string;
  asset: { id: string; originalName: string; storagePath: string; audioCodec: string | null; durationSec: number | null };
  settings: CutPlanSettings;
  wordsToRemove: string[];
  cacheKey: string;
  srtCues: ReturnType<typeof parseSrt>["cues"] | null;
  srtReport: RiisheSrtReport | null;
}): Promise<void> {
  const { jobId, asset, settings, wordsToRemove, cacheKey, srtCues, srtReport } = args;
  let lastStageKey: RiisheStageKey | "inference" = "mediaInspection";
  const lastStageLabel = () => (lastStageKey === "inference" ? "content-aware classification" : RIISHE_STAGE_LABELS[lastStageKey]);
  let lastPct = 0;
  let lastLabel = "Starting";
  const emitProgress = (event: AnalysisProgressEvent) => {
    lastStageKey = event.stage;
    lastPct = event.progressPct ?? lastPct;
    lastLabel = `${RIISHE_STAGE_LABELS[event.stage]} — ${event.status}`;
    const now = Date.now();
    if (now - lastProgressWrite > 400 || event.status !== "RUNNING") {
      lastProgressWrite = now;
      void jobManager.setProgress(jobId, lastPct, `${lastLabel}${event.detail ? ` (${event.detail})` : ""}`);
    }
  };
  // Heartbeat: long stages with no per-chunk events (the semantic inference
  // over hundreds of candidates can run for minutes) must keep the job
  // record fresh — otherwise the staleness sweep cannot tell a silent-but-
  // alive job from one orphaned by a server restart.
  const heartbeat = setInterval(() => {
    void jobManager.setProgress(jobId, lastPct, lastLabel);
  }, 30_000);
  const emitRoute = (stage: RiisheStageKey, status: AnalysisProgressEvent["status"], detail?: string, pct?: number) => {
    emitProgress({ stage, status, detail, progressPct: pct });
  };
  let lastProgressWrite = 0;
  // The pipeline's live events feed the job record (throttled) and remember
  // the last real stage so a failure names the exact stage that failed.
  const onProgress = (event: AnalysisProgressEvent) => emitProgress(event);

  try {
    emitRoute("mediaInspection", "DONE", asset.originalName, 4);
    await jobManager.setProgress(jobId, 4, `${RIISHE_STAGE_LABELS.mediaInspection} — DONE`);
    let result = cacheGet(cacheKey);
    let fromCache = Boolean(result);
    if (!result) {
      result = await analyzeMediaForAutocut({
        storagePath: asset.storagePath,
        settings,
        wordsToRemove,
        hasAudioStream: Boolean(asset.audioCodec),
        fallbackDurationSec: asset.durationSec,
        onProgress,
      });
      cachePut(cacheKey, result);
    }

    // Stage 9 — semantic inference (the ONE shared implementation). When the
    // provider is unavailable this is reported honestly; the deterministic
    // classification stands and ambiguous ranges stay REVIEW.
    let inferenceSummary: string | null = null;
    let inferenceModel: string | null = null;
    let inferenceClassified = 0;
    let inferenceDowngraded = 0;
    let inferenceNote: string | null = null;

    if (result.candidates.length === 0) {
      result.stages.contentClassification = "UNAVAILABLE";
      result.stages.candidatesValidated = "DONE";
      result.stages.readyForReview = "DONE";
      inferenceNote = "No candidate ranges were produced — nothing to classify semantically.";
    } else {
      try {
        emitRoute("contentClassification", "RUNNING", undefined, 80);
        const inf = await runRiisheInference({
          mediaName: asset.originalName,
          durationSec: result.durationSec,
          sensitivity: settings.sensitivity,
          candidates: result.candidates.map((c) => ({
            id: c.id,
            start: c.start,
            end: c.end,
            duration: c.duration,
            rms: c.evidence.rms,
            snr: c.evidence.snr,
            transcriptText:
              c.evidence.transcriptWordsInRange > 0
                ? result.transcript.segments
                    .filter((s) => s.start < c.end && s.end > c.start)
                    .map((s) => s.text)
                    .join(" ") || null
                : null,
            transcriptWordsInRange: c.evidence.transcriptWordsInRange,
            intraSentence: c.evidence.intraSentence,
            quietSpeechNearby: c.evidence.quietSpeechNearby,
            repeatedTake: c.evidence.repeatedTake,
            prevSentence: c.prevSentence ?? null,
            nextSentence: c.nextSentence ?? null,
            deterministicReview: c.review,
            wordMatchPhrase: c.wordMatch?.phrase ?? null,
          })),
          transcriptSegments: result.transcript.segments.map((s) => ({ id: s.id, start: s.start, end: s.end, text: s.text })),
        });
        const { applied, downgraded } = applySuggestions(result.candidates, inf.suggestions, inf.model);
        inferenceSummary = inf.summary;
        inferenceModel = inf.model;
        inferenceClassified = applied;
        inferenceDowngraded = downgraded;
        result.stages.contentClassification = "DONE";
        result.stages.candidatesValidated = "DONE";
        result.stages.readyForReview = "DONE";
        inferenceNote = `RIISHE inference (${inf.model}, ${inf.batches} batch(es)) classified ${applied}/${result.candidates.length} candidate range(s)${downgraded ? `, ${downgraded} semantic REMOVE(s) over transcribed speech were kept as REVIEW by the safety guard` : ""}.`;
      } catch (err) {
        const partial = (err as Error & { partial?: { suggestions: RiisheSuggestion[]; model: string; batches: number } }).partial;
        if (partial && partial.suggestions.length > 0) {
          const { applied, downgraded } = applySuggestions(result.candidates, partial.suggestions, partial.model);
          inferenceClassified = applied;
          inferenceDowngraded = downgraded;
          inferenceModel = partial.model;
          result.stages.contentClassification = "FAILED";
          result.stages.candidatesValidated = "DONE";
          result.stages.readyForReview = "DONE";
          inferenceNote = `Inference completed partially: ${applied}/${result.candidates.length} range(s) classified (${err instanceof Error ? err.message : "unknown error"}). Unclassified ranges keep their deterministic classification.`;
        } else {
          const unavailable = isProviderUnavailable(err);
          result.stages.contentClassification = unavailable ? "UNAVAILABLE" : "FAILED";
          result.stages.candidatesValidated = "DONE";
          result.stages.readyForReview = "DONE";
          inferenceNote = `Semantic inference ${unavailable ? "unavailable" : "failed"}: ${err instanceof Error ? err.message : "unknown error"}. Deterministic evidence-based classification stands; uncertain ranges are REVIEW. Nothing was classified REMOVE because inference failed.`;
        }
      }
    }

    emitRoute("candidatesValidated", "RUNNING", undefined, 88);

    // Stage 11 — candidate validation after any suggestion application, then
    // recompute the canonical plan from the final classification.
    const { valid: finalCandidates, fixes } = validateCandidates(result.candidates, result.durationSec);
    const removals = unionIntervals(finalCandidates.filter((c) => c.review === "REMOVE").map((c) => ({ start: c.start, end: c.end })), result.durationSec);
    const removedSec = removals.reduce((a, r) => a + (r.end - r.start), 0);
    const plan = { removals, removedSec: Math.round(removedSec * 1000) / 1000, finalDurationSec: Math.round((result.durationSec - removedSec) * 1000) / 1000 };
    if (fixes.length) inferenceNote = `${inferenceNote ?? ""} Post-inference validation adjusted ${fixes.length} range(s).`;

    // SRT reference matching — always measured against the ACTUAL transcript
    // of this media; the SRT timing itself is never trusted as audio timing.
    if (srtCues && srtReport) {
      const cov = srtCoverage(srtCues, result.durationSec);
      srtReport.coverage = {
        coveredSec: cov.coveredSec,
        coverageRatio: cov.coverageRatio,
        firstStartSec: cov.firstStartSec,
        lastEndSec: cov.lastEndSec,
        missingRanges: cov.missingRanges.slice(0, 30),
        duplicates: cov.duplicates.slice(0, 30),
        repeatedText: cov.repeatedText.slice(0, 30),
      };
      if (result.transcript.available && result.transcript.segments.length) {
        const m = matchSrtToTranscript(srtCues, result.transcript.segments);
        srtReport.matching = {
          matchedCount: m.matchedCount,
          medianOffsetSec: m.medianOffsetSec,
          driftSec: m.driftSec,
          samples: m.perCue
            .filter((p) => p.offsetSec !== null)
            .slice(0, 250)
            .map((p) => ({ ordinal: p.cue.ordinal, start: p.cue.start, offsetSec: p.offsetSec as number, similarity: p.similarity })),
        };
      }
    }

    const payload = {
      ok: true,
      mediaId: asset.id,
      originalName: asset.originalName,
      durationSec: result.durationSec,
      sampleRate: result.sampleRate,
      analysis: {
        noiseFloor: result.noiseFloor,
        peak: result.peak,
        floorReliable: result.floorReliable,
        speechSpanCount: result.speechSpans.length,
        windowMs: result.windowMs,
      },
      candidates: finalCandidates,
      transcript: {
        available: result.transcript.available,
        text: result.transcript.text.slice(0, 20000),
        segments: result.transcript.segments,
        chunkCount: result.transcript.chunkCount,
        failedChunks: result.transcript.failedChunks,
        warnings: result.transcript.warnings,
        language: result.transcript.language,
        alignmentStats: result.transcript.alignmentStats,
      },
      peaks: result.peaks,
      notes: result.notes,
      stages: result.stages,
      srt: srtReport,
      plan,
      fromCache,
      inference: inferenceModel
        ? { model: inferenceModel, summary: inferenceSummary, candidatesClassified: inferenceClassified, downgraded: inferenceDowngraded }
        : null,
      inferenceNote,
    };

    await fs.mkdir(RESULTS_DIR, { recursive: true });
    await fs.writeFile(path.join(RESULTS_DIR, `${jobId}.json`), JSON.stringify(payload));
    await jobManager.complete(jobId, "", `Analysis complete: ${payload.candidates.length} candidate(s), plan removes ${plan.removedSec.toFixed(2)}s (final ${plan.finalDurationSec.toFixed(2)}s).`);
    console.log(`[autocut-analyze] job ${jobId} completed: ${payload.candidates.length} candidates, fromCache=${fromCache}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Analysis failed.";
    console.error(`[autocut-analyze] job ${jobId} failed during "${lastStageLabel()}":`, message);
    await jobManager.fail(jobId, analysisErrorMessage(lastStageKey, message));
  } finally {
    clearInterval(heartbeat);
  }
}
