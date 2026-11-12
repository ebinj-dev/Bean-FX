/**
 * BEAN FX — client-side audio analysis engine (real DSP on real samples).
 *
 * All results here are computed from the decoded PCM of the actual recording.
 * No random data, no simulated envelopes.
 */
import type { CutPlanSettings, SensitivityProfile } from "@/lib/types";

export interface DecodedAudio {
  buffer: AudioBuffer;
  sampleRate: number;
  durationSec: number;
  channels: number;
}

export interface Envelope {
  /** RMS value per window, 0..1 (linear amplitude). */
  values: Float32Array;
  windowSec: number;
  windowMs: number;
}

export interface SilenceSpan {
  start: number;
  end: number;
  /** Mean RMS inside the span. */
  rms: number;
  snr: number;
}

export interface AnalysisResult {
  envelope: Envelope;
  noiseFloor: number;
  peak: number;
  /** Detected silent spans BEFORE padding (eligible raw silence). */
  silenceSpans: SilenceSpan[];
  clippingDetected: boolean;
  windowMs: number;
}

/** Decode a File/Blob through the Web Audio API. Throws on unsupported/corrupt media. */
export async function decodeAudio(file: Blob): Promise<DecodedAudio> {
  const arrayBuffer = await file.arrayBuffer();
  const Ctx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) throw new Error("Web Audio API is not available in this browser.");
  const ctx = new Ctx();
  try {
    const buffer = await ctx.decodeAudioData(arrayBuffer);
    return {
      buffer,
      sampleRate: buffer.sampleRate,
      durationSec: buffer.duration,
      channels: buffer.numberOfChannels,
    };
  } finally {
    void ctx.close();
  }
}

/**
 * Compute a short-term RMS envelope with a configurable analysis window
 * (default 10 ms — the capability-strip claim refers to this window).
 * Mono-mixed from channel 0 (plus averaged additional channels when present).
 */
export function computeEnvelope(buffer: AudioBuffer, windowMs: number): Envelope {
  const winSec = Math.max(0.001, windowMs / 1000);
  const winLen = Math.max(1, Math.floor(buffer.sampleRate * winSec));
  const chCount = buffer.numberOfChannels;
  const ch0 = buffer.getChannelData(0);
  // Hoisted out of the sample loop — getChannelData is not free per-sample.
  const ch1 = chCount >= 2 ? buffer.getChannelData(1) : null;
  const frames = Math.ceil(buffer.length / winLen);
  const values = new Float32Array(frames);

  for (let f = 0; f < frames; f++) {
    const start = f * winLen;
    const end = Math.min(start + winLen, buffer.length);
    let sum = 0;
    for (let i = start; i < end; i++) {
      // Average up to 2 channels to keep cost bounded for multichannel files.
      if (ch1) {
        const s = (ch0[i] + ch1[i]) / 2;
        sum += s * s;
      } else {
        sum += ch0[i] * ch0[i];
      }
    }
    values[f] = Math.sqrt(sum / Math.max(1, end - start));
  }
  return { values, windowSec: winSec, windowMs };
}

/**
 * Adaptive noise floor: 10th percentile of the envelope — robust against
 * brief transients and represents the "background" level of the recording.
 */
export function estimateNoiseFloor(envelope: Envelope): number {
  const arr = Array.from(envelope.values).sort((a, b) => a - b);
  if (!arr.length) return 0;
  const idx = Math.floor(arr.length * 0.1);
  return arr[Math.min(arr.length - 1, Math.max(0, idx))];
}

/** Downsampled min/max peaks for waveform drawing. */
export function computePeaks(buffer: AudioBuffer, targetBuckets: number): { min: Float32Array; max: Float32Array } {
  const ch0 = buffer.getChannelData(0);
  const buckets = Math.max(1, targetBuckets);
  const per = Math.floor(ch0.length / buckets) || 1;
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  for (let b = 0; b < buckets; b++) {
    let mn = 1;
    let mx = -1;
    const start = b * per;
    const end = Math.min(start + per, ch0.length);
    for (let i = start; i < end; i++) {
      const v = ch0[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    min[b] = mn === 1 ? 0 : mn;
    max[b] = mx === -1 ? 0 : mx;
  }
  return { min, max };
}

/**
 * Detect silent spans from the envelope. A span is "silent" when its RMS stays
 * below max(noiseFloor * noiseMultiplier, absoluteThreshold) for at least
 * minSilenceSec. This distinguishes low-energy signal from verified silence:
 * the threshold is ADAPTIVE (relative to the measured noise floor).
 */
export function detectSilence(
  envelope: Envelope,
  opts: { minSilenceSec: number; sensitivity: SensitivityProfile }
): { silenceSpans: SilenceSpan[]; noiseFloor: number; peak: number; clippingDetected: boolean } {
  const noiseFloor = estimateNoiseFloor(envelope);
  let peak = 0;
  let clipping = false;
  for (let i = 0; i < envelope.values.length; i++) {
    const v = envelope.values[i];
    if (v > peak) peak = v;
    if (v >= 0.985) clipping = true;
  }

  // Sensitivity → how far above the noise floor counts as "silence".
  const noiseMultiplier = { LOW: 2.2, BALANCED: 3.2, HIGH: 4.6 }[opts.sensitivity];
  const absoluteFloor = { LOW: 0.006, BALANCED: 0.004, HIGH: 0.0028 }[opts.sensitivity];
  const threshold = Math.max(noiseFloor * noiseMultiplier, absoluteFloor);

  const spans: SilenceSpan[] = [];
  const minFrames = Math.max(1, Math.round(opts.minSilenceSec / envelope.windowSec));
  let runStart = -1;
  let runSum = 0;
  let runCount = 0;

  const flush = (endFrame: number) => {
    if (runStart >= 0 && runCount >= minFrames) {
      const start = runStart * envelope.windowSec;
      const end = endFrame * envelope.windowSec;
      const meanRms = runSum / runCount;
      spans.push({
        start,
        end,
        rms: meanRms,
        snr: meanRms > 1e-9 ? 20 * Math.log10(meanRms / Math.max(1e-9, noiseFloor)) : 0,
      });
    }
    runStart = -1;
    runSum = 0;
    runCount = 0;
  };

  for (let i = 0; i < envelope.values.length; i++) {
    if (envelope.values[i] < threshold) {
      if (runStart < 0) runStart = i;
      runSum += envelope.values[i];
      runCount++;
    } else {
      flush(i);
    }
  }
  flush(envelope.values.length);

  return { silenceSpans: spans, noiseFloor, peak, clippingDetected: clipping };
}

export interface CutCandidateInput {
  id: string;
  start: number;
  end: number;
  duration: number;
  reason: string;
  rms: number;
  snr: number;
}

/**
 * Build cut candidates from detected silence spans, applying head/tail padding
 * and target-pause logic. Padding KEEPS material around speech (the padded span
 * is never cut into). With tightening on, the removed amount scales with the
 * actual pause (pause - target, extra keep centered in the span) so the
 * remaining pause approximates the target; with tightening off, the full
 * padded span is proposed. No cut is applied here — these are proposals only.
 */
export function buildCandidatesFromSilence(
  analysis: AnalysisResult,
  settings: CutPlanSettings,
  durationSec: number
): CutCandidateInput[] {
  const candidates: CutCandidateInput[] = [];
  let id = 0;
  for (const span of analysis.silenceSpans) {
    const effective = span.end - span.start;
    // Silence shorter than min silence is never eligible.
    if (effective < settings.minSilenceSec - 1e-6) continue;

    // Head/tail padding preserves material before/after surrounding speech.
    const start = Math.max(0, span.start + settings.headPaddingSec);
    const end = Math.min(durationSec, span.end - settings.tailPaddingSec);
    if (end - start < Math.max(0.02, settings.minSilenceSec * 0.5)) continue;

    // Removing less than 30ms is pointless.
    if (end - start < 0.03) continue;

    // Padding alone already leaves head+tail seconds of pause. When that is
    // already >= the target pause, the full padded span is removed. Otherwise
    // an extra (target - head - tail) is kept, centered inside the padded
    // span, so the remaining pause ~= target. The removed amount therefore
    // scales with the actual pause length (pause - target), it is never a
    // fixed-duration cut.
    const padded = end - start;
    const extraKeep = Math.max(0, settings.targetPauseSec - (settings.headPaddingSec + settings.tailPaddingSec));
    const cutLen = Math.max(0.03, padded - (settings.tightenSentencePauses ? extraKeep : 0));
    const s2 = settings.tightenSentencePauses ? start + (padded - cutLen) / 2 : start;
    const e2 = s2 + cutLen;
    if (e2 - s2 < 0.03 || e2 > end + 1e-6) continue;

    candidates.push({
      id: `sil-${++id}`,
      start: round3(s2),
      end: round3(e2),
      duration: round3(e2 - s2),
      reason: settings.tightenSentencePauses
        ? `Silence ${effective.toFixed(2)}s detected (RMS ${(span.rms * 100).toFixed(1)}% of peak scale, SNR ${span.snr.toFixed(1)} dB). Reduce to ~${settings.targetPauseSec.toFixed(2)}s pause with ${settings.headPaddingSec.toFixed(2)}s head / ${settings.tailPaddingSec.toFixed(2)}s tail padding.`
        : `Silence ${effective.toFixed(2)}s detected (RMS ${(span.rms * 100).toFixed(1)}% of peak scale, SNR ${span.snr.toFixed(1)} dB). Remove the padded span (${settings.headPaddingSec.toFixed(2)}s head / ${settings.tailPaddingSec.toFixed(2)}s tail kept); no target shortening applied.`,
      rms: span.rms,
      snr: span.snr,
    });
  }
  return candidates;
}

/** Sensitivity preview used by the UI to show effective parameters honestly. */
export function describeSensitivity(s: SensitivityProfile): string {
  switch (s) {
    case "LOW":
      return "Conservative — only clear, sustained silence is eligible; more pauses are kept.";
    case "BALANCED":
      return "Practical general-purpose editing — typical pauses are shortened.";
    case "HIGH":
      return "Aggressive — even low-level room tone may be shortened; speech is still preserved.";
  }
}

export function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Merge/normalize overlapping ranges deterministically (half-open [start,end)). */
export function normalizeRanges(ranges: { start: number; end: number }[], durationSec: number): { start: number; end: number }[] {
  const valid = ranges
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start && r.start >= 0)
    .map((r) => ({ start: round3(r.start), end: round3(Math.min(r.end, durationSec)) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  for (const r of valid) {
    const prev = out[out.length - 1];
    if (prev && r.start <= prev.end + 1e-6) {
      prev.end = Math.max(prev.end, r.end);
    } else {
      out.push({ ...r });
    }
  }
  return out;
}
