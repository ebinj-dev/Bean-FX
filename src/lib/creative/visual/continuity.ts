/**
 * M12 — Visual continuity & quality intelligence (§8).
 *
 * Evidence-based checks, separated by provenance:
 *  - DETERMINISTIC (measured): repeated shots (aHash distance on real
 *    representative frames), static/freeze sections and black sections
 *    (ffmpeg detectors), abrupt cut rate, aspect-ratio changes between
 *    adjacent timeline video placements (probe dimensions);
 *  - MODEL-INTERPRETED (ai-interpretation, ONLY when frames were analyzed
 *    with consent): composition / subject-position shifts between
 *    consecutive analyzed scenes.
 *
 * Explicitly NOT claimed: exact camera movement, emotional expressions,
 * professional cinematography quality, or semantic continuity derived from
 * scene-change timestamps alone. Every finding carries evidence + timestamps
 * + confidence where quantifiable.
 */
import { FindingSchema, type Finding } from "../contracts";
import type { VisualIndex } from "./contracts";

export interface ContinuityInput {
  index: VisualIndex | null;
  /** Deterministic detector outputs (SOURCE-media seconds) from JAZMII local analysis. */
  sceneChangesSec: number[];
  staticSectionsSec: { start: number; end: number }[];
  blackSectionsSec: { start: number; end: number }[];
  /** Adjacent timeline video placements with probe dims (aspect changes). */
  videoPlacements: { clipId: string; assetId: string | null; startSec: number; endSec: number; width: number | null; height: number | null }[];
}

export interface ContinuityResult {
  findings: Finding[];
  notes: string[];
}

export function analyzeVisualContinuity(input: ContinuityInput): ContinuityResult {
  const findings: Finding[] = [];
  const notes: string[] = [];
  let n = 0;
  const next = () => ++n;
  const push = (f: Finding) => {
    const parsed = FindingSchema.safeParse(f);
    if (parsed.success) findings.push(parsed.data);
  };

  // ── repeated shots (deterministic aHash groups on real frames) ──
  if (input.index) {
    const groups = new Map<number, VisualIndex["scenes"]>();
    for (const s of input.index.scenes) {
      if (s.repeatGroup !== null) groups.set(s.repeatGroup, [...(groups.get(s.repeatGroup) ?? []), s]);
    }
    for (const [group, scenes] of groups) {
      const tl = scenes[0].timelinePlacements[0]?.timelineStartSec ?? null;
      push({
        findingNo: next(),
        category: "visual-repetition",
        startSec: tl,
        endSec: null,
        severity: scenes.length >= 3 ? "moderate" : "info",
        confidence: 0.8,
        evidenceLabel: "measured",
        engine: "JAZMII",
        evidence: {
          repeatGroup: group,
          sceneIds: scenes.map((s) => s.sceneId),
          hashDistanceLimit: input.index.settings.repeatShotHashDistance,
          representativeHashes: scenes.map((s) => input.index?.frames.find((f) => f.frameId === s.representativeFrameId)?.ahash ?? null),
          note: "64-bit aHash Hamming distance ≤ limit on REAL representative frames — visual similarity, not verified semantic sameness",
        },
        explanation: `${scenes.length} scene(s) are visually near-identical by deterministic perceptual hash (aHash). Reuse may be intentional (motif/refrain); review whether the repetition serves the story.`,
        suggestion: scenes.length >= 3 ? "Consider replacing one of the repeated shots with alternative coverage (see B-roll suggestions)." : null,
      });
    }

    // ── model-interpreted composition shifts (ONLY from analyzed frames) ──
    if (input.index.measurement.consentVisual) {
      const analyzed = input.index.scenes.filter((s) => s.understanding === "semantic" && s.description);
      let interpreted = 0;
      for (let i = 1; i < analyzed.length && interpreted < 3; i++) {
        const prev = analyzed[i - 1];
        const cur = analyzed[i];
        const descShift = (prev.description ?? "") !== (cur.description ?? "");
        const compositionShift = cur.description?.toLowerCase().includes("different angle") || cur.description?.toLowerCase().includes("different position");
        if (descShift && compositionShift) {
          interpreted += 1;
          const tl = cur.timelinePlacements[0]?.timelineStartSec ?? null;
          push({
            findingNo: next(),
            category: "scene-structure",
            startSec: tl,
            endSec: null,
            severity: "info",
            confidence: 0.5,
            evidenceLabel: "ai-interpretation",
            engine: "MYAI",
            evidence: {
              prevScene: prev.sceneId,
              curScene: cur.sceneId,
              prevDescription: (prev.description ?? "").slice(0, 240),
              curDescription: (cur.description ?? "").slice(0, 240),
              provider: cur.provider,
              model: cur.model,
            },
            explanation: "The vision model's descriptions of consecutive scenes indicate a composition/subject-position change (model interpretation of analyzed frames — NOT a camera-movement measurement).",
            suggestion: null,
          });
        }
      }
    } else if (input.index.scenes.some((s) => s.understanding === "semantic") === false && input.index.measurement.framesExtracted > 0) {
      notes.push("No frame analysis was consented — continuity interpretation is limited to deterministic measurements (no composition/subject claims).");
    }
  } else {
    notes.push("No visual index — continuity checks run on detector outputs only.");
  }

  // ── static (freeze) sections (deterministic detector) ──
  for (const st of input.staticSectionsSec.slice(0, 3)) {
    push({
      findingNo: next(),
      category: "static-visuals",
      startSec: Math.round(st.start * 100) / 100,
      endSec: Math.round(st.end * 100) / 100,
      severity: st.end - st.start > 10 ? "minor" : "info",
      confidence: 0.9,
      evidenceLabel: "model-observed",
      engine: "JAZMII",
      evidence: { detector: "ffmpeg freezedetect (n=-60dB, d=2)", startSec: st.start, endSec: st.end, durationSec: Math.round((st.end - st.start) * 100) / 100 },
      explanation: `Freeze/static section of ${(st.end - st.start).toFixed(1)}s detected by ffmpeg freezedetect on the real file (deterministic; no AI claims).`,
      suggestion: null,
    });
  }

  // ── black sections (deterministic detector) ──
  for (const b of input.blackSectionsSec.slice(0, 3)) {
    push({
      findingNo: next(),
      category: "technical",
      startSec: Math.round(b.start * 100) / 100,
      endSec: Math.round(b.end * 100) / 100,
      severity: b.end - b.start > 2 ? "minor" : "info",
      confidence: 0.9,
      evidenceLabel: "model-observed",
      engine: "JAZMII",
      evidence: { detector: "ffmpeg blackdetect (d=0.5, pix_th=0.10)", startSec: b.start, endSec: b.end, durationSec: Math.round((b.end - b.start) * 100) / 100 },
      explanation: `Black section of ${(b.end - b.start).toFixed(1)}s detected by ffmpeg blackdetect (intentional fades/pauses are legitimate).`,
      suggestion: null,
    });
  }

  // ── abrupt cut rate (deterministic) ──
  const rapid: number[] = [];
  for (let i = 1; i < input.sceneChangesSec.length; i++) {
    if (input.sceneChangesSec[i] - input.sceneChangesSec[i - 1] < 0.5) rapid.push(input.sceneChangesSec[i]);
  }
  if (rapid.length >= 3) {
    push({
      findingNo: next(),
      category: "transition",
      startSec: rapid[0],
      endSec: rapid[rapid.length - 1],
      severity: "info",
      confidence: 0.8,
      evidenceLabel: "measured",
      engine: "JAZMII",
      evidence: { detector: "ffmpeg scene-score threshold", rapidCutCount: rapid.length, windowSec: [rapid[0], rapid[rapid.length - 1]] },
      explanation: `${rapid.length} scene changes within <0.5 s of each other — a rapid montage segment (intentional style is legitimate).`,
      suggestion: null,
    });
  }

  // ── aspect-ratio changes between adjacent timeline video placements ──
  const withDims = input.videoPlacements.filter((p) => p.width && p.height).sort((a, b) => a.startSec - b.startSec);
  for (let i = 1; i < withDims.length && i <= 5; i++) {
    const a = withDims[i - 1];
    const b = withDims[i];
    if (a.assetId === b.assetId) continue;
    const ra = (a.width ?? 1) / (a.height ?? 1);
    const rb = (b.width ?? 1) / (b.height ?? 1);
    if (Math.abs(ra - rb) / Math.max(ra, rb) > 0.2) {
      push({
        findingNo: next(),
        category: "technical",
        startSec: b.startSec,
        endSec: b.endSec,
        severity: "minor",
        confidence: 0.9,
        evidenceLabel: "measured",
        engine: "deterministic",
        evidence: { prevClip: a.clipId, prevAspect: Number(ra.toFixed(3)), nextClip: b.clipId, nextAspect: Number(rb.toFixed(3)) },
        explanation: `Adjacent timeline video clips change aspect ratio from ${ra.toFixed(2)} to ${rb.toFixed(2)} at ${b.startSec.toFixed(1)}s (probe-measured dimensions; rendering letterboxes/crops per the compositor).`,
        suggestion: "Consider matching aspect ratios or planning the framing for the export profile.",
      });
    }
  }

  notes.push("NOT claimed: exact camera movement, emotional expressions, cinematography quality, or semantic continuity from timestamps alone.");
  return { findings, notes };
}
