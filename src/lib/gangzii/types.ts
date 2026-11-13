/**
 * GANGZII — typed, validated surfaces (M5).
 *
 * Every client-facing parameter surface is a strict zod schema: bounded
 * numbers, enum operations, no free-form strings ever reach FFmpeg. The MY AI
 * interface (§6 of the milestone) produces proposals against the SAME
 * schemas — an LLM can never execute arbitrary shell commands or touch
 * original media, because the only accepted input is a validated
 * GangziiParams object and the only executor is the deterministic DSP chain.
 */
import { z } from "zod";

// ── loudness targets (configurable, never one hardcoded target) ──────────
export const LoudnessTargetSchema = z.object({
  /** Integrated target in LUFS (EBU R128 broadcast −23, streaming −14, podcast −16 …). */
  integrated: z.number().min(-48).max(-6),
  /** True-peak ceiling in dBTP. */
  truePeak: z.number().min(-12).max(0),
  /** Loudness-range target in LU (loudnorm); 0 keeps the source range. */
  lra: z.number().min(0).max(20),
});
export type LoudnessTarget = z.infer<typeof LoudnessTargetSchema>;

// ── equalizer (editable bands + editable HP/LP filters) ──────────────────
export const EqBandSchema = z.object({
  /** Parametric band center frequency in Hz. */
  frequency: z.number().min(20).max(20000),
  /** Gain in dB (±24). */
  gainDb: z.number().min(-24).max(24),
  /** Q factor (0.1–16). */
  q: z.number().min(0.1).max(16),
});
export const EqSchema = z.object({
  highPassHz: z.number().min(5).max(2000).nullable().default(null),
  lowPassHz: z.number().min(200).max(22000).nullable().default(null),
  lowShelfHz: z.number().min(20).max(1000).nullable().default(null),
  lowShelfGainDb: z.number().min(-24).max(24).default(0),
  highShelfHz: z.number().min(1000).max(20000).nullable().default(null),
  highShelfGainDb: z.number().min(-24).max(24).default(0),
  /** Up to 8 parametric bands. */
  bands: z.array(EqBandSchema).max(8).default([]),
});
export type Eq = z.infer<typeof EqSchema>;

// ── dynamics (compressor / limiter / gate) ────────────────────────────────
export const CompressorSchema = z.object({
  enabled: z.boolean().default(false),
  thresholdDbfs: z.number().min(-60).max(0).default(-18),
  ratio: z.number().min(1).max(20).default(3),
  attackMs: z.number().min(0.5).max(500).default(20),
  releaseMs: z.number().min(10).max(2000).default(200),
  /** Soft-knee width in dB. */
  kneeDb: z.number().min(0).max(24).default(6),
  makeupDb: z.number().min(0).max(24).default(0),
});
export const LimiterSchema = z.object({
  enabled: z.boolean().default(false),
  ceilingDbtp: z.number().min(-12).max(0).default(-1),
  releaseMs: z.number().min(10).max(2000).default(100),
});
export const GateSchema = z.object({
  enabled: z.boolean().default(false),
  thresholdDbfs: z.number().min(-90).max(0).default(-50),
  ratio: z.number().min(1).max(100).default(4),
  attackMs: z.number().min(0.1).max(100).default(5),
  releaseMs: z.number().min(10).max(2000).default(120),
  /** Amount of attenuation when closed, in dB (range). */
  rangeDb: z.number().min(0).max(90).default(30),
});

// ── the full processing parameter surface ─────────────────────────────────
export const GangziiParamsSchema = z.object({
  /** Noise reduction: FFT denoiser amount in dB (0 = off). */
  noiseReductionDb: z.number().min(0).max(30).default(0),
  /** Noise-floor estimate in dBFS used by the denoiser (measured value). */
  noiseFloorDbfs: z.number().min(-100).max(0).default(-50),
  /** Mains hum: base frequency (0 = off, else typically 50 or 60). */
  humHz: z
    .number()
    .refine((v) => v === 0 || (v >= 45 && v <= 65), "humHz must be 0 (off) or 45–65 Hz")
    .default(0),
  /** Harmonics of the hum to also remove (1..5). */
  humHarmonics: z.number().int().min(1).max(5).default(3),
  /** De-esser intensity 0–1 (0 = off). */
  deEss: z.number().min(0).max(1).default(0),
  /** High-pass rumble filter in Hz (0 = off). */
  rumbleHighPassHz: z.number().min(0).max(300).default(0),
  /** Click/pop repair amount 0–1 (0 = off). */
  clickRepair: z.number().min(0).max(1).default(0),
  /** DC-offset removal. */
  removeDcOffset: z.boolean().default(false),
  /** Per-channel balance gains in dB (length = channels; empty = untouched). */
  channelGainsDb: z.array(z.number().min(-24).max(24)).max(8).default([]),
  eq: EqSchema.prefault({}),
  compressor: CompressorSchema.prefault({}),
  limiter: LimiterSchema.prefault({}),
  gate: GateSchema.prefault({}),
  /** Loudness normalization with explicit targets ("none" = off). */
  loudness: z
    .discriminatedUnion("mode", [
      z.object({ mode: z.literal("none") }),
      z.object({ mode: z.literal("staticGain"), target: LoudnessTargetSchema }),
      z.object({ mode: z.literal("dynamic"), target: LoudnessTargetSchema }),
    ])
    .default({ mode: "none" }),
  /** Static output trim in dB (applied last). */
  outputGainDb: z.number().min(-24).max(24).default(0),
  /** Fade in/out in seconds (0 = off). */
  fadeInSec: z.number().min(0).max(60).default(0),
  fadeOutSec: z.number().min(0).max(60).default(0),
});
export type GangziiParams = z.infer<typeof GangziiParamsSchema>;

// ── inspection result (structured, saveable with project media) ───────────
export const SpectrumBandSchema = z.object({ hz: z.number(), db: z.number() });
export const GangziiInspectionSchema = z.object({
  analyzedAt: z.string(),
  analyzerVersion: z.string(),
  /** Decoded/measured facts (measurement standardized at 48 kHz). */
  durationSec: z.number(),
  sampleRate: z.number(),
  channels: z.number(),
  channelLayout: z.string().nullable(),
  loudness: z.object({
    integratedLufs: z.number().nullable(),
    lraLu: z.number().nullable(),
    momentaryMaxLufs: z.number().nullable(),
    shortTerm: z.array(z.object({ tSec: z.number(), lufs: z.number() })).max(400),
  }),
  samplePeakDbfs: z.number(),
  truePeakDbtp: z.number(),
  overs4x: z.number(),
  clipping: z.object({
    runs: z.number(),
    samples: z.number(),
    longestRunSamples: z.number(),
    suspected: z.boolean(),
    note: z.string(),
  }),
  dcOffsetPerChannel: z.array(z.number()),
  rmsPerChannelDbfs: z.array(z.number()),
  channelImbalanceDb: z.number().nullable(),
  /** Suggested per-channel gains (dB) that would equalize channel levels. */
  suggestedBalanceGainsDb: z.array(z.number()).default([]),
  spectrum: z.object({ bands: z.array(SpectrumBandSchema).max(64) }),
  levels: z.object({
    classification: z.enum(["speech", "music", "mixed", "unclear"]),
    speechBandRmsDbfs: z.number(),
    totalRmsDbfs: z.number(),
    modulation2to8Hz: z.number(),
    note: z.string(),
  }),
  silence: z.object({
    spans: z.array(z.object({ start: z.number(), end: z.number() })).max(500),
    totalSec: z.number(),
    fraction: z.number(),
  }),
  noiseFloorDbfs: z.number().nullable(),
  waveform: z.object({ min: z.array(z.number()).max(4000), max: z.array(z.number()).max(4000) }),
  notes: z.array(z.string()),
});
export type GangziiInspection = z.infer<typeof GangziiInspectionSchema>;

// ── MY AI proposal surface ────────────────────────────────────────────────
export const GangziiProposalSchema = z.object({
  engine: z.literal("GANGZII"),
  /** Matched intent (for audit/display), never executed as text. */
  intent: z.string(),
  /** Deterministic confidence for the intent match (0–1). */
  confidence: z.number().min(0).max(1),
  /** The validated parameters GANGZII would execute. */
  params: GangziiParamsSchema,
  /** Human explanation of what will happen (honest, no magic claims). */
  explanation: z.string(),
  caveats: z.array(z.string()).default([]),
  presetId: z.string().nullable().default(null),
});
export type GangziiProposal = z.infer<typeof GangziiProposalSchema>;
