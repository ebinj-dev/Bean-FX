/**
 * M11 — Cross-modal creative understanding (§5).
 *
 * Combines REAL audio (GANGZII), speech (RIISHE/transcript versions),
 * captions (SRT parse), VISUAL (JAZMII deterministic local scene analysis —
 * ffprobe-based scene/black/freeze detection, nothing leaves the server) and
 * timeline structure into scene-aware findings.
 *
 * Honesty rules:
 *  - "model-observed" is used ONLY for the local deterministic frame/scene
 *    analyzer output; an LLM reading is "ai-interpretation"; waveform/timing
 *    numbers are "measured"; statistical patterns are "inferred";
 *  - a video is NEVER claimed to be visually understood from filename,
 *    metadata or transcript alone — without real scene analysis the visual
 *    findings are "insufficient-evidence" with the reason;
 *  - caption "mismatch" means measured low overlap vs an available
 *    transcript, and is labeled inferred (captions may legitimately be
 *    summaries rather than verbatim).
 */
import { clampToDuration, type MeasuredContext } from "./context";
import { FindingSchema, type Finding } from "./contracts";
import { analyzeVideoFile } from "@/lib/jazmii/analysis";
import type { JazmiiAnalysisReport } from "@/lib/jazmii/types";

/**
 * REAL local visual analysis (§5): the JAZMII deterministic analyzer runs
 * ffmpeg scene/black/freeze detection on the actual FILE — nothing is
 * uploaded and no model claims are made (its own header says "No AI claims").
 * Maps the report into the cross-modal SceneAnalysisResult.
 */
export async function runLocalSceneAnalysis(filePath: string, assetId: string, embeddedAudioDurationSec: number | null): Promise<SceneAnalysisResult> {
  try {
    const report: JazmiiAnalysisReport = await analyzeVideoFile(filePath, assetId);
    const sceneChanges: number[] = [];
    for (const sc of report.scenes) {
      if (Number.isFinite(sc.startSec) && sc.startSec > 0 && !sceneChanges.includes(sc.startSec)) sceneChanges.push(Math.round(sc.startSec * 100) / 100);
    }
    const drift = embeddedAudioDurationSec !== null && report.durationSec > 0 ? Math.round(Math.abs(embeddedAudioDurationSec - report.durationSec) * 100) / 100 : null;
    return {
      available: true,
      sceneChangesSec: sceneChanges.slice(0, 200),
      staticSectionsSec: report.freezeSegments.map((f) => ({ start: f.startSec, end: f.endSec })).slice(0, 40),
      blackSectionsSec: report.blackSegments.map((f) => ({ start: f.startSec, end: f.endSec })).slice(0, 40),
      avDriftSec: drift,
      note: null,
    };
  } catch (err) {
    return { available: false, sceneChangesSec: [], staticSectionsSec: [], blackSectionsSec: [], avDriftSec: null, note: `local scene analysis failed: ${(err as Error).message.slice(0, 160)}` };
  }
}

export const CROSSMODAL_THRESHOLDS = {
  modelVersion: "m11-crossmodal-1.0",
  /** Scene analysis (JAZMII local): cuts below this interval = rapid montage. */
  minSceneSec: 0.5,
  /** Static section: no scene change AND no motion for longer than this. */
  staticSectionSec: 8,
  /** Caption↔transcript word overlap below this on shared spans = mismatch. */
  captionOverlapMin: 0.25,
  /** AV duration drift tolerance (embedded audio vs container video). */
  syncDriftToleranceSec: 0.35,
} as const;

export interface SceneAnalysisResult {
  available: boolean;
  sceneChangesSec: number[];
  staticSectionsSec: { start: number; end: number }[];
  blackSectionsSec: { start: number; end: number }[];
  /** Measured |audioDuration − videoDuration| on the analyzed source, when known. */
  avDriftSec: number | null;
  note: string | null;
}

/** Build cross-modal findings from the measured context + scene analysis. */
export function analyzeCrossModal(ctx: MeasuredContext, scene: SceneAnalysisResult | null): { findings: Finding[]; notes: string[] } {
  const findings: Finding[] = [];
  const notes: string[] = [];
  let n = 0;
  const next = () => ++n;
  const push = (f: Finding) => {
    const parsed = FindingSchema.safeParse(f);
    if (parsed.success) findings.push(parsed.data);
  };

  const cutPointsSec = scene?.available ? scene.sceneChangesSec : [];

  // ── speech continuing across a scene change (measured spans vs cuts) ──
  if (ctx.transcript?.available && cutPointsSec.length > 0) {
    const segs = ctx.transcript.segments;
    let across = 0;
    const examples: Record<string, unknown>[] = [];
    for (const seg of segs) {
      const cutInside = cutPointsSec.find((c) => c > seg.start + 0.2 && c < seg.end - 0.2);
      if (cutInside !== undefined) {
        across += 1;
        if (examples.length < 4) examples.push({ speechStartSec: seg.start, speechEndSec: seg.end, sceneCutSec: cutInside, text: seg.text.slice(0, 120) });
      }
    }
    if (across > 0) {
      push({
        findingNo: next(),
        category: "speech-across-cut",
        startSec: examples[0] ? Number(examples[0].speechStartSec) : null,
        endSec: null,
        severity: "info",
        confidence: 0.7,
        evidenceLabel: "measured",
        engine: "MYAI",
        evidence: { acrossCount: across, examples, sceneCutCount: cutPointsSec.length, source: "RIISHE transcript segments × JAZMII local scene cuts" },
        explanation: `${across} speech segment(s) continue across a visual scene cut. Cross-cutting mid-sentence is a legitimate technique (J/L cuts); this is an observation to review, not a defect.`,
        suggestion: null,
      });
    }
  }

  // ── narration with no visual support (speech on the timeline with no video clip) ──
  if (ctx.transcript?.available && ctx.videoClipCount > 0) {
    // Which timeline ranges carry video?
    const videoSpans = ctx.videoTimelineSpans;
    const uncovered = ctx.transcript.segments.filter((seg) => !videoSpans.some((v) => v.startSec <= seg.start && seg.end <= v.endSec));
    if (uncovered.length > 0) {
      push({
        findingNo: next(),
        category: "narration-without-visuals",
        startSec: uncovered[0].start,
        endSec: uncovered[0].end,
        severity: "minor",
        confidence: 0.75,
        evidenceLabel: "measured",
        engine: "MYAI",
        evidence: { uncoveredSegments: uncovered.slice(0, 6).map((s) => ({ start: s.start, end: s.end, text: s.text.slice(0, 120) })), videoSpans: videoSpans.slice(0, 10) },
        explanation: `${uncovered.length} spoken segment(s) play where NO video clip covers the timeline — voice-only stretches. Intentional for audio-led sections; visually dead for feeds.`,
        suggestion: "Add b-roll or visual coverage (JAZMII generation, library asset, or NIIKI text) for those stretches.",
      });
    }
  }

  // ── visual sections with no narration (video-only stretches) ──
  if (ctx.transcript?.available && ctx.videoClipCount > 0) {
    const speechSpans = ctx.transcript.segments.map((s) => ({ start: s.start, end: s.end }));
    const silentVisuals = ctx.videoTimelineSpans
      .map((v) => {
        const overlap = speechSpans.reduce((acc, s) => acc + Math.max(0, Math.min(v.endSec, s.end) - Math.max(v.startSec, s.start)), 0);
        return { ...v, speechOverlapSec: Math.round(overlap * 100) / 100, silentSec: Math.round((v.endSec - v.startSec - overlap) * 100) / 100 };
      })
      .filter((v) => v.silentSec >= 5);
    if (silentVisuals.length > 0) {
      push({
        findingNo: next(),
        category: "visuals-without-narration",
        startSec: silentVisuals[0].startSec,
        endSec: silentVisuals[0].endSec,
        severity: "info",
        confidence: 0.7,
        evidenceLabel: "measured",
        engine: "MYAI",
        evidence: { sections: silentVisuals.slice(0, 6), transcriptCoverage: "transcript segments on the timeline" },
        explanation: `${silentVisuals.length} visual section(s) run ≥5 s with no speech overlap (music/silence only). Deliberate montages are legitimate — verify the pacing is intended.`,
        suggestion: null,
      });
    }
  }

  // ── static visual sections (REAL local frame analysis → model-observed) ──
  if (scene?.available) {
    const statics = scene.staticSectionsSec.filter((s) => s.end - s.start >= CROSSMODAL_THRESHOLDS.staticSectionSec);
    if (statics.length > 0) {
      push({
        findingNo: next(),
        category: "static-visuals",
        startSec: statics[0].start,
        endSec: statics[0].end,
        severity: "minor",
        confidence: 0.85,
        evidenceLabel: "model-observed",
        engine: "JAZMII",
        evidence: { staticSections: statics.slice(0, 6), method: "JAZMII deterministic scene/freeze analysis (local ffprobe-based; no external upload)" },
        explanation: `${statics.length} static section(s) of ≥${CROSSMODAL_THRESHOLDS.staticSectionSec} s measured by local scene analysis (no scene change detected). Static holds may be intentional; long ones commonly read as stalls.`,
        suggestion: "Consider a b-roll cutaway (JAZMII/LAXII) or trimming the hold.",
      });
    }
    const blacks = scene.blackSectionsSec.filter((s) => s.end - s.start >= 1.5);
    if (blacks.length > 0) {
      push({
        findingNo: next(),
        category: "static-visuals",
        startSec: blacks[0].start,
        endSec: blacks[0].end,
        severity: "minor",
        confidence: 0.85,
        evidenceLabel: "model-observed",
        engine: "JAZMII",
        evidence: { blackSections: blacks.slice(0, 6) },
        explanation: `${blacks.length} near-black section(s) ≥1.5 s detected by local frame analysis — often unintended gaps between clips or fade residue.`,
        suggestion: "Review the timeline at those positions; trim or cover with content.",
      });
    }
  } else {
    push({
      findingNo: next(),
      category: "static-visuals",
      startSec: null,
      endSec: null,
      severity: "info",
      confidence: null,
      evidenceLabel: "insufficient-evidence",
      engine: "JAZMII",
      evidence: { reason: "no local scene analysis available for this run" },
      explanation: "Visual sections could NOT be assessed — no scene analysis ran. The video was not visually understood from filename or metadata (which would be a false claim); run a multimodal analysis to inspect real frames locally.",
      suggestion: null,
    });
  }

  // ── caption mismatch vs transcript (measured overlap, inferred verdict) ──
  if (ctx.transcript?.available && ctx.transcript.segments.length >= 2) {
    const capWords = captionWordSet(ctx);
    const speechWords = new Set(ctx.transcript.text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));
    if (capWords.size > 0 && speechWords.size > 0) {
      let inter = 0;
      for (const w of capWords) if (speechWords.has(w)) inter += 1;
      const overlap = inter / Math.max(capWords.size, 1);
      if (overlap < CROSSMODAL_THRESHOLDS.captionOverlapMin) {
        push({
          findingNo: next(),
          category: "caption-mismatch",
          startSec: null,
          endSec: null,
          severity: "minor",
          confidence: 0.6,
          evidenceLabel: "inferred",
          engine: "RIISHE",
          evidence: { captionWordOverlap: Math.round(overlap * 100) / 100, captionWords: capWords.size, transcriptWords: speechWords.size, threshold: CROSSMODAL_THRESHOLDS.captionOverlapMin },
          explanation: `Captions share only ${Math.round(overlap * 100)}% of significant words with the transcript. Captions may intentionally paraphrase (summaries, translations, on-screen text) — the overlap is measured, the mismatch judgment is interpretive.`,
          suggestion: "If captions should follow the narration, regenerate from the approved transcript (M11 transcription flow preserves existing captions).",
        });
      }
    }
  } else if (ctx.captions?.sourceKind === "srt-assets" && !ctx.transcript?.available) {
    push({
      findingNo: next(),
      category: "caption-mismatch",
      startSec: null,
      endSec: null,
      severity: "info",
      confidence: null,
      evidenceLabel: "insufficient-evidence",
      engine: "RIISHE",
      evidence: { captionsPresent: true, transcriptPresent: false },
      explanation: "Captions exist but no transcript is available to compare against — alignment could not be assessed (not assumed either way).",
      suggestion: null,
    });
  }

  // ── A/V synchronization (measured container drift) ──
  if (scene?.available && scene.avDriftSec !== null && scene.avDriftSec > CROSSMODAL_THRESHOLDS.syncDriftToleranceSec) {
    push({
      findingNo: next(),
      category: "av-sync",
      startSec: null,
      endSec: null,
      severity: "moderate",
      confidence: 0.9,
      evidenceLabel: "measured",
      engine: "JAZMII",
      evidence: { driftSec: scene.avDriftSec, toleranceSec: CROSSMODAL_THRESHOLDS.syncDriftToleranceSec },
      explanation: `Embedded audio duration diverges from the video stream duration by ${scene.avDriftSec.toFixed(2)} s (beyond the ${CROSSMODAL_THRESHOLDS.syncDriftToleranceSec} s tolerance) — potential A/V desync at the tail of the clip.`,
      suggestion: "Re-encode the source with matched streams, or trim the tail before use.",
    });
  }

  // ── audio gaps on the timeline (no audio coverage where speech/music expected) ──
  if (ctx.audio?.inspection && ctx.videoClipCount > 0) {
    const videoSpans = ctx.videoTimelineSpans;
    const audioCoverage = ctx.audioClipSpans;
    const gaps = videoSpans
      .map((v) => {
        const covered = audioCoverage.reduce((acc, a) => acc + Math.max(0, Math.min(v.endSec, a.endSec) - Math.max(v.startSec, a.startSec)), 0);
        return { ...v, uncoveredSec: Math.round((v.endSec - v.startSec - covered) * 100) / 100 };
      })
      .filter((v) => v.uncoveredSec >= 3);
    if (gaps.length > 0) {
      push({
        findingNo: next(),
        category: "audio-gap",
        startSec: gaps[0].startSec,
        endSec: gaps[0].endSec,
        severity: "minor",
        confidence: 0.8,
        evidenceLabel: "measured",
        engine: "GANGZII",
        evidence: { gaps: gaps.slice(0, 6), audioClipSpans: audioCoverage.slice(0, 10) },
        explanation: `${gaps.length} visual section(s) of ≥3 s have NO dedicated audio clip beneath them. If the source videos carry embedded audio this is fine — otherwise those stretches will be silent.`,
        suggestion: "Confirm embedded audio covers them (multimodal analysis), or add narration/music.",
      });
    }
  }

  // ── abrupt transitions (measured cut density + no transitions) ──
  if (cutPointsSec.length >= 3 && ctx.transitionCount === 0) {
    push({
      findingNo: next(),
      category: "transition",
      startSec: null,
      endSec: null,
      severity: "info",
      confidence: 0.65,
      evidenceLabel: "model-observed",
      engine: "NIIKI",
      evidence: { sceneCuts: cutPointsSec.length, timelineTransitions: ctx.transitionCount, method: "JAZMII local scene analysis" },
      explanation: `${cutPointsSec.length} visual scene changes meet with no transitions. Hard cuts are a valid style — flagged for review, not as a defect.`,
      suggestion: null,
    });
  }

  return { findings, notes };
}

function captionWordSet(ctx: MeasuredContext): Set<string> {
  return new Set(
    (ctx.captions?.textSample ?? "")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2),
  );
}
