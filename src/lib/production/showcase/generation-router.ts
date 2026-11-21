/**
 * M31 SHOWCASE STUDIO — Generation router (Phase 5).
 *
 * Routes a showcase generation operation to the REAL configured providers
 * through the EXISTING durable job system — never a fake success, never an
 * unapproved paid call. Implements the 10-step model-selection protocol:
 *
 *   1 provider availability probe      6 estimated price (UNKNOWN unless verified)
 *   2 supported operations/models      7 present the actual production path
 *   3 output resolution/duration       8 explicit user approval gate
 *   4 aspect-ratio support             9 submit a REAL job
 *   5 input limitations               10 validate output (job handlers) + sync
 *
 * Pricing note carried verbatim from the provider registries: metered by the
 * provider account; per-call pricing is NOT independently verified → cost is
 * UNKNOWN (never 0, never invented). Approval therefore always applies to an
 * UNKNOWN-cost call, and the approved budget is the user's ceiling.
 */
import { execFile } from "node:child_process";
import { z } from "zod";
import { db } from "@/lib/db";
import { jobManager } from "@/lib/job-runner";
import { JOB_TYPE_JAZMII_GENERATE, JOB_TYPE_LAXII_GENERATE } from "@/lib/job-helpers";
import { JazmiiGenerateParamsSchema } from "@/lib/jazmii/types";
import { probeVideoProvider } from "@/lib/jazmii/jobs";
import { LaxiiGenerateParamsSchema } from "@/lib/laxii/types";
import { ProductionError } from "../runner";

// ── Availability probes (real, cheap, no paid calls) ────────────────────────
export function cliAvailable(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("which", [bin], { timeout: 5_000 }, (err) => resolve(!err));
  });
}

const ZAI_BIN = (): string => process.env.BEANFX_ZAI_BIN ?? "z-ai";

export async function providerAvailability(): Promise<{
  video: { configured: boolean; detail: string };
  image: { configured: boolean; detail: string };
}> {
  const video = await probeVideoProvider().then((r) => ({ configured: r.ok, detail: r.detail })).catch((e: unknown) => ({ configured: false, detail: String(e).slice(0, 200) }));
  const imageOk = await cliAvailable(ZAI_BIN());
  return {
    video,
    image: imageOk
      ? { configured: true, detail: `image provider CLI "${ZAI_BIN()}" present` }
      : { configured: false, detail: `image provider CLI "${ZAI_BIN()}" is not installed on the server — LAXII generation is unavailable (CONFIGURATION REQUIRED).` },
  };
}

// ── Request schemas ─────────────────────────────────────────────────────────
export const ShowcaseGenerationRequestSchema = z.object({
  assetId: z.string().min(1).max(64),
  kind: z.enum(["generated_image", "generated_video"]),
  prompt: z.string().min(1).max(2000),
  referenceMediaId: z.string().max(64).nullable().default(null),
  /** Provider contract enums — rejected, never silently mapped. */
  size: z.string().max(20).default("1920x1080"),
  durationSec: z.enum(["5", "10"]).default("5"),
  quality: z.enum(["speed", "quality"]).default("speed"),
  /** Explicit user approval for a KNOWN-UNKNOWN-cost call. */
  approved: z.boolean(),
  /** M32 Track A: duplicate-submission protection — the same key on the same
   *  production returns the EXISTING job (never a second paid call). */
  idempotencyKey: z.string().min(8).max(64).nullable().default(null),
});
export type ShowcaseGenerationRequest = z.infer<typeof ShowcaseGenerationRequestSchema>;

// ── The router ──────────────────────────────────────────────────────────────
export async function routeGeneration(userId: string, req: ShowcaseGenerationRequest): Promise<{ jobId: string; assetId: string; path: string[]; costUnknown: true; provider: string; model: string | null; deduped?: boolean }> {
  if (!req.approved) {
    throw new ProductionError("This generation calls a metered provider with UNKNOWN cost. Explicit user approval (and an approved budget) is required before any paid call.", 409, "APPROVAL_REQUIRED");
  }
  // M32 Track A — DUPLICATE-SUBMISSION PROTECTION: the same idempotency key
  // on the same production returns the EXISTING job (in flight or complete).
  // Never a second paid call.
  if (req.idempotencyKey) {
    const existing = await db.productionAsset.findFirst({
      where: { idempotencyKey: req.idempotencyKey, jobId: { not: null }, status: { in: ["GENERATING", "READY", "APPROVED"] } },
    });
    if (existing) {
      const prod = await db.production.findUnique({ where: { id: existing.productionId } });
      if (prod && prod.userId === userId) {
        const job = await db.job.findUnique({ where: { id: existing.jobId! } });
        if (job && !["FAILED", "CANCELLED"].includes(job.status)) {
          return { jobId: job.id, assetId: existing.id, path: ["idempotency-key hit — existing job returned, no new submission"], costUnknown: true, provider: existing.provider ?? "", model: existing.model, deduped: true };
        }
      }
    }
  }
  const asset = await db.productionAsset.findUnique({ where: { id: req.assetId } });
  if (!asset) throw new ProductionError("Asset row not found.", 404, "NOT_FOUND");
  const production = await db.production.findUnique({ where: { id: asset.productionId } });
  if (!production || production.userId !== userId) throw new ProductionError("Production not found.", 404, "NOT_FOUND");
  if (production.approvedBudgetCents === null) {
    throw new ProductionError("No approved budget set — set a budget before any paid generation.", 409, "BUDGET_REQUIRED");
  }
  if (asset.status === "APPROVED" || asset.status === "READY") {
    throw new ProductionError("Asset is already produced — refusing to duplicate the provider call.", 409, "ALREADY_PRODUCED");
  }

  const availability = await providerAvailability();
  const path: string[] = ["1 provider probe", "2 capability match", "3 aspect check", "4 approval ✓", "5 submit job", "6 validate output (job handler)"];

  if (req.kind === "generated_video") {
    if (!availability.video.configured) {
      throw new ProductionError(`Video generation unavailable: ${availability.video.detail}`, 409, "CONFIGURATION_REQUIRED");
    }
    // Reference image (imageToVideo) must exist and be owned.
    if (req.referenceMediaId) {
      const ref = await db.mediaAsset.findFirst({ where: { id: req.referenceMediaId, userId } });
      if (!ref) throw new ProductionError("Reference media not found or not owned by the caller.", 404, "NOT_FOUND");
    }
    const parsed = JazmiiGenerateParamsSchema.safeParse({
      prompt: req.prompt,
      operation: req.referenceMediaId ? "imageToVideo" : "textToVideo",
      referenceAssetId: req.referenceMediaId,
      quality: req.quality,
      size: req.size,
      fps: "30",
      durationSec: req.durationSec,
      withAudio: false,
      projectId: production.projectId,
    });
    if (!parsed.success) throw new ProductionError(`Video params not supported by the provider contract: ${parsed.error.issues.map((i) => i.message).join("; ")}`, 400, "UNSUPPORTED");
    const jobId = await jobManager.createJob(userId, JOB_TYPE_JAZMII_GENERATE, parsed.data);
    await db.productionAsset.update({
      where: { id: asset.id },
      data: { status: "GENERATING", provider: "zai-video", model: "cogvideox-3", jobId, costUnknown: true, costCents: null, idempotencyKey: req.idempotencyKey, provenanceJson: JSON.stringify({ routedAt: new Date().toISOString(), protocolPath: path, providerAvailability: availability.video.detail }) },
    });
    await db.productionEvent.create({ data: { productionId: production.id, kind: "generation.submitted", stageKey: "ASSET_GENERATION", detailJson: JSON.stringify({ assetId: asset.id, jobId, kind: "video", costUnknown: true }) } });
    return { jobId, assetId: asset.id, path, costUnknown: true, provider: "zai-video", model: "cogvideox-3" };
  }

  // Image path
  if (!availability.image.configured) {
    throw new ProductionError(`Image generation unavailable: ${availability.image.detail}`, 409, "CONFIGURATION_REQUIRED");
  }
  if (req.referenceMediaId) {
    const ref = await db.mediaAsset.findFirst({ where: { id: req.referenceMediaId, userId } });
    if (!ref) throw new ProductionError("Reference media not found or not owned by the caller.", 404, "NOT_FOUND");
  }
  const parsed = LaxiiGenerateParamsSchema.safeParse({
    prompt: req.prompt,
    mode: req.referenceMediaId ? "edit" : "generate",
    referenceAssetId: req.referenceMediaId,
    size: req.size,
    count: 1,
    aspect: "original",
    projectId: production.projectId,
  });
  if (!parsed.success) throw new ProductionError(`Image params not supported by the provider contract: ${parsed.error.issues.map((i) => i.message).join("; ")}`, 400, "UNSUPPORTED");
  const jobId = await jobManager.createJob(userId, JOB_TYPE_LAXII_GENERATE, parsed.data);
  await db.productionAsset.update({
    where: { id: asset.id },
    data: { status: "GENERATING", provider: "zai-image", model: null, jobId, costUnknown: true, costCents: null, idempotencyKey: req.idempotencyKey, provenanceJson: JSON.stringify({ routedAt: new Date().toISOString(), protocolPath: path, providerAvailability: availability.image.detail }) },
  });
  await db.productionEvent.create({ data: { productionId: production.id, kind: "generation.submitted", stageKey: "ASSET_GENERATION", detailJson: JSON.stringify({ assetId: asset.id, jobId, kind: "image", costUnknown: true }) } });
  return { jobId, assetId: asset.id, path, costUnknown: true, provider: "zai-image", model: null };
}

/** Sync GENERATING production assets with their real job results (idempotent;
 *  a completed job maps to its registered media asset via Job.resultJson). */
export async function syncGenerationAssets(productionId: string): Promise<{ synced: number; ready: number; failed: number }> {
  const assets = await db.productionAsset.findMany({ where: { productionId, status: "GENERATING", jobId: { not: null } } });
  let ready = 0; let failed = 0;
  for (const a of assets) {
    const job = await db.job.findUnique({ where: { id: a.jobId! } });
    if (!job) continue;
    if (job.status === "COMPLETED") {
      const mediaAssetId = (job.exportId ?? "").trim() || null;
      const mediaOk = mediaAssetId ? await db.mediaAsset.findUnique({ where: { id: mediaAssetId } }) : null;
      await db.productionAsset.update({
        where: { id: a.id },
        data: { status: mediaOk ? "READY" : "FAILED", mediaAssetId: mediaOk ? mediaAssetId : null, error: mediaOk ? null : "job completed but no registered media asset found in result" },
      });
      if (mediaOk) ready++; else failed++;
    } else if (["FAILED", "CANCELLED"].includes(job.status)) {
      await db.productionAsset.update({ where: { id: a.id }, data: { status: "FAILED", error: job.message ?? job.status } });
      failed++;
    }
  }
  return { synced: assets.length, ready, failed };
}
