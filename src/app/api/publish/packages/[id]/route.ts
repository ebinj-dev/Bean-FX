/**
 * M9 API — one publication package (§7).
 * GET    /api/publish/packages/[id]    manifest + status
 * DELETE /api/publish/packages/[id]    delete package row + zip (variants untouched)
 */
import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { notFound, unauthorized } from "@/lib/process-helpers";
import { MEDIA_ROOT } from "@/lib/media-storage";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const pkg = await db.publishPackage.findUnique({ where: { id } });
  if (!pkg || pkg.userId !== user.id) return notFound();
  return NextResponse.json({
    package: {
      id: pkg.id,
      projectId: pkg.projectId,
      status: pkg.status,
      variantIds: JSON.parse(pkg.variantIdsJson) as string[],
      metadataId: pkg.metadataId,
      thumbnailDraftId: pkg.thumbnailDraftId,
      manifest: pkg.manifestJson ? JSON.parse(pkg.manifestJson) : null,
      manifestSha256: pkg.manifestSha256,
      sizeBytes: pkg.sizeBytes,
      error: pkg.error,
      jobId: pkg.jobId,
      createdAt: pkg.createdAt.toISOString(),
    },
  });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const pkg = await db.publishPackage.findUnique({ where: { id } });
  if (!pkg || pkg.userId !== user.id) return notFound();
  await db.publishPackage.delete({ where: { id } });
  if (pkg.storagePath && pkg.storagePath.startsWith(MEDIA_ROOT)) {
    await fs.unlink(pkg.storagePath).catch(() => undefined);
  }
  return NextResponse.json({ ok: true });
}
