/**
 * Shared generated-asset lifecycle (M7 §8) — used by BOTH JAZMII and LAXII.
 *
 * Every successful provider output must become a normal, validated BEAN FX
 * media asset: content-sniffed (never trusting provider MIME types — the
 * zai-image provider returns JPEG bytes even when told ".png", caught in the
 * provider probe), ffprobe'd when applicable, quota-checked, hash-recorded,
 * registered with full provenance, and never orphaned (files are written
 * under MEDIA_ROOT/<engine>/ and referenced by the DB row created AFTER the
 * file is complete; failures delete the file).
 */
import { mkdir, rename, rm, stat } from "fs/promises";
import path from "path";
import { db } from "@/lib/db";
import { MEDIA_ROOT, pathInsideMediaRoot, sniffContainer, sniffMatchesClass, sha256File, ffprobe, hasQuotaFor } from "@/lib/media-storage";
import { ProviderError } from "@/lib/jazmii/types";

export type GeneratedEngine = "JAZMII" | "LAXII" | "SHOWCASE";

export interface RegisterOptions {
  engine: GeneratedEngine;
  userId: string;
  projectId?: string | null;
  originalName: string;
  provider: string;
  model: string;
  prompt: string;
  params: Record<string, unknown>;
  license?: string | null;
  attribution?: string | null;
  providerTaskId?: string | null;
  referenceAssetId?: string | null;
  /** Expected media class for content sniffing. */
  expectClass: "IMAGE" | "VIDEO";
  /** Extra validation callback after the sniff (PIL/ffprobe asserts). */
  validate?: (filePath: string) => Promise<void>;
  /** Measured dimensions for images (no ffprobe pass for stills). */
  width?: number | null;
  height?: number | null;
}

export interface RegisteredAsset {
  id: string;
  storagePath: string;
  sizeBytes: number;
  sha256: string;
}

/** Download a provider URL to MEDIA_ROOT/<engine>/ with a size cap. */
export async function downloadProviderOutput(url: string, engine: GeneratedEngine, userId: string, ext: string, maxBytes = 500 * 1024 * 1024): Promise<string> {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new ProviderError("PROVIDER_FAILURE", `Provider output download failed with HTTP ${res.status}.`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new ProviderError("INVALID_RESPONSE", "Provider returned an empty output file.");
  if (buf.length > maxBytes) throw new ProviderError("INVALID_RESPONSE", `Provider output exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB safety cap.`);
  const dir = pathInsideMediaRoot(`${engine.toLowerCase()}-outputs`, `u_${userId}`);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${engine.toLowerCase()}_${Date.now().toString(36)}${ext}`);
  await writeFile2(file, buf);
  return file;
}

async function writeFile2(file: string, buf: Buffer): Promise<void> {
  const { writeFile } = await import("fs/promises");
  await writeFile(file, buf);
}

/**
 * Validate + register one generated output file as a MediaAsset.
 * Throws (and deletes the file) on ANY validation failure — no orphan files.
 */
export async function registerGeneratedAsset(file: string, opts: RegisterOptions): Promise<RegisteredAsset> {
  let sizeBytes = 0;
  try {
    const st = await stat(file);
    if (!st || st.size === 0) throw new ProviderError("INVALID_RESPONSE", "Provider output is empty.");
    sizeBytes = st.size;

    // 1. Content sniff — the declared type is untrusted (zai-image sends
    //    JPEG bytes even for .png requests; caught in the live probe).
    const head = await import("fs/promises").then((fs) => fs.readFile(file, { flag: "r" }).then((b) => b.subarray(0, 512)));
    const sniff = sniffContainer(head);
    if (!sniffMatchesClass(sniff, opts.expectClass)) {
      throw new ProviderError("INVALID_RESPONSE", `Provider output content sniff failed: expected ${opts.expectClass}, got ${sniff.family} (${sniff.mime ?? "unknown mime"}).`);
    }
    // 2. Engine-specific validation (PIL decode / ffprobe asserts).
    await opts.validate?.(file);
    // 3. Quota enforcement — same policy as uploads.
    const quota = await hasQuotaFor(opts.userId, sizeBytes);
    if (!quota.ok) throw new ProviderError("PROVIDER_FAILURE", `Storage quota exceeded: ${quota.usedBytes} / ${quota.quotaBytes} bytes in use.`);
    // 3.5. Outputs MUST live under MEDIA_ROOT/<engine>-outputs/ — a provider
    // file still in /tmp is relocated here (registered path stays valid).
    let finalPath = file;
    if (!file.startsWith(MEDIA_ROOT)) {
      const dir = pathInsideMediaRoot(`${opts.engine.toLowerCase()}-outputs`, `u_${opts.userId}`);
      await mkdir(dir, { recursive: true });
      finalPath = path.join(dir, path.basename(file));
      await rename(file, finalPath);
    }

    // 4. Real metadata — AFTER the relocation: sha/probe read the FINAL path.
    const sha = await sha256File(finalPath);
    let probeMeta: Awaited<ReturnType<typeof ffprobe>> | null = null;
    if (opts.expectClass === "VIDEO") {
      probeMeta = await ffprobe(finalPath);
      if (!probeMeta.durationSec || !probeMeta.width) throw new ProviderError("INVALID_RESPONSE", "Provider video output failed ffprobe validation.");
    }
    // 5. Register (create the DB row only after the file is final).
    const mime = sniff.mime ?? (opts.expectClass === "IMAGE" ? "image/jpeg" : "video/mp4");
    const asset = await db.mediaAsset.create({
      data: {
        userId: opts.userId,
        projectId: opts.projectId ?? null,
        originalName: opts.originalName,
        storagePath: finalPath,
        kind: opts.expectClass,
        mimeType: mime,
        sizeBytes,
        durationSec: probeMeta?.durationSec ?? null,
        width: probeMeta?.width ?? opts.width ?? null,
        height: probeMeta?.height ?? opts.height ?? null,
        fps: probeMeta?.fps ?? null,
        videoCodec: probeMeta?.videoCodec ?? null,
        audioCodec: probeMeta?.audioCodec ?? null,
        sha256: sha,
        probeStatus: probeMeta ? "READY" : null,
        probeMetaJson: probeMeta && probeMeta.width && probeMeta.height ? JSON.stringify({ aspect: (probeMeta.width / probeMeta.height).toFixed(3) }) : null,
        createdBy: opts.engine,
        provider: opts.provider,
        model: opts.model,
        prompt: opts.prompt.slice(0, 2000),
        paramsJson: JSON.stringify(opts.params).slice(0, 4000),
        license: opts.license ?? "provider-terms",
        attribution: (opts.attribution ?? "").slice(0, 500),
        referenceAssetId: opts.referenceAssetId ?? null,
        role: opts.engine === "JAZMII" ? "BROLL" : null,
      },
    });
    return { id: asset.id, storagePath: finalPath, sizeBytes, sha256: sha };
  } catch (err) {
    // No orphan files: a failed registration removes the output.
    await rm(file, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Register a local analysis artifact (thumbnail) as an IMAGE asset. */
export async function registerImageArtifact(file: string, opts: Omit<RegisterOptions, "expectClass">): Promise<RegisteredAsset> {
  return registerGeneratedAsset(file, { ...opts, expectClass: "IMAGE" });
}
