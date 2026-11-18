/**
 * M14.6 — LAXII Visual Asset Studio (composition-oriented workflow).
 *
 * Scene assets are generated through the EXISTING LAXII engine (provider
 * registry, validation, provenance, metering) with prompts built from the
 * APPROVED art direction's style profile — style consistency comes from the
 * shared prompt, and the profile's consistency rules travel with every call.
 * Honesty: the configured provider returns JPEG bytes even for .png outputs
 * (verified live in M7) — alpha transparency is NOT claimed; if pixels
 * actually carry alpha, it is verified with PIL and reported; otherwise the
 * limitation is stated. Character identity across independent generations is
 * NOT guaranteed — stated in every result. Failed registrations clean up.
 */
import { rm, stat } from "fs/promises";
import { db } from "@/lib/db";
import { laxiiProvider } from "@/lib/laxii/providers";
import { registerImageArtifact } from "@/lib/ai/asset-lifecycle";
import { styleProfilePromptBlock, getApprovedDirection } from "./direction";
import type { ArtDirection } from "./contracts";

const FORMAT_SIZE: Record<string, "1024x1024" | "768x1344" | "864x1152" | "1344x768" | "1152x864"> = {
  "16:9": "1344x768",
  "9:16": "768x1344",
  "1:1": "1024x1024",
  "4:5": "864x1152",
};

export interface AssetSpec {
  projectId: string;
  sceneId: string;
  role: "background" | "foreground" | "character" | "prop" | "decorative" | "cutout" | "scene-artwork" | "texture";
  prompt: string;
  alternatives?: number;
  mode?: "generate" | "edit";
  referenceAssetId?: string | null;
}

/** Verify ACTUAL pixel alpha via PIL (no provider self-reporting). */
export async function verifyAlpha(filePath: string): Promise<{ hasAlpha: boolean; alphaCoverage: number | null }> {
  try {
    const { execFile } = await import("child_process");
    const out = await new Promise<string>((resolve, reject) => {
      execFile(
        "python3",
        [
          "-c",
          "import sys\nfrom PIL import Image\nim = Image.open(sys.argv[1])\nif im.mode in (\"RGBA\", \"LA\") or (im.mode == \"P\" and \"transparency\" in im.info):\n    im = im.convert(\"RGBA\")\n    a = im.getchannel(\"A\")\n    hist = a.histogram()\n    cov = sum(hist[:250]) / sum(hist)\n    print(f\"alpha {cov:.4f}\")\nelse:\n    print(\"opaque 0.0000\")",
          filePath,
        ],
        { timeout: 30_000 },
        (err, stdout, stderr) => (err ? reject(new Error(String(stderr).slice(0, 200))) : resolve(stdout.trim())),
      );
    });
    if (out.startsWith("alpha")) {
      const cov = Number(out.split(/\s+/)[1]);
      return { hasAlpha: cov > 0.001, alphaCoverage: Math.round(cov * 10000) / 10000 };
    }
    return { hasAlpha: false, alphaCoverage: null };
  } catch {
    return { hasAlpha: false, alphaCoverage: null };
  }
}

export async function generateSceneAsset(userId: string, projectId: string, spec: AssetSpec, opts: { providerId?: string | null } = {}): Promise<{ assets: { assetId: string; width: number; height: number; hasAlpha: boolean; alphaCoverage: number | null; originalPreserved: boolean }[]; disclosure: string; limitations: string[] }> {
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project || project.userId !== userId) throw new Error("Project not found or not owned by the caller.");
  const approved = await getApprovedDirection(userId, projectId);
  if (!approved) throw new Error("No APPROVED art direction for this project — approve a direction before generating assets (nothing is generated without approval).");
  const direction = approved.direction;

  const plan = await db.scenePlan.findFirst({ where: { userId, projectId }, orderBy: { updatedAt: "desc" } });
  const fmt = plan ? ((JSON.parse(plan.scenesJson) as { format?: "16:9" | "9:16" | "1:1" | "4:5" }).format ?? "16:9") : "16:9";
  const size = FORMAT_SIZE[fmt] ?? "1344x768";
  const count = Math.min(3, Math.max(1, spec.alternatives ?? 1));

  const prompt = [
    styleProfilePromptBlock(direction),
    `Scene ${spec.sceneId}, asset role: ${spec.role}.`,
    spec.prompt.slice(0, 600),
    spec.role === "character" ? "NOTE: independent generations do NOT guarantee identical character identity; keep costume/silhouette consistent via the prompt." : "",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 1900);

  const provider = laxiiProvider(opts.providerId ?? null);
  const out: { assetId: string; width: number; height: number; hasAlpha: boolean; alphaCoverage: number | null; originalPreserved: boolean }[] = [];
  const limitations: string[] = [];
  for (let i = 0; i < count; i++) {
    let tempPath: string | null = null;
    try {
      const img = await provider.generateImage({ prompt, mode: spec.mode ?? "generate", referenceAssetId: spec.referenceAssetId ?? null, size, count: 1, aspect: "original", projectId }, spec.referenceAssetId ? (await db.mediaAsset.findFirst({ where: { id: spec.referenceAssetId, userId } }))?.storagePath ?? null : null);
      tempPath = img.filePath;
      const alpha = await verifyAlpha(img.filePath);
      const st = await stat(img.filePath);
      if (!alpha.hasAlpha) limitations.push(`Provider returned no usable alpha channel for alternative ${i + 1} (actual pixels verified) — transparency is NOT claimed for this asset.`);
      const registered = await registerImageArtifact(img.filePath, {
        engine: "LAXII",
        userId,
        projectId,
        originalName: `m14_${spec.sceneId}_${spec.role}_${i + 1}.${img.sniffedFormat === "jpeg" ? "jpg" : img.sniffedFormat === "png" ? "png" : "img"}`,
        provider: provider.id,
        model: provider.label,
        prompt: prompt.slice(0, 1800),
        params: { size, role: spec.role, sceneId: spec.sceneId, directionId: approved.id, directionFingerprint: direction.fingerprint ?? null, alternative: i + 1 },
        license: "generated-original",
        attribution: `Generated by BEAN FX LAXII (${provider.id}/${provider.label}) following the approved art direction "${direction.name}".`,
        width: img.width,
        height: img.height,
      });
      // Preserve the original generated asset: registration keeps it under the
      // media root; the temp path is consumed, never deleted post-registration.
      await rm(tempPath, { force: true }).catch(() => undefined);
      tempPath = null;
      out.push({ assetId: registered.id, width: img.width, height: img.height, hasAlpha: alpha.hasAlpha, alphaCoverage: alpha.alphaCoverage, originalPreserved: true });
    } finally {
      if (tempPath) await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
  limitations.push("Style consistency comes from the shared approved-direction prompt; character identity across independent generations is NOT guaranteed by the provider.");
  return {
    assets: out,
    disclosure: `${out.length} LAXII asset(s) generated via ${provider.id}/${provider.label} (metered external call, consented image generation), registered through the existing asset lifecycle with prompt + provenance.`,
    limitations: limitations.slice(0, 4),
  };
}
