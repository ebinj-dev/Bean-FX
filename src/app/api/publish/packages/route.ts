/**
 * M9 API — publication packages (§7).
 * GET  /api/publish/packages[?projectId=]   list packages
 * POST /api/publish/packages                create + enqueue durable PUBLISH_PACKAGE job
 *      {variantIds[], metadataId?, thumbnailDraftId?, projectId?}
 *      Only COMPLETED variants and APPROVED metadata are packaged.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/process-helpers";
import { enqueueMediaJob, JOB_TYPE_PUBLISH_PACKAGE } from "@/lib/job-helpers";

export const runtime = "nodejs";

const CreateSchema = z
  .object({
    variantIds: z.array(z.string().max(64)).min(1).max(10),
    projectId: z.string().max(64).nullable().default(null),
    metadataId: z.string().max(64).nullable().default(null),
    thumbnailDraftId: z.string().max(64).nullable().default(null),
  })
  .strict();

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const projectId = new URL(req.url).searchParams.get("projectId");
  const rows = await db.publishPackage.findMany({
    where: { userId: user.id, ...(projectId ? { projectId } : {}) },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({
    packages: rows.map((p) => ({
      id: p.id,
      projectId: p.projectId,
      status: p.status,
      variantIds: JSON.parse(p.variantIdsJson) as string[],
      metadataId: p.metadataId,
      thumbnailDraftId: p.thumbnailDraftId,
      manifestSha256: p.manifestSha256,
      sizeBytes: p.sizeBytes,
      error: p.error,
      jobId: p.jobId,
      createdAt: p.createdAt.toISOString(),
    })),
  });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const parsed = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const { variantIds, projectId, metadataId, thumbnailDraftId } = parsed.data;

  if (projectId) {
    const project = await db.project.findUnique({ where: { id: projectId } });
    if (!project || project.userId !== user.id) return badRequest("Project not found or not owned by the caller.");
  }
  const variants = await db.exportVariant.findMany({ where: { id: { in: variantIds }, userId: user.id } });
  if (variants.length !== variantIds.length) return badRequest("One or more variants were not found for this caller.");
  const notReady = variants.filter((v) => v.status !== "COMPLETED");
  if (notReady.length) return badRequest(`All variants must be COMPLETED before packaging (not ready: ${notReady.map((v) => `${v.id}:${v.status}`).join(", ")}).`);
  if (metadataId) {
    const meta = await db.publishMetadata.findUnique({ where: { id: metadataId } });
    if (!meta || meta.userId !== user.id) return badRequest("Metadata row not found or not owned by the caller.");
    if (meta.status !== "APPROVED") return badRequest("Metadata must be APPROVED before packaging — AI suggestions are never packaged.");
  }
  if (thumbnailDraftId) {
    const draft = await db.thumbnailDraft.findUnique({ where: { id: thumbnailDraftId } });
    if (!draft || draft.userId !== user.id) return badRequest("Thumbnail draft not found or not owned by the caller.");
    if (!draft.compositedAssetId && !draft.selectedAssetId) return badRequest("Thumbnail draft has no selected/composited image yet.");
  }

  const pkg = await db.publishPackage.create({
    data: {
      userId: user.id,
      projectId,
      status: "BUILDING",
      variantIdsJson: JSON.stringify(variantIds),
      metadataId,
      thumbnailDraftId,
    },
  });
  const jobId = await enqueueMediaJob(user.id, JOB_TYPE_PUBLISH_PACKAGE, { packageId: pkg.id });
  await db.publishPackage.update({ where: { id: pkg.id }, data: { jobId } });
  await db.automationAudit
    .create({ data: { userId: user.id, projectId, action: "publish.package.create", detailJson: JSON.stringify({ packageId: pkg.id, variantIds }) } })
    .catch(() => undefined);
  return NextResponse.json({ packageId: pkg.id, jobId }, { status: 202 });
}
