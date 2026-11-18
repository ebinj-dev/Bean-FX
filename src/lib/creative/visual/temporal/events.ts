/**
 * M13 — Temporal scene understanding (§6): evidence-linked event observations.
 *
 * Combines M13 tracks + motion measurements + camera classification with M12
 * scene boundaries and M11 speech timing (mapped to the timeline) into typed
 * TemporalEvents. Provenance stays separated: deterministic measurements are
 * `measured`/`model-observed`, a provider category label is `ai-interpretation`,
 * and a re-appearance link across windows is `inferred` (hash/IoU evidence —
 * NEVER a claimed persistent identity). Heuristic motion is never presented
 * as confirmed semantic intent.
 */
import { eventIdOf, type CameraMotion, type MotionMeasurement, type TemporalEvent, type TemporalFrame, type Track } from "./contracts";

export interface EventInput {
  assetId: string;
  frames: TemporalFrame[];
  tracks: Track[];
  motion: MotionMeasurement[];
  camera: CameraMotion[];
  sceneCuts: number[];
  sceneIdOfIndex: (index: number) => string | null;
  /** Timeline-mapped speech spans (M11) for speech-over-motion/static events. */
  speechSpans: { start: number; end: number }[];
}

function sceneIdAt(sec: number, sceneCuts: number[], sceneIdOfIndex: (i: number) => string | null): string | null {
  let idx = 0;
  for (const c of sceneCuts) {
    if (sec >= c) idx += 1;
    else break;
  }
  return sceneIdOfIndex(idx);
}

function timelineRangeOf(startSec: number, endSec: number, frames: TemporalFrame[]): { start: number | null; end: number | null } {
  const inRange = frames.filter((f) => f.sourceSec >= startSec - 0.2 && f.sourceSec <= endSec + 0.2 && f.timelineSec !== null);
  if (inRange.length === 0) return { start: null, end: null };
  return { start: inRange[0].timelineSec, end: inRange[inRange.length - 1].timelineSec };
}

export function buildTemporalEvents(input: EventInput): TemporalEvent[] {
  const events: TemporalEvent[] = [];
  let n = 0;
  const push = (e: Omit<TemporalEvent, "eventId">) => {
    events.push({ ...e, eventId: eventIdOf(input.assetId, e.type, n++) });
  };
  const W = input.frames[0]?.width ?? 1;
  const H = input.frames[0]?.height ?? 1;

  for (const track of input.tracks) {
    const motion = input.motion.find((m) => m.trackId === track.trackId);
    const sceneId = sceneIdAt(track.entrySourceSec, input.sceneCuts, input.sceneIdOfIndex);
    const tl = timelineRangeOf(track.entrySourceSec, track.exitSourceSec, input.frames);
    // Entry / exit / loss events.
    push({
      type: "subject-entry",
      sourceStartSec: track.entrySourceSec,
      sourceEndSec: Math.min(track.exitSourceSec, track.entrySourceSec + 1),
      timelineStartSec: tl.start,
      timelineEndSec: tl.end,
      sceneIds: sceneId ? [sceneId] : [],
      trackIds: [track.trackId],
      frameRefs: track.samples.slice(0, 2).map((s) => s.frameId),
      method: "csrt+mog2 detection",
      evidenceLabel: "measured",
      confidence: track.confidence,
      description: `Subject ${track.trackId} first detected at ${track.entrySourceSec.toFixed(2)}s${track.category ? ` (${track.category}, ${track.categoryProvenance})` : ""} and tracked across ${track.samples.length} consecutive samples.`,
      evidence: { entryBox: track.samples[0]?.bbox, termination: track.terminationReason },
    });
    if (track.terminationReason === "left-frame") {
      push({
        type: "subject-exit",
        sourceStartSec: Math.max(track.entrySourceSec, track.exitSourceSec - 1),
        sourceEndSec: track.exitSourceSec,
        timelineStartSec: tl.start,
        timelineEndSec: tl.end,
        sceneIds: sceneId ? [sceneId] : [],
        trackIds: [track.trackId],
        frameRefs: track.samples.slice(-2).map((s) => s.frameId),
        method: "csrt box-centroid tracking",
        evidenceLabel: "measured",
        confidence: track.confidence,
        description: `Subject ${track.trackId} left the frame around ${track.exitSourceSec.toFixed(2)}s (tracked center crossed the frame boundary).`,
        evidence: { exitBox: track.samples[track.samples.length - 1]?.bbox },
      });
    } else if (track.terminationReason === "tracker-lost") {
      push({
        type: "subject-lost",
        sourceStartSec: track.exitSourceSec,
        sourceEndSec: track.exitSourceSec,
        timelineStartSec: tl.start,
        timelineEndSec: tl.end,
        sceneIds: sceneId ? [sceneId] : [],
        trackIds: [track.trackId],
        frameRefs: track.samples.slice(-2).map((s) => s.frameId),
        method: "csrt update failure",
        evidenceLabel: "measured",
        confidence: 0.9,
        description: `Tracking of ${track.trackId} FAILED at ${track.exitSourceSec.toFixed(2)}s (CSRT update failed / degenerate box). No continuity is claimed after this point — the track is broken, not extrapolated.`,
        evidence: { lastBox: track.samples[track.samples.length - 1]?.bbox },
      });
    }
    // Occlusion intervals.
    for (const o of track.occlusionIntervals.slice(0, 4)) {
      push({
        type: "subject-lost",
        sourceStartSec: o.startSec,
        sourceEndSec: o.endSec,
        timelineStartSec: tl.start,
        timelineEndSec: tl.end,
        sceneIds: sceneId ? [sceneId] : [],
        trackIds: [track.trackId],
        frameRefs: [],
        method: "box-overlap analysis",
        evidenceLabel: "inferred",
        confidence: 0.6,
        description: `Possible occlusion of ${track.trackId} during ${o.startSec.toFixed(2)}–${o.endSec.toFixed(2)}s (${o.reason}). The tracker kept following the template — identity through full occlusion is NOT guaranteed.`,
        evidence: { reason: o.reason },
      });
    }
    // Motion onset/stop/sudden/repeated from the measured record.
    if (motion) {
      const sceneAt = (sec: number) => sceneIdAt(sec, input.sceneCuts, input.sceneIdOfIndex);
      if (motion.onsetSec !== null) {
        const tl2 = timelineRangeOf(motion.onsetSec, motion.onsetSec + 1, input.frames);
        push({
          type: "motion-onset",
          sourceStartSec: motion.onsetSec,
          sourceEndSec: motion.onsetSec + (input.frames[0]?.sampleIntervalSec ?? 0.2),
          timelineStartSec: tl2.start,
          timelineEndSec: tl2.end,
          sceneIds: [sceneAt(motion.onsetSec)].filter((s): s is string => Boolean(s)),
          trackIds: [track.trackId],
          frameRefs: [],
          method: "foreground displacement after camera compensation",
          evidenceLabel: "measured",
          confidence: motion.confidence,
          description: `Motion onset of ${track.trackId} at ~${motion.onsetSec.toFixed(2)}s (foreground displacement exceeded 1.5% of frame diagonal after global camera motion was removed).`,
          evidence: { foregroundPxPerFrame: motion.foregroundPxPerFrame, speedPxPerSec: motion.speedPxPerSec },
        });
      }
      if (motion.stopSec !== null && motion.onsetSec !== null && motion.stopSec > motion.onsetSec + 0.5) {
        const tl2 = timelineRangeOf(motion.stopSec, motion.stopSec + 1, input.frames);
        push({
          type: "motion-stop",
          sourceStartSec: motion.stopSec,
          sourceEndSec: motion.stopSec + 0.5,
          timelineStartSec: tl2.start,
          timelineEndSec: tl2.end,
          sceneIds: [sceneAt(motion.stopSec)].filter((s): s is string => Boolean(s)),
          trackIds: [track.trackId],
          frameRefs: [],
          method: "foreground displacement",
          evidenceLabel: "measured",
          confidence: motion.confidence,
          description: `Motion of ${track.trackId} stopped at ~${motion.stopSec.toFixed(2)}s (subject became static relative to the registered background).`,
          evidence: {},
        });
      }
      for (const j of motion.suddenJumps.slice(0, 3)) {
        const tl2 = timelineRangeOf(j.sourceSec, j.sourceSec + 0.5, input.frames);
        push({
          type: "sudden-position-change",
          sourceStartSec: j.sourceSec,
          sourceEndSec: j.sourceSec + 0.2,
          timelineStartSec: tl2.start,
          timelineEndSec: tl2.end,
          sceneIds: [sceneAt(j.sourceSec)].filter((s): s is string => Boolean(s)),
          trackIds: [track.trackId],
          frameRefs: [],
          method: "center displacement vs global motion",
          evidenceLabel: "measured",
          confidence: 0.7,
          description: `Sudden position change of ${track.trackId} at ${j.sourceSec.toFixed(2)}s (${j.px.toFixed(0)} px foreground step — camera motion was subtracted). May indicate a jump cut, occlusion boundary or tracker discontinuity.`,
          evidence: { prevCenter: [j.prevNx, j.prevNy], nextCenter: [j.nextNx, j.nextNy], px: j.px },
        });
      }
      if (motion.repeatedPatternSec !== null) {
        push({
          type: "repeated-motion",
          sourceStartSec: track.entrySourceSec,
          sourceEndSec: track.exitSourceSec,
          timelineStartSec: tl.start,
          timelineEndSec: tl.end,
          sceneIds: sceneId ? [sceneId] : [],
          trackIds: [track.trackId],
          frameRefs: [],
          method: "autocorrelation of tracked center-x series",
          evidenceLabel: "measured",
          confidence: 0.7,
          description: `Repeating movement pattern of ${track.trackId} with period ≈${motion.repeatedPatternSec}s (autocorrelation ≥ 0.7 on the foreground motion series).`,
          evidence: { periodSec: motion.repeatedPatternSec },
        });
      }
    }
  }

  // Re-appearance candidates within one continuous source: a later track whose
  // entry box is similar (normalized IoU + size ratio) to an EARLIER track that
  // ended with tracker-lost in the same scene. Labeled inferred — never identity.
  for (let i = 0; i < input.tracks.length; i++) {
    const a = input.tracks[i];
    if (a.terminationReason !== "tracker-lost") continue;
    for (let j = 0; j < input.tracks.length; j++) {
      if (i === j) continue;
      const b = input.tracks[j];
      if (b.entrySourceSec <= a.exitSourceSec) continue;
      const ia = a.samples[a.samples.length - 1];
      const ib = b.samples[0];
      const dx = Math.abs(ia.nx - ib.nx);
      const dy = Math.abs(ia.ny - ib.ny);
      const sizeRatio = Math.min(ia.bbox.w, ib.bbox.w) / Math.max(ia.bbox.w, ib.bbox.w);
      if (dx < 0.18 && dy < 0.18 && sizeRatio > 0.6) {
        a.reappearsAs.push(b.trackId);
        const tl2 = timelineRangeOf(b.entrySourceSec, b.entrySourceSec + 1, input.frames);
        push({
          type: "subject-continuity-candidate",
          sourceStartSec: b.entrySourceSec,
          sourceEndSec: b.entrySourceSec + 1,
          timelineStartSec: tl2.start,
          timelineEndSec: tl2.end,
          sceneIds: [sceneIdAt(b.entrySourceSec, input.sceneCuts, input.sceneIdOfIndex)].filter((s): s is string => Boolean(s)),
          trackIds: [a.trackId, b.trackId],
          frameRefs: [],
          method: "box position/size similarity across a tracking gap",
          evidenceLabel: "inferred",
          confidence: 0.4,
          description: `Subject ${b.trackId} appeared near where ${a.trackId} was last seen (position Δ<0.18 frame, size ratio ${sizeRatio.toFixed(2)}) after a tracking loss — a CONTINUITY CANDIDATE for review, not an established identity.`,
          evidence: { lastSeen: a.exitSourceSec, reappeared: b.entrySourceSec, sizeRatio },
        });
        break;
      }
    }
  }

  // Camera-move events.
  for (const cam of input.camera) {
    if (cam.classification === "static" || cam.classification === "uncertain") continue;
    const startSec = cam.panningSec[0]?.startSec ?? cam.zoomingSec[0]?.startSec ?? 0;
    const endSec = cam.panningSec[cam.panningSec.length - 1]?.endSec ?? cam.zoomingSec[cam.zoomingSec.length - 1]?.endSec ?? startSec + 1;
    const tl2 = timelineRangeOf(startSec, Math.max(endSec, startSec + 1), input.frames);
    push({
      type: "camera-move",
      sourceStartSec: startSec,
      sourceEndSec: endSec,
      timelineStartSec: tl2.start,
      timelineEndSec: tl2.end,
      sceneIds: [sceneIdAt(startSec, input.sceneCuts, input.sceneIdOfIndex)].filter((s): s is string => Boolean(s)),
      trackIds: [],
      frameRefs: [],
      method: cam.method,
      evidenceLabel: "model-observed",
      confidence: cam.confidence,
      description: `Global background motion classified as ${cam.classification} (median ${cam.medianDxPx?.toFixed(1)}px/frame horizontal, ${cam.medianDyPx?.toFixed(1)}px/frame vertical, scale ratio ${cam.medianScaleRatio?.toFixed(4) ?? "n/a"}). Foreground tracks were measured against this global motion, not conflated with it.`,
      evidence: { medians: [cam.medianDxPx, cam.medianDyPx, cam.medianScaleRatio], panningSec: cam.panningSec, zoomingSec: cam.zoomingSec },
    });
  }

  // Speech-over-motion / speech-over-static (M11 speech × measured activity).
  for (const sp of input.speechSpans.slice(0, 30)) {
    const overlapping = input.tracks.filter((t) => t.samples.some((s) => s.timelineSec !== null && s.timelineSec >= sp.start && s.timelineSec <= sp.end && s.visibility === "visible" && (input.motion.find((m) => m.trackId === t.trackId)?.foregroundPxPerFrame ?? 0) > 1));
    const tl = timelineRangeOf(sp.start, sp.end, input.frames);
    if (overlapping.length > 0) {
      push({
        type: "speech-over-motion",
        sourceStartSec: sp.start,
        sourceEndSec: sp.end,
        timelineStartSec: tl.start,
        timelineEndSec: tl.end,
        sceneIds: [sceneIdAt(sp.start, input.sceneCuts, input.sceneIdOfIndex)].filter((s): s is string => Boolean(s)),
        trackIds: overlapping.slice(0, 3).map((t) => t.trackId),
        frameRefs: [],
        method: "M11 speech mapping × M13 foreground motion",
        evidenceLabel: "measured",
        confidence: 0.7,
        description: `Speech span overlaps measurable foreground motion of ${overlapping.length} tracked subject(s) (deterministic overlap — not semantic intent).`,
        evidence: {},
      });
    } else {
      push({
        type: "speech-over-static",
        sourceStartSec: sp.start,
        sourceEndSec: sp.end,
        timelineStartSec: tl.start,
        timelineEndSec: tl.end,
        sceneIds: [sceneIdAt(sp.start, input.sceneCuts, input.sceneIdOfIndex)].filter((s): s is string => Boolean(s)),
        trackIds: [],
        frameRefs: [],
        method: "M11 speech mapping × M13 foreground motion",
        evidenceLabel: "measured",
        confidence: 0.7,
        description: `Speech span has no tracked foreground motion beneath it (static coverage — fine for talking-head content, weak for dynamic narration).`,
        evidence: {},
      });
    }
  }

  // Static spans: long intervals with no tracks and no camera motion.
  const staticCams = input.camera.filter((c) => c.classification === "static");
  if (staticCams.length > 0 && input.tracks.length === 0) {
    const tl2 = timelineRangeOf(input.frames[0]?.sourceSec ?? 0, input.frames[input.frames.length - 1]?.sourceSec ?? 0, input.frames);
    push({
      type: "static-span",
      sourceStartSec: input.frames[0]?.sourceSec ?? 0,
      sourceEndSec: input.frames[input.frames.length - 1]?.sourceSec ?? 0,
      timelineStartSec: tl2.start,
      timelineEndSec: tl2.end,
      sceneIds: [],
      trackIds: [],
      frameRefs: [],
      method: "no detections + static global registration",
      evidenceLabel: "measured",
      confidence: 0.8,
      description: `No moving subjects detected and camera registered static across the analyzed windows (${input.frames.length} sampled frames) — footage with almost no movement.`,
      evidence: { windows: staticCams.length },
    });
  }

  return events.slice(0, 80);
}
