/**
 * GANGZII API — GET/DELETE /api/gangzii/process/[id]
 *
 * GET: one process row (owner-only) — the polling surface for job progress
 *      plus the stored result (params, inspection, derived asset, notes).
 * DELETE: cancels a running job (via the Job row, which the worker observes),
 *      removes the DERIVED asset row + file when present, and deletes the
 *      process row. The ORIGINAL media is never touched.
 */
import { NextResponse } from "next/server";
import { rm } from "fs/promises";
import { db } from "@/lib/db";
import { jobManager } from "@/lib/job-runner";
import { getCurrentUser } from "@/lib/auth";
import { notFound, unauthorized } from "@/lib/process-helpers";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const row = await db.gangziiProcess.findUnique({ where: { id } });
  if (!row || row.userId !== user.id) return notFound();
  const job = row.jobId ? await db.job.findUnique({ where: { id: row.jobId } }) : null;
  return NextResponse.json({
    ok: true,
    process: {
      id: row.id, kind: row.kind, status: row.status, name: row.name,
      paramsJson: row.paramsJson, analysisJson: row.analysisJson,
      resultAssetId: row.resultAssetId, resultMetaJson: row.resultMetaJson,
      error: row.error, createdAt: row.createdAt, updatedAt: row.updatedAt,
    },
    job: job ? { id: job.id, status: job.status, progress: job.progress, stage: job.stage, message: job.message } : null,
  });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const row = await db.gangziiProcess.findUnique({ where: { id } });
  if (!row || row.userId !== user.id) return notFound();

  // Cancel the backing job if it is still in flight (worker + JobManager
  // observe the row; the ffmpeg child is killed through the JobManager map).
  if (row.jobId) {
    const job = await db.job.findUnique({ where: { id: row.jobId } });
    if (job && (job.status === "QUEUED" || job.status === "PROCESSING")) {
      await db.job
        .update({ where: { id: job.id }, data: { status: "CANCELLED", stage: "Cancelled", message: "Cancelled by user." } })
        .catch(() => undefined);
      if (job.status === "PROCESSING") jobManager.cancel(job.id, user.id).catch(() => undefined);
      else {
        // A QUEUED job is never claimed, so the worker's onSettled hook never
        // runs — sync the process row here.
        await db.gangziiProcess
          .update({ where: { id: row.id }, data: { status: "CANCELLED", error: "Cancelled by user." } })
          .catch(() => undefined);
      }
    }
  }

  // Remove the derived asset (row + file) — the original stays intact.
  if (row.resultAssetId) {
    const derived = await db.mediaAsset.findUnique({ where: { id: row.resultAssetId } });
    if (derived && derived.userId === user.id) {
      if (derived.storagePath && derived.storagePath.includes("/derived/")) {
        await rm(derived.storagePath, { force: true }).catch(() => undefined);
      }
      await db.mediaAsset.delete({ where: { id: derived.id } }).catch(() => undefined);
    }
  }
  await db.gangziiProcess.delete({ where: { id: row.id } }).catch(() => undefined);
  return NextResponse.json({ ok: true });
}
