/**
 * M9 API — retry a failed export variant (§8).
 * POST /api/publish/variants/[id]/retry — FAILED/QUEUED→ new durable job,
 * same variant row (attempts accumulate; history preserved).
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, notFound, unauthorized } from "@/lib/process-helpers";
import { enqueueMediaJob, JOB_TYPE_EXPORT_VARIANT } from "@/lib/job-helpers";

export const runtime = "nodejs";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const v = await db.exportVariant.findUnique({ where: { id } });
  if (!v || v.userId !== user.id) return notFound();
  if (v.status === "RENDERING") return badRequest("Variant is currently rendering — cancel it first if needed.");
  if (v.status === "COMPLETED") return badRequest("Variant already completed — download the existing output instead of re-rendering.");
  if (v.status === "CANCELLED") return badRequest("Variant was cancelled — create a new variant instead of retrying a cancelled one.");

  const jobId = await enqueueMediaJob(user.id, JOB_TYPE_EXPORT_VARIANT, { variantId: v.id });
  await db.exportVariant.update({ where: { id }, data: { status: "QUEUED", stage: "Queued (retry)", error: null, jobId } });
  await db.automationAudit
    .create({ data: { userId: user.id, projectId: v.projectId, action: "publish.variant.retry", detailJson: JSON.stringify({ variantId: v.id, jobId }) } })
    .catch(() => undefined);
  return NextResponse.json({ ok: true, jobId }, { status: 202 });
}
