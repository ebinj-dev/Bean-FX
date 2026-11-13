/**
 * GANGZII API — POST /api/gangzii/proposal   (MY AI interface, M5 §6)
 *
 * Maps a natural-language instruction to a structured, zod-validated
 * proposal via the DETERMINISTIC intent table (no LLM inside GANGZII).
 * The proposal is returned, never executed — the caller applies it through
 * POST /api/gangzii/process, which re-validates every parameter.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, getOwnedMedia, notFound, unauthorized } from "@/lib/process-helpers";
import { proposeGangzii } from "@/lib/gangzii/proposal";
import { GangziiInspectionSchema, type GangziiInspection } from "@/lib/gangzii/types";

const Schema = z.object({
  mediaId: z.string().min(1).max(64),
  instruction: z.string().min(1).max(500),
});

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("Invalid request: mediaId and instruction required.");
  const media = await getOwnedMedia(parsed.data.mediaId, user);
  if (!media) return notFound();
  if (!media.hasAudio) return badRequest("This media has no audio stream.");

  // Feed the latest completed inspection so proposals can use measured facts
  // (noise floor, hum detection, balance gains).
  const latest = await db.gangziiProcess.findFirst({
    where: { userId: user.id, sourceAssetId: media.id, kind: "ANALYSIS", status: "COMPLETED" },
    orderBy: { createdAt: "desc" },
  });
  let inspection: GangziiInspection | null = null;
  if (latest?.analysisJson) {
    const check = GangziiInspectionSchema.safeParse(JSON.parse(latest.analysisJson));
    if (check.success) inspection = check.data;
  }

  const proposal = proposeGangzii(parsed.data.instruction, inspection);
  if (!proposal) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "No GANGZII intent matched that instruction. Supported examples: clean background noise, remove the electrical hum, make the voice clearer, normalize the audio, duck the background music, fix channel balance, repair clicks.",
      },
      { status: 422 },
    );
  }
  return NextResponse.json({ ok: true, proposal });
}
