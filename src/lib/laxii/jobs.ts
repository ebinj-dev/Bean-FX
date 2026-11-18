/**
 * LAXII — durable jobs (M7 §7): LAXII_GENERATE on the M3 worker.
 *
 * For `count` alternatives: provider call → validate (already inside the
 * provider adapter: sniff + PIL decode + size assert) → register each as a
 * MediaAsset (kind IMAGE, full provenance, referenceAssetId for edits) →
 * local derivatives (aspect adaptation, thumbnail) registered as CHILD assets
 * with parent provenance. A job completes only when every promised output is
 * a registered, validated asset — no placeholder completions.
 */
import { pathInsideMediaRoot } from "@/lib/media-storage";
import { db } from "@/lib/db";
import { jobManager } from "@/lib/job-runner";
import { PermanentJobError } from "@/lib/job-helpers";
import { rm } from "fs/promises";
import { laxiiProvider } from "./providers";
import { LaxiiGenerateParamsSchema } from "./types";
import { adaptAspect, makeThumbnail } from "./processing";
import { registerGeneratedAsset } from "@/lib/ai/asset-lifecycle";

interface HandlerJob {
  id: string;
  userId: string;
  paramsJson: string | null;
}

export async function runLaxiiGenerateJob(job: HandlerJob): Promise<void> {
  const parsed = LaxiiGenerateParamsSchema.safeParse(JSON.parse(job.paramsJson ?? "{}"));
  if (!parsed.success) throw new PermanentJobError(`LAXII_GENERATE invalid params: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const params = parsed.data;

  // Reference image ownership (mode=edit).
  let referencePath: string | null = null;
  if (params.referenceAssetId) {
    const ref = await db.mediaAsset.findUnique({ where: { id: params.referenceAssetId } });
    if (!ref || ref.userId !== job.userId) throw new PermanentJobError("LAXII_GENERATE reference asset not found or not owned by the caller.");
    if (!ref.mimeType.startsWith("image/")) throw new PermanentJobError("LAXII_GENERATE reference asset is not an image.");
    referencePath = ref.storagePath;
  }

  const provider = laxiiProvider(null);
  // Derivative files (thumbnail/adaptation) are written here by PIL — create
  // the directory up front (PIL save does not mkdir).
  const { mkdir } = await import("fs/promises");
  await mkdir(pathInsideMediaRoot("laxii-outputs", `u_${job.userId}`), { recursive: true });
  const assetIds: string[] = [];
  for (let i = 0; i < params.count; i++) {
    await jobManager.setProgress(job.id, Math.round(((i + 0.2) / params.count) * 70), `Generating image ${i + 1}/${params.count} via ${provider.id}`);
    const result = await provider.generateImage(params, referencePath);
    await jobManager.setProgress(job.id, Math.round(((i + 0.8) / params.count) * 80), `Validating image ${i + 1}/${params.count}`);
    const registered = await registerGeneratedAsset(result.filePath, {
      engine: "LAXII",
      userId: job.userId,
      projectId: params.projectId ?? null,
      originalName: `laxii_${Date.now().toString(36)}_${i}.${result.sniffedFormat.toLowerCase()}`,
      provider: provider.id,
      model: params.mode === "edit" ? "image-edit" : "text-to-image",
      prompt: params.prompt,
      params: { ...params, sniffedFormat: result.sniffedFormat, width: result.width, height: result.height },
      license: provider.capabilities.license,
      attribution: provider.capabilities.attribution,
      referenceAssetId: params.referenceAssetId ?? null,
      expectClass: "IMAGE",
      width: result.width,
      height: result.height,
    });
    assetIds.push(registered.id);

    // Local derivatives (never modifying the original): thumbnail.
    const thumbPath = pathInsideMediaRoot("laxii-outputs", `u_${job.userId}`, `laxii_thumb_${registered.id}.jpg`);
    const thumbDims = await makeThumbnail(registered.storagePath, thumbPath, 480);
    const thumb = await registerGeneratedAsset(thumbPath, {
      engine: "LAXII",
      userId: job.userId,
      projectId: params.projectId ?? null,
      originalName: `laxii_thumb_${registered.id}.jpg`,
      provider: "laxii-processing",
      model: "thumbnail-480",
      prompt: `Thumbnail of ${registered.id}`,
      params: { parentAssetId: registered.id, maxEdge: 480 },
      license: "provider-terms",
      attribution: `Derived from LAXII output ${registered.id}`,
      referenceAssetId: registered.id,
      expectClass: "IMAGE",
      width: thumbDims.width,
      height: thumbDims.height,
    });
    assetIds.push(thumb.id);

    // Aspect adaptation creates an ADDITIONAL child asset (original preserved).
    if (params.aspect !== "original") {
      const adaptedPath = pathInsideMediaRoot("laxii-outputs", `u_${job.userId}`, `laxii_${params.aspect.replace(":", "x")}_${registered.id}.jpg`);
      await adaptAspect(registered.storagePath, params.aspect, adaptedPath);
      const adaptedDims = await adaptAspect(registered.storagePath, params.aspect, adaptedPath);
      const adapted = await registerGeneratedAsset(adaptedPath, {
        engine: "LAXII",
        userId: job.userId,
        projectId: params.projectId ?? null,
        originalName: `laxii_${params.aspect.replace(":", "x")}_${registered.id}.jpg`,
        provider: "laxii-processing",
        model: `aspect-${params.aspect}`,
        prompt: `${params.aspect} adaptation of ${registered.id}`,
        params: { parentAssetId: registered.id, aspect: params.aspect },
        license: "provider-terms",
        attribution: `Derived from LAXII output ${registered.id}`,
        referenceAssetId: registered.id,
        expectClass: "IMAGE",
        width: adaptedDims.width,
        height: adaptedDims.height,
      });
      assetIds.push(adapted.id);
    }
    // The provider temp file is consumed (registered) — remove the tmp copy.
    await rm(result.filePath, { force: true }).catch(() => undefined);
  }

  await jobManager.complete(job.id, assetIds[0] ?? null, `LAXII assets ready: ${assetIds.join(", ")}`);
}
