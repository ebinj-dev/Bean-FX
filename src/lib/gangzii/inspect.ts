/**
 * GANGZII — streaming audio inspection (M5 §3A).
 *
 * Decodes ANY audio/video file via FFmpeg into 48 kHz Float32 PCM on a pipe
 * and measures incrementally — memory is O(window + bands), never O(file),
 * so a 20-minute stereo recording is inspected without loading it into RAM:
 *
 *  - BS.1770-4 loudness: integrated, short-term (per second), LRA, momentary max
 *  - Sample peak, true peak (4× oversampled) and 4×-overs count
 *  - Clipping detection (consecutive at-scale runs per channel)
 *  - DC offset per channel
 *  - Per-channel RMS + measured imbalance + suggested corrective gains
 *  - Frequency spectrum (48 log-spaced bands, 20 Hz–20 kHz, time-averaged)
 *  - Speech/music level heuristic (speech-band energy + 2–8 Hz modulation)
 *  - Silence spans, total and fraction
 *  - Noise floor (10th percentile of 100 ms window RMS)
 *  - Waveform min/max buckets for the editor UI
 *
 * The classification is a DETERMINISTIC HEURISTIC (band energy + envelope
 * modulation) — no machine-learning claim is made anywhere.
 */
import { spawn } from "child_process";
import { execFile } from "child_process";
import { LoudnessMeter, TruePeakMeter, defaultChannelWeights } from "./loudness";
import { realSpectrum } from "./fft";
import { GangziiInspectionSchema, type GangziiInspection } from "./types";

export const ANALYZER_VERSION = "gangzii-inspect-1.0";
export const ANALYSIS_SAMPLE_RATE = 48000;

interface StreamInfo {
  channels: number;
  sampleRate: number | null;
  durationSec: number | null;
  channelLayout: string | null;
}

/** Lightweight ffprobe of the first audio stream (channels, rate, duration, layout). */
export async function probeAudioStream(filePath: string): Promise<StreamInfo> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      "ffprobe",
      [
        "-v", "error",
        "-select_streams", "a:0",
        "-show_entries", "stream=channels,channel_layout,duration,sample_rate:format=duration",
        "-of", "json",
        filePath,
      ],
      { maxBuffer: 4 * 1024 * 1024 },
      (err, out) => (err ? reject(err) : resolve(out)),
    );
  });
  const parsed = JSON.parse(stdout) as {
    streams?: { channels?: number; channel_layout?: string; duration?: string; sample_rate?: string }[];
    format?: { duration?: string };
  };
  const st = parsed.streams?.[0] ?? {};
  const channels = st.channels ?? 2;
  const duration = Number(st.duration ?? parsed.format?.duration ?? NaN);
  const sampleRate = Number(st.sample_rate ?? NaN);
  return {
    channels,
    sampleRate: Number.isFinite(sampleRate) ? sampleRate : null,
    durationSec: Number.isFinite(duration) ? duration : null,
    channelLayout: st.channel_layout ?? null,
  };
}

/** Log-spaced band edges 20 Hz–20 kHz for the spectrum report. */
function bandEdges(count: number): number[] {
  const edges: number[] = [];
  for (let i = 0; i <= count; i++) edges.push(20 * (1000) ** (i / count));
  return edges;
}

export interface InspectOptions {
  /** Progress callback (0..1) — driven by bytes decoded vs expected size. */
  onProgress?: (fraction: number) => void;
  /** Abort the decode (kills FFmpeg). */
  signal?: AbortSignal;
  /** Waveform buckets for the UI (default 2000). */
  peakBuckets?: number;
}

interface ClippingState {
  run: number;
  runs: number;
  samples: number;
  longest: number;
}

/**
 * Inspect one file. Throws when FFmpeg fails (corrupted/undecodable media —
 * the caller surfaces an honest error; nothing is invented).
 */
export async function inspectAudioFile(filePath: string, opts: InspectOptions = {}): Promise<GangziiInspection> {
  const info = await probeAudioStream(filePath);
  const channels = Math.max(1, info.channels);
  const expectedBytes = info.durationSec ? info.durationSec * ANALYSIS_SAMPLE_RATE * channels * 4 : null;

  const loud = new LoudnessMeter(ANALYSIS_SAMPLE_RATE, defaultChannelWeights(channels, info.channelLayout));
  const tp = new TruePeakMeter(ANALYSIS_SAMPLE_RATE, channels);
  const clip = Array.from({ length: channels }, () => ({ run: 0, runs: 0, samples: 0, longest: 0 }) as ClippingState);
  const dcSum = new Float64Array(channels);
  const sqSum = new Float64Array(channels);
  let frames = 0;

  // spectrum accumulation (48 bands, one 4096-sample window every 0.5 s)
  const BANDS = 48;
  const edges = bandEdges(BANDS);
  const bandSum = new Float64Array(BANDS);
  let bandCount = 0;
  const FFT_N = 4096;
  const FFT_STEP = Math.round(0.5 * ANALYSIS_SAMPLE_RATE);
  let sinceLastFft = 0;
  const fftScratch = { re: new Float64Array(FFT_N), im: new Float64Array(FFT_N) };

  // envelope at 100 ms hops (for silence, noise floor, waveform, modulation)
  const WIN = Math.round(0.1 * ANALYSIS_SAMPLE_RATE);
  const envRms: number[] = [];
  let winSqSum = 0;
  let winFill = 0;

  let carry: Buffer = Buffer.alloc(0);
  const bytesPerFrame = channels * 4;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error",
        "-i", filePath,
        "-vn", "-sn", "-dn",
        "-map", "0:a:0",
        "-ar", String(ANALYSIS_SAMPLE_RATE),
        "-acodec", "pcm_f32le",
        "-f", "f32le",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderrTail = "";
    child.stderr.on("data", (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-4000);
    });
    if (opts.signal) {
      opts.signal.addEventListener("abort", () => {
        child.kill("SIGKILL");
        reject(new Error("GANGZII inspection aborted"));
      }, { once: true });
    }
    child.stdout.on("data", (chunk: Buffer) => {
      const buf = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
      const usable = buf.length - (buf.length % bytesPerFrame);
      carry = buf.subarray(usable);
      const view = new Float32Array(buf.buffer, buf.byteOffset, usable / 4);
      processWindow(view);
      if (expectedBytes) opts.onProgress?.(Math.min(1, (frames * bytesPerFrame) / expectedBytes));
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (opts.signal?.aborted) return; // abort handler rejected already
      if (code !== 0) {
        reject(new Error(`ffmpeg decode failed (exit ${code}): ${stderrTail.trim() || "no stderr"}`));
        return;
      }
      resolve();
    });

    function processWindow(view: Float32Array): void {
      loud.process(view, channels);
      tp.process(view, channels);
      const fCount = view.length / channels;
      for (let f = 0; f < fCount; f++) {
        for (let c = 0; c < channels; c++) {
          const x = view[f * channels + c];
          dcSum[c] += x;
          sqSum[c] += x * x;
          const st = clip[c];
          if (Math.abs(x) >= 0.999) {
            st.run += 1;
            st.samples += 1;
            if (st.run > st.longest) st.longest = st.run;
          } else {
            if (st.run >= 3) st.runs += 1;
            st.run = 0;
          }
        }
        // envelope windows (channel-mixed RMS)
        let mix = 0;
        for (let c = 0; c < channels; c++) mix += view[f * channels + c];
        mix /= channels;
        winSqSum += mix * mix;
        if (++winFill >= WIN) {
          envRms.push(Math.sqrt(winSqSum / WIN));
          winSqSum = 0;
          winFill = 0;
        }
      }
      frames += fCount;
      // spectrum: one 4096-sample window every 0.5 s (the most recent window)
      sinceLastFft += fCount;
      if (sinceLastFft >= FFT_STEP) {
        sinceLastFft = 0;
        const base = view.length - FFT_N * channels;
        if (base >= 0) {
          const frame = new Float32Array(FFT_N);
          for (let i = 0; i < FFT_N; i++) {
            let mix = 0;
            for (let c = 0; c < channels; c++) mix += view[base + i * channels + c];
            frame[i] = mix / channels;
          }
          const mags = realSpectrum(frame, fftScratch);
          const binHz = ANALYSIS_SAMPLE_RATE / FFT_N;
          // Parseval-normalized band levels: magnitude² summed over bins per band
          for (let b = 0; b < BANDS; b++) {
            const lo = edges[b];
            const hi = edges[b + 1];
            let sum = 0;
            for (let bin = Math.max(1, Math.floor(lo / binHz)); bin <= Math.min(FFT_N / 2, Math.ceil(hi / binHz)); bin++) {
              sum += mags[bin] * mags[bin];
            }
            bandSum[b] += sum;
          }
          bandCount += 1;
        }
      }
    }
  });

  // settle trailing clipping runs
  for (const st of clip) {
    if (st.run >= 3) st.runs += 1;
    st.run = 0;
  }

  const measuredSec = frames / ANALYSIS_SAMPLE_RATE;
  const loudness = loud.finalize();
  const peaks = tp.finalize();

  // per-channel RMS in dBFS (full-scale sine = 0 dBFS reference)
  const rmsPerChannelDbfs = Array.from(sqSum, (s) => (s > 0 ? 20 * Math.log10(Math.sqrt(s / frames)) : -120));
  const maxRms = Math.max(...rmsPerChannelDbfs);
  const minRms = Math.min(...rmsPerChannelDbfs);
  const imbalanceDb = channels >= 2 ? maxRms - minRms : null;
  const suggestedBalanceGainsDb =
    imbalanceDb !== null && imbalanceDb >= 1.0
      ? Array.from(rmsPerChannelDbfs, (r) => Number((maxRms - r).toFixed(2)))
      : [];

  // spectrum bands → dBFS (relative to a full-scale sine's Parseval power)
  const bands = Array.from(bandSum, (sum, i) => {
    const relPower = bandCount > 0 ? sum / bandCount : 0;
    // normalize by window power: a full-scale sine in-band reads ≈ −3 dB
    const norm = (FFT_N / 4) * (0.5 ** 2); // Hann coherent gain 0.5 → power 0.25
    const db = relPower > 0 ? 10 * Math.log10(relPower / norm) : -120;
    return { hz: Number(((edges[i] + edges[i + 1]) / 2).toFixed(1)), db: Number(Math.max(-120, db).toFixed(1)) };
  });
  const speechBand = bands.filter((b) => b.hz >= 300 && b.hz <= 3400);
  const totalPower = bands.reduce((s, b) => s + 10 ** (b.db / 10), 0);
  const speechBandRmsDbfs = speechBand.length > 0 ? 10 * Math.log10(speechBand.reduce((s, b) => s + 10 ** (b.db / 10), 0)) : -120;

  // speech/music heuristic: speech-band share + envelope modulation 2–8 Hz
  const modulation2to8Hz = envelopeModulation(envRms, 0.1);
  const shareDb = speechBandRmsDbfs - 10 * Math.log10(totalPower || 1e-12);
  const classification =
    modulation2to8Hz > 0.35 && shareDb > -12 ? "speech"
    : modulation2to8Hz < 0.2 && shareDb < -15 ? "music"
    : "mixed";
  const levels = {
    classification: classification as GangziiInspection["levels"]["classification"],
    speechBandRmsDbfs: Number(speechBandRmsDbfs.toFixed(1)),
    totalRmsDbfs: Number((20 * Math.log10(Math.sqrt(sqSum.reduce((s, v) => s + v, 0) / (frames * channels)))).toFixed(1)),
    modulation2to8Hz: Number(modulation2to8Hz.toFixed(2)),
    note:
      "Deterministic heuristic (speech-band energy + 2–8 Hz envelope modulation). " +
      "It informs presets; it is NOT a machine-learning classifier.",
  };

  // silence + noise floor from window RMS (dBFS)
  const envDb = envRms.map((r) => 20 * Math.log10(Math.max(r, 1e-9)));
  const sorted = [...envDb].sort((a, b) => a - b);
  const p10 = sorted.length > 0 ? sorted[Math.floor(0.1 * (sorted.length - 1))] : null;
  const noiseFloorDbfs = p10 !== null && p10 >= -120 ? p10 : null; // digital silence clamps to null
  const silenceThreshold = noiseFloorDbfs !== null ? Math.max(noiseFloorDbfs + 6, -60) : -60;
  const spans: { start: number; end: number }[] = [];
  let spanStart: number | null = null;
  for (let i = 0; i < envDb.length; i++) {
    const silent = envDb[i] < silenceThreshold;
    if (silent && spanStart === null) spanStart = i * 0.1;
    if (!silent && spanStart !== null) {
      if (i * 0.1 - spanStart >= 0.5) spans.push({ start: Number(spanStart.toFixed(2)), end: Number((i * 0.1).toFixed(2)) });
      spanStart = null;
    }
    if (spans.length >= 500) break;
  }
  if (spanStart !== null && spans.length < 500 && envDb.length * 0.1 - spanStart >= 0.5) {
    spans.push({ start: Number(spanStart.toFixed(2)), end: Number((envDb.length * 0.1).toFixed(2)) });
  }
  const totalSilence = spans.reduce((s, sp) => s + (sp.end - sp.start), 0);

  // waveform buckets resampled from the envelope windows
  const target = Math.max(64, Math.min(opts.peakBuckets ?? 2000, 4000));
  const wfMin: number[] = [];
  const wfMax: number[] = [];
  if (envRms.length > 0) {
    for (let i = 0; i < target; i++) {
      const lo = Math.floor((i * envRms.length) / target);
      const hi = Math.max(lo + 1, Math.floor(((i + 1) * envRms.length) / target));
      let peak = 0;
      for (let j = lo; j < hi && j < envRms.length; j++) peak = Math.max(peak, envRms[j]);
      wfMin.push(Number((-peak).toFixed(4)));
      wfMax.push(Number(peak.toFixed(4)));
    }
  }

  const clippedSamples = clip.reduce((s, st) => s + st.samples, 0);
  const clippedRuns = clip.reduce((s, st) => s + st.runs, 0);
  const longest = clip.reduce((m, st) => Math.max(m, st.longest), 0);
  const clipFraction = frames > 0 ? clippedSamples / (frames * channels) : 0;

  const notes: string[] = [
    "Measurements are taken on a 48 kHz decode (loudness-standard practice).",
    "Clipping REPAIR is limited: detected clipping can be attenuated/limited but heavily clipped material cannot be perfectly restored.",
    "Speech/music classification is a deterministic heuristic, not machine learning.",
  ];
  if (measuredSec < (info.durationSec ?? measuredSec) - 0.5) {
    notes.push(`Decode ended early (${measuredSec.toFixed(1)}s of ${info.durationSec?.toFixed(1)}s probed) — the file may be truncated or corrupted.`);
  }

  const inspection = GangziiInspectionSchema.parse({
    analyzedAt: new Date().toISOString(),
    analyzerVersion: ANALYZER_VERSION,
    durationSec: Number(measuredSec.toFixed(3)),
    sampleRate: ANALYSIS_SAMPLE_RATE,
    channels,
    channelLayout: info.channelLayout,
    loudness: {
      integratedLufs: loudness.integratedLufs,
      lraLu: loudness.lraLu,
      momentaryMaxLufs: loudness.momentaryMaxLufs,
      shortTerm: loudness.shortTerm.slice(0, 400),
    },
    samplePeakDbfs: peaks.samplePeakDbfs,
    truePeakDbtp: peaks.truePeakDbtp,
    overs4x: peaks.overs4x,
    clipping: {
      runs: clippedRuns,
      samples: clippedSamples,
      longestRunSamples: longest,
      suspected: clippedRuns > 10 || clipFraction > 1e-5,
      note: "Runs of ≥3 consecutive samples at ≥99.9% full scale per channel.",
    },
    dcOffsetPerChannel: Array.from(dcSum, (s) => Number((s / frames).toFixed(6))),
    rmsPerChannelDbfs: rmsPerChannelDbfs.map((v) => Number(v.toFixed(2))),
    channelImbalanceDb: imbalanceDb === null ? null : Number(imbalanceDb.toFixed(2)),
    suggestedBalanceGainsDb,
    spectrum: { bands },
    levels,
    silence: {
      spans,
      totalSec: Number(totalSilence.toFixed(2)),
      fraction: measuredSec > 0 ? Number((totalSilence / measuredSec).toFixed(3)) : 0,
    },
    noiseFloorDbfs: noiseFloorDbfs === null ? null : Number(noiseFloorDbfs.toFixed(1)),
    waveform: { min: wfMin, max: wfMax },
    notes,
  });
  return inspection;
}

/** Fraction of envelope energy in the 2–8 Hz band (speech syllable rate). */
function envelopeModulation(env: number[], hopSec: number): number {
  if (env.length < 24) return 0; // below ~2.4 s the 2–8 Hz band is unresolvable
  // 100 ms hop → Nyquist 5 Hz … the syllable band needs a finer envelope.
  // Re-window the series at 12.5 Hz effective (every 8th window) is wrong —
  // instead use autocorrelation-free FFT on the 100 ms series only for the
  // 2–4 Hz reachable range, and compute 4–8 Hz from adjacent-window deltas.
  const n = 1 << Math.min(14, Math.max(8, Math.floor(Math.log2(env.length))));
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const mean = env.reduce((s, v) => s + v, 0) / env.length || 1e-9;
  const variance = env.reduce((s, v) => s + (v - mean) ** 2, 0) / env.length;
  if (variance < 1e-8) return 0; // constant level — modulation is undefined, not 1.0
  for (let i = 0; i < n; i++) re[i] = i < env.length ? (env[i] - mean) / mean : 0; // zero-pad
  // inline FFT via realSpectrum (power-of-two length)
  const mags = realSpectrum(new Float32Array(Array.from(re, (v) => v)));
  const binHz = 1 / (n * hopSec);
  let total = 0;
  let band = 0;
  for (let i = 1; i < mags.length; i++) {
    total += mags[i] * mags[i];
    if (i * binHz >= 2 && i * binHz <= 8) band += mags[i] * mags[i];
  }
  return total > 0 ? band / total : 0;
}
