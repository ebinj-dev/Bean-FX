/**
 * M45 Unit B — NIIKI VFX stabilization entry point.
 *
 * POST /api/media/[id]/stabilize → queues a durable MEDIA_STABILIZE job for
 * an owned, probed VIDEO asset. Two-pass libvidstab runs in the existing
 * media worker; the stabilized derivative is registered with provenance and
 * appears in the media library. The response is a QUEUED job id — progress
 * polls through the EXISTING /api/jobs/[id] surface. Honest 4xx for assets
 * that cannot be stabilized (not probed, not video).
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { enqueueMediaJob, JOB_TYPE_MEDIA_STABILIZE } from "@/lib/job-helpers";

export const runtime = "nodejs";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { id } = await ctx.params;

  const asset = await db.mediaAsset.findUnique({ where: { id }, select: { userId: true, kind: true, probeStatus: true, originalName: true } });
  if (!asset || asset.userId !== user.id) {
    return NextResponse.json({ error: "Media asset not found." }, { status: 404 });
  }
  if (asset.kind !== "VIDEO") {
    return NextResponse.json({ error: "Stabilization applies only to video assets." }, { status: 400 });
  }
  if (asset.probeStatus !== "READY") {
    return NextResponse.json({ error: "Probe the media before stabilizing it (probeStatus must be READY)." }, { status: 409 });
  }

  const jobId = await enqueueMediaJob(user.id, JOB_TYPE_MEDIA_STABILIZE, { mediaId: id });
  return NextResponse.json({ jobId, status: "QUEUED", message: `Stabilization queued for ${asset.originalName} — progress under jobs/${jobId}.` });
}
