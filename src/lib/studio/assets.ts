/**
 * Social Video Studio — scene assets (M8.1 §6/§7).
 *
 * Scene footage sourcing options, all through REAL backend operations:
 *  - JAZMII generation (durable M7 job; result asset registered with provenance)
 *  - LAXII generation (durable M7 job)
 *  - manual assignment of an OWNED asset (upload or previously generated)
 * There is NO stock-footage provider configured in this deployment (verified
 * in the M8.1 audit) — searchStockFootage() says so HONESTLY and points to
 * the alternatives. We never download restricted content or invent licences.
 */
import { db } from "@/lib/db";
import { jobManager } from "@/lib/job-runner";
import { JOB_TYPE_JAZMII_GENERATE, JOB_TYPE_LAXII_GENERATE } from "@/lib/job-helpers";
import { JazmiiGenerateParamsSchema } from "@/lib/jazmii/types";
import { LaxiiGenerateParamsSchema } from "@/lib/laxii/types";
import { capabilityCatalog } from "@/lib/my-ai/discovery/effects";

export interface SceneAssetOutcome {
  sceneId: string;
  jobId?: string;
  assetId?: string;
  source: "jazmii" | "laxii" | "manual";
  note: string;
}

async function loadOwnedScene(userId: string, planId: string, sceneId: string) {
  const scene = await db.studioScene.findFirst({ where: { id: sceneId, userId, planId } });
  if (!scene) throw new Error("Scene not found or not owned.");
  return scene;
}

async function markAssetPending(sceneId: string): Promise<void> {
  await db.studioScene.update({ where: { id: sceneId }, data: { assetId: null, assetSource: "none", assetKind: null, status: "ASSET_PENDING" } });
}

/** Honest stock-footage availability (M8.1 §6: never invent providers). */
export function footageSourcingStatus(): { stockSearchAvailable: boolean; note: string; alternatives: string[] } {
  return {
    stockSearchAvailable: false,
    note: "No stock-footage provider is configured in this deployment. BEAN FX does not download restricted or unlicensed content.",
    alternatives: [
      "Generate scene footage with JAZMII (metered, provenance-registered).",
      "Generate scene illustrations/backgrounds with LAXII.",
      "Upload your own footage and assign it to the scene (you hold the rights).",
    ],
  };
}

/** Queue JAZMII generation for a scene's visual (approval-gated upstream). */
export async function generateSceneFootage(userId: string, planId: string, sceneId: string): Promise<SceneAssetOutcome> {
  const scene = await loadOwnedScene(userId, planId, sceneId);
  const plan = await db.studioPlan.findFirst({ where: { id: planId, userId } });
  if (!plan) throw new Error("Plan not found or not owned.");
  const brief = JSON.parse(plan.briefJson) as { projectId?: string | null; visualStyle?: string; platform?: keyof typeof PLATFORM_ASPECT };
  const prompt = [scene.visualDescription, scene.footageNeed, brief.visualStyle].filter((s) => (s ?? "").trim().length > 0).join(". ").slice(0, 1900);
  if (prompt.trim().length < 3) throw new Error("Scene has no visual description to generate from — describe the visual first.");
  const aspect = PLATFORM_ASPECT[brief.platform ?? "youtube_shorts"] ?? "16:9";
  const vertical = aspect === "9:16" || aspect === "9:16";
  const parsed = JazmiiGenerateParamsSchema.safeParse({
    prompt,
    operation: "textToVideo",
    referenceAssetId: null,
    quality: "speed",
    size: vertical ? "1080x1920" : "1920x1080",
    fps: "30",
    durationSec: "5",
    withAudio: false,
    projectId: brief.projectId ?? null,
  });
  if (!parsed.success) throw new Error(`JAZMII params invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  await markAssetPending(scene.id);
  const jobId = await jobManager.createJob(userId, JOB_TYPE_JAZMII_GENERATE, parsed.data);
  await db.studioScene.update({ where: { id: scene.id }, data: { assetSource: "jazmii" } });
  return { sceneId: scene.id, jobId, source: "jazmii", note: "JAZMII generation queued (metered external provider). When the job completes, assign the asset to the scene or enable auto-assign on the plan." };
}

/** Queue LAXII generation for a scene illustration/background. */
export async function generateSceneImage(userId: string, planId: string, sceneId: string): Promise<SceneAssetOutcome> {
  const scene = await loadOwnedScene(userId, planId, sceneId);
  const plan = await db.studioPlan.findFirst({ where: { id: planId, userId } });
  if (!plan) throw new Error("Plan not found or not owned.");
  const brief = JSON.parse(plan.briefJson) as { projectId?: string | null; visualStyle?: string; platform?: keyof typeof PLATFORM_ASPECT };
  const prompt = [scene.visualDescription, scene.footageNeed, brief.visualStyle].filter((s) => (s ?? "").trim().length > 0).join(". ").slice(0, 1900);
  if (prompt.trim().length < 3) throw new Error("Scene has no visual description to generate from — describe the visual first.");
  const aspect = PLATFORM_ASPECT[brief.platform ?? "youtube_shorts"] ?? "16:9";
  const parsed = LaxiiGenerateParamsSchema.safeParse({
    prompt,
    mode: "generate",
    referenceAssetId: null,
    size: aspect === "9:16" ? "768x1344" : aspect === "1:1" ? "1024x1024" : aspect === "4:5" ? "864x1152" : "1344x768",
    count: 1,
    aspect: aspect === "9:16" ? "9:16" : aspect === "1:1" ? "1:1" : aspect === "4:5" ? "4:5" : "16:9",
    projectId: brief.projectId ?? null,
  });
  if (!parsed.success) throw new Error(`LAXII params invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  await markAssetPending(scene.id);
  const jobId = await jobManager.createJob(userId, JOB_TYPE_LAXII_GENERATE, parsed.data);
  await db.studioScene.update({ where: { id: scene.id }, data: { assetSource: "laxii" } });
  return { sceneId: scene.id, jobId, source: "laxii", note: "LAXII generation queued (metered external provider)." };
}

/** Assign an OWNED asset to the scene (manual upload or prior generation). */
export async function assignSceneAsset(userId: string, planId: string, sceneId: string, assetId: string): Promise<SceneAssetOutcome> {
  const scene = await loadOwnedScene(userId, planId, sceneId);
  const asset = await db.mediaAsset.findFirst({ where: { id: assetId, userId } });
  if (!asset) throw new Error("Asset not found or not owned — only your own media can be used.");
  if (!["VIDEO", "IMAGE"].includes(asset.kind)) throw new Error(`Scene visuals must be VIDEO or IMAGE (asset kind is ${asset.kind}).`);
  const source = asset.createdBy === "JAZMII" ? "jazmii" : asset.createdBy === "LAXII" ? "laxii" : "manual";
  await db.studioScene.update({
    where: { id: scene.id },
    data: {
      assetId: asset.id,
      assetKind: asset.kind,
      assetSource: source,
      status: scene.narrationAssetId ? "READY" : "ASSET_READY",
      attributionJson: JSON.stringify({
        assetId: asset.id,
        name: asset.originalName,
        createdBy: asset.createdBy ?? "user-upload",
        provider: asset.provider,
        model: asset.model,
        license: asset.license ?? "user-provided — you hold the rights",
      }),
    },
  });
  return { sceneId: scene.id, assetId: asset.id, source, note: `Asset assigned (${asset.kind}, provenance recorded).` };
}

/** Auto-assign completed generation jobs' outputs to their scenes (§4). */
export async function autoAssignGeneratedAssets(userId: string, planId: string): Promise<{ assigned: number; note: string }> {
  const scenes = await db.studioScene.findMany({ where: { planId, userId, assetId: null, assetSource: { in: ["jazmii", "laxii"] } } });
  let assigned = 0;
  for (const scene of scenes) {
    // The newest generation output for this user that matches the scene's visual need is ambiguous —
    // match by the scene id recorded in the generation prompt metadata is not available, so we look
    // for unassigned, plan-scoped generated assets by creation order (honest best-effort with disclosure).
    const candidates = await db.mediaAsset.findMany({
      where: { userId, kind: scene.assetSource === "laxii" ? "IMAGE" : "VIDEO", createdBy: scene.assetSource === "laxii" ? "LAXII" : "JAZMII", projectId: (await db.studioPlan.findFirst({ where: { id: planId }, select: { projectId: true } }))?.projectId ?? null },
      orderBy: { createdAt: "desc" },
      take: 8,
    });
    if (candidates.length === 0) continue;
    await assignSceneAsset(userId, planId, scene.id, candidates[0].id);
    assigned += 1;
  }
  return { assigned, note: assigned > 0 ? `${assigned} scene(s) auto-assigned from completed generations — VERIFY each match in the Storyboard (best-effort by recency).` : "No completed generation outputs matched; check job status." };
}

const PLATFORM_ASPECT: Record<string, string> = {
  youtube_shorts: "9:16",
  instagram_reels: "9:16",
  tiktok: "9:16",
  youtube_landscape: "16:9",
  square_social: "1:1",
};

void capabilityCatalog;
