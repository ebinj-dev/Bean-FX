/**
 * NIIKI API — POST /api/nikki/render
 *
 * Queues a durable NIKKI_RENDER job from a VALIDATED sequence snapshot
 * (parseSequence — the same zod schema that guards stored timelines). The
 * render plan is built server-side (render.ts); clients cannot submit
 * FFmpeg arguments. Every referenced source asset is ownership-checked and
 * its media path embedded by THIS route, never by the client.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, notFound, unauthorized } from "@/lib/process-helpers";
import { jobManager } from "@/lib/job-runner";
import { JOB_TYPE_NIKKI_RENDER } from "@/lib/job-helpers";
import { parseSequence } from "@/lib/editor/model";

const Schema = z.object({
  sequence: z.unknown(),
  sourceAssetId: z.string().max(64).nullable().default(null),
  startFrame: z.number().int().min(0).optional(),
  endFrame: z.number().int().min(1).optional(),
});

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);

  // The snapshot must be a structurally valid sequence (same schema as storage).
  let seq;
  try {
    seq = parseSequence(parsed.data.sequence);
  } catch (err) {
    return badRequest(`Invalid sequence snapshot: ${err instanceof Error ? err.message : "validation failed"}`);
  }
  if (seq.clips.length === 0) return badRequest("Nothing to render: the sequence has no clips.");

  const assetPaths: Record<string, string> = {};
  const videoAssetIds = new Set<string>(
    seq.clips
      .filter((c) => !c.missingMedia && c.sourceAssetId && seq.tracks.find((t) => t.id === c.trackId)?.kind === "VIDEO")
      .map((c) => c.sourceAssetId as string),
  );
  if (parsed.data.sourceAssetId) videoAssetIds.add(parsed.data.sourceAssetId);
  if (parsed.data.sourceAssetId) {
    const src = await db.mediaAsset.findUnique({ where: { id: parsed.data.sourceAssetId } });
    if (!src || src.userId !== user.id) return notFound();
    assetPaths[parsed.data.sourceAssetId] = src.storagePath;
  }
  for (const assetId of videoAssetIds) {
    if (assetPaths[assetId]) continue;
    const asset = await db.mediaAsset.findUnique({ where: { id: assetId } });
    if (!asset || asset.userId !== user.id) return notFound(); // foreign media in the snapshot → refuse
    assetPaths[assetId] = asset.storagePath;
  }

  const jobId = await jobManager.createJob(user.id, JOB_TYPE_NIKKI_RENDER, {
    sequence: seq,
    sourceAssetId: parsed.data.sourceAssetId,
    startFrame: parsed.data.startFrame,
    endFrame: parsed.data.endFrame,
    assetPaths,
  });
  return NextResponse.json({ jobId });
}
