/**
 * JAZMII — video creative engine types (M7).
 *
 * Every shape here is zod-validated at the boundary (routes and jobs).
 * Provider capabilities are DATA, not folklore: the supported option lists
 * mirror what the configured provider ACTUALLY accepts (verified against the
 * zai-video adapter in tests) and unsupported options are absent by design —
 * the UI renders options from the capability map, so a control that exists
 * can be executed.
 *
 * Honesty rules encoded here:
 *  - Suggestions carry `confidence: null` unless something genuinely computed
 *    a score (shot matching with perceptual hashes sets it; keyword heuristics
 *    do not).
 *  - Analysis produced by FFmpeg filters is labeled HEURISTIC, never AI.
 *  - No Ollama anywhere; providers are the configured HTTP/CLI services.
 */
import { z } from "zod";

// ── provider capability surface ─────────────────────────────────────────────
export const JazmiiQuality = z.enum(["speed", "quality"]);
export type JazmiiQualityT = z.infer<typeof JazmiiQuality>;
export const JazmiiDuration = z.enum(["5", "10"]); // seconds — provider contract
export type JazmiiDurationT = z.infer<typeof JazmiiDuration>;
export const JazmiiFps = z.enum(["30", "60"]);
export type JazmiiFpsT = z.infer<typeof JazmiiFps>;
export const JazmiiSize = z.enum(["1920x1080", "1280x720", "1080x1920", "720x1280"]);
export type JazmiiSizeT = z.infer<typeof JazmiiSize>;
export const JazmiiOperation = z.enum(["textToVideo", "imageToVideo"]);
export type JazmiiOperationT = z.infer<typeof JazmiiOperation>;

export const JazmiiGenerateParamsSchema = z.object({
  prompt: z.string().min(1).max(2000),
  operation: JazmiiOperation.default("textToVideo"),
  /** Reference image asset id for imageToVideo (must be owned by the user). */
  referenceAssetId: z.string().max(64).nullable().default(null),
  quality: JazmiiQuality.default("speed"),
  size: JazmiiSize.default("1920x1080"),
  fps: JazmiiFps.default("30"),
  /** Requested duration in seconds ("5" | "10" — provider contract). */
  durationSec: JazmiiDuration.default("5"),
  /** With-audio generation when the provider supports it (documented). */
  withAudio: z.boolean().default(false),
  projectId: z.string().max(64).nullable().default(null),
});
export type JazmiiGenerateParams = z.infer<typeof JazmiiGenerateParamsSchema>;

export interface VideoProviderCapabilities {
  operations: JazmiiOperationT[];
  qualities: JazmiiQualityT[];
  sizes: JazmiiSizeT[];
  fps: JazmiiFpsT[];
  durationsSec: JazmiiDurationT[];
  withAudio: boolean;
  /** True when the provider returns provider-side progress values. */
  providerProgress: boolean;
  /** Commercial-use, retention and licensing notes (provider metadata). */
  commercialUse: string;
  dataRetention: string;
  license: string;
  attribution: string;
  pricingNote: string;
}

export interface VideoTaskHandle {
  taskId: string;
  model: string;
  requestId: string | null;
}

export type VideoTaskStatus = "QUEUED" | "PROCESSING" | "SUCCESS" | "FAIL" | "CANCELLED" | "UNKNOWN";

export interface VideoTaskState {
  status: VideoTaskStatus;
  videoUrl: string | null;
  /** Provider-side progress 0..100 when the provider supplies one. */
  providerProgress: number | null;
  raw: unknown;
}

/** The typed provider contract (§5): one interface, many adapters. */
export interface VideoProvider {
  id: string;
  label: string;
  capabilities: VideoProviderCapabilities;
  /** Create a generation task. Throws ProviderError on failure. */
  createTask(params: JazmiiGenerateParams, imageUrl: string | null): Promise<VideoTaskHandle>;
  /** Poll a task — must be side-effect free. */
  pollTask(taskId: string): Promise<VideoTaskState>;
}

export class ProviderError extends Error {
  constructor(
    public code: "NOT_CONFIGURED" | "UNSUPPORTED" | "AUTH_FAILED" | "RATE_LIMITED" | "PROVIDER_FAILURE" | "INVALID_RESPONSE" | "TIMEOUT",
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

// ── shot suggestions (§6B) ──────────────────────────────────────────────────
export const JazmiiShotType = z.enum(["wide", "medium", "closeup", "overhead", "tracking", "establishing", "cutaway", "insert"]);
export const JazmiiShotSource = z.enum(["generate", "import", "library"]);

export const JazmiiShotSuggestionSchema = z.object({
  id: z.string().min(1).max(64),
  description: z.string().min(1).max(300),
  subject: z.string().min(1).max(120),
  shotType: JazmiiShotType,
  /** Suggested cutaway length in sequence frames. */
  durationFrames: z.number().int().min(12).max(1500),
  aspectRatio: z.string().max(12),
  source: JazmiiShotSource,
  providerHint: z.string().max(40).nullable(),
  /** Generation prompt when source = "generate" (provenance before the fact). */
  prompt: z.string().max(2000).nullable(),
  /** Deterministic human-readable matching rationale. */
  rationale: z.string().max(300),
  /** Non-null ONLY when a real matcher scored this suggestion. */
  confidence: z.number().min(0).max(1).nullable(),
});
export type JazmiiShotSuggestion = z.infer<typeof JazmiiShotSuggestionSchema>;

// ── analysis (§6C) ──────────────────────────────────────────────────────────
export const JazmiiSceneSchema = z.object({
  index: z.number().int().min(0),
  startSec: z.number().min(0),
  endSec: z.number().min(0),
  /** Motion energy 0..1 at the cut (ffmpeg scene score — a heuristic). */
  score: z.number().min(0).max(1),
});
export type JazmiiScene = z.infer<typeof JazmiiSceneSchema>;

export interface JazmiiAnalysisReport {
  mediaId: string;
  durationSec: number;
  fps: number;
  width: number;
  height: number;
  aspectRatio: string;
  videoCodec: string | null;
  audioCodec: string | null;
  hasAudio: boolean;
  /** ffmpeg scene-change boundaries — labeled HEURISTIC by construction. */
  scenes: JazmiiScene[];
  analysisMethod: "ffmpeg-heuristic";
  blackSegments: { startSec: number; endSec: number }[];
  freezeSegments: { startSec: number; endSec: number }[];
  keyframeFiles: { file: string; sec: number }[];
  /** 64-bit perceptual hashes (aHash hex) per scene — deterministic. */
  sceneHashes: string[];
}

// ── generation record (§6A/§12) ─────────────────────────────────────────────
export const JazmiiProvenanceSchema = z.object({
  createdBy: z.literal("JAZMII"),
  provider: z.string().min(1).max(40),
  model: z.string().min(1).max(80),
  prompt: z.string().max(2000),
  paramsJson: z.string().max(4000),
  license: z.string().max(80),
  attribution: z.string().max(500),
  providerTaskId: z.string().max(120).nullable(),
});
export type JazmiiProvenance = z.infer<typeof JazmiiProvenanceSchema>;
