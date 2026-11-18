/**
 * MY AI API — GET /api/ai/outputs?engine=JAZMII|LAXII  (M7 §11)
 * Lists the caller's generated assets with provenance (prompt, provider,
 * model, attribution, reference). Owner-scoped by the session user.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { unauthorized } from "@/lib/process-helpers";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const engine = req.nextUrl.searchParams.get("engine") === "JAZMII" ? "JAZMII" : "LAXII";
  const assets = await db.mediaAsset.findMany({
    where: { userId: user.id, createdBy: engine },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true, originalName: true, kind: true, mimeType: true, sizeBytes: true,
      durationSec: true, width: true, height: true, createdAt: true,
      provider: true, model: true, prompt: true, attribution: true, referenceAssetId: true, role: true,
    },
  });
  return NextResponse.json({ assets });
}
