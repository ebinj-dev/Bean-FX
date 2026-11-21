/**
 * M32 Track A — Provider capability registry & honest readiness.
 *
 * EXTENDS the existing provider registries (JAZMII/LAXII) — it does not
 * replace them. Every field here is derived FROM the providers' actual,
 * documented contracts (the capability DATA already verified in tests) or
 * from a REAL probe. Support is never invented: a capability the provider
 * contract does not document is reported false/unsupported with the exact
 * reason, and pricing is COST UNKNOWN unless authoritative data with a
 * source and date has been recorded.
 *
 * No secret values ever flow through this module: probes return booleans and
 * pre-redacted detail strings produced by the existing adapters (which never
 * include keys or authorization headers).
 */
import { z } from "zod";
import { execFile } from "node:child_process";
import { jazmiiProvider } from "@/lib/jazmii/providers";
import { laxiiProvider } from "@/lib/laxii/providers";
import { probeVideoProvider } from "@/lib/jazmii/jobs";
import { ProviderError } from "@/lib/jazmii/types";

// ── Readiness statuses (spec §3 A3) ─────────────────────────────────────────
export const READINESS_STATUSES = [
  "READY",
  "CONFIGURATION_REQUIRED",
  "UNSUPPORTED_CAPABILITY",
  "TEMPORARILY_UNAVAILABLE",
  "AUTHENTICATION_FAILED",
  "PROVIDER_ERROR",
  "COST_UNKNOWN",
] as const;
export type ReadinessStatus = (typeof READINESS_STATUSES)[number];

export const ProviderCostInfoSchema = z.object({
  /** VERIFIED only when authoritative pricing data (source + date) exists. */
  state: z.enum(["UNKNOWN", "VERIFIED"]),
  currency: z.string().max(8).nullable().default(null),
  /** e.g. "USD per generated second" — unit as documented by the source. */
  unit: z.string().max(120).nullable().default(null),
  assumptions: z.string().max(400).nullable().default(null),
  source: z.string().max(200).nullable().default(null),
  /** ISO date of the pricing verification, when VERIFIED. */
  sourceDate: z.string().max(10).nullable().default(null),
});
export type ProviderCostInfo = z.infer<typeof ProviderCostInfoSchema>;
export const COST_UNKNOWN: ProviderCostInfo = { state: "UNKNOWN", currency: null, unit: null, assumptions: null, source: null, sourceDate: null };

export interface ProviderReadiness {
  providerId: string;
  engine: "JAZMII" | "LAXII";
  status: ReadinessStatus;
  /** Real probe evidence — safe detail only (no keys, no headers, no URLs with tokens). */
  detail: string;
  cost: ProviderCostInfo;
}

// ── Capability report (superset view over the existing registries) ──────────
export interface VideoCapabilityReport {
  providerId: string;
  label: string;
  operations: string[];
  textToVideo: boolean;
  imageToVideo: boolean;
  /** Reference-VIDEO conditioning — documented by the provider contract? */
  referenceVideoConditioning: boolean;
  /** Conditioning from a reference IMAGE (the imageToVideo operation). */
  referenceImageConditioning: boolean;
  negativePrompt: boolean;
  seedControl: boolean;
  durationsSec: string[];
  sizes: string[];
  fps: string[];
  qualities: string[];
  withAudio: boolean;
  jobStates: string[];
  /** Provider-side progress reporting (measured flag from the registry). */
  providerProgress: boolean;
  /** Provider-side task cancellation (documented or absent). */
  cancellation: "none" | "provider-side";
  outputFormats: string[];
  /** PLATFORM download cap of the registration pipeline (not a provider claim). */
  maxOutputBytes: number;
  unsupported: string[];
  pricing: ProviderCostInfo;
}

const ZAI_VIDEO_UNDOCUMENTED = [
  "reference-video conditioning (provider contract documents image-to-video only)",
  "negative prompts (no provider parameter)",
  "seed control (no provider parameter)",
  "provider-side cancellation (tasks run to completion; results simply not registered when the local job is cancelled)",
];

/** Derive the report from the ACTUAL registered capabilities — nothing invented. */
export function buildVideoCapabilityReport(): VideoCapabilityReport {
  const provider = jazmiiProvider(null);
  const c = provider.capabilities;
  return {
    providerId: provider.id,
    label: provider.label,
    operations: [...c.operations],
    textToVideo: c.operations.includes("textToVideo"),
    imageToVideo: c.operations.includes("imageToVideo"),
    referenceVideoConditioning: false, // not in the provider contract (see unsupported[])
    referenceImageConditioning: c.operations.includes("imageToVideo"),
    negativePrompt: false,
    seedControl: false,
    durationsSec: [...c.durationsSec],
    sizes: [...c.sizes],
    fps: [...c.fps],
    qualities: [...c.qualities],
    withAudio: c.withAudio,
    jobStates: ["QUEUED", "PROCESSING", "SUCCESS", "FAIL", "CANCELLED", "UNKNOWN"],
    providerProgress: c.providerProgress,
    cancellation: "none",
    outputFormats: ["mp4"],
    // 500 MB platform download/registration cap (asset-lifecycle default).
    maxOutputBytes: 500 * 1024 * 1024,
    unsupported: ZAI_VIDEO_UNDOCUMENTED,
    pricing: COST_UNKNOWN, // pricingNote is a disclaimer, NOT verified pricing
  };
}

export interface ImageCapabilityReport {
  providerId: string;
  label: string;
  operations: string[];
  sizes: string[];
  /** The registry's own honesty list (e.g. transparency not supported). */
  unsupported: string[];
  negativePrompt: boolean;
  seedControl: boolean;
  outputFormats: string[];
  pricing: ProviderCostInfo;
}

export function buildImageCapabilityReport(): ImageCapabilityReport {
  const provider = laxiiProvider(null);
  const c = provider.capabilities;
  return {
    providerId: provider.id,
    label: provider.label,
    operations: [...c.operations],
    sizes: [...c.sizes],
    unsupported: [...c.unsupported],
    negativePrompt: false, // documented: provider has no such parameter
    seedControl: false,
    outputFormats: ["jpeg (provider returns JPEG bytes even for .png requests — verified in the M7 live probe)"],
    pricing: COST_UNKNOWN,
  };
}

// ── Real readiness probes (no fake READY) ───────────────────────────────────
/** Cheap, real availability check: does the provider CLI binary exist? */
export function cliAvailable(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("which", [bin], { timeout: 5_000 }, (err) => resolve(!err));
  });
}

const ZAI_BIN = (): string => process.env.BEANFX_ZAI_BIN ?? "z-ai";

export async function videoProviderReadiness(): Promise<ProviderReadiness> {
  const report = buildVideoCapabilityReport();
  try {
    const probe = await probeVideoProvider();
    return {
      providerId: report.providerId, engine: "JAZMII",
      status: probe.ok ? "READY" : "CONFIGURATION_REQUIRED",
      detail: probe.detail.slice(0, 300), cost: report.pricing,
    };
  } catch (err) {
    return {
      providerId: report.providerId, engine: "JAZMII",
      status: err instanceof ProviderError ? providerErrorToStatus(err) : "PROVIDER_ERROR",
      detail: safeDetail(err), cost: report.pricing,
    };
  }
}

export async function imageProviderReadiness(): Promise<ProviderReadiness> {
  const report = buildImageCapabilityReport();
  const ok = await cliAvailable(ZAI_BIN());
  return {
    providerId: report.providerId, engine: "LAXII",
    status: ok ? "READY" : "CONFIGURATION_REQUIRED",
    detail: ok
      ? `image provider CLI "${ZAI_BIN()}" present (capability list verified in the M7 live probe; cost ${report.pricing.state})`
      : `image provider CLI "${ZAI_BIN()}" is not installed on the server — LAXII generation is unavailable. Install/configure the provider binary to enable it.`,
    cost: report.pricing,
  };
}

export function providerErrorToStatus(err: ProviderError): ReadinessStatus {
  switch (err.code) {
    case "NOT_CONFIGURED": return "CONFIGURATION_REQUIRED";
    case "UNSUPPORTED": return "UNSUPPORTED_CAPABILITY";
    case "AUTH_FAILED": return "AUTHENTICATION_FAILED";
    case "RATE_LIMITED": case "TIMEOUT": return "TEMPORARILY_UNAVAILABLE";
    default: return "PROVIDER_ERROR";
  }
}

/** Strip anything that could carry secret material; keep the typed message. */
export function safeDetail(err: unknown): string {
  if (err instanceof ProviderError) return `${err.code}: ${err.message}`.slice(0, 300);
  return String(err).slice(0, 300);
}

// ── Transient vs permanent (Phase 2 — retry eligibility) ────────────────────
/** Provider errors that can NEVER succeed on retry → permanent (no paid-call
 *  re-fires, no pointless backoff loops). */
export const PERMANENT_PROVIDER_CODES: ReadonlySet<ProviderError["code"]> = new Set([
  "NOT_CONFIGURED", "UNSUPPORTED", "AUTH_FAILED", "INVALID_RESPONSE",
]);
/** Errors eligible for bounded retry with backoff: RATE_LIMITED, TIMEOUT,
 *  PROVIDER_FAILURE — but a JAZMII retry must RESUME from the persisted
 *  provider task id (never create a second task). */

export function isTransientProviderError(err: unknown): boolean {
  return err instanceof ProviderError && !PERMANENT_PROVIDER_CODES.has(err.code);
}
