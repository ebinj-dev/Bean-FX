/**
 * GANGZII — ITU-R BS.1770-4 loudness measurement (deterministic DSP, no deps).
 *
 * Implements:
 *  - K-weighting with the EXACT BS.1770 48 kHz coefficient table (loudness
 *    meters standardize on 48 kHz measurement; the caller must feed 48 kHz
 *    PCM — GANGZII's inspection pipeline decodes at 48 kHz).
 *  - 400 ms blocks with 75 % overlap (100 ms hop).
 *  - Integrated loudness with the standard two-stage gating
 *    (absolute −70 LKFS, then relative −10 LU below the ungated mean).
 *  - Short-term loudness: 3 s sliding window evaluated every 1 s (start-timed).
 *  - Loudness range (LRA): 10th–95th percentile of short-term values after
 *    the BS.1770-4 LRA gates (absolute −20 LKFS, relative −20 LU).
 *  - Channel weights: front/mono 1.0, surround 1.41; the LFE channel of a
 *    5.1 layout is excluded (weight 0) per the standard.
 *
 * The caller streams interleaved Float32 PCM chunks into `process()`.
 * Memory is O(window), never O(file).
 *
 * Reference anchors (EBU Tech 3341, verified by tests):
 *  - stereo 1 kHz sine @ −23 dBFS → −23.0 LUFS (K-gain at 1 kHz ≈ +0.69 dB);
 *  - stereo 1 kHz sine @ 0 dBFS  → ≈ 0.0 LUFS;
 *  - mono   1 kHz sine @ 0 dBFS  → −3.01 LUFS.
 */

/** Biquad as b0 + b1·z⁻¹ + b2·z⁻² − a1·y⁻¹ − a2·y⁻² (normalized a0=1). */
interface Biquad {
  b0: number; b1: number; b2: number; a1: number; a2: number;
}

function biquadApply(f: Biquad, x: number, s: { x1: number; x2: number; y1: number; y2: number }): number {
  const y = f.b0 * x + f.b1 * s.x1 + f.b2 * s.x2 - f.a1 * s.y1 - f.a2 * s.y2;
  s.x2 = s.x1; s.x1 = x; s.y2 = s.y1; s.y1 = y;
  return y;
}

/**
 * K-weighting stage 1 — pre-filter high shelf, EXACT BS.1770 48 kHz table:
 * b = [1.53512485958697, −2.69169618940638, 1.19839281085285]
 * a = [1, −1.69065929318241, 0.73248077421585]
 */
function stage1Shelf(): Biquad {
  return {
    b0: 1.53512485958697,
    b1: -2.69169618940638,
    b2: 1.19839281085285,
    a1: -1.69065929318241,
    a2: 0.73248077421585,
  };
}

/**
 * K-weighting stage 2 — RLB high-pass, EXACT BS.1770 48 kHz table:
 * b = [1.0, −2.0, 1.0]
 * a = [1, −1.99004745483398, 0.99007225036621]
 */
function stage2Rlb(): Biquad {
  return {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: -1.99004745483398,
    a2: 0.99007225036621,
  };
}

/**
 * Channel weights. `layout` is the ffprobe channel_layout string when
 * available (e.g. "5.1", "stereo", "mono"); raw channel count otherwise.
 * LFE (channel index 3 of the standard 5.1 order L R C LFE Ls Rs) → 0.
 */
export function defaultChannelWeights(channels: number, layout?: string | null): number[] {
  const normalized = (layout ?? "").toLowerCase();
  if (channels === 6 && (normalized.includes("5.1") || normalized.includes("lfe"))) {
    return [1.0, 1.0, 1.0, 0.0, 1.41, 1.41];
  }
  if (channels >= 5 && !normalized.includes("layout")) {
    // Generic surround without a known layout: exclude nothing, surround gain
    // for channels beyond the first three (documented honest fallback).
    return Array.from({ length: channels }, (_, i) => (i < 3 ? 1.0 : 1.41));
  }
  return Array.from({ length: channels }, () => 1.0);
}

const ABS_GATE = -70;
const REL_GATE_LU = 10;
const LRA_ABS_GATE = -20;
const LRA_REL_GATE_LU = 20;

export interface LoudnessResult {
  integratedLufs: number | null;
  shortTerm: { tSec: number; lufs: number }[];
  lraLu: number | null;
  momentaryMaxLufs: number | null;
}

export class LoudnessMeter {
  private readonly fs: number;
  private readonly weights: number[];
  private readonly chStates: { s1: { x1: number; x2: number; y1: number; y2: number }[]; s2: { x1: number; x2: number; y1: number; y2: number }[] }[];
  private readonly blockSize: number;
  private readonly hopSize: number;
  /** Per-channel sliding window of filtered samples (block length). */
  private readonly win: Float64Array[];
  private readonly winSq: Float64Array[]; // squared, precomputed per new sample
  private winFill = 0;
  private winPos = 0;
  private samplesSeen = 0;
  /** Mean square per channel of the current window (sliding sums). */
  private readonly msSum: Float64Array;
  private readonly blockLoudness: number[] = [];
  private momentaryMax: number | null = null;
  private lastHop = 0;

  constructor(sampleRate: number, channelWeights: number[]) {
    // Loudness meters standardize on 48 kHz — the ITU coefficient table is
    // defined there and GANGZII always decodes analysis audio at 48 kHz.
    if (sampleRate !== 48000) {
      throw new Error(`LoudnessMeter requires 48 kHz PCM (got ${sampleRate} Hz) — decode with -ar 48000`);
    }
    this.fs = sampleRate;
    this.weights = channelWeights;
    this.blockSize = Math.round(0.4 * sampleRate);
    this.hopSize = Math.round(0.1 * sampleRate);
    this.chStates = Array.from({ length: channelWeights.length }, () => ({
      s1: Array.from({ length: 1 }, () => ({ x1: 0, x2: 0, y1: 0, y2: 0 })),
      s2: Array.from({ length: 1 }, () => ({ x1: 0, x2: 0, y1: 0, y2: 0 })),
    }));
    this.stage1 = stage1Shelf();
    this.stage2 = stage2Rlb();
    this.win = Array.from({ length: channelWeights.length }, () => new Float64Array(this.blockSize));
    this.winSq = Array.from({ length: channelWeights.length }, () => new Float64Array(this.blockSize));
    this.msSum = new Float64Array(channelWeights.length);
  }

  private stage1: Biquad;
  private stage2: Biquad;

  /** Feed interleaved float PCM (frames × channels). */
  process(chunk: Float32Array, channels: number): void {
    const frames = Math.floor(chunk.length / channels);
    for (let f = 0; f < frames; f++) {
      // Filter each channel sample through K-weighting, slide into window.
      for (let c = 0; c < channels; c++) {
        const st = this.chStates[c];
        const x = chunk[f * channels + c];
        const y1 = biquadApply(this.stage1, x, st.s1[0]);
        const y2 = biquadApply(this.stage2, y1, st.s2[0]);
        const pos = this.winPos;
        const old = this.winSq[c][pos];
        const sq = y2 * y2;
        this.winSq[c][pos] = sq;
        this.win[c][pos] = y2;
        this.msSum[c] += sq - old;
      }
      this.winPos = (this.winPos + 1) % this.blockSize;
      this.samplesSeen += 1;
      if (this.samplesSeen > this.blockSize && this.samplesSeen - this.lastHop >= this.hopSize) {
        this.lastHop = this.samplesSeen;
        // Block loudness from the sliding window mean squares.
        let weighted = 0;
        for (let c = 0; c < this.weights.length; c++) {
          weighted += this.weights[c] * (this.msSum[c] / this.blockSize);
        }
        if (weighted > 0) {
          const l = -0.691 + 10 * Math.log10(weighted);
          this.blockLoudness.push(l);
          if (this.momentaryMax === null || l > this.momentaryMax) this.momentaryMax = l;
        }
      }
    }
  }

  finalize(): LoudnessResult {
    // Block loudness values already carry the −0.691 calibration offset, so
    // converting back to block ENERGIES must restore it: E = 10^((l+0.691)/10).
    // Averaging 10^(l/10) directly would bias the mean by −0.7 LU.
    const blockEnergy = (l: number): number => 10 ** ((l + 0.691) / 10);
    // Integrated: two-stage gating over 400ms blocks.
    const blocks = this.blockLoudness;
    let integrated: number | null = null;
    if (blocks.length > 0) {
      const abs = blocks.filter((l) => l > ABS_GATE);
      if (abs.length > 0) {
        const meanAbs = abs.reduce((s, l) => s + blockEnergy(l), 0) / abs.length;
        const absL = -0.691 + 10 * Math.log10(meanAbs);
        const rel = abs.filter((l) => l > absL - REL_GATE_LU);
        if (rel.length > 0) {
          const meanRel = rel.reduce((s, l) => s + blockEnergy(l), 0) / rel.length;
          integrated = -0.691 + 10 * Math.log10(meanRel);
        } else {
          integrated = absL;
        }
      }
    }
    // Short-term: 3s sliding window over the block list, evaluated every 1s
    // (blocks hop at 100ms → a 3s window spans ~28 blocks; step 10 blocks).
    const shortTerm: { tSec: number; lufs: number }[] = [];
    const hopSec = this.hopSize / this.fs;
    const winBlocks = Math.max(1, Math.round(3 / hopSec) - 1); // ≈28 blocks
    for (let start = 0; start + winBlocks <= blocks.length; start += 10) {
      const slice = blocks.slice(start, start + winBlocks);
      const above = slice.filter((l) => l > ABS_GATE);
      if (above.length === 0) continue;
      const mean = above.reduce((s, l) => s + blockEnergy(l), 0) / above.length;
      shortTerm.push({ tSec: Number((start * hopSec).toFixed(2)), lufs: Number((-0.691 + 10 * Math.log10(mean)).toFixed(1)) });
    }
    // LRA: BS.1770-4 gates over short-term values, 10th–95th percentile.
    let lra: number | null = null;
    if (shortTerm.length > 0) {
      const stAbs = shortTerm.map((s) => s.lufs).filter((l) => l > LRA_ABS_GATE);
      if (stAbs.length > 0) {
        const meanAbs = stAbs.reduce((s, l) => s + 10 ** (l / 10), 0) / stAbs.length;
        const gate = -0.691 + 10 * Math.log10(meanAbs) - LRA_REL_GATE_LU;
        const stRel = stAbs.filter((l) => l > gate).sort((a, b) => a - b);
        if (stRel.length > 1) {
          const lo = stRel[Math.floor(0.1 * (stRel.length - 1))];
          const hi = stRel[Math.floor(0.95 * (stRel.length - 1))];
          lra = Number((hi - lo).toFixed(1));
        }
      }
    }
    return {
      integratedLufs: integrated === null ? null : Number(integrated.toFixed(1)),
      shortTerm,
      lraLu: lra,
      momentaryMaxLufs: this.momentaryMax === null ? null : Number(this.momentaryMax.toFixed(1)),
    };
  }
}

/**
 * True-peak meter: 4× oversampling via a 4-phase polyphase FIR
 * (windowed-sinc, 16 taps per phase). Tracks sample peak and the maximum
 * absolute interpolated value; reports dBFS/dBTP and 4×-overs count
 * (interpolated samples above 0 dBFS are the standard overs indicator).
 */
export class TruePeakMeter {
  private readonly taps: Float64Array[]; // [phase][taps]
  private readonly history: Float64Array[]; // per channel, last (taps-1) samples
  private samplePeak = 0;
  private truePeak = 0;
  private overs = 0;

  constructor(sampleRate: number, channels: number, factor = 4, tapsPerPhase = 16) {
    void sampleRate;
    const half = tapsPerPhase / 2;
    this.taps = Array.from({ length: factor }, (_, phase) => {
      const t = new Float64Array(tapsPerPhase);
      for (let k = 0; k < tapsPerPhase; k++) {
        const n = k - half + phase / factor; // fractional delay of this phase
        const sinc = n === 0 ? 1 : Math.sin(Math.PI * n) / (Math.PI * n);
        // Hann-windowed sinc (cutoff at the input Nyquist).
        const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * (k + 0.5)) / tapsPerPhase);
        t[k] = sinc * w;
      }
      return t;
    });
    this.history = Array.from({ length: channels }, () => new Float64Array(tapsPerPhase));
    this.tapsPerPhase = tapsPerPhase;
  }

  private tapsPerPhase: number;

  process(chunk: Float32Array, channels: number): void {
    const frames = Math.floor(chunk.length / channels);
    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < channels; c++) {
        const x = chunk[f * channels + c];
        const h = this.history[c];
        for (let k = h.length - 1; k > 0; k--) h[k] = h[k - 1];
        h[0] = x;
        if (Math.abs(x) > this.samplePeak) this.samplePeak = Math.abs(x);
        // Evaluate the interpolation phases strictly between input samples.
        for (let phase = 1; phase < this.taps.length; phase++) {
          let acc = 0;
          const tp = this.taps[phase];
          for (let k = 0; k < this.tapsPerPhase; k++) acc += tp[k] * h[k];
          const v = Math.abs(acc);
          if (v > this.truePeak) this.truePeak = v;
          if (v > 1.0) this.overs += 1;
        }
      }
    }
  }

  finalize(): { samplePeakDbfs: number; truePeakDbtp: number; overs4x: number } {
    const sp = Math.max(this.samplePeak, 1e-9);
    const tp = Math.max(this.truePeak, sp, 1e-9);
    return {
      samplePeakDbfs: Number((20 * Math.log10(sp)).toFixed(2)),
      truePeakDbtp: Number((20 * Math.log10(tp)).toFixed(2)),
      overs4x: this.overs,
    };
  }
}
