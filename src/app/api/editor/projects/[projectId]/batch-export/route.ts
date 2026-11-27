/**
 * M26 P5 — batch export: fan a rendered master out to multiple social
 * profiles in one call. Reuses the REAL ExportVariant pipeline (probe →
 * variant rows → EXPORT_VARIANT jobs on the M3 worker). Idempotent: a
 * profile that already has a QUEUED/RENDERING/COMPLETED variant for the
 * same master returns the existing row instead of submitting a duplicate
 * job (refresh/retry safe). Plan entitlements (M25) are respected by the
 * underlying render/variant jobs.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { unauthorized, badRequest } from "@/lib/process-helpers";
import { getExportProfile, exportProfileRegistry } from "@/lib/publish/profiles";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

const BatchSchema = z.object({
  sourceExportId: z.string().min(1),
  profileIds: z.array(z.string().min(1).max(60)).min(1).max(8),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ projectId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { projectId } = await ctx.params;
  const parsed = BatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("sourceExportId and profileIds required (max 8).");
  const { sourceExportId, profileIds } = parsed.data;

  const project = await db.project.findFirst({ where: { id: projectId, userId: user.id } });
  if (!project) return badRequest("Project not found or not owned by the caller.");
  // M48-B bugfix — timeline renders register kind TIMELINE_RENDER (legacy MEDIA
  // exports are kind VIDEO); both are legitimate masters for aspect variants.
  const master = await db.exportFile.findFirst({ where: { id: sourceExportId, userId: user.id, kind: { in: ["VIDEO", "TIMELINE_RENDER"] } } });
  if (!master) return badRequest("Master export not found (render the timeline first — kind VIDEO or TIMELINE_RENDER).");

  const created: Array<{ profileId: string; variantId: string; reused: boolean; status: string }> = [];
  const rejected: Array<{ profileId: string; reason: string }> = [];
  for (const profileId of [...new Set(profileIds)]) {
    const profile = getExportProfile(profileId);
    if (!profile) {
      rejected.push({ profileId, reason: `unknown profile (available: ${Object.keys(exportProfileRegistry().profiles).join(", ")})` });
      continue;
    }
    // Idempotency: one active variant per (master, profile).
    const existing = await db.exportVariant.findFirst({
      where: { userId: user.id, profileId, sourceExportId: master.id, status: { in: ["QUEUED", "RENDERING", "COMPLETED"] } },
      select: { id: true, status: true },
    });
    if (existing) {
      created.push({ profileId, variantId: existing.id, reused: true, status: existing.status });
      continue;
    }
    // Create the variant the same way /api/publish/variants does (measured
    // probe happens again inside the worker — the row stores the profile).
    const variant = await db.exportVariant.create({
      data: {
        userId: user.id,
        projectId,
        profileId,
        profileVersion: String((profile as unknown as { version?: number }).version ?? 1),
        profileJson: JSON.stringify(profile),
        status: "QUEUED",
        sourceExportId: master.id,
      },
      select: { id: true, status: true },
    });
    // Dispatch through the existing job queue.
    const { enqueueMediaJob, JOB_TYPE_EXPORT_VARIANT } = await import("@/lib/job-helpers");
    await enqueueMediaJob(user.id, JOB_TYPE_EXPORT_VARIANT, { variantId: variant.id });
    created.push({ profileId, variantId: variant.id, reused: false, status: variant.status });
  }
  await audit("batch.export", { userId: user.id, detail: JSON.stringify({ projectId, master: master.id, profiles: created.map((c) => c.profileId), rejected: rejected.length }) });
  return NextResponse.json({ batch: created, rejected, master: { id: master.id, filename: master.filename } });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ projectId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { projectId } = await ctx.params;
  const project = await db.project.findFirst({ where: { id: projectId, userId: user.id } });
  if (!project) return badRequest("Project not found.");
  const masters = await db.exportFile.findMany({
    where: { userId: user.id, kind: { in: ["VIDEO", "TIMELINE_RENDER"] }, paramsJson: { contains: projectId } },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { id: true, filename: true, createdAt: true, sizeBytes: true, durationSec: true },
  });
  const variants = await db.exportVariant.findMany({
    where: { userId: user.id, projectId },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, profileId: true, status: true, progress: true, stage: true, sourceExportId: true, createdAt: true, error: true },
  });
  return NextResponse.json({ masters, variants });
}
