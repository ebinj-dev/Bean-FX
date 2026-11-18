/**
 * GANGZII API — GET /api/gangzii/processes?mediaId=…
 * Persisted GANGZII operations (analyses + processing profiles) for one
 * media asset the caller owns, newest first. Enables reload/reopen: the
 * editor panel restores analyses and parameter sets from these rows.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, notFound, unauthorized } from "@/lib/process-helpers";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const mediaId = req.nextUrl.searchParams.get("mediaId") ?? "";
  const resultAssetId = req.nextUrl.searchParams.get("resultAssetId") ?? "";
  if (!mediaId && !resultAssetId) return badRequest("mediaId or resultAssetId required.");

  // resultAssetId lookup: resolve the ORIGINAL asset behind a derived one
  // (A/B bypass in the editor). Owner-only like every GANGZII surface.
  if (!mediaId) {
    const derived = await db.mediaAsset.findUnique({ where: { id: resultAssetId } });
    if (!derived || derived.userId !== user.id) return notFound();
    const row = await db.gangziiProcess.findFirst({
      where: { userId: user.id, resultAssetId },
      orderBy: { createdAt: "desc" },
      select: { id: true, sourceAssetId: true, name: true, status: true, kind: true },
    });
    return NextResponse.json({ ok: true, mediaId: row?.sourceAssetId ?? null, processes: [] });
  }

  const source = await db.mediaAsset.findUnique({ where: { id: mediaId } });
  if (!source || source.userId !== user.id) return notFound();

  const processes = await db.gangziiProcess.findMany({
    where: { userId: user.id, sourceAssetId: mediaId },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true, kind: true, status: true, name: true, paramsJson: true,
      analysisJson: true, resultAssetId: true, resultMetaJson: true,
      error: true, jobId: true, createdAt: true, updatedAt: true,
    },
  });
  return NextResponse.json({ ok: true, mediaId, processes });
}
