/**
 * GANGZII — MY AI proposal interface (M5 §6).
 *
 * Maps a natural-language instruction to a STRUCTURED, zod-validated
 * proposal through a deterministic keyword/intent table. No LLM runs inside
 * GANGZII (that is M8's orchestration layer, built on top of this interface);
 * the proposal contains typed parameters only — never shell arguments,
 * never file paths, never raw FFmpeg text. Execution happens exclusively
 * through the validated job pipeline against derived copies of media.
 */
import { GangziiProposalSchema, type GangziiInspection, type GangziiProposal } from "./types";
import { presetById, GANGZII_PRESETS } from "./presets";
import { GangziiParamsSchema, type GangziiParams } from "./types";

interface IntentRule {
  intent: string;
  patterns: RegExp[];
  confidence: number;
  build: (instruction: string, inspection: GangziiInspection | null) => { params: GangziiParams; presetId: string | null; explanation: string; caveats?: string[] };
}

function withInspection(params: GangziiParams, inspection: GangziiInspection | null): GangziiParams {
  if (!inspection) return params;
  const patched: GangziiParams = { ...params };
  // Feed measured facts into the parameters that consume them.
  if (inspection.noiseFloorDbfs !== null && patched.noiseReductionDb > 0) {
    patched.noiseFloorDbfs = inspection.noiseFloorDbfs;
  }
  return patched;
}

const RULES: IntentRule[] = [
  {
    intent: "noise-reduction",
    patterns: [/background noise/i, /\bnoise\b/i, /\bhiss\b/i, /\bfan\b/i, /\bstatic\b/i, /\bwind\b/i],
    confidence: 0.9,
    build: (_ins, inspection) => ({
      params: withInspection(presetById("noise-cleanup")!.params, inspection),
      presetId: "noise-cleanup",
      explanation: "Reduces continuous background noise with the FFT denoiser and removes DC offset / low rumble.",
      caveats: ["Very aggressive reduction can soften consonants — use the A/B compare after processing."],
    }),
  },
  {
    intent: "hum-removal",
    patterns: [/hum/i, /\bmain(s)?\b/i, /electrical/i, /\b60 ?hz\b/i, /\b50 ?hz\b/i, /\bbuzz\b/i],
    confidence: 0.92,
    build: (instruction, inspection) => {
      const base = presetById("hum-removal")!.params;
      let humHz = 50;
      const explicit60 = /60 ?hz/i.test(instruction);
      const explicit50 = /50 ?hz/i.test(instruction);
      if (!explicit60 && !explicit50 && inspection) {
        // Pick the mains frequency whose band shows more energy near 50 vs 60.
        const near = (hz: number, w: number) =>
          inspection.spectrum.bands.filter((b) => Math.abs(b.hz - hz) <= w).reduce((m, b) => Math.max(m, b.db), -120);
        humHz = near(60, 8) > near(50, 8) ? 60 : 50;
      } else if (explicit60) {
        humHz = 60;
      }
      return {
        params: withInspection({ ...base, humHz }, inspection),
        presetId: humHz === 60 ? "hum-removal-60" : "hum-removal",
        explanation: `Removes mains hum with notches at ${humHz} Hz and its harmonics, plus DC offset removal.`,
      };
    },
  },
  {
    intent: "voice-clarity",
    patterns: [/clear(er)?/i, /intelligib/i, /muffled/i, /\bdull\b/i, /presence/i],
    confidence: 0.85,
    build: (_ins, inspection) => ({
      params: withInspection(presetById("voice-clear")!.params, inspection),
      presetId: "voice-clear",
      explanation: "Removes rumble, adds gentle presence EQ and mild compression for speech clarity.",
    }),
  },
  {
    intent: "voice-professional",
    patterns: [/professional/i, /podcast/i, /radio voice/i, /polish/i, /broadcast voice/i],
    confidence: 0.8,
    build: (_ins, inspection) => ({
      params: withInspection(presetById("voice-professional")!.params, inspection),
      presetId: "voice-professional",
      explanation: "Full voice chain (noise, clarity EQ, compression, de-ess) plus normalization to −16 LUFS.",
      caveats: ["The loudness target can be changed before applying (podcast −16, broadcast −23, streaming −14)."],
    }),
  },
  {
    intent: "channel-balance",
    patterns: [/channel (balance|imbalance)/i, /(left|right)\s+(side|channel)/i, /one side/i, /stereo balance/i, /(left|right)\s+is\s+(louder|quieter)/i],
    confidence: 0.85,
    build: (_ins, inspection) => {
      const gains = inspection?.suggestedBalanceGainsDb ?? [];
      return {
        params: withInspection({ ...presetById("fix-channel-balance")!.params, channelGainsDb: gains }, inspection),
        presetId: "fix-channel-balance",
        explanation:
          gains.length > 0
            ? `Applies measured corrective per-channel gains (${gains.map((g) => `${g > 0 ? "+" : ""}${g} dB`).join(", ")}).`
            : "Balances channel levels using measured corrective gains (requires a completed analysis; none found).",
        caveats: gains.length === 0 ? ["No measured imbalance data available — run the analysis first."] : [],
      };
    },
  },
  {
    intent: "loudness-normalize",
    patterns: [/normali[sz]e/i, /\bloudness\b/i, /too (quiet|soft|low)/i, /louder/i, /quieter/i, /volume (level|consistency)/i, /dialogue consistency/i],
    confidence: 0.9,
    build: (instruction, inspection) => {
      const presetId = /broadcast|r128/i.test(instruction) ? "broadcast-loudness" : /streaming|youtube|spotify/i.test(instruction) ? "streaming-loudness" : "normalize-loudness";
      return {
        params: withInspection(presetById(presetId)!.params, inspection),
        presetId,
        explanation: `Static-gain loudness normalization (duration-neutral, sample-accurate) to the ${presetById(presetId)!.label.toLowerCase()} target.`,
        caveats: inspection?.loudness.integratedLufs != null
          ? [`Measured integrated loudness: ${inspection.loudness.integratedLufs} LUFS.`]
          : [],
      };
    },
  },
  {
    intent: "duck-music",
    patterns: [/duck/i, /background music/i, /music (down|under|bed)/i, /reduce the (background )?music/i],
    confidence: 0.85,
    build: (_ins, inspection) => ({
      params: withInspection(presetById("duck-music")!.params, inspection),
      presetId: "duck-music",
      explanation: "Attenuates the audio when speech is absent (gate tuned for music beds under dialogue).",
      caveats: ["For real speech/music separation, GANGZII M5 uses gating — a source-separation model is out of scope."],
    }),
  },
  {
    intent: "duck-music",
    patterns: [/duck/i, /background music/i, /music (down|under|bed)/i, /reduce the (background )?music/i],
    confidence: 0.85,
    build: (_ins, inspection) => ({
      params: withInspection(presetById("duck-music")!.params, inspection),
      presetId: "duck-music",
      explanation: "Attenuates the audio when speech is absent (gate tuned for music beds under dialogue).",
      caveats: ["For real speech/music separation, GANGZII M5 uses gating — a source-separation model is out of scope."],
    }),
  },
];

/** Highest-scoring intent wins; ties go to the earlier rule (deterministic). */
export function proposeGangzii(instruction: string, inspection: GangziiInspection | null = null): GangziiProposal | null {
  const text = instruction.trim();
  if (!text) return null;
  for (const rule of RULES) {
    if (rule.patterns.some((re) => re.test(text))) {
      const built = rule.build(text, inspection);
      const proposal = GangziiProposalSchema.parse({
        engine: "GANGZII",
        intent: rule.intent,
        confidence: rule.confidence,
        params: built.params,
        explanation: built.explanation,
        caveats: built.caveats ?? [],
        presetId: built.presetId,
      });
      return proposal;
    }
  }
  return null;
}

/**
 * Engine descriptor — the M8 MY AI registry groundwork: a typed surface the
 * orchestrator can discover, propose against, and validate with.
 */
export const GANGZII_ENGINE = {
  id: "GANGZII",
  version: 1,
  deterministic: true,
  usesLLM: false,
  capabilities: [
    "audio-analysis",
    "noise-reduction",
    "hum-removal",
    "voice-enhancement",
    "click-repair",
    "equalizer",
    "compressor",
    "limiter",
    "gate",
    "loudness-normalization",
    "channel-balance",
    "fades",
  ],
  presets: GANGZII_PRESETS.map((p) => p.id),
  propose: proposeGangzii,
  validateParams: (raw: unknown): GangziiParams => GangziiParamsSchema.parse(raw),
} as const;
