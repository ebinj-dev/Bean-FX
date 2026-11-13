/**
 * GANGZII — deterministic DSP chain builder (M5 §3B–G).
 *
 * Converts a validated GangziiParams object into an explicit FFmpeg filter
 * list. Clients can NEVER send FFmpeg arguments: every accepted input is a
 * typed, bounded parameter (see types.ts), and this module is the ONLY place
 * that composes filter strings.
 *
 * Fixed pipeline order (deterministic, documented in docs/M5_GANGZII.md):
 *   channel balance → high-pass (DC/rumble/EQ-HP combined) → click repair →
 *   hum notches → denoiser → de-esser → EQ (LP, shelves, parametric) → gate
 *   → compressor → loudness (static gain | dynamic) → output trim → limiter
 *   → fades.
 *
 * Honest limitations are emitted as notes/warnings, never hidden:
 *  - clipping repair is attenuation/limiting, not restoration;
 *  - dynamic loudness may micro-shift duration (resampler flush) — static
 *    gain mode is duration-neutral and preferred;
 *  - channel-balance gains apply to mono/stereo layouts (multichannel is
 *    passed through untouched, with a warning).
 */
import { GangziiParamsSchema, type GangziiParams } from "./types";

export interface ChainContext {
  durationSec: number;
  channels: number;
  channelLayout: string | null;
  measured?: { integratedLufs: number | null; truePeakDbtp: number | null };
}

export interface BuiltChain {
  filters: string[];
  /** Human notes describing what was applied (shown in the UI/report). */
  notes: string[];
  /** Honest warnings about limits of the requested processing. */
  warnings: string[];
  /** Extra OUTPUT arguments (e.g. sample-rate reset after loudnorm). */
  outputArgs: string[];
}

const dbToLinear = (db: number): number => 10 ** (db / 20);
const fmt = (v: number, digits = 4): string => Number(v.toFixed(digits)).toString();

export function parseGangziiParams(raw: unknown): GangziiParams {
  return GangziiParamsSchema.parse(raw);
}

/** Channel layout string usable by the pan filter (mono/stereo only). */
function panLayout(channels: number): string | null {
  if (channels === 1) return "mono";
  if (channels === 2) return "stereo";
  return null;
}

export function buildGangziiChain(params: GangziiParams, ctx: ChainContext): BuiltChain {
  const filters: string[] = [];
  const notes: string[] = [];
  const warnings: string[] = [];
  const outputArgs: string[] = [];
  const active = (b: { enabled?: boolean }): boolean => b.enabled === undefined ? true : b.enabled;

  // 0) channel balance (mono/stereo only — honest limitation elsewhere)
  const layout = panLayout(ctx.channels);
  const gains = params.channelGainsDb;
  if (gains.length > 0 && gains.some((g) => Math.abs(g) > 0.01)) {
    if (layout && gains.length === ctx.channels) {
      // pan gain syntax: gain BEFORE the channel reference (e.g. 0.5*c0)
      const terms = gains
        .map((g, i) => `c${i}=${fmt(dbToLinear(g))}*c${i}`)
        .join("|");
      filters.push(`pan=${layout}|${terms}`);
      notes.push(`Channel balance applied: ${gains.map((g) => `${g > 0 ? "+" : ""}${g} dB`).join(", ")}.`);
    } else {
      warnings.push(
        `Channel balance gains were requested but the source has ${ctx.channels} channels (${ctx.channelLayout ?? "unknown layout"}) — GANGZII M5 applies per-channel balance to mono/stereo only. Gains were NOT applied.`,
      );
    }
  }

  // 1) high-pass: DC offset removal (8 Hz) / rumble filter / EQ high-pass
  const hpCandidates: number[] = [];
  if (params.removeDcOffset) hpCandidates.push(8);
  if (params.rumbleHighPassHz > 0) hpCandidates.push(params.rumbleHighPassHz);
  if (params.eq.highPassHz) hpCandidates.push(params.eq.highPassHz);
  if (hpCandidates.length > 0) {
    const f = Math.max(...hpCandidates);
    filters.push(`highpass=f=${fmt(f, 1)}`);
    const reasons = [
      params.removeDcOffset ? "DC offset" : null,
      params.rumbleHighPassHz > 0 ? `rumble (${params.rumbleHighPassHz} Hz)` : null,
      params.eq.highPassHz ? `EQ high-pass (${params.eq.highPassHz} Hz)` : null,
    ].filter(Boolean);
    notes.push(`High-pass at ${f} Hz (${reasons.join(" + ")}).`);
  }

  // 2) click/pop repair
  if (params.clickRepair > 0) {
    // ffmpeg adeclick: window 50 ms, 75% overlap; threshold 1–7 (lower = more
    // aggressive). Map amount 0..1 → threshold 7..1.
    const t = Math.max(1, Math.round(7 - 6 * params.clickRepair));
    filters.push(`adeclick=w=50:o=75:t=${t}`);
    notes.push(`Click/pop repair (strength ${Math.round(params.clickRepair * 100)}%).`);
    warnings.push("Click repair is spectral interpolation — dense damage can remain audible.");
  }

  // 3) hum notches (fundamental + harmonics)
  if (params.humHz > 0) {
    for (let h = 1; h <= params.humHarmonics; h++) {
      const f = params.humHz * h;
      if (f > 20000) break;
      filters.push(`bandreject=f=${fmt(f, 1)}:width_type=o:w=0.04`);
    }
    notes.push(`Hum removal: notches at ${params.humHz} Hz + ${params.humHarmonics - 1} harmonics (electrical hum / fan / static).`);
  }

  // 4) FFT denoiser (continuous background noise / hiss / fan)
  if (params.noiseReductionDb > 0) {
    const nr = Math.max(1, Math.min(30, params.noiseReductionDb));
    const nf = Math.max(-80, Math.min(-20, Math.round(params.noiseFloorDbfs)));
    filters.push(`afftdn=nr=${fmt(nr, 1)}:nf=${nf}`);
    notes.push(`Noise reduction ${nr} dB (FFT denoiser, noise floor ${nf} dBFS).`);
    warnings.push("Aggressive noise reduction can soften consonants — compare with the original (A/B).");
  }

  // 5) de-esser
  if (params.deEss > 0) {
    filters.push(`deesser=i=${fmt(params.deEss, 2)}:m=0.5:f=0.5`);
    notes.push(`De-esser (intensity ${Math.round(params.deEss * 100)}%).`);
  }

  // 6) EQ: low-pass, shelves, parametric bands (high-pass merged above)
  const eq = params.eq;
  if (eq.lowPassHz) {
    filters.push(`lowpass=f=${fmt(eq.lowPassHz, 1)}`);
    notes.push(`Low-pass at ${eq.lowPassHz} Hz.`);
  }
  if (eq.lowShelfHz && Math.abs(eq.lowShelfGainDb) > 0.01) {
    filters.push(`bass=g=${fmt(eq.lowShelfGainDb, 2)}:f=${fmt(eq.lowShelfHz, 1)}`);
    notes.push(`Low shelf ${eq.lowShelfGainDb > 0 ? "+" : ""}${eq.lowShelfGainDb} dB @ ${eq.lowShelfHz} Hz.`);
  }
  if (eq.highShelfHz && Math.abs(eq.highShelfGainDb) > 0.01) {
    filters.push(`treble=g=${fmt(eq.highShelfGainDb, 2)}:f=${fmt(eq.highShelfHz, 1)}`);
    notes.push(`High shelf ${eq.highShelfGainDb > 0 ? "+" : ""}${eq.highShelfGainDb} dB @ ${eq.highShelfHz} Hz.`);
  }
  for (const band of eq.bands) {
    if (Math.abs(band.gainDb) < 0.01) continue;
    filters.push(`equalizer=f=${fmt(band.frequency, 1)}:t=q:w=${fmt(band.q, 2)}:g=${fmt(band.gainDb, 2)}`);
    notes.push(`Parametric EQ ${band.gainDb > 0 ? "+" : ""}${band.gainDb} dB @ ${band.frequency} Hz (Q ${band.q}).`);
  }

  // 7) gate
  if (active(params.gate)) {
    const g = params.gate;
    filters.push(
      `agate=threshold=${fmt(dbToLinear(g.thresholdDbfs), 6)}:ratio=${fmt(g.ratio, 2)}:attack=${fmt(g.attackMs, 2)}:release=${fmt(g.releaseMs, 2)}:range=${fmt(dbToLinear(-g.rangeDb), 5)}`,
    );
    notes.push(`Gate ${g.thresholdDbfs} dBFS, ratio ${g.ratio}:1, range −${g.rangeDb} dB.`);
  }

  // 8) compressor
  if (active(params.compressor)) {
    const c = params.compressor;
    // ffmpeg acompressor: threshold/makeup are LINEAR; knee is a 1–8 ramp factor.
    const kneeFactor = 1 + Math.min(24, c.kneeDb) / 8;
    filters.push(
      `acompressor=threshold=${fmt(dbToLinear(c.thresholdDbfs), 6)}:ratio=${fmt(c.ratio, 2)}:attack=${fmt(c.attackMs, 2)}:release=${fmt(c.releaseMs, 2)}:knee=${fmt(kneeFactor, 3)}:makeup=${fmt(Math.min(64, dbToLinear(c.makeupDb)), 4)}`,
    );
    notes.push(`Compressor ${c.thresholdDbfs} dBFS, ${c.ratio}:1, ${c.attackMs}/${c.releaseMs} ms, knee ${c.kneeDb} dB, makeup +${c.makeupDb} dB.`);
  }

  // 9) loudness management
  if (params.loudness.mode === "staticGain") {
    const { target } = params.loudness;
    if (!ctx.measured?.integratedLufs) {
      warnings.push("Static-gain normalization requested but no measured integrated loudness is available — run analysis first. Gain NOT applied.");
    } else {
      let gain = target.integrated - ctx.measured.integratedLufs;
      let tpNote = "";
      if (ctx.measured.truePeakDbtp !== null && ctx.measured.truePeakDbtp !== undefined) {
        const headroom = target.truePeak - ctx.measured.truePeakDbtp;
        if (gain > headroom) {
          warnings.push(
            `Requested ${target.integrated} LUFS would exceed the ${target.truePeak} dBTP ceiling (available headroom ${headroom.toFixed(1)} dB) — gain limited to fit the ceiling.`,
          );
          gain = Math.min(gain, headroom);
          tpNote = " (true-peak-limited)";
        }
      }
      if (gain > 0.05 || gain < -0.05) {
        filters.push(`volume=${fmt(gain, 3)}dB`);
        notes.push(`Loudness: static gain ${gain > 0 ? "+" : ""}${fmt(gain, 2)} dB toward ${target.integrated} LUFS${tpNote} — duration-neutral, sample-accurate.`);
      } else {
        notes.push("Loudness already within 0.05 LU of the target — no gain applied.");
      }
    }
  } else if (params.loudness.mode === "dynamic") {
    const { target } = params.loudness;
    filters.push(`loudnorm=I=${fmt(target.integrated, 1)}:TP=${fmt(target.truePeak, 1)}:LRA=${fmt(target.lra, 1)}`);
    outputArgs.push("-ar", "48000");
    notes.push(`Dynamic loudness normalization to ${target.integrated} LUFS / ${target.truePeak} dBTP / LRA ${target.lra} (FFmpeg loudnorm).`);
    warnings.push("Dynamic loudness applies time-varying gain and may shift duration by a few ms — static gain mode is preferred for exact timing.");
  }

  // 10) output trim
  if (Math.abs(params.outputGainDb) > 0.01) {
    filters.push(`volume=${fmt(params.outputGainDb, 2)}dB`);
    notes.push(`Output trim ${params.outputGainDb > 0 ? "+" : ""}${params.outputGainDb} dB.`);
  }

  // 11) limiter (LAST gain element — protects the ceiling after everything)
  if (active(params.limiter)) {
    const l = params.limiter;
    filters.push(
      `alimiter=level_in=1:level_out=1:limit=${fmt(dbToLinear(l.ceilingDbtp), 5)}:attack=5:release=${fmt(l.releaseMs, 2)}:level=disabled`,
    );
    notes.push(`True-peak limiter at ${l.ceilingDbtp} dBTP (auto-level disabled — no hidden gain).`);
  }

  // 12) fades
  if (params.fadeInSec > 0 && ctx.durationSec > params.fadeInSec) {
    filters.push(`afade=t=in:st=0:d=${fmt(params.fadeInSec, 2)}`);
    notes.push(`Fade-in ${params.fadeInSec} s.`);
  }
  if (params.fadeOutSec > 0 && ctx.durationSec > params.fadeOutSec) {
    const st = Math.max(0, ctx.durationSec - params.fadeOutSec);
    filters.push(`afade=t=out:st=${fmt(st, 2)}:d=${fmt(params.fadeOutSec, 2)}`);
    notes.push(`Fade-out ${params.fadeOutSec} s.`);
  }

  return { filters, notes, warnings, outputArgs };
}

/** True when the params request at least one audible operation. */
export function chainIsEmpty(chain: BuiltChain): boolean {
  return chain.filters.length === 0;
}
