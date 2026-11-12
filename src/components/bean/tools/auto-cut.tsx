"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Scissors,
  Play,
  Pause,
  ZoomIn,
  ZoomOut,
  Trash2,
  Sparkles,
  ShieldCheck,
  AlertTriangle,
  Download,
  RotateCcw,
  Brain,
  Loader2,
  Plus,
  X,
} from "lucide-react";
import { ToolShell } from "@/components/bean/tool-shell";
import { readMediaRef } from "@/components/bean/upload-gate";
import { JobProgressBar } from "@/components/bean/job-progress";
import { AnalysisJobProgress } from "@/components/bean/analysis-progress";
import { Waveform, type WaveCuts } from "@/components/bean/waveform";
import type {
  SessionUser,
  MediaMeta,
  CutRange,
  CutPlanSettings,
  TranscriptSegment,
  SensitivityProfile,
  CutPlanSummary,
  RiisheAnalyzeResult,
} from "@/lib/types";
import { normalizeRanges, round3 } from "@/lib/audio-analysis";
import { formatDuration, formatPrecise } from "@/lib/format-utils";
import { cn } from "@/lib/utils";

type StageState = "PENDING" | "RUNNING" | "DONE" | "UNAVAILABLE" | "FAILED";

interface RiisheStages {
  mediaInspection: StageState;
  audioExtraction: StageState;
  audioDecoding: StageState;
  waveformFeatures: StageState;
  vad: StageState;
  speechSegmentation: StageState;
  transcription: StageState;
  wordAlignment: StageState;
  languageId: StageState;
  fillerDetection: StageState;
  repetitionDetection: StageState;
  pauseClassification: StageState;
  contentClassification: StageState;
  candidatesValidated: StageState;
  readyForReview: StageState;
}

const INITIAL_STAGES: RiisheStages = {
  mediaInspection: "PENDING",
  audioExtraction: "PENDING",
  audioDecoding: "PENDING",
  waveformFeatures: "PENDING",
  vad: "PENDING",
  speechSegmentation: "PENDING",
  transcription: "PENDING",
  wordAlignment: "PENDING",
  languageId: "PENDING",
  fillerDetection: "PENDING",
  repetitionDetection: "PENDING",
  pauseClassification: "PENDING",
  contentClassification: "PENDING",
  candidatesValidated: "PENDING",
  readyForReview: "PENDING",
};

/** The 15 RIISHE orchestration stages, in execution order — the panel
 *  renders exactly this list with the server's truthful per-stage states. */
const STAGE_LABELS: [keyof RiisheStages, string][] = [
  ["mediaInspection", "1 · Media inspection (FFprobe)"],
  ["audioExtraction", "2 · Audio extraction"],
  ["audioDecoding", "3 · Audio decoding + normalization"],
  ["waveformFeatures", "4 · Waveform & feature extraction"],
  ["vad", "5 · Voice activity detection"],
  ["speechSegmentation", "6 · Speech segmentation"],
  ["transcription", "7 · Speech recognition (ASR)"],
  ["wordAlignment", "8 · Word-level alignment"],
  ["languageId", "9 · Language identification"],
  ["fillerDetection", "10 · Filler / unwanted-word detection"],
  ["repetitionDetection", "11 · Repetitions & false starts"],
  ["pauseClassification", "12 · Pause & silence classification"],
  ["contentClassification", "13 · Content-aware classification"],
  ["candidatesValidated", "14 · Evidence-backed candidates validated"],
  ["readyForReview", "15 · Final review plan"],
];

const DEFAULT_SETTINGS: CutPlanSettings = {
  minSilenceSec: 0.5,
  headPaddingSec: 0.15,
  tailPaddingSec: 0.2,
  targetPauseSec: 0.35,
  tightenSentencePauses: true,
  sensitivity: "BALANCED",
  builtinFillers: true,
};

/** One retained interval of the edited output, in source and output time. */
interface KeptSegment {
  srcStart: number;
  srcEnd: number;
  outStart: number;
  outEnd: number;
}

export function AutoCutTool({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  const [media, setMedia] = useState<MediaMeta | null>(() => readMediaRef("autocut"));
  const [mediaKey, setMediaKey] = useState(0);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisJobId, setAnalysisJobId] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  // Server-produced analysis artifacts (single source of truth).
  const [peaksA, setPeaksA] = useState<{ min: Float32Array; max: Float32Array } | null>(null);
  const [peaksLoading, setPeaksLoading] = useState(false);
  const [waveError, setWaveError] = useState<string | null>(null);
  const [settings, setSettings] = useState<CutPlanSettings>(DEFAULT_SETTINGS);
  const [windowMs, setWindowMs] = useState(10);
  const [cuts, setCuts] = useState<CutRange[]>([]);
  const [analyzeNotes, setAnalyzeNotes] = useState<string[]>([]);
  const [analyzed, setAnalyzed] = useState<(RiisheAnalyzeResult["analysis"] & { durationSec: number }) | null>(null);

  const [viewStart, setViewStart] = useState(0);
  const [viewEnd, setViewEnd] = useState(0);
  const [playheadDisplay, setPlayheadDisplay] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [bufferLoading, setBufferLoading] = useState(false);

  const [riisheStages, setRiisheStages] = useState<RiisheStages>(INITIAL_STAGES);
  const [riisheNote, setRiisheNote] = useState<string | null>(null);
  // Transcript segments (server-aligned) — rendered on candidate cards when
  // they overlap a proposed range.
  const [transcriptSegments, setTranscript] = useState<TranscriptSegment[]>([]);

  // Words to remove — the user's reusable, context-aware removal preferences.
  const [wordsList, setWordsList] = useState<{ id: string; phrase: string; note?: string | null }[]>([]);
  const [wordInput, setWordInput] = useState("");
  const [wordsBusy, setWordsBusy] = useState(false);
  const [wordsError, setWordsError] = useState<string | null>(null);

  // Video preview (VIDEO media): the <video> element is the playback clock —
  // audio/video stay synchronized because preview audio comes from the video
  // itself. Audio media keeps the WebAudio path untouched.
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const isVideoMedia = media?.kind === "VIDEO";

  const [applyOpen, setApplyOpen] = useState(false);
  const [applyJobId, setApplyJobId] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [appliedResult, setAppliedResult] = useState<{ exportId: string; message: string; estimatedFinalSec: number } | null>(null);

  // Playback clock — a ref (frame-accurate) + throttled state for readouts.
  const playheadRef = useRef(0);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioBufferRef = useRef<AudioBuffer | null>(null);
  const playSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const playStartRef = useRef<{ ctxTime: number; segments: { src: number; dst: number; dur: number }[] } | null>(null);
  const clockRafRef = useRef<number | null>(null);
  const pendingSeekRef = useRef<number | null>(null);
  const lastSeekRestartRef = useRef(0);
  const manualScrollUntilRef = useRef(0);
  const scrubbingRef = useRef(false);
  // Latest-wins token for waveform peak requests.
  const waveRequestRef = useRef(0);

  const mediaDuration = media?.durationSec ?? 0;
  const duration = analyzed ? Math.min(mediaDuration || analyzed.durationSec, analyzed.durationSec) : mediaDuration;

  /* ------------------- words-to-remove list management ------------------- */
  const loadWords = useCallback(async () => {
    try {
      const res = await fetch("/api/autocut/words");
      if (!res.ok) return;
      const data = await res.json();
      setWordsList((data.entries ?? []).map((e: { id: string; phrase: string; note?: string | null }) => ({ id: e.id, phrase: e.phrase, note: e.note })));
    } catch {
      /* the section simply stays empty; adding shows the error */
    }
  }, []);

  useEffect(() => {
    void loadWords();
  }, [loadWords]);

  const addWord = useCallback(async () => {
    const phrase = wordInput.trim();
    if (!phrase) return;
    setWordsBusy(true);
    setWordsError(null);
    try {
      const res = await fetch("/api/autocut/words", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phrase }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setWordsError(data?.error ?? "Could not add the entry.");
        return;
      }
      setWordsList((prev) => (prev.some((e) => e.id === data.entry.id) ? prev : [...prev, data.entry]));
      setWordInput("");
    } catch {
      setWordsError("Network error while adding the entry.");
    } finally {
      setWordsBusy(false);
    }
  }, [wordInput]);

  const removeWord = useCallback(async (id: string) => {
    setWordsError(null);
    try {
      const res = await fetch(`/api/autocut/words?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setWordsError(data?.error ?? "Could not remove the entry.");
        return;
      }
      setWordsList((prev) => prev.filter((e) => e.id !== id));
    } catch {
      setWordsError("Network error while removing the entry.");
    }
  }, []);
  // Timeline B total length = original minus approved removals.
  const keptSegments = useMemo<KeptSegment[]>(() => {
    if (!duration) return [];
    const removals = normalizeRanges(
      cuts.filter((c) => c.review === "REMOVE" || c.review === "APPROVED").map((c) => ({ start: c.start, end: c.end })),
      duration
    );
    const segs: KeptSegment[] = [];
    let cursor = 0;
    let out = 0;
    for (const r of removals) {
      if (r.start - cursor > 0.005) {
        segs.push({ srcStart: cursor, srcEnd: r.start, outStart: out, outEnd: out + (r.start - cursor) });
        out += r.start - cursor;
      }
      cursor = Math.max(cursor, r.end);
    }
    if (duration - cursor > 0.005) {
      segs.push({ srcStart: cursor, srcEnd: duration, outStart: out, outEnd: out + (duration - cursor) });
      out += duration - cursor;
    }
    return segs;
  }, [cuts, duration]);

  const outputDuration = useMemo(() => (keptSegments.length ? keptSegments[keptSegments.length - 1].outEnd : 0), [keptSegments]);

  /** Source time → edited-output time. Positions inside a removed interval
   *  map to the boundary of the correct retained segment. */
  const sourceToOutput = useCallback(
    (t: number): number => {
      if (!keptSegments.length) return 0;
      if (t <= keptSegments[0].srcStart) return Math.max(0, keptSegments[0].outStart + (t - keptSegments[0].srcStart));
      for (const seg of keptSegments) {
        if (t >= seg.srcStart && t < seg.srcEnd) return seg.outStart + (t - seg.srcStart);
      }
      const last = keptSegments[keptSegments.length - 1];
      if (t >= last.srcEnd) return last.outEnd;
      // Inside a removed gap → boundary between neighbours.
      for (let i = 0; i < keptSegments.length - 1; i++) {
        if (t >= keptSegments[i].srcEnd && t < keptSegments[i + 1].srcStart) return keptSegments[i].outEnd;
      }
      return last.outEnd;
    },
    [keptSegments]
  );

  /** Edited-output time → source time (nearest retained sample). */
  const outputToSource = useCallback(
    (u: number): number => {
      if (!keptSegments.length) return 0;
      if (u <= 0) return keptSegments[0].srcStart;
      for (const seg of keptSegments) {
        if (u >= seg.outStart && u < seg.outEnd) return seg.srcStart + (u - seg.outStart);
      }
      const last = keptSegments[keptSegments.length - 1];
      if (u >= last.outEnd) return last.srcEnd;
      return last.srcStart;
    },
    [keptSegments]
  );

  // Reset everything when the selected media changes.
  useEffect(() => {
    if (rafRefCleanup()) {
      /* cleanup ran */
    }
    stopPlaybackInternal();
    videoRef.current?.pause();
    playheadRef.current = 0;
    setPlayheadDisplay(0);
    setPlaying(false);
    audioBufferRef.current = null;
    waveRequestRef.current += 1;
    if (!media) {
      setPeaksA(null);
      setPeaksLoading(false);
      setWaveError(null);
      setCuts([]);
      setTranscript([]);
      setAnalyzed(null);
      setAnalyzeNotes([]);
      setRiisheStages(INITIAL_STAGES);
      setRiisheNote(null);
      setAppliedResult(null);
      setApplyJobId(null);
      setViewStart(0);
      setViewEnd(0);
      return;
    }
    setRiisheStages({ ...INITIAL_STAGES, mediaInspection: "DONE" });
    setViewStart(0);
    setViewEnd(media.durationSec ?? 0);
    setWaveError(null);
  }, [media, mediaKey]);

  /* ------------------ waveform peaks (real audio, cached) ----------------- */
  // Loaded from /api/media/[id]/waveform (server-decoded min/max peaks, disk
  // cached) the moment media is selected — the timeline shows the ACTUAL
  // uploaded audio immediately, without waiting for any analysis. Latest
  // request wins when media changes quickly.
  useEffect(() => {
    if (!media) return;
    const req = ++waveRequestRef.current;
    setPeaksLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/media/${media.id}/waveform`);
        const data = await res.json().catch(() => null);
        if (req !== waveRequestRef.current) return;
        if (!res.ok || !data?.ok) {
          setWaveError(data?.error ?? `Waveform generation failed (${res.status}).`);
          setPeaksA(null);
        } else {
          setPeaksA({ min: Float32Array.from(data.min as number[]), max: Float32Array.from(data.max as number[]) });
        }
      } catch {
        if (req === waveRequestRef.current) setWaveError("Network error while generating the waveform.");
      } finally {
        if (req === waveRequestRef.current) setPeaksLoading(false);
      }
    })();
  }, [media, mediaKey]);

  /** Stop playback and release scheduled sources (keeps the AudioContext). */
  function stopPlaybackInternal() {
    playSourcesRef.current.forEach((s) => {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    });
    playSourcesRef.current = [];
    playStartRef.current = null;
    if (clockRafRef.current) cancelAnimationFrame(clockRafRef.current);
    clockRafRef.current = null;
  }

  function rafRefCleanup() {
    return false;
  }

  useEffect(() => {
    return () => {
      if (clockRafRef.current) cancelAnimationFrame(clockRafRef.current);
      playSourcesRef.current.forEach((s) => {
        try {
          s.stop();
        } catch {
          /* noop */
        }
      });
      void audioCtxRef.current?.close();
      audioCtxRef.current = null;
    };
  }, []);

  const markManualScroll = useCallback(() => {
    manualScrollUntilRef.current = performance.now() + 2500;
  }, []);

  /* ----------------------- server-side analysis ------------------------- */
  // THE unified RIISHE pipeline — both the REANALYZE and the RUN RIISHE
  // ANALYSIS actions run THIS function against /api/autocut/analyze, which
  // executes every stage (decode, VAD, transcription, language, alignment,
  // evidence, inference when available, validation, canonical plan) in one
  // action. There is no separate audio-only analysis path.
  // The server runs the analysis as a background job (same infrastructure as
  // the apply flow): the POST returns a jobId immediately, live stage/progress
  // arrives via /api/jobs/[id], and the full payload is fetched from the
  // result endpoint on completion. A multi-minute analysis therefore survives
  // client disconnects and gateway timeouts — the request that failed with a
  // bare `Analysis failed (502)` on long recordings.
  const handleAnalysisCompleted = useCallback((result: RiisheAnalyzeResult) => {
      setAnalysisJobId(null);
      setAnalyzing(false);
      // The dedicated waveform endpoint already loaded higher-resolution
      // peaks on media selection — only fall back to the analysis peaks when
      // they are somehow missing.
      setPeaksA((prev) => prev ?? { min: Float32Array.from(result.peaks.min), max: Float32Array.from(result.peaks.max) });
      setAnalyzed({ ...result.analysis, durationSec: result.durationSec });
      setAnalyzeNotes(result.notes);
      setViewStart(0);
      setViewEnd(result.durationSec);

      // Canonical cut plan from the server's validated candidates. The
      // provenance label comes from the server so deterministic vs semantic
      // classification always reflects what actually ran.
      const proposals: CutRange[] = result.candidates.map((c) => ({
        id: c.id,
        start: c.start,
        end: c.end,
        duration: c.duration,
        reason: c.reason,
        source: c.classificationSource === "RIISHE_INFERENCE" ? "RIISHE_INFERENCE" : c.wordMatch ? "WORDS_TO_REMOVE" : "SILENCE_ANALYSIS",
        review: c.review,
        wordMatch: c.wordMatch,
        paddingApplied: { head: settings.headPaddingSec, tail: settings.tailPaddingSec },
        audioEvidence: {
          rms: c.evidence.rms,
          noiseFloor: result.analysis.noiseFloor,
          snr: c.evidence.snr,
          windowMs: result.analysis.windowMs,
        },
        combinedEvidence: c.evidence,
        inference:
          c.classificationSource === "RIISHE_INFERENCE"
            ? { model: result.inference?.model ?? "riishe", confidence: c.confidence, notes: c.reason }
            : undefined,
      }));
      setCuts(proposals);

      // Transcript segments aligned server-side (word timings estimated).
      setTranscript(
        result.transcript.segments.map((s) => ({
          id: s.id,
          start: s.start,
          end: s.end,
          text: s.text,
          timingSource: "estimated" as const,
          words: s.words,
          energyValidated: s.energyValidated,
          boundaryJoined: s.boundaryJoined,
        }))
      );

      // The server owns the stage states: nothing is DONE unless that stage
      // actually completed in THIS action (no ready-DONE-while-pending).
      setRiisheStages({ ...result.stages });

      const stats = result.transcript.alignmentStats;
      const langNote = result.transcript.available ? ` ${result.transcript.language.description}` : "";
      const alignNote =
        result.transcript.available && stats
          ? ` Alignment: ${stats.sentenceCount} sentence segment(s) from ${stats.chunksWithText}/${stats.chunkCount} chunks (${stats.chunksSilent} silent, ${result.transcript.failedChunks.length} failed), ${stats.boundaryJoins} chunk-boundary join(s), ${stats.energyValidated}/${stats.sentenceCount} energy-validated${stats.anchored ? `, ${stats.anchored} anchored` : ""}.`
          : "";
      const planNote = `Canonical plan: ${result.plan.removals.length} removal interval(s), ${result.plan.removedSec.toFixed(2)}s → final ${formatDuration(result.plan.finalDurationSec)}.`;
      setRiisheNote(
        `${proposals.length} evidence-based candidate(s). ${planNote}${alignNote}${langNote} ${result.inferenceNote ?? ""}${
          result.notes.length ? ` ${result.notes[0]}` : ""
        }`.trim()
      );
  }, [settings, windowMs]);

  const runAnalysis = useCallback(async () => {
    if (!media) return;
    setAnalyzing(true);
    setAnalysisError(null);
    setAppliedResult(null);
    setApplyJobId(null);
    try {
      const res = await fetch("/api/autocut/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mediaId: media.id,
          settings: { ...settings, windowMs },
          wordsToRemove: wordsList.map((w) => w.phrase),
        }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; jobId?: string } | (ApiErrorBody) | null;
      if (!res.ok || !data || !("ok" in data) || !data.ok) {
        throw new Error((data as ApiErrorBody)?.error ?? `Analysis failed (${res.status}).`);
      }
      const jobId = (data as { jobId?: string }).jobId;
      if (!jobId) throw new Error("The analysis endpoint did not return a job id.");
      setAnalysisJobId(jobId);
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : "Analysis failed.");
      setAnalyzing(false);
    }
  }, [media, settings, windowMs, wordsList]);

  const handleAnalysisFailed = useCallback((error: string) => {
    setAnalysisJobId(null);
    setAnalyzing(false);
    setAnalysisError(error);
  }, []);

  /* ----------------------------- playback ------------------------------- */
  // Preview decode budget: a 20-minute 48 kHz stereo file decoded at full
  // rate is ~470 MB of Float32 samples. The preview decodes at 24 kHz and
  // mixes to mono (~59 MB) — exports always process the ORIGINAL file via
  // ffmpeg, so preview fidelity never affects output quality.
  const PREVIEW_SAMPLE_RATE = 24000;
  const ensureBuffer = useCallback(async (): Promise<AudioBuffer | null> => {
    if (audioBufferRef.current) return audioBufferRef.current;
    if (!media) return null;
    setBufferLoading(true);
    try {
      const res = await fetch(`/api/media/${media.id}/file`);
      if (!res.ok) throw new Error(`Failed to load media (${res.status}).`);
      const blob = await res.blob();
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      let ctx = audioCtxRef.current;
      if (!ctx) {
        try {
          ctx = new Ctx({ sampleRate: PREVIEW_SAMPLE_RATE });
        } catch {
          ctx = new Ctx();
        }
        audioCtxRef.current = ctx;
      }
      if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
      const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
      let buffer = decoded;
      if (decoded.numberOfChannels > 1) {
        const mono = ctx.createBuffer(1, decoded.length, decoded.sampleRate);
        const out = mono.getChannelData(0);
        const channels = decoded.numberOfChannels;
        for (let ch = 0; ch < channels; ch++) {
          const data = decoded.getChannelData(ch);
          for (let i = 0; i < out.length; i++) out[i] += data[i] / channels;
        }
        buffer = mono;
      }
      audioBufferRef.current = buffer;
      return buffer;
    } finally {
      setBufferLoading(false);
    }
  }, [media]);

  /** Start preview playback (skipping approved removals) from a source time. */
  const startPlaybackFrom = useCallback(
    (fromSrc: number) => {
      const buffer = audioBufferRef.current;
      const ctx = audioCtxRef.current;
      if (!buffer || !ctx || !duration) return;
      stopPlaybackInternal();

      const removals = normalizeRanges(
        cuts.filter((c) => c.review === "REMOVE" || c.review === "APPROVED").map((c) => ({ start: c.start, end: c.end })),
        buffer.duration
      );
      // Kept regions with output positions, then skip to the segment holding fromSrc.
      const kept: { src: number; dst: number; dur: number }[] = [];
      let cursor = 0;
      let dst = 0;
      for (const r of removals) {
        if (r.start > cursor + 0.01) {
          kept.push({ src: cursor, dst, dur: r.start - cursor });
          dst += r.start - cursor;
        }
        cursor = Math.max(cursor, r.end);
      }
      if (buffer.duration - cursor > 0.01) {
        kept.push({ src: cursor, dst, dur: buffer.duration - cursor });
      }
      if (!kept.length) return;

      // If fromSrc lands inside a removal, resume at the next retained sample.
      let segIdx = kept.findIndex((s) => fromSrc >= s.src && fromSrc < s.src + s.dur);
      if (segIdx === -1) {
        segIdx = kept.findIndex((s) => s.src > fromSrc);
        if (segIdx === -1) {
          // Past the end → stop cleanly at the media end.
          playheadRef.current = duration;
          setPlayheadDisplay(duration);
          setPlaying(false);
          return;
        }
        fromSrc = kept[segIdx].src;
      }

      const startAt = ctx.currentTime + 0.06;
      const offsetInSeg = fromSrc - kept[segIdx].src;
      const shifted = kept.slice(segIdx).map((s, i) =>
        i === 0 ? { ...s, src: fromSrc, dur: s.dur - offsetInSeg, dst: s.dst + offsetInSeg } : s
      );
      const sources: AudioBufferSourceNode[] = [];
      for (const seg of shifted) {
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        src.start(startAt + (seg.dst - shifted[0].dst), seg.src, seg.dur);
        sources.push(src);
      }
      playSourcesRef.current = sources;
      playStartRef.current = { ctxTime: startAt, segments: shifted };
      setPlaying(true);

      // Clock loop: advances playheadRef every frame, stops at media end.
      const total = shifted.reduce((a, s) => a + s.dur, 0);
      let lastPaint = 0;
      const tick = () => {
        const st = playStartRef.current;
        const actx = audioCtxRef.current;
        if (!st || !actx) return;
        const elapsed = actx.currentTime - st.ctxTime;
        let t = shifted[shifted.length - 1].src + shifted[shifted.length - 1].dur;
        if (elapsed < total) {
          for (const seg of st.segments) {
            if (elapsed <= seg.dst - st.segments[0].dst + seg.dur) {
              t = seg.src + Math.max(0, elapsed - (seg.dst - st.segments[0].dst));
              break;
            }
          }
        } else {
          playheadRef.current = Math.min(t, duration);
          setPlayheadDisplay(playheadRef.current);
          setPlaying(false);
          playStartRef.current = null;
          clockRafRef.current = null;
          return;
        }
        playheadRef.current = Math.min(Math.max(0, t), duration);
        const now = performance.now();
        if (now - lastPaint > 100) {
          lastPaint = now;
          setPlayheadDisplay(playheadRef.current);
        }
        clockRafRef.current = requestAnimationFrame(tick);
      };
      clockRafRef.current = requestAnimationFrame(tick);
    },
    [cuts, duration]
  );

  /** Approved removals as a plain sorted list (playback skip logic). */
  const removalsRef = useRef<{ start: number; end: number }[]>([]);
  useEffect(() => {
    removalsRef.current = normalizeRanges(
      cuts.filter((c) => c.review === "REMOVE" || c.review === "APPROVED").map((c) => ({ start: c.start, end: c.end })),
      Math.max(duration, 0.001)
    );
  }, [cuts, duration]);

  /** Audition exactly one candidate range (±0.5 s of context) on the same
   *  playback clock. The playhead follows the real clock and stops at the
   *  range end — the affected audio is heard before any classification. */
  const playRange = useCallback(async (start: number, end: number) => {
    if (isVideoMedia) {
      const v = videoRef.current;
      if (!v) return;
      v.pause();
      const from = Math.max(0, start - 0.5);
      const stopAt = Math.min(end + 0.5, Math.max(duration, 0.01));
      v.currentTime = from;
      playheadRef.current = from;
      setPlayheadDisplay(from);
      try {
        await v.play();
        setPlaying(true);
      } catch {
        setPlaying(false);
        return;
      }
      const check = () => {
        const vv = videoRef.current;
        if (!vv || !playing) return;
        if (vv.currentTime >= stopAt || vv.ended) {
          vv.pause();
          setPlaying(false);
          return;
        }
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
      return;
    }
    const buffer = await ensureBuffer();
    const ctx = audioCtxRef.current;
    if (!buffer || !ctx) return;
    if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
    stopPlaybackInternal();
    const from = Math.max(0, start - 0.5);
    const to = Math.min(end + 0.5, buffer.duration);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    const startAt = ctx.currentTime + 0.03;
    src.start(startAt, from, to - from);
    playSourcesRef.current = [src];
    src.onended = () => {
      if (playSourcesRef.current.includes(src)) {
        playSourcesRef.current = [];
        setPlaying(false);
      }
    };
    playheadRef.current = from;
    setPlayheadDisplay(from);
    setPlaying(true);
    let lastPaint = 0;
    const total = to - from;
    const tick = () => {
      const actx = audioCtxRef.current;
      if (!actx) return;
      const elapsed = actx.currentTime - startAt;
      if (elapsed >= total) {
        playheadRef.current = to;
        setPlayheadDisplay(to);
        setPlaying(false);
        playSourcesRef.current = [];
        clockRafRef.current = null;
        return;
      }
      playheadRef.current = Math.min(Math.max(0, from + Math.max(0, elapsed)), duration);
      const now = performance.now();
      if (now - lastPaint > 100) {
        lastPaint = now;
        setPlayheadDisplay(playheadRef.current);
      }
      clockRafRef.current = requestAnimationFrame(tick);
    };
    clockRafRef.current = requestAnimationFrame(tick);
  }, [isVideoMedia, ensureBuffer, duration, playing]);

  /** Jump out of an approved removal (nearest kept material after it). */
  const skipOutOfRemovals = useCallback((t: number): number => {
    let out = t;
    for (let guard = 0; guard < 8; guard++) {
      const hit = removalsRef.current.find((r) => out >= r.start - 1e-6 && out < r.end - 1e-6);
      if (!hit) break;
      out = hit.end;
    }
    return Math.min(out, Math.max(0, duration));
  }, [duration]);

  // Video clock loop: the <video> element plays; the playhead follows it and
  // approved removals are skipped by jumping. Audio comes from the video
  // element itself, so A/V stay synchronized by construction.
  useEffect(() => {
    if (!isVideoMedia || !playing) return;
    let raf = 0;
    let lastPaint = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v) {
        let t = v.currentTime;
        const skipped = skipOutOfRemovals(t);
        if (skipped - t > 0.02) {
          v.currentTime = skipped;
          t = skipped;
        }
        playheadRef.current = t;
        const now = performance.now();
        if (now - lastPaint > 100) {
          lastPaint = now;
          setPlayheadDisplay(t);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const v = videoRef.current;
    const onEnded = () => {
      setPlaying(false);
      playheadRef.current = duration;
      setPlayheadDisplay(duration);
    };
    v?.addEventListener("ended", onEnded);
    return () => {
      cancelAnimationFrame(raf);
      v?.removeEventListener("ended", onEnded);
    };
  }, [isVideoMedia, playing, skipOutOfRemovals, duration]);

  const previewPlayback = useCallback(async () => {
    if (isVideoMedia) {
      const v = videoRef.current;
      if (!v) return;
      if (playing) {
        v.pause();
        setPlaying(false);
        return;
      }
      const from = playheadRef.current >= duration - 0.05 ? 0 : playheadRef.current;
      const target = skipOutOfRemovals(from);
      if (Math.abs(v.currentTime - target) > 0.03) v.currentTime = target;
      playheadRef.current = target;
      setPlayheadDisplay(target);
      try {
        await v.play();
        setPlaying(true);
      } catch {
        setPlaying(false);
      }
      return;
    }
    if (playing) {
      stopPlaybackInternal();
      setPlaying(false);
      return;
    }
    const buffer = await ensureBuffer();
    const ctx = audioCtxRef.current;
    if (!buffer || !ctx) return;
    if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
    startPlaybackFrom(playheadRef.current >= duration - 0.05 ? 0 : playheadRef.current);
  }, [isVideoMedia, playing, ensureBuffer, startPlaybackFrom, duration, skipOutOfRemovals]);

  /** Seek / scrub — playhead follows continuously, no stale-position race:
   *  during playback the sources restart (throttled) from the new position. */
  const seekTo = useCallback(
    (t: number) => {
      let clamped = Math.min(Math.max(0, t), Math.max(0, duration));
      // Seeking into an approved removal lands on the next kept sample —
      // same behavior as the preview playback skip.
      if (cuts.some((c) => c.review === "REMOVE" || c.review === "APPROVED")) clamped = skipOutOfRemovals(clamped);
      playheadRef.current = clamped;
      setPlayheadDisplay(clamped);
      if (isVideoMedia) {
        const v = videoRef.current;
        if (v && Math.abs(v.currentTime - clamped) > 0.03) v.currentTime = clamped;
        return;
      }
      if (playing) {
        pendingSeekRef.current = clamped;
        const now = performance.now();
        if (now - lastSeekRestartRef.current > 120) {
          lastSeekRestartRef.current = now;
          pendingSeekRef.current = null;
          startPlaybackFrom(clamped);
        }
      }
    },
    [playing, startPlaybackFrom, duration, isVideoMedia, cuts, skipOutOfRemovals]
  );

  // Apply a pending scrub position that arrived while restart-throttled.
  useEffect(() => {
    if (!playing && pendingSeekRef.current !== null) {
      const t = pendingSeekRef.current;
      pendingSeekRef.current = null;
      startPlaybackFrom(t);
    }
  }, [playing, startPlaybackFrom]);

  const onScrubStart = useCallback(() => {
    scrubbingRef.current = true;
    setScrubbing(true);
  }, []);

  const onScrubMove = useCallback(
    (t: number) => {
      seekTo(t);
      // Follow the playhead near the edges while dragging.
      followProbe(t);
    },
    [seekTo]
  );

  const onScrubEnd = useCallback(
    (_t: number) => {
      scrubbingRef.current = false;
      setScrubbing(false);
      if (playing && pendingSeekRef.current !== null) {
        const t = pendingSeekRef.current;
        pendingSeekRef.current = null;
        startPlaybackFrom(t);
      }
    },
    [playing, startPlaybackFrom]
  );

  /* ------------------------- zoom & auto-follow -------------------------- */
  // Live mirror of the view window. Zoom reads and writes it synchronously so
  // rapid wheel bursts (several zoom events before React re-renders) compose
  // correctly instead of repeating one step from a stale closure.
  const viewRef = useRef({ start: 0, end: 0 });
  useEffect(() => {
    viewRef.current = { start: viewStart, end: viewEnd };
  }, [viewStart, viewEnd]);

  const zoomAt = useCallback(
    (factor: number, centerT: number, anchorFrac?: number) => {
      if (!duration) return;
      markManualScroll();
      const { start, end } = viewRef.current;
      const oldDur = Math.max(0.01, end - start);
      const frac = anchorFrac ?? Math.max(0, Math.min(1, (centerT - start) / oldDur));
      const newDur = Math.max(0.25, Math.min(duration, oldDur * factor));
      // The anchor keeps its exact source timestamp in the zoomed view.
      let s = centerT - frac * newDur;
      let e = s + newDur;
      if (s < 0) {
        s = 0;
        e = newDur;
      }
      if (e > duration) {
        e = duration;
        s = Math.max(0, duration - newDur);
      }
      viewRef.current = { start: s, end: e };
      setViewStart(s);
      setViewEnd(e);
    },
    [duration, markManualScroll]
  );

  const followProbe = useCallback(
    (t: number) => {
      const active = playing || scrubbingRef.current;
      if (!active) return;
      if (performance.now() < manualScrollUntilRef.current) return; // never fight manual scrolling
      const { start, end } = viewRef.current;
      const viewDur = Math.max(0.01, end - start);
      if (t > start + viewDur * 0.92 || t < start) {
        // Page-flip: keep the playhead a quarter window from the left edge.
        const s = Math.max(0, Math.min(duration - viewDur, t - viewDur * 0.25));
        setViewStart(s);
        setViewEnd(Math.min(duration, s + viewDur));
      }
    },
    [playing, duration]
  );

  /* --------------------------- derived state ---------------------------- */
  const summary: CutPlanSummary | null = useMemo(() => {
    if (!duration) return null;
    const removeCuts = cuts.filter((c) => c.review === "REMOVE");
    const approvedRemoved = normalizeRanges(removeCuts.map((c) => ({ start: c.start, end: c.end })), duration);
    const approvedSec = approvedRemoved.reduce((a, r) => a + (r.end - r.start), 0);
    const proposedSec = cuts.filter((c) => c.review !== "KEEP").reduce((a, c) => a + c.duration, 0);
    const finalEst = Math.max(0, duration - approvedSec);
    return {
      originalDurationSec: duration,
      proposedRemovedSec: proposedSec,
      approvedRemovedSec: approvedSec,
      appliedRemovedSec: appliedResult ? duration - appliedResult.estimatedFinalSec : 0,
      finalEstimatedSec: appliedResult ? appliedResult.estimatedFinalSec : finalEst,
      proposedCount: cuts.length,
      approvedCount: removeCuts.length,
      appliedCount: appliedResult ? removeCuts.length : 0,
      keptPercent: duration > 0 ? (finalEst / duration) * 100 : 100,
      removedPercent: duration > 0 ? (approvedSec / duration) * 100 : 0,
    };
  }, [cuts, duration, appliedResult]);

  const waveCuts: WaveCuts[] = useMemo(
    () =>
      cuts.map((c) => ({
        id: c.id,
        start: c.start,
        end: c.end,
        status:
          c.review === "REMOVE"
            ? "REMOVE"
            : c.review === "APPROVED"
              ? "APPROVED_REMOVE"
              : c.review === "REVIEW"
                ? "REVIEW"
                : "KEEP",
      })),
    [cuts]
  );

  // Timeline B waveform: the kept regions of the source peaks, spliced in
  // output order — the real approved plan, not a decorative copy.
  const peaksB = useMemo<{ min: Float32Array; max: Float32Array } | null>(() => {
    if (!peaksA || !outputDuration) return null;
    const n = peaksA.max.length;
    const buckets = n;
    const min = new Float32Array(buckets);
    const max = new Float32Array(buckets);
    for (let b = 0; b < buckets; b++) {
      const u0 = (b / buckets) * outputDuration;
      const u1 = ((b + 1) / buckets) * outputDuration;
      const s0 = outputToSource(u0);
      const s1 = outputToSource(u1);
      const i0 = Math.min(n - 1, Math.floor((s0 / Math.max(duration, 0.001)) * n));
      const i1 = Math.min(n, Math.max(i0 + 1, Math.ceil((s1 / Math.max(duration, 0.001)) * n)));
      let mn = 1;
      let mx = -1;
      for (let i = i0; i < i1; i++) {
        if (peaksA.min[i] < mn) mn = peaksA.min[i];
        if (peaksA.max[i] > mx) mx = peaksA.max[i];
      }
      min[b] = mn === 1 ? 0 : mn;
      max[b] = mx === -1 ? 0 : mx;
    }
    return { min, max };
  }, [peaksA, outputDuration, outputToSource, duration]);

  /* ------------------------------ apply --------------------------------- */
  const startApply = useCallback(async () => {
    if (!media || !summary) return;
    const approved = cuts.filter((c) => c.review === "REMOVE");
    if (!approved.length) return;
    setApplyError(null);
    try {
      // Send the canonical UNION of approved intervals so the export exactly
      // equals the displayed plan: final = original − union(approved). The
      // server re-validates and rejects overlapping ranges.
      const union = normalizeRanges(
        approved.map((c) => ({ start: c.start, end: c.end })),
        duration
      );
      const res = await fetch("/api/process/autocut", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mediaId: media.id,
          cuts: union,
          outputFormat: media.kind === "VIDEO" ? "mp4" : "wav",
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setApplyError(data?.error ?? `Apply failed (${res.status}).`);
        return;
      }
      setApplyOpen(false);
      setApplyJobId(data.jobId);
      setAppliedResult({
        exportId: "",
        message: "",
        estimatedFinalSec: data.estimatedFinalSec,
      });
      setCuts((prev) => prev.map((c) => (c.review === "REMOVE" ? { ...c, review: "APPROVED" } : c)));
    } catch {
      setApplyError("Network error while starting the apply job.");
    }
  }, [media, cuts, summary, duration]);

  const setCutReview = (id: string, review: CutRange["review"]) =>
    setCuts((prev) => prev.map((c) => (c.id === id ? { ...c, review } : c)));

  const deleteCut = (id: string) => setCuts((prev) => prev.filter((c) => c.id !== id));

  const updateCutBounds = (id: string, start: number, end: number) =>
    setCuts((prev) =>
      prev.map((c) =>
        c.id === id && Number.isFinite(start) && Number.isFinite(end) && end > start && start >= 0 && end <= duration
          ? { ...c, start: round3(start), end: round3(end), duration: round3(end - start) }
          : c
      )
    );

  const isLive = playing || scrubbing;
  const livePlayhead = useCallback(() => playheadRef.current, []);

  return (
    <ToolShell
      user={user}
      onLogout={onLogout}
      route="/autocut"
      label="AUTO CUT"
      title="Silence removal and cut planning"
      description="Analyze the real waveform, review evidence-backed proposals, and approve every cut before it is applied. Your original recording is never modified."
    >
      <div className="grid gap-5 lg:grid-cols-[340px_1fr]">
        {/* LEFT: import + settings */}
        <div className="flex flex-col gap-4">
          <section className="rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
            <h2 className="bean-label text-[10px] text-[#8f8f8a]">1 · SELECTED MEDIA</h2>
            <div className="mt-3">
              {/* Dedicated import happens on the Auto Cut upload page; the
                  editor only shows the selected media and an intentional
                  "change media" action. */}
              {media ? (
                <p className="text-[12px] leading-relaxed text-[#9a9a94]">
                  <span className="font-semibold text-white">{media.originalName}</span> — {formatDuration(media.durationSec)}
                  {media.audioCodec ? `, ${media.audioCodec}` : ""}
                  {media.sampleRate ? ` @ ${media.sampleRate} Hz` : ""}.
                </p>
              ) : (
                <p className="text-[12px] text-[#7a7a76]">No media selected.</p>
              )}
              <a href="#/autocut" className="mt-2 inline-flex h-8 items-center rounded-md border border-[#2a2a2a] px-3 text-[10px] font-extrabold uppercase tracking-wider text-[#9a9a94] hover:border-[#d4a017]/50 hover:text-white">
                Change media
              </a>
            </div>
            {media && (
              <p className="mt-3 text-[11px] leading-relaxed text-[#8f8f8a]">
                Selected: <span className="font-semibold text-white">{media.originalName}</span> — {formatDuration(media.durationSec)}
                {media.audioCodec ? `, ${media.audioCodec}` : ""}
                {media.sampleRate ? ` @ ${media.sampleRate} Hz` : ""}.
              </p>
            )}
            {bufferLoading && (
              <p className="mt-2 flex items-center gap-2 text-xs text-[#d4a017]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Preparing preview audio…
              </p>
            )}
            {analysisError && (
              <p className="mt-2 rounded-md border border-[#3b1515] bg-[#1a0d0d] px-3 py-2 text-xs text-[#f87171]">
                {analysisError}
              </p>
            )}
          </section>

          <section className="rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
            <h2 className="bean-label text-[10px] text-[#8f8f8a]">2 · ANALYSIS SETTINGS</h2>
            <div className="mt-3 flex flex-col gap-3.5">
              <NumberField
                label="MINIMUM SILENCE (S)"
                hint="Silences shorter than this are never eligible."
                value={settings.minSilenceSec}
                min={0.1}
                max={10}
                step={0.05}
                onChange={(v) => setSettings((s) => ({ ...s, minSilenceSec: v }))}
              />
              <NumberField
                label="HEAD PADDING (S)"
                hint="Material kept before speech resumes."
                value={settings.headPaddingSec}
                min={0}
                max={2}
                step={0.05}
                onChange={(v) => setSettings((s) => ({ ...s, headPaddingSec: v }))}
              />
              <NumberField
                label="TAIL PADDING (S)"
                hint="Material kept after speech ends."
                value={settings.tailPaddingSec}
                min={0}
                max={2}
                step={0.05}
                onChange={(v) => setSettings((s) => ({ ...s, tailPaddingSec: v }))}
              />
              <NumberField
                label="TARGET PAUSE (S)"
                hint="Intended remaining pause when shortening is valid."
                value={settings.targetPauseSec}
                min={0.05}
                max={3}
                step={0.05}
                onChange={(v) => setSettings((s) => ({ ...s, targetPauseSec: v }))}
              />
              <NumberField
                label={`ANALYSIS WINDOW (MS)`}
                hint="Short-term RMS window used for detection (10 ms default)."
                value={windowMs}
                min={5}
                max={50}
                step={1}
                onChange={(v) => setWindowMs(Math.round(v))}
              />
              <div>
                <span className="bean-label text-[10px] text-[#8f8f8a]">SENSITIVITY</span>
                <div className="mt-2 grid grid-cols-3 gap-1.5">
                  {(["LOW", "BALANCED", "HIGH"] as SensitivityProfile[]).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setSettings((p) => ({ ...p, sensitivity: s }))}
                      className={cn(
                        "rounded-md border px-2 py-2 text-[10px] font-extrabold uppercase tracking-wider transition-colors",
                        settings.sensitivity === s
                          ? "border-[#d4a017] bg-[#191307] text-[#d4a017]"
                          : "border-[#242424] bg-[#111] text-[#8f8f8a] hover:border-[#333]"
                      )}
                    >
                      {s}
                    </button>
                  ))}
                </div>
                <p className="mt-1.5 text-[11px] leading-relaxed text-[#7a7a76]">
                  {settings.sensitivity === "LOW"
                    ? "Conservative — only clear, sustained silence is eligible; more pauses are kept."
                    : settings.sensitivity === "BALANCED"
                      ? "Practical general-purpose editing — typical pauses are shortened."
                      : "Aggressive — even low-level room tone may be shortened; speech is still preserved."}
                </p>
              </div>
              <label className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={settings.tightenSentencePauses}
                  onChange={(e) => setSettings((p) => ({ ...p, tightenSentencePauses: e.target.checked }))}
                  className="mt-0.5 h-4 w-4 accent-[#d4a017]"
                />
                <span>
                  <span className="block text-xs font-semibold text-white">Tighten sentence pauses</span>
                  <span className="block text-[11px] leading-relaxed text-[#7a7a76]">
                    Shorten eligible pauses to the target pause. When off, only silences longer than the minimum are
                    proposed and no shrinking to a target is applied.
                  </span>
                </span>
              </label>

              <label className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={settings.builtinFillers !== false}
                  onChange={(e) => setSettings((p) => ({ ...p, builtinFillers: e.target.checked }))}
                  className="mt-0.5 h-4 w-4 accent-[#d4a017]"
                />
                <span>
                  <span className="block text-xs font-semibold text-white">Flag built-in filler words</span>
                  <span className="block text-[11px] leading-relaxed text-[#7a7a76]">
                    Matches from the built-in multilingual filler lexicon (um, uh, you know… plus Tamil and Tanglish
                    discourse fillers) are added as REVIEW candidates — never REMOVE. Your own words list below keeps
                    full context-aware classification.
                  </span>
                </span>
              </label>

              <div className="flex flex-col gap-2">
                {/* THE single analysis entry point. RIISHE orchestrates every
                    stage server-side (inspection → extraction → decode →
                    features → VAD → segmentation → ASR → alignment → language
                    → fillers → repetitions → pauses → content-aware
                    classification → validation → review plan); this one
                    action runs the whole pipeline. */}
                {analysisJobId && (
                  <AnalysisJobProgress
                    jobId={analysisJobId}
                    onComplete={(result) => handleAnalysisCompleted(result as RiisheAnalyzeResult)}
                    onFail={handleAnalysisFailed}
                  />
                )}
                <button
                  type="button"
                  disabled={!media || analyzing || Boolean(analysisJobId)}
                  onClick={runAnalysis}
                  className="bean-glow inline-flex h-10 items-center justify-center gap-2 rounded-md bg-[#d4a017] text-[11px] font-extrabold uppercase tracking-[0.14em] text-[#0c0c0c] hover:bg-[#e9b52a] disabled:opacity-40"
                >
                  {analyzing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Brain className="h-4 w-4" />}
                  {analyzed ? "REANALYZE WITH RIISHE" : "ANALYZE WITH RIISHE"}
                </button>
                <p className="text-[10px] leading-relaxed text-[#5c5c58]">
                  RIISHE is the only analysis engine: one action runs the complete pipeline on the server and reports
                  every stage truthfully — transcription, language detection, speech alignment and content-aware
                  classification run when the provider is available and are reported as unavailable when it is not.
                  Deterministic, evidence-based suggestions always stand, labeled as such.
                </p>
              </div>
            </div>
          </section>

          {/* Words to remove — the user's context-aware removal preferences. */}
          <section className="rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
            <h2 className="bean-label text-[10px] text-[#8f8f8a]">3 · WORDS TO REMOVE</h2>
            <p className="mt-2 text-[11px] leading-relaxed text-[#7a7a76]">
              Words and phrases RIISHE should consider removing — fillers, verbal habits, unwanted expressions. Every
              occurrence is matched case-insensitively (any script) and judged in context: a standalone filler may
              become a REMOVE candidate, the same word doing real work in a sentence is kept or flagged for review.
              Matches are proposals only — nothing is cut without your approval, and a sentence is never removed
              because one unwanted word appears in it.
            </p>
            <div className="mt-3 flex gap-2">
              <input
                type="text"
                value={wordInput}
                onChange={(e) => setWordInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void addWord();
                  }
                }}
                placeholder="e.g. um — மறுபடியும் — actually you know"
                className="h-9 flex-1 rounded-md border border-[#2a2a2a] bg-[#121212] px-3 text-sm text-white placeholder:text-[#4a4a46] focus:border-[#d4a017] focus:outline-none"
                aria-label="Add a word or phrase to remove"
              />
              <button
                type="button"
                disabled={!wordInput.trim() || wordsBusy}
                onClick={() => void addWord()}
                className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[#2e2410] bg-[#141007] px-3 text-[10px] font-extrabold uppercase tracking-wider text-[#d4a017] hover:bg-[#191307] disabled:opacity-40"
              >
                {wordsBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} ADD
              </button>
            </div>
            {wordsError && (
              <p className="mt-2 rounded-md border border-[#3b1515] bg-[#1a0d0d] px-3 py-2 text-xs text-[#f87171]">{wordsError}</p>
            )}
            {wordsList.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {wordsList.map((w) => (
                  <span
                    key={w.id}
                    className="inline-flex items-center gap-1.5 rounded-full border border-[#2e2410] bg-[#141007] py-1 pl-3 pr-1.5 text-[11px] text-[#e9d9a8]"
                  >
                    {w.phrase}
                    <button
                      type="button"
                      onClick={() => void removeWord(w.id)}
                      className="rounded-full p-0.5 text-[#8f8f8a] hover:bg-[#2a1212] hover:text-[#f87171]"
                      aria-label={`Remove entry ${w.phrase}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-[11px] text-[#5c5c58]">
                No entries yet. The list is saved to your account and applied on the next analysis.
              </p>
            )}
          </section>

          {/* RIISHE pipeline stages (truthful) */}
          {(analyzed || riisheStages.transcription !== "PENDING") && (
            <section className="rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
              <h2 className="bean-label text-[10px] text-[#8f8f8a]">RIISHE PIPELINE</h2>
              <ol className="mt-3 flex flex-col gap-1.5">
                {(
                  [
                    ...STAGE_LABELS.map(([key, label]) => [label, riisheStages[key]] as [string, StageState]),
                  ] as [string, StageState][]
                ).map(([label, state]) => (
                  <li key={label} className="flex items-center justify-between text-[11px]">
                    <span className="text-[#9a9a94]">{label}</span>
                    <StageBadge state={state} />
                  </li>
                ))}
              </ol>
              {riisheNote && (
                <p className="mt-3 rounded-md border border-[#2e2410] bg-[#161007] px-3 py-2 text-[11px] leading-relaxed text-[#d4a017]">
                  {riisheNote}
                </p>
              )}
            </section>
          )}
        </div>

        {/* RIGHT: timeline + cuts */}
        <div className="flex flex-col gap-4">
          <section className="rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="bean-label text-[10px] text-[#8f8f8a]">TIMELINE</h2>
              <div className="flex items-center gap-1.5">
                <span className="mr-1 font-mono text-[10px] text-[#8f8f8a]" aria-label="Current playhead position">
                  {formatPrecise(playheadDisplay)} / {formatDuration(duration)}
                </span>
                <button
                  type="button"
                  onClick={() => zoomAt(0.5, playheadRef.current)}
                  disabled={!media}
                  className="inline-flex h-7 items-center gap-1 rounded border border-[#242424] bg-[#111] px-2 text-[10px] font-bold text-[#9a9a94] hover:text-white disabled:opacity-40"
                >
                  <ZoomIn className="h-3 w-3" /> ZOOM IN
                </button>
                <button
                  type="button"
                  onClick={() => zoomAt(2, playheadRef.current)}
                  disabled={!media}
                  className="inline-flex h-7 items-center gap-1 rounded border border-[#242424] bg-[#111] px-2 text-[10px] font-bold text-[#9a9a94] hover:text-white disabled:opacity-40"
                >
                  <ZoomOut className="h-3 w-3" /> OUT
                </button>
                <button
                  type="button"
                  onClick={() => {
                    markManualScroll();
                    setViewStart(0);
                    setViewEnd(duration);
                  }}
                  disabled={!media}
                  className="inline-flex h-7 items-center gap-1 rounded border border-[#242424] bg-[#111] px-2 text-[10px] font-bold text-[#9a9a94] hover:text-white disabled:opacity-40"
                >
                  <RotateCcw className="h-3 w-3" /> FIT
                </button>
                <button
                  type="button"
                  onClick={previewPlayback}
                  disabled={!media}
                  className="inline-flex h-7 items-center gap-1 rounded border border-[#d4a017]/40 bg-[#191307] px-2 text-[10px] font-bold text-[#d4a017] hover:bg-[#221a08] disabled:opacity-40"
                >
                  {playing ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                  {playing ? "STOP" : "PREVIEW (SKIP REMOVED)"}
                </button>
              </div>
            </div>
            {media ? (
              <>
                {/* Video media: synchronized preview above the audio tracks.
                    The video element IS the playback clock (audio comes from
                    it), so seeking and removal-skipping keep A/V in sync. */}
                {isVideoMedia && (
                  <video
                    ref={videoRef}
                    src={`/api/media/${media.id}/file`}
                    playsInline
                    preload="metadata"
                    className="mb-3 max-h-[320px] w-full rounded-lg border border-[#1c1c1c] bg-black"
                  />
                )}
                <Waveform
                  peaks={peaksA}
                  duration={duration}
                  viewStart={viewStart}
                  viewEnd={viewEnd}
                  onSeek={seekTo}
                  cuts={waveCuts}
                  playhead={playheadDisplay}
                  peaksLoading={peaksLoading}
                  peaksError={waveError}
                  playheadLive={isLive ? livePlayhead : undefined}
                  playing={isLive}
                  onScrubStart={onScrubStart}
                  onScrub={onScrubMove}
                  onScrubEnd={onScrubEnd}
                  onWheelZoom={(factor, centerTime) => zoomAt(factor, centerTime)}
                  onFollowProbe={followProbe}
                  height={150}
                />
                <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-[#7a7a76]">
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-sm bg-[#ef4444]/60" /> REMOVE — proposed cuts only
                  </span>
                  <span>Everything else is preserved · REVIEW candidates live in the panel below</span>
                  <span>Drag anywhere to move the playhead · scroll to zoom around the pointer · click to seek</span>
                </div>

                {/* Timeline B — edited output (approved cuts applied). */}
                <div className="mt-4">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <h2 className="bean-label text-[10px] text-[#8f8f8a]">EDITED OUTPUT — APPROVED CUTS APPLIED</h2>
                    <span className="font-mono text-[10px] text-[#8f8f8a]">
                      {formatDuration(outputDuration)} kept
                    </span>
                  </div>
                  <Waveform
                    peaks={peaksB}
                    duration={outputDuration || 0.001}
                    viewStart={Math.min(sourceToOutput(viewStart), Math.max(0, outputDuration - 0.01))}
                    viewEnd={Math.max(Math.min(sourceToOutput(viewEnd), outputDuration), Math.min(sourceToOutput(viewStart), Math.max(0, outputDuration - 0.01)) + 0.01)}
                    onSeek={(outT) => seekTo(outputToSource(outT))}
                    cuts={[]}
                    peaksLoading={peaksLoading}
                    peaksError={waveError}
                    playhead={sourceToOutput(playheadDisplay)}
                    playheadLive={isLive ? () => sourceToOutput(playheadRef.current) : undefined}
                    playing={isLive}
                    height={110}
                  />
                  <p className="mt-2 text-[10px] text-[#7a7a76]">
                    Timeline B shows the approved plan: removed ranges are gone, retained segments play in order.
                    Seeking either timeline maps the position to the other.
                  </p>
                </div>
              </>
            ) : (
              <div className="flex h-[150px] items-center justify-center rounded-lg border border-dashed border-[#242424] text-xs text-[#5c5c58]">
                Import media to see the waveform
              </div>
            )}
          </section>

          {/* Summary */}
          {summary && (
            <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <SummaryTile label="ORIGINAL" value={formatDuration(summary.originalDurationSec)} />
              <SummaryTile label="PROPOSED CUTS" value={String(summary.proposedCount)} sub={formatDuration(summary.proposedRemovedSec)} />
              <SummaryTile
                label="APPROVED CUTS"
                value={String(summary.approvedCount)}
                sub={formatDuration(summary.approvedRemovedSec)}
              />
              <SummaryTile
                label={appliedResult?.exportId ? "FINAL (APPLIED)" : "FINAL (ESTIMATED)"}
                value={formatDuration(summary.finalEstimatedSec)}
                sub={`${summary.removedPercent.toFixed(1)}% removed`}
                accent
              />
            </section>
          )}

          {analysisError && (
            <p className="rounded-md border border-[#3b1515] bg-[#1a0d0d] px-3 py-2 text-xs text-[#f87171]">{analysisError}</p>
          )}

          {/* Cut list */}
          <section className="rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
            <div className="flex items-center justify-between">
              <h2 className="bean-label text-[10px] text-[#8f8f8a]">CUT CANDIDATES ({cuts.length})</h2>
              {cuts.length > 0 && (
                <button
                  type="button"
                  onClick={() => setCuts([])}
                  className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-[#8f8f8a] hover:text-[#f87171]"
                >
                  <Trash2 className="h-3 w-3" /> CLEAR ALL
                </button>
              )}
            </div>
            {!analyzed && !media && (
              <p className="mt-3 rounded-lg border border-dashed border-[#242424] px-4 py-8 text-center text-xs text-[#5c5c58]">
                Run an analysis to generate evidence-backed cut candidates.
              </p>
            )}
            {cuts.length === 0 && analyzed && (
              <p className="mt-3 rounded-lg border border-[#1f2a1a] bg-[#0c120a] px-4 py-6 text-center text-xs leading-relaxed text-[#7fbf8e]">
                No cut candidates found with the current settings — the recording has no eligible silence. Nothing was
                proposed, and nothing will be cut. This is a valid result.
              </p>
            )}
            <div className="bean-panel-scroll mt-3 max-h-[420px] space-y-2.5 overflow-y-auto pr-1">
              {cuts.map((c) => (
                <div
                  key={c.id}
                  className={cn(
                    "rounded-lg border px-3.5 py-3",
                    c.review === "REMOVE"
                      ? "border-[#3b1515] bg-[#140b0b]"
                      : c.review === "REVIEW"
                        ? "border-[#3a2408] bg-[#141006]"
                        : c.review === "APPROVED"
                          ? "border-[#5c1a1a] bg-[#1a0d0d]"
                          : "border-[#152a18] bg-[#0b120c]"
                  )}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-xs font-bold text-white">
                      {formatPrecise(c.start)} → {formatPrecise(c.end)}
                      <span className="ml-2 text-[#8f8f8a]">({c.duration.toFixed(2)}s)</span>
                    </span>
                    <div className="flex items-center gap-1.5">
                      {(["REMOVE", "REVIEW", "KEEP"] as const).map((st) => (
                        <button
                          key={st}
                          type="button"
                          onClick={() => setCutReview(c.id, st)}
                          className={cn(
                            "rounded border px-2 py-1 text-[9px] font-extrabold tracking-wider transition-colors",
                            c.review === st
                              ? st === "REMOVE"
                                ? "border-[#ef4444] bg-[#2a1212] text-[#f87171]"
                                : st === "REVIEW"
                                  ? "border-[#f97316] bg-[#2a1c08] text-[#fdba74]"
                                  : "border-[#22c55e] bg-[#0f2415] text-[#86efac]"
                              : "border-[#2a2a2a] text-[#7a7a76] hover:border-[#3a3a3a]"
                          )}
                        >
                          {st}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() => deleteCut(c.id)}
                        className="ml-1 rounded border border-[#2a2a2a] p-1 text-[#7a7a76] hover:border-[#ef4444] hover:text-[#f87171]"
                        aria-label={`Delete cut at ${c.start.toFixed(2)}s`}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-[#9a9a94]">{c.reason}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]">
                    <span className={cn("font-bold uppercase tracking-wider", c.source === "RIISHE_INFERENCE" ? "text-[#d4a017]" : c.source === "WORDS_TO_REMOVE" ? "text-[#d4a017]" : "text-[#5c5c58]")}>
                      {c.source === "RIISHE_INFERENCE"
                        ? `RIISHE · ${c.inference?.model ?? "inference"} · confidence ${(c.inference?.confidence ?? 0).toFixed(2)}`
                        : c.source === "WORDS_TO_REMOVE"
                          ? `WORDS TO REMOVE${c.wordMatch ? ` · "${c.wordMatch.phrase}" · estimated word timing` : ""}`
                          : c.source === "MANUAL"
                            ? "MANUAL"
                            : "DETERMINISTIC (combined evidence)"}
                    </span>
                    {c.audioEvidence && (
                      <span className="text-[#5c5c58]">
                        RMS {(c.audioEvidence.rms * 100).toFixed(1)}% · SNR {c.audioEvidence.snr.toFixed(1)} dB
                      </span>
                    )}
                    {c.combinedEvidence && c.combinedEvidence.transcriptWordsInRange > 0 && (
                      <span className="text-[#5c5c58]">⚠ transcript words inside range ({c.combinedEvidence.transcriptWordsInRange})</span>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-1.5 text-[10px] text-[#7a7a76]">
                      IN
                      <input
                        type="number"
                        value={c.start}
                        step={0.01}
                        min={0}
                        max={duration}
                        onChange={(e) => updateCutBounds(c.id, Number(e.target.value), c.end)}
                        className="h-6 w-20 rounded border border-[#2a2a2a] bg-[#111] px-1.5 font-mono text-[11px] text-white focus:border-[#d4a017] focus:outline-none"
                      />
                    </label>
                    <label className="flex items-center gap-1.5 text-[10px] text-[#7a7a76]">
                      OUT
                      <input
                        type="number"
                        value={c.end}
                        step={0.01}
                        min={0}
                        max={duration}
                        onChange={(e) => updateCutBounds(c.id, c.start, Number(e.target.value))}
                        className="h-6 w-20 rounded border border-[#2a2a2a] bg-[#111] px-1.5 font-mono text-[11px] text-white focus:border-[#d4a017] focus:outline-none"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => void playRange(c.start, c.end)}
                      className="text-[10px] font-bold uppercase tracking-wider text-[#d4a017] hover:text-white"
                    >
                      PLAY RANGE
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        markManualScroll();
                        setViewStart(Math.max(0, c.start - 1));
                        setViewEnd(Math.min(duration, c.end + 1));
                      }}
                      className="text-[10px] font-bold uppercase tracking-wider text-[#8f8f8a] hover:text-white"
                    >
                      FOCUS
                    </button>
                  </div>
                  {transcriptSegments
                    .filter((seg) => seg.start < c.end && seg.end > c.start)
                    .slice(0, 2)
                    .map((seg) => (
                      <p
                        key={seg.id}
                        className="mt-1.5 rounded border border-[#242424] bg-[#101010] px-2.5 py-1.5 text-[11px] italic leading-relaxed text-[#8f8f8a]"
                      >
                        “{seg.text}”
                      </p>
                    ))}
                </div>
              ))}
            </div>
          </section>

          {/* Apply */}
          {media && (
            <section className="rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
              <h2 className="bean-label text-[10px] text-[#8f8f8a]">APPROVE & APPLY</h2>
              <p className="mt-2 text-[11px] leading-relaxed text-[#8f8f8a]">
                Applying creates a <span className="text-white">new export</span> with the approved cuts removed — the
                original file is untouched. Ranges are re-validated server-side (order, overlap, bounds) before
                processing.
              </p>
              <button
                type="button"
                disabled={!cuts.some((c) => c.review === "REMOVE") || Boolean(applyJobId)}
                onClick={() => setApplyOpen(true)}
                className="bean-glow mt-3 inline-flex h-10 items-center gap-2 rounded-md bg-[#d4a017] px-5 text-[11px] font-extrabold uppercase tracking-[0.14em] text-[#0c0c0c] hover:bg-[#e9b52a] disabled:opacity-40"
              >
                <ShieldCheck className="h-4 w-4" />
                PREVIEW & APPLY ({cuts.filter((c) => c.review === "REMOVE").length} CUTS)
              </button>
              {applyError && (
                <p className="mt-3 rounded-md border border-[#3b1515] bg-[#1a0d0d] px-3 py-2 text-xs text-[#f87171]">{applyError}</p>
              )}
              {applyJobId && (
                <JobProgressBar
                  jobId={applyJobId}
                  label="APPLYING CUTS"
                  onComplete={(exportId, message) =>
                    setAppliedResult((prev) => (prev ? { ...prev, exportId, message } : { exportId, message, estimatedFinalSec: 0 }))
                  }
                  onFail={(error) => {
                    setApplyError(error);
                    setCuts((prev) => prev.map((c) => (c.review === "APPROVED" ? { ...c, review: "REMOVE" } : c)));
                    setApplyJobId(null);
                  }}
                />
              )}
              {appliedResult?.exportId && (
                <a
                  href={`/api/exports/${appliedResult.exportId}/file`}
                  className="mt-3 inline-flex h-10 items-center gap-2 rounded-md border border-[#1f2a1a] bg-[#0c120a] px-4 text-[11px] font-extrabold uppercase tracking-[0.14em] text-[#22c55e] hover:bg-[#0f1a0e]"
                >
                  <Download className="h-4 w-4" /> DOWNLOAD RESULT
                </a>
              )}
            </section>
          )}
        </div>
      </div>

      {/* Approval dialog */}
      {applyOpen && summary && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-xl border border-[#241f10] bg-[#101010] p-6">
            <h3 className="flex items-center gap-2 text-base font-extrabold text-white">
              <AlertTriangle className="h-5 w-5 text-[#d4a017]" />
              CONFIRM APPROVED CUTS
            </h3>
            <div className="mt-4 space-y-1.5 rounded-lg border border-[#242424] bg-[#0c0c0c] p-3.5 text-xs">
              <div className="flex justify-between">
                <span className="text-[#8f8f8a]">Original duration</span>
                <span className="font-mono text-white">{formatDuration(summary.originalDurationSec)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#8f8f8a]">Cuts to apply</span>
                <span className="font-mono text-white">{summary.approvedCount}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#8f8f8a]">Removed duration</span>
                <span className="font-mono text-white">
                  {summary.approvedRemovedSec < 10 ? `${summary.approvedRemovedSec.toFixed(2)}s` : formatDuration(summary.approvedRemovedSec)}
                </span>
              </div>
              <div className="flex justify-between border-t border-[#1c1c1c] pt-1.5">
                <span className="text-[#8f8f8a]">Estimated final</span>
                <span className="font-mono text-[#d4a017]">
                  {summary.finalEstimatedSec < 10 ? `${summary.finalEstimatedSec.toFixed(2)}s` : formatDuration(summary.finalEstimatedSec)}
                </span>
              </div>
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-[#8f8f8a]">
              This applies every cut currently marked REMOVE. KEEP and REVIEW ranges are not applied. The original media
              is never modified.
            </p>
            <div className="mt-5 flex justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setApplyOpen(false)}
                className="h-9 rounded-md border border-[#2a2a2a] px-4 text-[11px] font-bold uppercase tracking-wider text-[#9a9a94] hover:text-white"
              >
                CANCEL
              </button>
              <button
                type="button"
                onClick={startApply}
                className="bean-glow h-9 rounded-md bg-[#d4a017] px-4 text-[11px] font-extrabold uppercase tracking-wider text-[#0c0c0c] hover:bg-[#e9b52a]"
              >
                APPROVE & APPLY
              </button>
            </div>
          </div>
        </div>
      )}
    </ToolShell>
  );
}

interface ApiErrorBody {
  error?: string;
}

function SummaryTile({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={cn("rounded-lg border px-3.5 py-3", accent ? "border-[#241f10] bg-[#120e05]" : "border-[#1c1c1c] bg-[#0d0d0d]")}>
      <p className="bean-label text-[9px] text-[#7a7a76]">{label}</p>
      <p className={cn("mt-1 font-mono text-lg font-bold", accent ? "text-[#d4a017]" : "text-white")}>{value}</p>
      {sub && <p className="text-[10px] text-[#7a7a76]">{sub}</p>}
    </div>
  );
}

function StageBadge({ state }: { state: StageState }) {
  const map: Record<StageState, { label: string; cls: string }> = {
    PENDING: { label: "PENDING", cls: "text-[#5c5c58]" },
    RUNNING: { label: "RUNNING…", cls: "text-[#d4a017]" },
    DONE: { label: "DONE", cls: "text-[#22c55e]" },
    UNAVAILABLE: { label: "UNAVAILABLE", cls: "text-[#f97316]" },
    FAILED: { label: "FAILED", cls: "text-[#f87171]" },
  };
  return <span className={cn("font-bold uppercase tracking-wider", map[state].cls)}>{map[state].label}</span>;
}

function NumberField({
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="bean-label text-[10px] text-[#8f8f8a]">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v)));
        }}
        className="mt-1.5 h-9 w-full rounded-md border border-[#2a2a2a] bg-[#121212] px-3 font-mono text-sm text-white focus:border-[#d4a017] focus:outline-none"
      />
      <span className="mt-1 block text-[10.5px] leading-snug text-[#6a6a66]">{hint}</span>
    </label>
  );
}
