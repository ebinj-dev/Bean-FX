/**
 * M13 — Motion intelligence (§4) + camera-motion classification (§5).
 *
 * DETERMINISTIC analysis over REAL tracking samples and registration output:
 *  - every MotionMeasurement documents the coordinate system, frame interval,
 *    resolution and its limitations; speed is PIXEL-space only (never
 *    real-world without calibrated scene geometry);
 *  - foreground motion is measured AFTER removing the registered global
 *    (camera) motion — a large frame difference alone is never object
 *    movement, and motion around detected scene cuts is excluded;
 *  - camera classification reports magnitude evidence + confidence; uncertain
 *    evidence stays "uncertain" — no exact pan/tilt/zoom direction claims,
 *    and unstable-but-unclassifiable footage is NOT labeled handheld.
 */
import { type CameraMotion, type MotionMeasurement, type Track } from "./contracts";
import { type RawCameraPair } from "./tracking";

interface MotionCtx {
  width: number | null;
  height: number | null;
  sampleIntervalSec: number;
  sceneCuts: number[];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

const LIMITS = "pixel displacement in sampled-frame space; not real-world speed (no calibrated scene geometry); direction from net center displacement; area-based proxies only for depth (no 3D claims)";

/** Per-track motion measurement (§4) — deterministic. */
export function measureTrackMotion(track: Track, camera: RawCameraPair[], ctx: MotionCtx): MotionMeasurement {
  const samples = track.samples.filter((s) => s.visibility !== "lost");
  const interval = Math.max(0.05, ctx.sampleIntervalSec);
  const first = samples[0];
  const last = samples[samples.length - 1];
  const W = ctx.width ?? 1;
  const H = ctx.height ?? 1;
  const dxNet = (last.nx - first.nx) * W;
  const dyNet = (last.ny - first.ny) * H;
  const durationSec = Math.max(interval, last.sourceSec - first.sourceSec);

  // Per-step foreground displacement = center delta − global camera delta.
  const cameraAt = (t: number): RawCameraPair | null => {
    let best: RawCameraPair | null = null;
    let bestD = Infinity;
    for (const c of camera) {
      const d = Math.abs(c.t - t);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return bestD <= interval * 1.5 ? best : null;
  };
  const perFrame: number[] = [];
  let prev: (typeof samples)[number] | null = null;
  const jumps: MotionMeasurement["suddenJumps"] = [];
  for (const s of samples) {
    if (prev) {
      const cam = cameraAt(s.sourceSec);
      const fdx = (s.nx - prev.nx) * W - (cam?.dx ?? 0);
      const fdy = (s.ny - prev.ny) * H - (cam?.dy ?? 0);
      const px = Math.hypot(fdx, fdy);
      // Exclude steps adjacent to a detected scene cut (apparent motion).
      const nearCut = ctx.sceneCuts.some((c) => Math.abs(s.sourceSec - c) < interval * 1.5);
      if (!nearCut) perFrame.push(px);
      if (!nearCut && px > 0.15 * Math.hypot(W, H) && px > 3 * (median(perFrame.slice(0, -1)) ?? px)) {
        jumps.push({ sourceSec: Math.round(s.sourceSec * 100) / 100, prevNx: prev.nx, prevNy: prev.ny, nextNx: s.nx, nextNy: s.ny, px: Math.round(px * 10) / 10 });
      }
    }
    prev = s;
  }
  const speedPxPerSec = durationSec > 0 ? Math.round((Math.hypot(dxNet, dyNet) / durationSec) * 100) / 100 : null;
  const medianStep = median(perFrame) ?? 0;

  // Direction from net displacement (threshold 2% of frame diagonal).
  const diag = Math.hypot(W, H);
  let direction: MotionMeasurement["direction"] = "static";
  if (Math.hypot(dxNet, dyNet) > 0.02 * diag) {
    if (Math.abs(dxNet) >= Math.abs(dyNet)) direction = dxNet > 0 ? "right" : "left";
    else direction = dyNet > 0 ? "down" : "up";
    // Area-based depth proxy: strong consistent growth/shrink with small net center motion.
    const area0 = first.bbox.w * first.bbox.h;
    const area1 = last.bbox.w * last.bbox.h;
    if (Math.hypot(dxNet, dyNet) < 0.04 * diag && area0 > 0 && (area1 / area0 > 1.35 || area1 / area0 < 0.7)) {
      direction = area1 > area0 ? "toward-camera" : "away-from-camera";
    }
  } else if (perFrame.some((p) => p > 0.02 * diag)) {
    direction = "mixed";
  }

  // Acceleration trend: compare first/second half mean step.
  const half = Math.floor(perFrame.length / 2);
  let accelTrend: MotionMeasurement["accelTrend"] = "insufficient-data";
  if (perFrame.length >= 6 && half >= 2) {
    const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const a = mean(perFrame.slice(0, half));
    const b = mean(perFrame.slice(half));
    if (b > a * 1.35) accelTrend = "accelerating";
    else if (b < a * 0.65) accelTrend = "decelerating";
    else accelTrend = "steady";
  }

  // Motion onset/stop: first/last step above 1.5% of diagonal.
  let onset: number | null = null;
  let stop: number | null = null;
  let prevStep: (typeof samples)[number] | null = null;
  for (const s of samples) {
    if (prevStep) {
      const cam = cameraAt(s.sourceSec);
      const px = Math.hypot((s.nx - prevStep.nx) * W - (cam?.dx ?? 0), (s.ny - prevStep.ny) * H - (cam?.dy ?? 0));
      if (px > 0.015 * diag) {
        if (onset === null) onset = prevStep.sourceSec;
        stop = s.sourceSec;
      }
    }
    prevStep = s;
  }

  // Repeated pattern: autocorrelation peak of the center-x series.
  let repeatedPatternSec: number | null = null;
  const xs = samples.map((s) => s.nx);
  if (xs.length >= 12) {
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const centered = xs.map((x) => x - mean);
    const energy = centered.reduce((a, b) => a + b * b, 0);
    if (energy > 0) {
      let bestLag = -1;
      let bestScore = 0;
      const minLag = Math.max(2, Math.round(1 / interval));
      const maxLag = Math.floor(xs.length / 2);
      for (let lag = minLag; lag <= maxLag; lag++) {
        let dot = 0;
        for (let i = 0; i + lag < centered.length; i++) dot += centered[i] * centered[i + lag];
        const score = dot / energy;
        if (score > bestScore) {
          bestScore = score;
          bestLag = lag;
        }
      }
      if (bestLag > 0 && bestScore >= 0.7) repeatedPatternSec = Math.round(bestLag * interval * 100) / 100;
    }
  }

  return {
    trackId: track.trackId,
    coordinateSystem: "pixel-top-left-origin (sampled frame space) + normalized [0,1] center",
    frameIntervalSec: interval,
    resolution: `${ctx.width ?? "?"}x${ctx.height ?? "?"}`,
    displacementPx: Math.round(Math.hypot(dxNet, dyNet) * 10) / 10,
    speedPxPerSec,
    direction,
    directionVector: { dx: Math.round(dxNet * 10) / 10, dy: Math.round(dyNet * 10) / 10 },
    accelTrend,
    onsetSec: onset !== null ? Math.round(onset * 100) / 100 : null,
    stopSec: stop !== null ? Math.round(stop * 100) / 100 : null,
    suddenJumps: jumps.slice(0, 8),
    repeatedPatternSec,
    foregroundPxPerFrame: Math.round(medianStep * 100) / 100,
    confidence: track.confidence,
    limitations: LIMITS,
  };
}

/** Camera-motion classification per window (§5) — deterministic evidence-based.
 *  `windowScale` is the window-CUMULATIVE multiscale-template ratio (first vs
 *  last frame); the per-frame zoom RATE is its (n−1)th root. */
export function classifyCameraMotion(assetId: string, windowIndex: number, camera: RawCameraPair[], ctx: MotionCtx, windowScale: number | null = null, windowScaleNcc: number | null = null): CameraMotion {
  const pairs = camera.filter((c) => c.t !== undefined);
  const dxs = pairs.map((c) => c.dx);
  const dys = pairs.map((c) => c.dy);
  const mdx = median(dxs) ?? 0;
  const mdy = median(dys) ?? 0;
  const interval = Math.max(0.05, ctx.sampleIntervalSec);
  const zoomRate = windowScale !== null && pairs.length >= 4 ? Math.pow(windowScale, 1 / Math.max(1, pairs.length - 1)) : null;

  // Variance-based evidence for handheld-like vs coherent motion.
  const variance = (arr: number[]): number => {
    if (arr.length < 3) return 0;
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    return arr.reduce((a, b) => a + (b - m) * (b - m), 0) / arr.length;
  };
  const vdx = variance(dxs);
  const vdy = variance(dys);

  const pans: CameraMotion["panningSec"] = [];
  const zooms: CameraMotion["zoomingSec"] = [];
  const abrupt: CameraMotion["abruptChanges"] = [];
  let panRun: { start: number; sum: number; n: number } | null = null;
  let zoomRun: { start: number; sum: number; n: number } | null = null;
  for (const c of pairs) {
    const nearCut = ctx.sceneCuts.some((cut) => Math.abs(c.t - cut) < interval * 1.5);
    if (Math.abs(c.dx) > 2.5 && Math.abs(c.dx) >= 2 * Math.abs(c.dy)) {
      panRun = panRun ?? { start: c.t, sum: 0, n: 0 };
      panRun.sum += c.dx;
      panRun.n += 1;
    } else if (panRun && c.t - (panRun.start + panRun.n * interval) < interval * 2) {
      pans.push({ startSec: Math.round(panRun.start * 100) / 100, endSec: Math.round((panRun.start + panRun.n * interval) * 100) / 100, dxPxPerFrame: Math.round((panRun.sum / panRun.n) * 100) / 100 });
      panRun = null;
    }
    if (c.scale !== null && Math.abs(c.scale - 1) >= 0.012) {
      zoomRun = zoomRun ?? { start: c.t, sum: 0, n: 0 };
      zoomRun.sum += c.scale;
      zoomRun.n += 1;
    } else if (zoomRun && c.t - (zoomRun.start + zoomRun.n * interval) < interval * 2) {
      zooms.push({ startSec: Math.round(zoomRun.start * 100) / 100, endSec: Math.round((zoomRun.start + zoomRun.n * interval) * 100) / 100, ratioPerFrame: Math.round((zoomRun.sum / zoomRun.n) * 1000) / 1000 });
      zoomRun = null;
    }
    if (!nearCut && Math.abs(c.dx) > 0.12 * (ctx.width ?? 1000) && Math.abs(c.dy) > 0.12 * (ctx.height ?? 1000)) {
      abrupt.push({ sourceSec: Math.round(c.t * 100) / 100, dxPx: Math.round(c.dx), dyPx: Math.round(c.dy) });
    }
  }
  if (panRun) pans.push({ startSec: Math.round(panRun.start * 100) / 100, endSec: Math.round((panRun.start + panRun.n * interval) * 100) / 100, dxPxPerFrame: Math.round((panRun.sum / panRun.n) * 100) / 100 });
  if (zoomRun) zooms.push({ startSec: Math.round(zoomRun.start * 100) / 100, endSec: Math.round((zoomRun.start + zoomRun.n * interval) * 100) / 100, ratioPerFrame: Math.round((zoomRun.sum / zoomRun.n) * 1000) / 1000 });

  let classification: CameraMotion["classification"] = "uncertain";
  let confidence: number | null = null;
  const coherent = vdx < 4 && vdy < 4;
  if (pairs.length < 4) {
    classification = "uncertain";
    confidence = 0.3;
  } else if (Math.abs(mdx) <= 0.8 && Math.abs(mdy) <= 0.8 && (zoomRate === null || Math.abs(zoomRate - 1) <= 0.008)) {
    classification = "static";
    confidence = 0.9;
  } else if (zoomRate !== null && Math.abs(zoomRate - 1) >= 0.008 && Math.abs(mdx) < 2 && Math.abs(mdy) < 2) {
    classification = "zoom";
    confidence = 0.75;
  } else if (Math.abs(mdx) > 2.5 && Math.abs(mdx) >= 2 * Math.abs(mdy)) {
    classification = "pan";
    confidence = coherent ? 0.85 : 0.55;
  } else if (Math.abs(mdy) > 2.5 && Math.abs(mdy) >= 2 * Math.abs(mdx)) {
    classification = "tilt";
    confidence = coherent ? 0.85 : 0.55;
  } else if (Math.abs(mdx) > 2.5 && Math.abs(mdy) > 2.5) {
    classification = "pan-tilt";
    confidence = coherent ? 0.7 : 0.5;
  } else if ((vdx > 4 || vdy > 4) && median(dxs.map(Math.abs))! > 0.8 && median(dxs.map(Math.abs))! <= 2.5) {
    // High-variance, mixed-sign, moderate magnitudes — REPORT the evidence,
    // label conservatively (never "handheld" as a cinematography claim).
    classification = "handheld-like";
    confidence = 0.5;
  }

  return {
    windowIndex,
    assetId,
    classification,
    medianDxPx: Math.round(mdx * 100) / 100,
    medianDyPx: Math.round(mdy * 100) / 100,
    medianScaleRatio: zoomRate !== null ? Math.round(zoomRate * 100000) / 100000 : null,
    panningSec: pans.slice(0, 8),
    zoomingSec: zooms.slice(0, 8),
    abruptChanges: abrupt.slice(0, 8),
    confidence,
    method: "ecc-affine/phase-correlation global registration (opencv)",
    note:
      classification === "handheld-like"
        ? "High-variance global motion of moderate magnitude (registration evidence). 'handheld-like' describes the measured statistics — NOT a cinematography classification."
        : "Classification from registered global translation/scale (window-cumulative multiscale ratio for zoom); foreground motion was subtracted for per-track measurements. Exact direction/type claims are limited to the reported magnitudes — NOT a cinematography classification.",
  };
}
