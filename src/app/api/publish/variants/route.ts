/**
 * M9 API — export variants (§6/§8).
 * GET  /api/publish/variants[?projectId=&status=]   export history (§8)
 * POST /api/publish/variants                        create variant: {profileId, sourceExportId?|sourceAssetId?, projectId?}
 *      Pre-flights the master (real ffprobe + profile validation), then
 *      enqueues a durable EXPORT_VARIANT job on the EXISTING worker.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, notFound, unauthorized } from "@/lib/process-helpers";
import { enqueueMediaJob, JOB_TYPE_EXPORT_VARIANT } from "@/lib/job-helpers";
import { getExportProfile, exportProfileRegistry, validateVariantTarget } from "@/lib/publish/profiles";
import { probeMaster } from "@/lib/publish/variants";

export const runtime = "nodejs";

const CreateSchema = z
  .object({
    profileId: z.string().min(2).max(40),
    projectId: z.string().max(64).nullable().default(null),
    sourceExportId: z.string().max(64).nullable().default(null),
    sourceAssetId: z.string().max(64).nullable().default(null),
  })
  .strict()
  .refine((v) => Boolean(v.sourceExportId) !== Boolean(v.sourceAssetId), "Provide exactly one source: sourceExportId (a completed render) or sourceAssetId (an owned video).");

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const params = new URL(req.url).searchParams;
  const projectId = params.get("projectId");
  const status = params.get("status");
  const rows = await db.exportVariant.findMany({
    where: { userId: user.id, ...(projectId ? { projectId } : {}), ...(status ? { status } : {}) },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return NextResponse.json({
    variants: rows.map((v) => ({
      id: v.id,
      projectId: v.projectId,
      profileId: v.profileId,
      profileVersion: v.profileVersion,
      status: v.status,
      progress: v.progress,
      stage: v.stage,
      sourceExportId: v.sourceExportId,
      sourceAssetId: v.sourceAssetId,
      resultExportId: v.resultExportId,
      validation: v.validationJson ? JSON.parse(v.validationJson) : null,
      error: v.error,
      attempts: v.attempts,
      jobId: v.jobId,
      createdAt: v.createdAt.toISOString(),
      updatedAt: v.updatedAt.toISOString(),
    })),
  });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const parsed = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const { profileId, projectId, sourceExportId, sourceAssetId } = parsed.data;

  const profile = getExportProfile(profileId);
  if (!profile) {
    return badRequest(`Unknown export profile "${profileId}". Available: ${Object.keys(exportProfileRegistry().profiles).join(", ")}.`);
  }
  if (projectId) {
    const project = await db.project.findUnique({ where: { id: projectId } });
    if (!project || project.userId !== user.id) return notFound();
  }

  let sourcePath: string | null = null;
  if (sourceExportId) {
    const ex = await db.exportFile.findUnique({ where: { id: sourceExportId } });
    if (!ex || ex.userId !== user.id || ex.kind !== "VIDEO") return badRequest("Source export not found, not owned by the caller, or not a video.");
    sourcePath = ex.storagePath;
  } else if (sourceAssetId) {
    const asset = await db.mediaAsset.findUnique({ where: { id: sourceAssetId } });
    if (!asset || asset.userId !== user.id || asset.kind !== "VIDEO") return badRequest("Source asset not found, not owned by the caller, or not a video.");
    sourcePath = asset.storagePath;
  }

  // Pre-flight with REAL measurements (§6: validate before encoding). The
  // worker re-validates — this gives the caller an immediate, honest 400.
  let master;
  try {
    master = await probeMaster(sourcePath as string);
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : "Master inspection failed.");
  }
  const target = validateVariantTarget(profile, master.durationSec, master.width, master.height);
  if (!target.ok) {
    return NextResponse.json({ error: "Master does not conform to this profile.", failures: target.failures }, { status: 422 });
  }

  const variant = await db.exportVariant.create({
    data: {
      userId: user.id,
      projectId,
      profileId: profile.id,
      profileVersion: exportProfileRegistry().version,
      profileJson: JSON.stringify(profile),
      status: "QUEUED",
      stage: "Queued",
      sourceExportId,
      sourceAssetId,
    },
  });
  const jobId = await enqueueMediaJob(user.id, JOB_TYPE_EXPORT_VARIANT, { variantId: variant.id });
  await db.exportVariant.update({ where: { id: variant.id }, data: { jobId } });
  await db.automationAudit
    .create({ data: { userId: user.id, projectId, action: "publish.variant.create", detailJson: JSON.stringify({ variantId: variant.id, profileId: profile.id, sourceExportId, sourceAssetId }) } })
    .catch(() => undefined);
  return NextResponse.json({ variantId: variant.id, jobId }, { status: 202 });
}
