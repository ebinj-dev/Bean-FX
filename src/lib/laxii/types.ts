/**
 * LAXII — image creative engine types (M7 §7).
 *
 * Capability honesty: the size list mirrors what the configured provider
 * ACTUALLY accepts (verified live: 7 sizes); transparency is NOT claimed —
 * the provider returns JPEG bytes even for .png outputs (caught in the live
 * probe), so alpha output is an explicit UNSUPPORTED capability. Negative
 * prompts are likewise not exposed (provider has no such parameter).
 */
import { z } from "zod";

export const LaxiiSize = z.enum(["1024x1024", "768x1344", "864x1152", "1344x768", "1152x864", "1440x720", "720x1440"]);
export type LaxiiSizeT = z.infer<typeof LaxiiSize>;
export const LaxiiMode = z.enum(["generate", "edit"]);
/** Aspect adaptation presets for project use (local processing, §7C). */
export const LaxiiAspect = z.enum(["original", "16:9", "9:16", "1:1", "4:5"]);

export const LaxiiGenerateParamsSchema = z.object({
  prompt: z.string().min(1).max(2000),
  mode: LaxiiMode.default("generate"),
  /** For mode="edit": the owned image asset to edit/variate. */
  referenceAssetId: z.string().max(64).nullable().default(null),
  size: LaxiiSize.default("1024x1024"),
  /** 1..4 alternatives — sequential provider calls, each registered. */
  count: z.number().int().min(1).max(4).default(1),
  /** Local aspect adaptation AFTER registration of the original outputs. */
  aspect: LaxiiAspect.default("original"),
  projectId: z.string().max(64).nullable().default(null),
});
export type LaxiiGenerateParams = z.infer<typeof LaxiiGenerateParamsSchema>;

export interface ImageProviderCapabilities {
  operations: Array<"textToImage" | "imageToImage">;
  sizes: LaxiiSizeT[];
  /** Explicit honesty: what this provider CANNOT do. */
  unsupported: string[];
  commercialUse: string;
  dataRetention: string;
  license: string;
  attribution: string;
  pricingNote: string;
}

export interface ImageResult {
  filePath: string;
  /** TRUE content type determined by sniffing, not the provider's claim. */
  sniffedFormat: string;
  width: number;
  height: number;
}

/** The typed provider contract (§5). */
export interface ImageProvider {
  id: string;
  label: string;
  capabilities: ImageProviderCapabilities;
  /** Generate one image; returns a validated local file. */
  generateImage(params: LaxiiGenerateParams, referencePath: string | null): Promise<ImageResult>;
}

// Re-export the shared provider error so routes/tests use one class.
export { ProviderError } from "@/lib/jazmii/types";
