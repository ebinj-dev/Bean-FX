/**
 * M9 API — one export variant (§8: inspect / cancel).
 * GET    /api/publish/variants/[id]    status + validation + provenance
 * DELETE /api/publish/variants/[id]    cancel when queued/rendering (eligible only)
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, notFound, unauthorized } from "@/lib/process-helpers";
import { jobManager } from "@/lib/job-runner";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const v = await db.exportVariant.findUnique({ where: { id } });
  if (!v || v.userId !== user.id) return notFound();
  return NextResponse.json({
    variant: {
      id: v.id,
      projectId: v.projectId,
      profileId: v.profileId,
      profileVersion: v.profileVersion,
      profile: v.profileJson ? JSON.parse(v.profileJson) : null,
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
    },
  });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const v = await db.exportVariant.findUnique({ where: { id } });
  if (!v || v.userId !== user.id) return notFound();
  if (v.status === "COMPLETED" || v.status === "CANCELLED") {
    return badRequest(`Variant is already ${v.status}; nothing to cancel. Completed outputs are never deleted by this endpoint.`);
  }
  if (v.status === "FAILED") return badRequest("Variant already failed — use the retry endpoint.");
  const cancelled = v.jobId ? await jobManager.cancel(v.jobId, user.id) : false;
  // The job row AND the variant row must both land in CANCELLED: for an
  // actively-running job the handler's onSettled converges the same state.
  await db.exportVariant.updateMany({ where: { id, status: { in: ["QUEUED", "RENDERING"] } }, data: { status: "CANCELLED", stage: "Cancelled" } });
  void cancelled;
  await db.automationAudit
    .create({ data: { userId: user.id, projectId: v.projectId, action: "publish.variant.cancel", detailJson: JSON.stringify({ variantId: v.id }) } })
    .catch(() => undefined);
  return NextResponse.json({ ok: true });
}
