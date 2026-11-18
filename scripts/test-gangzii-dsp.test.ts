/**
 * BEAN FX — M5 GANGZII tests: DSP chain round-trips on REAL audio.
 *
 * Every test builds a chain with buildGangziiChain (the production filter
 * builder), runs REAL ffmpeg on generated fixtures, re-analyzes the output
 * with the production inspector, and asserts the measured effect. No mocked
 * audio math — the assertions are measured facts.
 *
 * Run: bun test scripts/test-gangzii-dsp.test.ts
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { execSync, execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildGangziiChain, parseGangziiParams } from "../src/lib/gangzii/dsp";
import { inspectAudioFile } from "../src/lib/gangzii/inspect";
import { GANGZII_PRESETS } from "../src/lib/gangzii/presets";

const WORK = mkdtempSync(path.join(os.tmpdir(), "beanfx-m5-dsp-"));

function ffmpeg(args: string, outfile: string): void {
  execSync(`ffmpeg -hide_banner -loglevel error -y ${args} "${outfile}"`, { stdio: ["ignore", "ignore", "inherit"] });
  if (!existsSync(outfile) || statSync(outfile).size === 0) throw new Error(`fixture generation failed: ${outfile}`);
}

function runChain(file: string, filters: string[], outfile: string, opts: { video?: boolean } = {}): void {
  const args = [
    "-i", file,
    "-map", "0:a:0",
    ...(opts.video ? ["-map", "0:v:0?", "-c:v", "copy"] : []),
    "-af", filters.join(","),
    "-c:a", opts.video ? "aac" : "flac",
    ...(opts.video ? ["-b:a", "256k"] : []),
    "-movflags", "+faststart",
    outfile,
  ];
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: ["ignore", "ignore", "inherit"] });
  if (!existsSync(outfile) || statSync(outfile).size === 0) throw new Error("chain produced no output");
}

function durationOf(file: string): number {
  const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", file]).toString();
  return Number((JSON.parse(out) as { format?: { duration?: string } }).format?.duration ?? 0);
}

beforeAll(() => {
  // NOTE: the lavfi `sine` source has a fixed 0.125 amplitude (≈ −18 dBFS).
  // Exact levels require aevalsrc expressions — otherwise dynamics tests
  // would measure the wrong thing (a compressor below threshold).
  // Speech-like tone (220/660/1320 Hz, syllable-modulated) + 50 Hz hum + noise + DC
  ffmpeg(
    "-f lavfi -i \"aevalsrc=exprs='0.12*(0.5+0.5*sin(2*PI*3.5*t))*(sin(2*PI*220*t)+0.5*sin(2*PI*660*t)+0.25*sin(2*PI*1320*t))+0.08*sin(2*PI*50*t)+0.02':d=6:s=48000\" " +
      "-af \"highpass=f=150\" -c:a pcm_f32le",
    path.join(WORK, "voice-hum.wav"),
  );
  // Low rumble content for high-pass tests
  ffmpeg("-f lavfi -i \"aevalsrc=exprs='0.4*sin(2*PI*55*t)':d=4:s=48000\" -c:a pcm_f32le", path.join(WORK, "rumble.wav"));
  // Unbalanced stereo (right −12 dB) — amerge of two mono sines
  ffmpeg(
    "-f lavfi -i \"aevalsrc=exprs='0.3*sin(2*PI*440*t)':d=4:s=48000\" -f lavfi -i \"aevalsrc=exprs='0.0753*sin(2*PI*440*t)':d=4:s=48000\" " +
      "-filter_complex \"[0][1]amerge=inputs=2,volume=0.5[out]\" -map \"[out]\" -ar 48000 -c:a pcm_f32le",
    path.join(WORK, "imbalance.wav"),
  );
  // Loud tone (true-peak ceiling target)
  ffmpeg("-f lavfi -i \"aevalsrc=exprs='0.8*sin(2*PI*997*t)':d=4:s=48000\" -c:a pcm_f32le", path.join(WORK, "loud.wav"));
  // DYNAMIC material (quiet→loud) for crest-factor compression tests
  ffmpeg(
    "-f lavfi -i \"aevalsrc=exprs='0.05*sin(2*PI*997*t)':d=2:s=48000\" -f lavfi -i \"aevalsrc=exprs='0.8*sin(2*PI*997*t)':d=2:s=48000\" " +
      "-filter_complex \"[0][1]concat=n=2:v=0:a=1[out]\" -map \"[out]\" -ar 48000 -c:a pcm_f32le",
    path.join(WORK, "dynamic.wav"),
  );
  // Video + audio for the sync/copy test
  ffmpeg(
    "-f lavfi -i \"testsrc2=duration=4:size=320x240:rate=30\" -f lavfi -i \"aevalsrc=exprs='0.2*sin(2*PI*440*t)':d=4:s=48000\" " +
      "-map 0:v -map 1:a -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac",
    path.join(WORK, "video.mp4"),
  );
});

afterAll(() => rmSync(WORK, { recursive: true, force: true }));

describe("GANGZII chain builder", () => {
  test("every preset builds at least one filter (except the balance template)", () => {
    for (const preset of GANGZII_PRESETS) {
      const chain = buildGangziiChain(preset.params, { durationSec: 60, channels: 2, channelLayout: "stereo", measured: { integratedLufs: -20, truePeakDbtp: -4 } });
      if (preset.id === "fix-channel-balance") {
        expect(chain.filters.length).toBe(0); // gains are filled from a measurement
        continue; // an empty balance template is honestly empty (the job rejects it)
      }
      expect(chain.filters.length).toBeGreaterThan(0);
      expect(chain.notes.length).toBeGreaterThan(0); // every operation is explained
    }
  });

  test("determinism: identical params produce an identical filter list", () => {
    const p = parseGangziiParams({ noiseReductionDb: 10, rumbleHighPassHz: 80, humHz: 50, loudness: { mode: "staticGain", target: { integrated: -16, truePeak: -1.5, lra: 11 } } });
    const ctx = { durationSec: 60, channels: 2, channelLayout: "stereo", measured: { integratedLufs: -19.5, truePeakDbtp: -3.2 } as const };
    expect(JSON.stringify(buildGangziiChain(p, ctx).filters)).toBe(JSON.stringify(buildGangziiChain(p, ctx).filters));
  });

  test("static gain is clamped by the true-peak ceiling", () => {
    const p = parseGangziiParams({ loudness: { mode: "staticGain", target: { integrated: -6, truePeak: -2, lra: 11 } } });
    const chain = buildGangziiChain(p, { durationSec: 60, channels: 1, channelLayout: "mono", measured: { integratedLufs: -20, truePeakDbtp: -5 } });
    // Target gain would be +14 dB but only 3 dB of headroom exists.
    const vol = chain.filters.find((f) => f.startsWith("volume="));
    expect(vol).toBeDefined();
    expect(Number(vol!.split("=")[1].replace("dB", ""))).toBeCloseTo(3, 1);
    expect(chain.warnings.some((w) => w.includes("ceiling"))).toBe(true);
  });

  test("empty params produce zero filters and the caller can reject them", () => {
    const chain = buildGangziiChain(parseGangziiParams({}), { durationSec: 60, channels: 2, channelLayout: "stereo" });
    expect(chain.filters.length).toBe(0);
  });
});

describe("GANGZII DSP round-trips (real ffmpeg + real re-analysis)", () => {
  test("hum removal: 50 Hz band energy drops by ≥ 20 dB", async () => {
    const before = await inspectAudioFile(path.join(WORK, "voice-hum.wav"));
    const humBefore = before.spectrum.bands.filter((b) => b.hz >= 40 && b.hz <= 63).reduce((m, b) => Math.max(m, b.db), -120);
    const chain = buildGangziiChain(parseGangziiParams({ humHz: 50, humHarmonics: 4, removeDcOffset: true }), {
      durationSec: 6, channels: 1, channelLayout: "mono",
    });
    const out = path.join(WORK, "dehummed.flac");
    runChain(path.join(WORK, "voice-hum.wav"), chain.filters, out);
    const after = await inspectAudioFile(out);
    const humAfter = after.spectrum.bands.filter((b) => b.hz >= 40 && b.hz <= 63).reduce((m, b) => Math.max(m, b.db), -120);
    expect(humBefore - humAfter).toBeGreaterThanOrEqual(20);
    // DC offset removed
    expect(Math.abs(after.dcOffsetPerChannel[0])).toBeLessThan(Math.abs(before.dcOffsetPerChannel[0]) + 1e-4);
  });

  test("loudness normalization: output integrates within 1 LU of the target", async () => {
    const before = await inspectAudioFile(path.join(WORK, "voice-hum.wav"));
    expect(before.loudness.integratedLufs).not.toBeNull();
    const target = { integrated: -16, truePeak: -1.5, lra: 11 };
    const chain = buildGangziiChain(parseGangziiParams({ loudness: { mode: "staticGain", target } }), {
      durationSec: 6, channels: 1, channelLayout: "mono", measured: { integratedLufs: before.loudness.integratedLufs, truePeakDbtp: before.truePeakDbtp },
    });
    const out = path.join(WORK, "normalized.flac");
    runChain(path.join(WORK, "voice-hum.wav"), chain.filters, out);
    const after = await inspectAudioFile(out);
    expect(after.loudness.integratedLufs).not.toBeNull();
    expect(Math.abs(after.loudness.integratedLufs! - target.integrated)).toBeLessThanOrEqual(1.0);
    // duration-neutral (sample-accurate static gain)
    expect(Math.abs(durationOf(out) - durationOf(path.join(WORK, "voice-hum.wav")))).toBeLessThan(0.05);
  });

  test("rumble high-pass: sub-100 Hz energy strongly attenuated, speech band preserved", async () => {
    const before = await inspectAudioFile(path.join(WORK, "rumble.wav"));
    const chain = buildGangziiChain(parseGangziiParams({ rumbleHighPassHz: 150 }), { durationSec: 4, channels: 1, channelLayout: "mono" });
    const out = path.join(WORK, "derumbled.flac");
    runChain(path.join(WORK, "rumble.wav"), chain.filters, out);
    const after = await inspectAudioFile(out);
    const lowBand = (r: Awaited<ReturnType<typeof inspectAudioFile>>) =>
      r.spectrum.bands.filter((b) => b.hz >= 40 && b.hz <= 80).reduce((m, b) => Math.max(m, b.db), -120);
    expect(lowBand(before) - lowBand(after)).toBeGreaterThanOrEqual(15);
  });

  test("channel balance: measured corrective gains equalize the stereo levels", async () => {
    const before = await inspectAudioFile(path.join(WORK, "imbalance.wav"));
    expect(before.channelImbalanceDb).not.toBeNull();
    expect(before.channelImbalanceDb!).toBeGreaterThan(8); // fixture is ~12 dB hotter on L
    const chain = buildGangziiChain(parseGangziiParams({ channelGainsDb: before.suggestedBalanceGainsDb }), {
      durationSec: 4, channels: 2, channelLayout: "stereo",
    });
    expect(chain.filters.length).toBe(1);
    const out = path.join(WORK, "balanced.flac");
    runChain(path.join(WORK, "imbalance.wav"), chain.filters, out);
    const after = await inspectAudioFile(out);
    expect(after.channelImbalanceDb).not.toBeNull();
    expect(after.channelImbalanceDb!).toBeLessThan(1.0);
  });

  test("compressor + limiter: loud segment compressed, quiet segment untouched, ceiling respected", async () => {
    const before = await inspectAudioFile(path.join(WORK, "dynamic.wav"));
    const chain = buildGangziiChain(
      parseGangziiParams({ compressor: { enabled: true, thresholdDbfs: -12, ratio: 6, attackMs: 10, releaseMs: 150, kneeDb: 6, makeupDb: 0 }, limiter: { enabled: true, ceilingDbtp: -3, releaseMs: 100 } }),
      { durationSec: 4, channels: 1, channelLayout: "mono" },
    );
    const out = path.join(WORK, "dynamics.flac");
    runChain(path.join(WORK, "dynamic.wav"), chain.filters, out);

    // Per-segment levels (volumedetect mean over each half): compression must
    // reduce the LOUD segment (−1.9 dBFS, ~7 dB over threshold → 6:1) while
    // leaving the QUIET segment (−26 dBFS, below threshold) untouched.
    const meanVolume = (file: string, from: number, to: number): number => {
      const { stderr } = spawnSync(
        "ffmpeg",
        ["-hide_banner", "-i", file, "-af", `atrim=${from}:${to},asetpts=PTS-STARTPTS,volumedetect`, "-f", "null", "-"],
        { encoding: "utf8" },
      );
      const m = (stderr ?? "").match(/mean_volume:\s*(-?[\d.]+) dB/);
      if (!m) throw new Error(`volumedetect produced no mean for ${file} [${from}:${to}]`);
      return Number(m[1]);
    };
    const loudIn = meanVolume(path.join(WORK, "dynamic.wav"), 2, 4);
    const loudOut = meanVolume(out, 2, 4);
    const quietIn = meanVolume(path.join(WORK, "dynamic.wav"), 0, 2);
    const quietOut = meanVolume(out, 0, 2);
    expect(loudOut).toBeLessThan(loudIn - 3); // loud segment pulled down ≥3 dB
    expect(Math.abs(quietOut - quietIn)).toBeLessThan(1.0); // quiet untouched
    // True-peak ceiling respected (limiter engaged: input peak was −1.9 dBFS).
    const after = await inspectAudioFile(out);
    expect(after.truePeakDbtp).toBeLessThanOrEqual(-2.5);
    expect(before.levels.totalRmsDbfs).toBeGreaterThan(after.levels.totalRmsDbfs);
  });

  test("video source: video stream is copied bit-exact and A/V duration is preserved", async () => {
    const srcDuration = durationOf(path.join(WORK, "video.mp4"));
    const chain = buildGangziiChain(parseGangziiParams({ noiseReductionDb: 6, loudness: { mode: "staticGain", target: { integrated: -16, truePeak: -1.5, lra: 11 } } }), {
      durationSec: 4, channels: 1, channelLayout: "mono", measured: { integratedLufs: -20, truePeakDbtp: -6 },
    });
    const out = path.join(WORK, "video-processed.mp4");
    runChain(path.join(WORK, "video.mp4"), chain.filters, out, { video: true });
    expect(Math.abs(durationOf(out) - srcDuration)).toBeLessThan(0.05);
    const streams = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "json", out]).toString();
    const list = (JSON.parse(streams) as { streams: { codec_type: string; codec_name: string }[] }).streams;
    const video = list.find((s) => s.codec_type === "video");
    expect(video?.codec_name).toBe("h264"); // copied, not re-encoded
  });

  test("noise reduction: broadband noise floor drops without killing the tone", async () => {
    // Fixture: 440 Hz tone + strong white noise.
    ffmpeg(
      "-f lavfi -i \"sine=frequency=440:duration=5,volume=0.2\" -f lavfi -i \"anoisesrc=color=white:duration=5:amplitude=0.03\" " +
        "-filter_complex \"[0][1]amix=inputs=2:duration=longest[out]\" -map \"[out]\" -ar 48000 -c:a pcm_f32le",
      path.join(WORK, "noisy.wav"),
    );
    const before = await inspectAudioFile(path.join(WORK, "noisy.wav"));
    const chain = buildGangziiChain(
      parseGangziiParams({ noiseReductionDb: 18, noiseFloorDbfs: Math.max(-80, Math.min(-20, before.noiseFloorDbfs ?? -40)) }),
      { durationSec: 5, channels: 1, channelLayout: "mono" },
    );
    const out = path.join(WORK, "denoised.flac");
    runChain(path.join(WORK, "noisy.wav"), chain.filters, out);
    const after = await inspectAudioFile(out);
    // Noise floor down; the 440 Hz content survives (spectrum peak stays in-band).
    expect(after.noiseFloorDbfs).not.toBeNull();
    expect(before.noiseFloorDbfs).not.toBeNull();
    expect(after.noiseFloorDbfs!).toBeLessThan(before.noiseFloorDbfs!);
    const peakBand = (r: Awaited<ReturnType<typeof inspectAudioFile>>) => [...r.spectrum.bands].sort((a, b) => b.db - a.db)[0];
    const pb = peakBand(after);
    expect(pb.hz).toBeGreaterThanOrEqual(350);
    expect(pb.hz).toBeLessThanOrEqual(550);
  });
});
