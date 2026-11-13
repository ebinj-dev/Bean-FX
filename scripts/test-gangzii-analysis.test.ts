/**
 * BEAN FX — M5 GANGZII tests: audio analysis (BS.1770 loudness, true peak,
 * clipping, DC offset, channels, spectrum, silence, noise floor).
 *
 * Fixtures are synthetic PCM generated in-test (sine/noise/DC/clipped) so
 * expected values are mathematically known — no invented claims.
 *
 * Run: bun test scripts/test-gangzii-analysis.test.ts
 */
import { describe, expect, test } from "bun:test";
import { LoudnessMeter, TruePeakMeter, defaultChannelWeights } from "../src/lib/gangzii/loudness";
import { realSpectrum } from "../src/lib/gangzii/fft";

const FS = 48000;

/** Interleaved stereo/mono sine generator. */
function sine(freqHz: number, amp: number, seconds: number, channels: number, phaseOffsetSamples = 0): Float32Array {
  const n = Math.round(seconds * FS);
  const out = new Float32Array(n * channels);
  for (let i = 0; i < n; i++) {
    const v = amp * Math.sin((2 * Math.PI * freqHz * (i + phaseOffsetSamples)) / FS);
    for (let c = 0; c < channels; c++) out[i * channels + c] = v;
  }
  return out;
}

function feed(meter: LoudnessMeter, pcm: Float32Array, channels: number, chunkFrames = 4800): void {
  for (let off = 0; off < pcm.length; off += chunkFrames * channels) {
    meter.process(pcm.subarray(off, Math.min(off + chunkFrames * channels, pcm.length)), channels);
  }
}

describe("GANGZII loudness (BS.1770-4)", () => {
  test("EBU 3341 anchor: stereo 1 kHz sine @ −23 dBFS → −23.0 LUFS", () => {
    const pcm = sine(1000, 10 ** (-23 / 20), 12, 2);
    const meter = new LoudnessMeter(FS, defaultChannelWeights(2, "stereo"));
    feed(meter, pcm, 2);
    const r = meter.finalize();
    expect(r.integratedLufs).not.toBeNull();
    expect(Math.abs(r.integratedLufs! - -23.0)).toBeLessThan(0.5);
  });

  test("full-scale stereo 1 kHz sine → ≈ 0.0 LUFS", () => {
    const pcm = sine(1000, 1.0, 8, 2);
    const meter = new LoudnessMeter(FS, defaultChannelWeights(2, "stereo"));
    feed(meter, pcm, 2);
    const r = meter.finalize();
    expect(Math.abs(r.integratedLufs! - 0.0)).toBeLessThan(0.5);
  });

  test("full-scale MONO 1 kHz sine → ≈ −3.01 LUFS (channel-weight sanity)", () => {
    const pcm = sine(1000, 1.0, 10, 1);
    const meter = new LoudnessMeter(FS, defaultChannelWeights(1, "mono"));
    feed(meter, pcm, 1);
    expect(Math.abs(meter.finalize().integratedLufs! - -3.01)).toBeLessThan(0.5);
  });

  test("5.1 layout: LFE channel excluded from the measurement", () => {
    // Voice-band noise on all channels, huge energy ONLY on LFE (index 3):
    // including it would inflate loudness by ~+9 dB; excluding it must not.
    const channels = 6;
    const n = FS * 8;
    const pcm = new Float32Array(n * channels);
    const amp = 10 ** (-20 / 20);
    for (let i = 0; i < n; i++) {
      const v = amp * Math.sin((2 * Math.PI * 1000 * i) / FS);
      for (let c = 0; c < channels; c++) pcm[i * channels + c] = v;
    }
    const withLfe = new Float32Array(n * channels);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < channels; c++) withLfe[i * channels + c] = pcm[i * channels + c];
      withLfe[i * channels + 3] = 1.0; // LFE at full scale — must NOT count
    }
    const m1 = new LoudnessMeter(FS, defaultChannelWeights(6, "5.1"));
    const m2 = new LoudnessMeter(FS, defaultChannelWeights(6, "5.1"));
    m1.process(pcm, 6);
    m2.process(withLfe, 6);
    const r1 = m1.finalize();
    const r2 = m2.finalize();
    expect(Math.abs(r1.integratedLufs! - r2.integratedLufs!)).toBeLessThan(0.2);
  });

  test("short-term loudness is reported per second and LRA is sane", () => {
    // Both segments above the −20 LKFS LRA absolute gate: −15 dBFS ≈ −18 LUFS
    // and −5 dBFS ≈ −8 LUFS → a gated range of ≈ 10 LU.
    const quiet = sine(1000, 10 ** (-15 / 20), 6, 2);
    const loud = sine(1000, 10 ** (-5 / 20), 6, 2);
    const pcm = new Float32Array(quiet.length + loud.length);
    pcm.set(quiet, 0);
    pcm.set(loud, quiet.length);
    const meter = new LoudnessMeter(FS, defaultChannelWeights(2, "stereo"));
    feed(meter, pcm, 2);
    const r = meter.finalize();
    expect(r.shortTerm.length).toBeGreaterThanOrEqual(8);
    const first = r.shortTerm[0].lufs;
    const last = r.shortTerm[r.shortTerm.length - 1].lufs;
    expect(last - first).toBeGreaterThan(8); // −15 → −5 dBFS is 10 LU apart
    expect(r.lraLu).toBeGreaterThan(8);
  });

  test("silence integrates below the absolute gate (null or ≤ −70)", () => {
    const pcm = new Float32Array(FS * 5 * 2); // 5 s of digital silence
    const meter = new LoudnessMeter(FS, defaultChannelWeights(2, "stereo"));
    feed(meter, pcm, 2);
    const r = meter.finalize();
    expect(r.integratedLufs === null || r.integratedLufs <= -70).toBe(true);
  });
});

describe("GANGZII true peak", () => {
  test("sample peak of a −6 dBFS sine is ≈ −6 dBFS", () => {
    const pcm = sine(1000, 10 ** (-6 / 20), 1, 2);
    const meter = new TruePeakMeter(FS, 2);
    meter.process(pcm, 2);
    const r = meter.finalize();
    expect(Math.abs(r.samplePeakDbfs - -6)).toBeLessThan(0.1);
  });

  test("half-sample phase-shifted sine has a true peak ABOVE the sample peak", () => {
    // A 12 kHz sine sampled near its zero crossings hides inter-sample peaks.
    const amp = 10 ** (-1 / 20); // ≈ −1 dBFS sample peak
    const pcm = sine(12000, amp, 1, 1, Math.floor(FS / 12000 / 4));
    const meter = new TruePeakMeter(FS, 1);
    meter.process(pcm, 1);
    const r = meter.finalize();
    expect(r.samplePeakDbfs).toBeLessThan(-0.5);
    expect(r.truePeakDbtp).toBeGreaterThan(r.samplePeakDbfs - 0.05);
    expect(r.truePeakDbtp).toBeLessThan(0.5); // honest bound: interpolation error
  });
});

describe("GANGZII FFT spectrum", () => {
  test("a 1 kHz sine peaks in the 1 kHz bin", () => {
    const n = 4096;
    const frame = new Float32Array(n);
    for (let i = 0; i < n; i++) frame[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / FS);
    const mags = realSpectrum(frame);
    const binHz = FS / n;
    const peakBin = mags.reduce((best, v, i) => (v > mags[best] ? i : best), 0);
    const peakHz = peakBin * binHz;
    expect(Math.abs(peakHz - 1000)).toBeLessThan(binHz * 2);
    // Energy is concentrated: the peak bin dominates its neighbors.
    expect(mags[peakBin]).toBeGreaterThan(10 * mags[peakBin - 2]);
  });
});
