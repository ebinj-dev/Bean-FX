/**
 * M10 — Retention Intelligence (§4): evidence-based pacing review.
 *
 * Every finding carries the evidence contract (FindingSchema): a LABEL
 * (measured / inferred / ai-interpretation / insufficient-evidence), the
 * measured values, and an explanation that separates the MEASUREMENT from the
 * CREATIVE JUDGMENT. Standing honesty rules baked in:
 *  - measured silence is NOT automatically a bad edit (explanations say so
 *    where music/intentional pauses are plausible);
 *  - a missing hook cannot be declared from duration alone — only speech
 *    ONSET is measured, hook quality is explicitly the creator's call;
 *  - viewer retention CANNOT be measured here — no platform analytics exist,
 *    and no drop-off graph is ever manufactured (RETENTION_DISCLAIMER).
 *
 * Evidence sources: GANGZII inspections (silence spans, LUFS, balance,
 * clipping), RIISHE analysis results (speech spans, transcript, language),
 * timeline structure (clip durations, transitions, asset reuse), SRT captions
 * (cue density/speed), Studio plan scenes, M9 publishing metadata.
 */
import { clampToDuration, type MeasuredContext } from "./context";
import { FindingSchema, type Finding } from "./contracts";

export const RETENTION_DISCLAIMER =
  "No viewer-retention analytics exist in this deployment. Everything below is content pacing evidence from the project's own audio/timeline/caption data — it is NOT a measurement or prediction of audience retention.";

/** Thresholds are documented, versioned constants (see docs §Retention). */
export const RETENTION_THRESHOLDS = {
  modelVersion: "m10-retention-1.0",
  longPauseSec: 1.5,
  moderatePauseSec: 2.5,
  majorPauseSec: 4.0,
  openingDeadAirSec: 3.0,
  speechOnsetLateSec: 4.0,
  silenceFractionHigh: 0.35,
  maxFindingsPerCategory: 12,
  captionCpsGuideline: 13,
  captionGapSec: 3,
  captionGapCount: 5,
  lufsStreamingReference: -14,
  channelImbalanceDb: 3,
  lraLowLu: 3,
  repetitionJaccard: 0.6,
  sceneOutlierRatio: 2.5,
  assetReuseFraction: 0.4,
  cutPointsForTransitionFinding: 4,
} as const;

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

const CTA_HINTS = ["subscribe", "follow", "like", "share", "comment", "பின்தொடர", "விருப்ப", "பங்கு", "கருத்து"];

/** Build all retention findings from the measured context. */
export function analyzeRetention(ctx: MeasuredContext): { findings: Finding[]; disclaimer: string } {
  const findings: Finding[] = [];
  let n = 0;
  const next = () => ++n;
  const push = (f: Finding) => {
    const parsed = FindingSchema.safeParse(f);
    if (parsed.success) findings.push(parsed.data);
  };
  const dur = ctx.durationSec;

  // ── audio-quality (measured, GANGZII) ──
  if (ctx.audio?.inspection) {
    const ins = ctx.audio.inspection;
    const audioAsset = ctx.audio.sourceName;
    if (ins.integratedLufs !== null) {
      const delta = Math.round((ins.integratedLufs - RETENTION_THRESHOLDS.lufsStreamingReference) * 10) / 10;
      push({
        findingNo: next(),
        category: "audio-quality",
        startSec: null,
        endSec: null,
        severity: Math.abs(delta) > 4 ? "moderate" : Math.abs(delta) > 2 ? "minor" : "info",
        confidence: 0.95,
        evidenceLabel: "measured",
        engine: "GANGZII",
        evidence: {
          integratedLufs: ins.integratedLufs,
          referenceLufs: RETENTION_THRESHOLDS.lufsStreamingReference,
          deltaDb: delta,
          source: `GANGZII inspection of ${audioAsset}`,
          note: `${RETENTION_THRESHOLDS.lufsStreamingReference} LUFS is a common streaming loudness REFERENCE, not a platform rule.`,
        },
        explanation:
          delta > 0
            ? `Integrated loudness measured ${ins.integratedLufs} LUFS — ${Math.abs(delta)} dB above the -14 LUFS streaming reference. Loudness is a measured fact; whether it suits the target platform is the creator's decision.`
            : `Integrated loudness measured ${ins.integratedLufs} LUFS — ${Math.abs(delta)} dB below the -14 LUFS streaming reference. Loudness is a measured fact; quiet audio commonly reads as low effort, but the target is a choice.`,
        suggestion: Math.abs(delta) > 2 ? `Consider a GANGZII loudness pass toward ${RETENTION_THRESHOLDS.lufsStreamingReference} LUFS (non-destructive, previewable).` : null,
      });
    }
    if (ins.channelImbalanceDb !== null && Math.abs(ins.channelImbalanceDb) > RETENTION_THRESHOLDS.channelImbalanceDb) {
      push({
        findingNo: next(),
        category: "audio-quality",
        startSec: null,
        endSec: null,
        severity: "moderate",
        confidence: 0.9,
        evidenceLabel: "measured",
        engine: "GANGZII",
        evidence: { channelImbalanceDb: ins.channelImbalanceDb, thresholdDb: RETENTION_THRESHOLDS.channelImbalanceDb, source: "GANGZII inspection" },
        explanation: `Channel imbalance measured at ${ins.channelImbalanceDb} dB — beyond the ${RETENTION_THRESHOLDS.channelImbalanceDb} dB threshold. Listeners on single-speaker devices may lose part of the content.`,
        suggestion: "Run a GANGZII balance/equalize pass (suggested gains are part of the inspection).",
      });
    }
    if (ins.clippingSuspected) {
      push({
        findingNo: next(),
        category: "audio-quality",
        startSec: null,
        endSec: null,
        severity: "major",
        confidence: 0.9,
        evidenceLabel: "measured",
        engine: "GANGZII",
        evidence: { clippingSuspected: true, source: "GANGZII inspection (true-peak overs)" },
        explanation: "True-peak clipping was DETECTED by GANGZII — audible distortion is likely in the rendered output.",
        suggestion: "Reduce the source gain or apply GANGZII peak control before export.",
      });
    }
  } else {
    push({
      findingNo: next(),
      category: "audio-quality",
      startSec: null,
      endSec: null,
      severity: "info",
      confidence: null,
      evidenceLabel: "insufficient-evidence",
      engine: "GANGZII",
      evidence: { reason: "no GANGZII inspection available" },
      explanation: "No audio inspection exists for this project's narration audio — loudness, balance and clipping could not be assessed.",
      suggestion: "Run a GANGZII AUDIO analysis to unlock measured audio findings.",
    });
  }

  // ── opening + pauses (measured silence spans) ──
  const insp = ctx.audio?.inspection ?? null;
  if (insp) {
    const spans = insp.silenceSpans;
    // Opening dead air: measured silence covering the very start.
    const opening = spans.find((s) => s.start <= 0.5);
    if (opening && opening.end >= RETENTION_THRESHOLDS.openingDeadAirSec) {
      push({
        findingNo: next(),
        category: "dead-air",
        startSec: 0,
        endSec: Math.round(opening.end * 100) / 100,
        severity: opening.end >= 6 ? "major" : "moderate",
        confidence: 0.9,
        evidenceLabel: "measured",
        engine: "GANGZII",
        evidence: { silenceSpan: opening, openingDeadAirThresholdSec: RETENTION_THRESHOLDS.openingDeadAirSec, source: "GANGZII silence spans" },
        explanation: `The audio opens with ${opening.end.toFixed(1)} s of measured silence before content. Measured silence is not automatically bad (an intentional cold open exists), but on vertical feeds most viewers decide in the first seconds.`,
        suggestion: "Consider trimming the opening silence or starting on the strongest visual beat.",
      });
    }
    // Long pauses (skip the opening span; bounded to the longest N).
    const pauses = spans
      .filter((s) => s.start > 0.5 && s.end - s.start >= RETENTION_THRESHOLDS.longPauseSec)
      .sort((a, b) => b.end - b.start - (a.end - a.start))
      .slice(0, RETENTION_THRESHOLDS.maxFindingsPerCategory);
    for (const p of pauses) {
      const len = Math.round((p.end - p.start) * 100) / 100;
      const clamped = clampToDuration(p.start, p.end, dur);
      const musicPlausible = insp.levelsClassification === "music" || insp.levelsClassification === "mixed";
      push({
        findingNo: next(),
        category: "long-pause",
        startSec: clamped.startSec,
        endSec: clamped.endSec,
        severity: len >= RETENTION_THRESHOLDS.majorPauseSec ? "major" : len >= RETENTION_THRESHOLDS.moderatePauseSec ? "moderate" : "minor",
        confidence: 0.85,
        evidenceLabel: "measured",
        engine: "GANGZII",
        evidence: { silenceSpan: p, lengthSec: len, levelsClassification: insp.levelsClassification, thresholdSec: RETENTION_THRESHOLDS.longPauseSec },
        explanation: `${len.toFixed(1)} s of measured silence at ${p.start.toFixed(1)} s. This is a MEASUREMENT, not a verdict — ${musicPlausible ? "the audio classifies as music/mixed, so this pause may be an intentional musical beat" : "an intentional dramatic pause is legitimate"}; review whether the pause earns its place.`,
        suggestion: musicPlausible ? null : `Review the pause at ${p.start.toFixed(1)} s — trim via a timeline trim if it reads as dead air.`,
      });
    }
    // Overall dead-air fraction.
    if (insp.silenceFraction > RETENTION_THRESHOLDS.silenceFractionHigh) {
      push({
        findingNo: next(),
        category: "dead-air",
        startSec: null,
        endSec: null,
        severity: "moderate",
        confidence: 0.9,
        evidenceLabel: "measured",
        engine: "GANGZII",
        evidence: { silenceTotalSec: insp.silenceTotalSec, silenceFraction: insp.silenceFraction, threshold: RETENTION_THRESHOLDS.silenceFractionHigh },
        explanation: `${Math.round(insp.silenceFraction * 100)}% of the audio is measured silence (${insp.silenceTotalSec.toFixed(1)} s total) — above the ${Math.round(RETENTION_THRESHOLDS.silenceFractionHigh * 100)}% threshold. For music-driven edits this can be intentional.`,
        suggestion: "Tighten pauses (RIISHE review flow) or add complementary audio where the silence is unintentional.",
      });
    }
    if (insp.levelsClassification === "unclear") {
      push({
        findingNo: next(),
        category: "dead-air",
        startSec: null,
        endSec: null,
        severity: "info",
        confidence: null,
        evidenceLabel: "insufficient-evidence",
        engine: "GANGZII",
        evidence: { levelsClassification: "unclear", noiseFloorDbfs: insp.noiseFloorDbfs },
        explanation: "GANGZII classified the recording's level profile as unclear (constant or compressed levels) — silence-based findings are UNRELIABLE for this source and were suppressed.",
        suggestion: null,
      });
    }
  }

  // ── speech onset (measured) + hook (creator judgment) ──
  if (ctx.transcript?.available && ctx.transcript.speechSpansSec.length > 0) {
    const onset = ctx.transcript.speechSpansSec[0].start;
    if (onset >= RETENTION_THRESHOLDS.speechOnsetLateSec) {
      push({
        findingNo: next(),
        category: "opening-hook",
        startSec: 0,
        endSec: Math.round(onset * 100) / 100,
        severity: onset >= 8 ? "moderate" : "minor",
        confidence: 0.85,
        evidenceLabel: "measured",
        engine: "RIISHE",
        evidence: { speechOnsetSec: onset, thresholdSec: RETENTION_THRESHOLDS.speechOnsetLateSec, source: "RIISHE speech spans" },
        explanation: `Measured speech onset at ${onset.toFixed(1)} s — the first spoken word arrives after ${onset.toFixed(1)} s. Whether the opening HOOK is strong cannot be declared from timing alone: judge the first seconds against the content's promise.`,
        suggestion: "Watch the first 5 seconds; if the promise of the video is not on screen or spoken, move the strongest moment to the front.",
      });
    }
  }

  // ── pacing distribution (measured durations; pacing judgment inferred) ──
  const unitDurations = ctx.scenes
    ? ctx.scenes.map((s) => s.durationSec)
    : null;
  const clipDurations = unitDurations ?? null;
  if (clipDurations && clipDurations.length >= 3) {
    const mean = clipDurations.reduce((a, b) => a + b, 0) / clipDurations.length;
    const sorted = [...clipDurations].sort((a, b) => b - a);
    const outliers = clipDurations
      .map((d, i) => ({ d, i }))
      .filter((x) => x.d > mean * RETENTION_THRESHOLDS.sceneOutlierRatio)
      .slice(0, 4);
    if (outliers.length) {
      push({
        findingNo: next(),
        category: "pacing",
        startSec: null,
        endSec: null,
        severity: "minor",
        confidence: 0.7,
        evidenceLabel: "inferred",
        engine: "MYAI",
        evidence: {
          meanDurationSec: Math.round(mean * 10) / 10,
          outliers: outliers.map((o) => ({ unit: o.i + 1, durationSec: o.d })),
          ratioThreshold: RETENTION_THRESHOLDS.sceneOutlierRatio,
          source: ctx.scenes ? "Studio plan scene durations" : "timeline clip durations",
        },
        explanation: `Some units run ${Math.round(RETENTION_THRESHOLDS.sceneOutlierRatio)}× longer than the mean (${mean.toFixed(1)} s). Long shots are not automatically poor pacing — a deliberate sequence can justify it — but the contrast is statistically notable.`,
        suggestion: "Review the long unit(s): split with a cutaway or tighten the middle.",
      });
    }
  }

  // ── transitions (measured cut points; judgment inferred) ──
  if (ctx.videoClipCount >= RETENTION_THRESHOLDS.cutPointsForTransitionFinding && ctx.transitionCount === 0) {
    push({
      findingNo: next(),
      category: "transition",
      startSec: null,
      endSec: null,
      severity: "info",
      confidence: 0.6,
      evidenceLabel: "inferred",
      engine: "NIIKI",
      evidence: { videoClips: ctx.videoClipCount, transitions: ctx.transitionCount },
      explanation: `${ctx.videoClipCount} video clips meet with hard cuts and no transitions. Hard cuts are a legitimate style — this is an observation, not a defect.`,
      suggestion: "If section boundaries feel abrupt, NIIKI can add a dissolve/wipe at specific cuts.",
    });
  }

  // ── captions (measured) ──
  if (ctx.captions?.sourceKind === "srt-assets" && ctx.captions.avgCps !== null) {
    const c = ctx.captions;
    if (c.overThirteenCps > 0 || (c.maxCps !== null && c.maxCps > RETENTION_THRESHOLDS.captionCpsGuideline)) {
      push({
        findingNo: next(),
        category: "caption-timing",
        startSec: null,
        endSec: null,
        severity: c.avgCps !== null && c.avgCps > RETENTION_THRESHOLDS.captionCpsGuideline ? "moderate" : "minor",
        confidence: 0.9,
        evidenceLabel: "measured",
        engine: "RIISHE",
        evidence: { avgCps: c.avgCps, maxCps: c.maxCps, cuesOverGuideline: c.overThirteenCps, guidelineCps: RETENTION_THRESHOLDS.captionCpsGuideline, cueCount: c.cueCount, source: "SRT cue timings" },
        explanation: `Caption reading speed measured ${c.avgCps} chars/s average (max ${c.maxCps}); ${c.overThirteenCps} cue(s) exceed the ~${RETENTION_THRESHOLDS.captionCpsGuideline} chars/s readability GUIDELINE (a heuristic, not a platform rule).`,
        suggestion: "Split fast cues or extend their durations; NIIKI caption styling can also help legibility.",
      });
    }
    if (c.gapsOver3Sec > RETENTION_THRESHOLDS.captionGapCount) {
      push({
        findingNo: next(),
        category: "caption-timing",
        startSec: null,
        endSec: null,
        severity: "minor",
        confidence: 0.8,
        evidenceLabel: "measured",
        engine: "RIISHE",
        evidence: { gapsOver3Sec: c.gapsOver3Sec, thresholdSec: RETENTION_THRESHOLDS.captionGapSec },
        explanation: `${c.gapsOver3Sec} caption gaps longer than ${RETENTION_THRESHOLDS.captionGapSec} s were measured — stretches of speech likely appear without captions.`,
        suggestion: "Re-check caption coverage for those stretches.",
      });
    }
  } else if (!ctx.captions) {
    // already noted in missingEvidence; an explicit finding keeps the UI honest
    push({
      findingNo: next(),
      category: "caption-timing",
      startSec: null,
      endSec: null,
      severity: "info",
      confidence: null,
      evidenceLabel: "insufficient-evidence",
      engine: "deterministic",
      evidence: { reason: "no captions in the project" },
      explanation: "No captions exist (no SRT assets and no caption clips) — caption quality could not be assessed.",
      suggestion: null,
    });
  }

  // ── repeated narration (measured overlap; intent inferred) ──
  if (ctx.transcript?.available && ctx.transcript.segments.length >= 3) {
    const segs = ctx.transcript.segments;
    const repeated: { a: number; b: number; score: number }[] = [];
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < Math.min(segs.length, i + 4); j++) {
        const score = jaccard(tokens(segs[i].text), tokens(segs[j].text));
        if (score >= RETENTION_THRESHOLDS.repetitionJaccard) repeated.push({ a: i, b: j, score: Math.round(score * 100) / 100 });
      }
    }
    if (repeated.length) {
      const top = repeated.sort((x, y) => y.score - x.score)[0];
      push({
        findingNo: next(),
        category: "repeated-narration",
        startSec: Math.round(segs[top.a].start * 100) / 100,
        endSec: Math.round(segs[top.b].end * 100) / 100,
        severity: "minor",
        confidence: 0.7,
        evidenceLabel: "inferred",
        engine: "RIISHE",
        evidence: { pairs: repeated.slice(0, 6), threshold: RETENTION_THRESHOLDS.repetitionJaccard, source: "transcript segment overlap (word-set Jaccard)" },
        explanation: `Narration segments ${top.a + 1} and ${top.b + 1} share ${Math.round(top.score * 100)}% of their significant words. Repetition may be an intentional refrain — the overlap is measured, the redundancy judgment is interpretive.`,
        suggestion: "Listen to both segments; trim the weaker repetition if it stalls the story.",
      });
    }
  }

  // ── ending / CTA (observed or interpreted — never declared from timing) ──
  const approvedCta = ctx.publishing.find((p) => p.cta)?.cta ?? null;
  const lastWords = ctx.transcript?.available && ctx.transcript.segments.length ? ctx.transcript.segments[ctx.transcript.segments.length - 1].text : null;
  if (lastWords && CTA_HINTS.some((h) => lastWords.toLowerCase().includes(h))) {
    push({
      findingNo: next(),
      category: "ending-cta",
      startSec: Math.round(ctx.transcript!.segments[ctx.transcript!.segments.length - 1].start * 100) / 100,
      endSec: null,
      severity: "info",
      confidence: 0.75,
      evidenceLabel: "ai-interpretation",
      engine: "MYAI",
      evidence: { lastSegment: lastWords.slice(0, 200), source: "final transcript segment" },
      explanation: "The closing narration appears to contain a call to action (keyword match on the final segment). Pattern match, not a guarantee.",
      suggestion: null,
    });
  } else if (approvedCta) {
    push({
      findingNo: next(),
      category: "ending-cta",
      startSec: null,
      endSec: null,
      severity: "info",
      confidence: 0.6,
      evidenceLabel: "measured",
      engine: "deterministic",
      evidence: { approvedCta: approvedCta.slice(0, 160), source: "M9 approved publishing metadata" },
      explanation: "An approved CTA exists in the publishing metadata, but the timeline's spoken ending did not visibly contain one. Whether the video should SPEAK its CTA is a creative choice.",
      suggestion: null,
    });
  } else {
    push({
      findingNo: next(),
      category: "ending-cta",
      startSec: null,
      endSec: null,
      severity: "info",
      confidence: null,
      evidenceLabel: "insufficient-evidence",
      engine: "deterministic",
      evidence: { transcriptAvailable: Boolean(ctx.transcript?.available), approvedMetadata: ctx.publishing.length },
      explanation: "No CTA could be located (no transcript ending available, no approved metadata CTA). A missing CTA cannot be declared from timing alone — this is an evidence gap, not a verdict.",
      suggestion: null,
    });
  }

  // ── visual asset reuse (measured; interpretation inferred) ──
  if (ctx.videoClipCount >= 4) {
    const byAsset = new Map<string, number>();
    for (const c of ctx.videoClipAssets) byAsset.set(c.assetId, (byAsset.get(c.assetId) ?? 0) + c.durationSec);
    const totalVideoSec = [...byAsset.values()].reduce((a, b) => a + b, 0);
    if (totalVideoSec > 0) {
      const [topAsset, topSec] = [...byAsset.entries()].sort((a, b) => b[1] - a[1])[0];
      const fraction = topSec / totalVideoSec;
      if (fraction >= RETENTION_THRESHOLDS.assetReuseFraction && byAsset.size > 1) {
        push({
          findingNo: next(),
          category: "visual-repetition",
          startSec: null,
          endSec: null,
          severity: "minor",
          confidence: 0.7,
          evidenceLabel: "inferred",
          engine: "JAZMII",
          evidence: { assetId: topAsset, reuseFraction: Math.round(fraction * 100) / 100, distinctAssets: byAsset.size, source: "timeline video clip inventory" },
          explanation: `One visual asset covers ${Math.round(fraction * 100)}% of the video duration across ${ctx.videoClipCount} clips. Reuse is often deliberate (a recurring motif); the monotony judgment is interpretive.`,
          suggestion: "Consider a JAZMII/LAXII alternative for the most repeated shot, or vary framing.",
        });
      }
    }
  }

  return { findings, disclaimer: RETENTION_DISCLAIMER };
}
