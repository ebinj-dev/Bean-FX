/**
 * M7 — GET /api/media/list?kind=IMAGE|VIDEO|AUDIO
 * Owner-scoped asset list for pickers (e.g. the LAXII reference-image
 * select). Minimal fields; ownership enforced by the session user.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { unauthorized } from "@/lib/process-helpers";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const kind = req.nextUrl.searchParams.get("kind");
  const assets = await db.mediaAsset.findMany({
    where: { userId: user.id, ...(kind && ["IMAGE", "VIDEO", "AUDIO", "SUBTITLE"].includes(kind) ? { kind } : {}) },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, originalName: true, kind: true, mimeType: true, sizeBytes: true, width: true, height: true, durationSec: true, fps: true, rotation: true, channels: true, sampleRate: true, videoCodec: true, createdAt: true },
  });
  return NextResponse.json({ assets });
}
