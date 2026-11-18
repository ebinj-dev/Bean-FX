/**
 * M9 — durable publishing jobs (§3/§6/§7) on the EXISTING M3 worker.
 *
 * Three new job types, registered with the same claim/heartbeat/retry/
 * timeout machinery as every other engine (no new queue, no duplicate
 * renderer):
 *  - PUBLISH_THUMBNAIL: LAXII alternatives for a ThumbnailDraft (new assets,
 *    provenance preserved; never overwrites previous selections).
 *  - EXPORT_VARIANT: validated master → platform profile transcode through
 *    the EXISTING jobManager.runFfmpeg path, with ffprobe conformance checks.
 *  - PUBLISH_PACKAGE: deterministic publication package (manifest + zip).
 */
import { copyFile, mkdir, rm, stat } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { db } from "@/lib/db";
import { jobManager } from "@/lib/job-runner";
import { PermanentJobError, failJob } from "@/lib/job-helpers";
import { ffprobe, pathInsideMediaRoot, sha256File } from "@/lib/media-storage";
import { registerGeneratedAsset } from "@/lib/ai/asset-lifecycle";
import { laxiiProvider } from "@/lib/laxii/providers";
import { composeThumbnailOverlay, thumbnailDimsForProfile, closestLaxiiSize, thumbnailPromptContext } from "./thumbnails";
import { buildVariantArgs, probeMaster, type MasterProbeSummary } from "./variants";
import { validateVariantTarget, validateVariantOutput, type ExportProfile } from "./profiles";
import { buildZip } from "./zip";

interface HandlerJob {
  id: string;
  userId: string;
  attempts: number;
  maxAttempts: number;
  paramsJson: string | null;
}

/** Poll a runFfmpeg-driven job to its terminal state (same pattern as NIKKI). */
async function awaitTerminal(jobId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let open = true;
    const poll = setInterval(async () => {
      const row = await db.job.findUnique({ where: { id: jobId } }).catch(() => null);
      if (!open || !row) return;
      if (row.status === "COMPLETED") {
        open = false;
        clearInterval(poll);
        resolve();
      } else if (row.status === "FAILED" || row.status === "CANCELLED") {
        open = false;
        clearInterval(poll);
        reject(new Error(row.message ?? `Job ${row.status}`));
      }
    }, 500);
    poll.unref?.();
  });
}

// ── PUBLISH_THUMBNAIL ───────────────────────────────────────────────────────

export async function runPublishThumbnailJob(job: HandlerJob): Promise<void> {
  const params = JSON.parse(job.paramsJson ?? "{}") as { draftId?: string; count?: number; prompt?: string; referenceAssetId?: string };
  if (!params.draftId) throw new PermanentJobError("PUBLISH_THUMBNAIL missing draftId");
  const draft = await db.thumbnailDraft.findUnique({ where: { id: params.draftId } });
  if (!draft || draft.userId !== job.userId) throw new PermanentJobError("Thumbnail draft not found or not owned by the caller.");
  const count = Math.max(1, Math.min(4, params.count ?? 2));

  const dims = thumbnailDimsForProfile(draft.platform);
  const size = closestLaxiiSize(dims.width, dims.height);
  const provider = laxiiProvider(null);

  let referencePath: string | null = null;
  if (params.referenceAssetId) {
    const ref = await db.mediaAsset.findUnique({ where: { id: params.referenceAssetId } });
    if (!ref || ref.userId !== job.userId || !ref.mimeType.startsWith("image/")) {
      throw new PermanentJobError("Reference asset not found, not owned by the caller, or not an image.");
    }
    referencePath = ref.storagePath;
  }

  await db.thumbnailDraft.update({ where: { id: draft.id }, data: { status: "GENERATING", jobId: job.id, error: null } });

  const ctx = await thumbnailPromptContext(job.userId, draft.projectId);
  const userHint = (params.prompt ?? draft.prompt ?? "").trim().slice(0, 400);
  // No text in the generated base — the title overlay is composited later
  // (editable, provider-independent). Asking the model for text would bake in
  // uneditable lettering and often misspelled it.
  const prompt = [
    `Bold, high-contrast thumbnail background image for a short video about "${ctx.topic}".`,
    userHint ? `Creator direction: ${userHint}.` : "",
    ctx.scriptExcerpt ? `Content essence: ${ctx.scriptExcerpt}.` : "",
    "Strong central subject, clean composition, vivid colors. NO text, NO letters, NO words, NO captions in the image.",
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 1900);

  const { mkdir } = await import("fs/promises");
  await mkdir(pathInsideMediaRoot("laxii-outputs", `u_${job.userId}`), { recursive: true });
  const candidateIds: string[] = [];
  try {
    for (let i = 0; i < count; i++) {
      await jobManager.setProgress(job.id, Math.round(((i + 0.2) / count) * 80), `Generating thumbnail ${i + 1}/${count} via ${provider.id}`);
      const result = await provider.generateImage(
        { prompt, mode: referencePath ? "edit" : "generate", size: size as never, count: 1, aspect: "original", referenceAssetId: params.referenceAssetId ?? null, projectId: draft.projectId },
        referencePath,
      );
      await jobManager.setProgress(job.id, Math.round(((i + 0.8) / count) * 85), `Validating thumbnail ${i + 1}/${count}`);
      const registered = await registerGeneratedAsset(result.filePath, {
        engine: "LAXII",
        userId: job.userId,
        projectId: draft.projectId,
        originalName: `thumbnail_${draft.platform}_${Date.now().toString(36)}_${i}.jpg`,
        provider: provider.id,
        model: params.referenceAssetId ? "image-edit" : "text-to-image",
        prompt,
        params: { purpose: "publish-thumbnail", draftId: draft.id, platform: draft.platform, requestedSize: size, target: `${dims.width}x${dims.height}` },
        license: provider.capabilities.license,
        attribution: provider.capabilities.attribution,
        referenceAssetId: params.referenceAssetId ?? null,
        expectClass: "IMAGE",
        width: result.width,
        height: result.height,
      });
      candidateIds.push(registered.id);
      await rm(result.filePath, { force: true }).catch(() => undefined);
    }
  } catch (err) {
    await db.thumbnailDraft.update({ where: { id: draft.id }, data: { status: candidateIds.length ? "READY" : "FAILED", error: err instanceof Error ? err.message.slice(0, 500) : "generation failed" } }).catch(() => undefined);
    throw err;
  }

  await db.thumbnailDraft.update({
    where: { id: draft.id },
    data: {
      status: "READY",
      candidateIdsJson: JSON.stringify(candidateIds),
      provenanceJson: JSON.stringify({ provider: provider.id, size, count, generatedAt: new Date().toISOString(), unsupported: provider.capabilities.unsupported }),
      error: null,
    },
  });
  await jobManager.complete(job.id, candidateIds[0] ?? null, `Thumbnail candidates ready: ${candidateIds.length} via ${provider.id} (${size} → ${dims.width}x${dims.height}).`);
}

// ── EXPORT_VARIANT ──────────────────────────────────────────────────────────

export async function runExportVariantJob(job: HandlerJob): Promise<void> {
  const params = JSON.parse(job.paramsJson ?? "{}") as { variantId?: string };
  if (!params.variantId) throw new PermanentJobError("EXPORT_VARIANT missing variantId");
  const variant = await db.exportVariant.findUnique({ where: { id: params.variantId } });
  if (!variant || variant.userId !== job.userId) throw new PermanentJobError("Export variant not found or not owned by the caller.");
  if (variant.status === "COMPLETED" || variant.status === "CANCELLED") return;

  const profile = JSON.parse(variant.profileJson) as ExportProfile;
  let sourcePath: string | null = null;
  if (variant.sourceExportId) {
    const ex = await db.exportFile.findUnique({ where: { id: variant.sourceExportId } });
    if (!ex || ex.userId !== job.userId) throw new PermanentJobError("Source export not found or not owned by the caller.");
    sourcePath = ex.storagePath;
  } else if (variant.sourceAssetId) {
    const asset = await db.mediaAsset.findUnique({ where: { id: variant.sourceAssetId } });
    if (!asset || asset.userId !== job.userId || asset.kind !== "VIDEO") throw new PermanentJobError("Source asset not found, not owned by the caller, or not a video.");
    sourcePath = asset.storagePath;
  } else {
    throw new PermanentJobError("Export variant has no source.");
  }

  await db.exportVariant.update({
    where: { id: variant.id },
    data: { status: "RENDERING", stage: "Inspecting master", jobId: job.id, error: null, attempts: { increment: 1 } },
  });

  let master: MasterProbeSummary;
  try {
    master = await probeMaster(sourcePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "master inspection failed";
    await db.exportVariant.update({ where: { id: variant.id }, data: { status: "FAILED", stage: "Failed", error: msg.slice(0, 500) } });
    await failJob(job.id, msg);
    return;
  }

  const target = validateVariantTarget(profile, master.durationSec, master.width, master.height);
  if (!target.ok) {
    await db.exportVariant.update({
      where: { id: variant.id },
      data: { status: "FAILED", stage: "Validation failed", error: target.failures.map((f) => f.message).join(" | ").slice(0, 500), validationJson: JSON.stringify(target.failures) },
    });
    await failJob(job.id, `Validation failed before encoding: ${target.failures.map((f) => f.code).join(", ")}`);
    return;
  }

  const outPath = pathInsideMediaRoot("publish-variants", `u_${job.userId}`, `variant_${variant.id}.mp4`);
  await mkdir(path.dirname(outPath), { recursive: true });
  const { args, summary } = buildVariantArgs(sourcePath, outPath, profile, master);
  await jobManager.setProgress(job.id, 2, `Encoding ${profile.label}`);

  await jobManager.runFfmpeg(job.id, args, {
    totalDurationSec: master.durationSec,
    stageLabel: `Export variant (${profile.label})`,
    onDone: async () => {
      const st = await stat(outPath).catch(() => null);
      if (!st || st.size === 0) throw new Error("Export variant produced no output file");
      const probe = await ffprobe(outPath);
      const report = validateVariantOutput(
        { width: probe.width, height: probe.height, fps: probe.fps, videoCodec: probe.videoCodec, audioCodec: probe.audioCodec, sampleRate: probe.sampleRate, durationSec: probe.durationSec },
        profile,
      );
      if (!report.ok) {
        await rm(outPath, { force: true }).catch(() => undefined);
        await db.exportVariant.update({
          where: { id: variant.id },
          data: { status: "FAILED", stage: "Validation failed", error: report.failures.map((f) => f.message).join(" | ").slice(0, 500), validationJson: JSON.stringify(report.failures) },
        });
        throw new Error(`Conformance validation failed: ${report.failures.map((f) => f.code).join(", ")}`);
      }
      const exportFile = await db.exportFile.create({
        data: {
          userId: job.userId,
          kind: "VIDEO",
          format: "mp4",
          filename: `${profile.id}_${variant.id}.mp4`,
          storagePath: outPath,
          sizeBytes: st.size,
          durationSec: probe.durationSec,
          paramsJson: JSON.stringify({ variantId: variant.id, profileId: profile.id, profileVersion: variant.profileVersion, summary }),
        },
      });
      await db.exportVariant.update({
        where: { id: variant.id },
        data: { status: "COMPLETED", progress: 100, stage: "Completed", resultExportId: exportFile.id, validationJson: JSON.stringify({ ok: true, probe: { width: probe.width, height: probe.height, fps: probe.fps, videoCodec: probe.videoCodec, audioCodec: probe.audioCodec, sampleRate: probe.sampleRate, durationSec: probe.durationSec } }) },
      });
      await jobManager.complete(job.id, exportFile.id, `Variant ready (${profile.label}): ${summary.join("; ")}`);
    },
    onSettled: async () => {
      const row = await db.job.findUnique({ where: { id: job.id } }).catch(() => null);
      if (row && (row.status === "CANCELLED" || row.status === "FAILED")) {
        await rm(outPath, { force: true }).catch(() => undefined);
        if (row.status === "CANCELLED") {
          await db.exportVariant.updateMany({ where: { id: variant.id, status: { in: ["QUEUED", "RENDERING"] } }, data: { status: "CANCELLED", stage: "Cancelled" } });
        } else {
          // Generic ffmpeg failure (validation failures already set FAILED
          // with their own report — never overwrite that honest record).
          await db.exportVariant.updateMany({
            where: { id: variant.id, status: "RENDERING" },
            data: { status: "FAILED", stage: "Failed", error: (row.message ?? "Encoding failed").slice(0, 500) },
          });
        }
      }
    },
  });

  await awaitTerminal(job.id);
}

// ── PUBLISH_PACKAGE ─────────────────────────────────────────────────────────

const PACKAGE_INPUT_BYTES_CAP = 800 * 1024 * 1024;

export async function runPublishPackageJob(job: HandlerJob): Promise<void> {
  const params = JSON.parse(job.paramsJson ?? "{}") as { packageId?: string };
  if (!params.packageId) throw new PermanentJobError("PUBLISH_PACKAGE missing packageId");
  const pkg = await db.publishPackage.findUnique({ where: { id: params.packageId } });
  if (!pkg || pkg.userId !== job.userId) throw new PermanentJobError("Package not found or not owned by the caller.");

  const staging = pathInsideMediaRoot("tmp", `pkg_${pkg.id}`);
  // EVERY failure after this point must land on the package row — a job that
  // fails without its row moving to FAILED would sit BUILDING forever.
  try {
    await runPublishPackageJobInner(job, pkg, staging);
  } catch (err) {
    await db.publishPackage
      .update({ where: { id: pkg.id }, data: { status: "FAILED", error: err instanceof Error ? err.message.slice(0, 500) : "packaging failed" } })
      .catch(() => undefined);
    throw err;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runPublishPackageJobInner(job: HandlerJob, pkg: { id: string; userId: string; projectId: string | null; variantIdsJson: string; metadataId: string | null; thumbnailDraftId: string | null }, staging: string): Promise<void> {
  const variantIds = JSON.parse(pkg.variantIdsJson) as string[];
  if (variantIds.length === 0) throw new PermanentJobError("Package has no export variants.");

  await jobManager.setProgress(job.id, 5, "Collecting package contents");
  const variants = await db.exportVariant.findMany({ where: { id: { in: variantIds }, userId: job.userId } });
  if (variants.length !== variantIds.length) throw new PermanentJobError("Some variants were not found for this package.");
  const notCompleted = variants.filter((v) => v.status !== "COMPLETED" || !v.resultExportId);
  if (notCompleted.length) {
    throw new PermanentJobError(`All variants must be COMPLETED before packaging (not ready: ${notCompleted.map((v) => `${v.profileId}:${v.status}`).join(", ")}).`);
  }

  const exportRows = await db.exportFile.findMany({ where: { id: { in: variants.map((v) => v.resultExportId as string) }, userId: job.userId } });
  const exportById = new Map(exportRows.map((e) => [e.id, e]));
  for (const v of variants) {
    const ex = exportById.get(v.resultExportId as string);
    if (!ex || !existsSync(ex.storagePath)) throw new PermanentJobError(`Variant output for ${v.profileId} is missing from storage.`);
  }
  const totalBytes = exportRows.reduce((n, e) => n + e.sizeBytes, 0);
  if (totalBytes > PACKAGE_INPUT_BYTES_CAP) {
    throw new PermanentJobError(`Package inputs total ${(totalBytes / 1024 / 1024).toFixed(0)} MB — over the ${(PACKAGE_INPUT_BYTES_CAP / 1024 / 1024).toFixed(0)} MB packaging cap (memory-bounded deterministic zip).`);
  }

  // Approved metadata (optional but REQUIRED to be APPROVED if referenced).
  let metadataBlock: Record<string, unknown> | null = null;
  if (pkg.metadataId) {
    const meta = await db.publishMetadata.findUnique({ where: { id: pkg.metadataId } });
    if (!meta || meta.userId !== job.userId) throw new PermanentJobError("Referenced metadata row not found or not owned by the caller.");
    if (meta.status !== "APPROVED" || !meta.approvedJson) {
      throw new PermanentJobError("Referenced metadata is not APPROVED — approve the metadata before packaging (AI suggestions are never packaged).");
    }
    metadataBlock = {
      platform: meta.platform,
      language: meta.language,
      fields: JSON.parse(meta.approvedJson),
      approvedAt: meta.updatedAt.toISOString(),
    };
  }

  // Thumbnail (optional; composited output preferred over the raw selection).
  let thumbnailBlock: Record<string, unknown> | null = null;
  if (pkg.thumbnailDraftId) {
    const draft = await db.thumbnailDraft.findUnique({ where: { id: pkg.thumbnailDraftId } });
    if (!draft || draft.userId !== job.userId) throw new PermanentJobError("Referenced thumbnail draft not found or not owned by the caller.");
    const assetId = draft.compositedAssetId ?? draft.selectedAssetId;
    if (!assetId) throw new PermanentJobError("Thumbnail draft has no selected/composited image yet.");
    const asset = await db.mediaAsset.findUnique({ where: { id: assetId } });
    if (!asset || asset.userId !== job.userId || asset.kind !== "IMAGE") throw new PermanentJobError("Thumbnail asset not found, not owned, or not an image.");
    thumbnailBlock = { platform: draft.platform, assetId: asset.id, kind: draft.compositedAssetId ? "composited" : "base-selection", layoutJson: draft.layoutJson ? JSON.parse(draft.layoutJson) : null };
  }

  await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(path.join(staging, "videos"), { recursive: true });
  await mkdir(path.join(staging, "thumbnail"), { recursive: true });

  const project = pkg.projectId ? await db.project.findUnique({ where: { id: pkg.projectId } }) : null;
  if (pkg.projectId && (!project || project.userId !== job.userId)) throw new PermanentJobError("Packaged project not found or not owned by the caller.");

  const files: { path: string; bytes: number; sha256: string; purpose: string; sourceRef: string }[] = [];
  try {
    for (const v of variants) {
      const ex = exportById.get(v.resultExportId as string) as { storagePath: string; sizeBytes: number; id: string };
      const name = `videos/${v.profileId}.mp4`;
      await copyFile(ex.storagePath, path.join(staging, name));
      files.push({ path: name, bytes: ex.sizeBytes, sha256: await sha256File(path.join(staging, name)), purpose: "video-variant", sourceRef: `exportVariant:${v.id}` });
    }

    if (thumbnailBlock) {
      const assetId = (thumbnailBlock.assetId as string) ?? "";
      const asset = await db.mediaAsset.findUnique({ where: { id: assetId } });
      if (asset) {
        const ext = asset.mimeType === "image/png" ? "png" : "jpg";
        const name = `thumbnail/${(thumbnailBlock.platform as string) ?? "platform"}.${ext}`;
        await copyFile(asset.storagePath, path.join(staging, name));
        files.push({ path: name, bytes: asset.sizeBytes, sha256: await sha256File(path.join(staging, name)), purpose: "thumbnail", sourceRef: `mediaAsset:${asset.id}` });
      }
    }

    await jobManager.setProgress(job.id, 60, "Building manifest");
    const metadataJson = metadataBlock ? JSON.stringify(metadataBlock, null, 2) + "\n" : null;
    if (metadataJson) {
      await (await import("fs/promises")).writeFile(path.join(staging, "metadata.json"), metadataJson, "utf8");
      files.push({ path: "metadata.json", bytes: Buffer.byteLength(metadataJson), sha256: await sha256File(path.join(staging, "metadata.json")), purpose: "approved-metadata", sourceRef: pkg.metadataId ? `publishMetadata:${pkg.metadataId}` : "" });
    }

    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const manifest = {
      schemaVersion: 1,
      generator: "BEAN FX M9 publication packaging",
      packageId: pkg.id,
      project: project ? { id: project.id, name: project.name } : null,
      platform: variants[0]?.profileId ?? null,
      profiles: variants.map((v) => ({ id: v.profileId, version: v.profileVersion, profileJson: JSON.parse(v.profileJson) as unknown })),
      brandPresetReference: null as string | null,
      metadata: metadataBlock ? { status: "USER-APPROVED", platform: metadataBlock.platform, language: metadataBlock.language } : { status: "NOT-INCLUDED", note: "No approved metadata row was referenced for this package." },
      thumbnail: thumbnailBlock,
      files,
      exclusions: {
        privateSourceMedia: "excluded by policy — packages contain completed variant outputs, the selected thumbnail and approved metadata only",
        credentials: "excluded by policy",
        internalFiles: "excluded by policy",
      },
    };
    const { writeFile } = await import("fs/promises");
    const manifestStr = JSON.stringify(manifest, null, 2) + "\n";
    await writeFile(path.join(staging, "manifest.json"), manifestStr, "utf8");
    const manifestSha = await sha256File(path.join(staging, "manifest.json"));

    await jobManager.setProgress(job.id, 80, "Zipping package");
    const { readFile } = await import("fs/promises");
    const entries: { name: string; data: Uint8Array }[] = [];
    const zipFiles = [...files.map((f) => f.path), "manifest.json"];
    for (const rel of zipFiles) {
      entries.push({ name: rel, data: new Uint8Array(await readFile(path.join(staging, rel))) });
    }
    const zip = buildZip(entries);
    const outDir = pathInsideMediaRoot("packages", `u_${job.userId}`);
    await mkdir(outDir, { recursive: true });
    const zipPath = path.join(outDir, `package_${pkg.id}.zip`);
    await writeFile(zipPath, zip.buffer);
    const zipStat = await stat(zipPath);

    await db.publishPackage.update({
      where: { id: pkg.id },
      data: {
        status: "READY",
        manifestJson: manifestStr,
        manifestSha256: manifestSha,
        storagePath: zipPath,
        sizeBytes: zipStat.size,
        error: null,
      },
    });
    await jobManager.complete(job.id, null, `Publication package ready: ${files.length} files + manifest (${(zipStat.size / 1024 / 1024).toFixed(1)} MB zip).`);
  } catch (err) {
    await db.publishPackage
      .update({ where: { id: pkg.id }, data: { status: "FAILED", error: err instanceof Error ? err.message.slice(0, 500) : "packaging failed" } })
      .catch(() => undefined);
    throw err;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Convenience used by the API route: composite + register a thumbnail selection. */
export async function compositeAndRegisterThumbnail(
  userId: string,
  draftId: string,
  layout: Parameters<typeof composeThumbnailOverlay>[1],
): Promise<{ assetId: string; dims: { width: number; height: number } }> {
  const draft = await db.thumbnailDraft.findUnique({ where: { id: draftId } });
  if (!draft || draft.userId !== userId) throw new PermanentJobError("Thumbnail draft not found or not owned by the caller.");
  if (!draft.selectedAssetId) throw new PermanentJobError("Select a base image before applying the overlay.");
  const asset = await db.mediaAsset.findUnique({ where: { id: draft.selectedAssetId } });
  if (!asset || asset.userId !== userId || asset.kind !== "IMAGE") throw new PermanentJobError("Selected asset not found, not owned, or not an image.");
  const dims = thumbnailDimsForProfile(draft.platform);
  const outPath = pathInsideMediaRoot("publish-thumbnails", `u_${userId}`, `composite_${draft.id}_${Date.now().toString(36)}.jpg`);
  const composed = await composeThumbnailOverlay(asset.storagePath, layout, dims.width, dims.height, outPath);
  const registered = await registerGeneratedAsset(composed.outPath, {
    engine: "LAXII",
    userId,
    projectId: draft.projectId,
    originalName: `thumbnail_composite_${draft.platform}_${Date.now().toString(36)}.jpg`,
    provider: "publish-compositor",
    model: "title-overlay-v1",
    prompt: draft.prompt || "thumbnail title overlay",
    params: { purpose: "publish-thumbnail-composite", draftId: draft.id, platform: draft.platform, layout },
    license: "derived-from-owned-assets",
    attribution: `Composite of ${asset.id} with editable title overlay`,
    referenceAssetId: asset.id,
    expectClass: "IMAGE",
    width: composed.width,
    height: composed.height,
  });
  await db.thumbnailDraft.update({ where: { id: draft.id }, data: { compositedAssetId: registered.id, layoutJson: JSON.stringify(layout) } });
  return { assetId: registered.id, dims: { width: composed.width, height: composed.height } };
}
