import { NextRequest, NextResponse } from "next/server";
import { existsSync } from "fs";
import path from "path";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { enqueueMediaJob, JOB_TYPE_MEDIA_PROXY } from "@/lib/job-helpers";

/**
 * M28 P2 — proxy regeneration. The proxy pipeline (M3.3) is idempotent and
 * crash-safe, but nothing could RE-queue a FAILED proxy or repair a stale
 * READY reference whose file vanished (storage moved, partial cleanup). This
 * endpoint is the explicit, user-driven path: it repairs honest state first,
 * refuses duplicates, and never touches the original media.
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { id } = await ctx.params;

  const asset = await db.mediaAsset.findUnique({ where: { id } });
  if (!asset || asset.userId !== user.id) {
    return NextResponse.json({ error: "Media not found." }, { status: 404 });
  }
  if (asset.kind !== "VIDEO") {
    return NextResponse.json({ error: "Proxies apply only to video assets." }, { status: 400 });
  }

  // A READY status without its file is a stale reference — repair it honestly
  // before requeueing so the library never advertises an unplayable proxy.
  const stale = asset.proxyStatus === "READY" && (!asset.proxyPath || !existsSync(asset.proxyPath));
  if (stale) {
    await db.mediaAsset.update({
      where: { id: asset.id },
      data: { proxyStatus: "FAILED", proxyError: "Stale proxy reference — the proxy file is no longer on disk. Regenerate." },
    });
  }

  // Duplicate-processing prevention: one active proxy job per asset.
  const active = await db.job.findFirst({
    where: { userId: user.id, type: JOB_TYPE_MEDIA_PROXY, status: { in: ["QUEUED", "PROCESSING"] }, paramsJson: { contains: asset.id } },
    select: { id: true, status: true },
  });
  if (active) {
    return NextResponse.json({ error: "A proxy job is already queued or running.", jobId: active.id, proxyStatus: "QUEUED" }, { status: 409 });
  }

  await db.mediaAsset.update({ where: { id: asset.id }, data: { proxyStatus: "QUEUED", proxyError: null } });
  const jobId = await enqueueMediaJob(user.id, JOB_TYPE_MEDIA_PROXY, { mediaId: asset.id });
  return NextResponse.json({ ok: true, jobId, repairedStale: stale }, { status: 202 });
}
