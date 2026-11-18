/**
 * GANGZII — named processing presets (M5 §3–5).
 *
 * Presets are GangziiParams VALUES (zod-validated at construction) — the UI
 * and the MY AI interface both propose them, and the user can edit every
 * parameter before applying. They are starting points, not magic.
 */
import { GangziiParamsSchema, type GangziiParams } from "./types";

export interface GangziiPreset {
  id: string;
  label: string;
  description: string;
  params: GangziiParams;
}

/** Parse at module load: a malformed preset would fail loudly here, not in prod. */
const P = (over: Partial<GangziiParams>): GangziiParams => GangziiParamsSchema.parse(over);

export const GANGZII_PRESETS: GangziiPreset[] = [
  {
    id: "noise-cleanup",
    label: "Clean background noise",
    description: "FFT denoiser + DC/rumble removal — continuous noise, fan, hiss.",
    params: P({ noiseReductionDb: 12, removeDcOffset: true, rumbleHighPassHz: 80 }),
  },
  {
    id: "hum-removal",
    label: "Remove electrical hum",
    description: "Notches at the mains fundamental and harmonics (50 Hz default; 60 Hz variant).",
    params: P({ humHz: 50, humHarmonics: 4, removeDcOffset: true }),
  },
  {
    id: "hum-removal-60",
    label: "Remove 60 Hz hum",
    description: "60 Hz mains variant (NTSC regions).",
    params: P({ humHz: 60, humHarmonics: 4, removeDcOffset: true }),
  },
  {
    id: "voice-clear",
    label: "Make the voice clearer",
    description: "Rumble removal, gentle presence EQ, mild compression, light de-ess.",
    params: P({
      noiseReductionDb: 6,
      removeDcOffset: true,
      rumbleHighPassHz: 90,
      deEss: 0.25,
      eq: { highPassHz: null, lowPassHz: null, lowShelfHz: 250, lowShelfGainDb: -2, highShelfHz: 4500, highShelfGainDb: 2.5, bands: [{ frequency: 2400, gainDb: 2, q: 1.4 }] },
      compressor: { enabled: true, thresholdDbfs: -20, ratio: 2.5, attackMs: 15, releaseMs: 180, kneeDb: 6, makeupDb: 2 },
      limiter: { enabled: true, ceilingDbtp: -1.5, releaseMs: 100 },
    }),
  },
  {
    id: "voice-professional",
    label: "Make the voice sound more professional",
    description: "Voice-clear chain + loudness normalization to −16 LUFS (podcast level).",
    params: P({
      noiseReductionDb: 8,
      removeDcOffset: true,
      rumbleHighPassHz: 90,
      deEss: 0.3,
      clickRepair: 0.3,
      eq: { highPassHz: null, lowPassHz: null, lowShelfHz: 220, lowShelfGainDb: -2.5, highShelfHz: 4200, highShelfGainDb: 2, bands: [{ frequency: 2400, gainDb: 2.5, q: 1.3 }, { frequency: 320, gainDb: 1.5, q: 1.2 }] },
      compressor: { enabled: true, thresholdDbfs: -21, ratio: 3, attackMs: 12, releaseMs: 160, kneeDb: 6, makeupDb: 3 },
      limiter: { enabled: true, ceilingDbtp: -1.5, releaseMs: 100 },
      loudness: { mode: "staticGain", target: { integrated: -16, truePeak: -1.5, lra: 11 } },
    }),
  },
  {
    id: "normalize-loudness",
    label: "Normalize the audio",
    description: "Static-gain loudness normalization to −16 LUFS / −1.5 dBTP (duration-neutral).",
    params: P({ loudness: { mode: "staticGain", target: { integrated: -16, truePeak: -1.5, lra: 11 } } }),
  },
  {
    id: "broadcast-loudness",
    label: "EBU R128 broadcast loudness",
    description: "−23 LUFS / −1 dBTP — broadcast delivery target.",
    params: P({ loudness: { mode: "staticGain", target: { integrated: -23, truePeak: -1, lra: 9 } } }),
  },
  {
    id: "streaming-loudness",
    label: "Streaming loudness (−14 LUFS)",
    description: "−14 LUFS / −1 dBTP — typical streaming platform target.",
    params: P({ loudness: { mode: "staticGain", target: { integrated: -14, truePeak: -1, lra: 11 } } }),
  },
  {
    id: "repair-clip",
    label: "Repair damaged audio",
    description: "Click repair, DC removal, de-ess, true-peak limiter — honest: heavily clipped audio cannot be fully restored.",
    params: P({ clickRepair: 0.5, removeDcOffset: true, deEss: 0.2, limiter: { enabled: true, ceilingDbtp: -1, releaseMs: 80 } }),
  },
  {
    id: "fix-channel-balance",
    label: "Fix channel balance",
    description: "Applies the measured per-channel corrective gains (from the inspection).",
    params: P({ channelGainsDb: [] }),
  },
  {
    id: "duck-music",
    label: "Duck under speech",
    description: "Gate tuned for music beds under dialogue (background music gain control).",
    params: P({ gate: { enabled: true, thresholdDbfs: -38, ratio: 4, attackMs: 40, releaseMs: 600, rangeDb: 12 } }),
  },
];

export function presetById(id: string): GangziiPreset | null {
  return GANGZII_PRESETS.find((p) => p.id === id) ?? null;
}
