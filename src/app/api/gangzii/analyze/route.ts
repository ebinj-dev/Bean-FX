/**
 * GANGZII API — POST /api/gangzii/analyze
 *
 * Queues a durable GANGZII_ANALYZE job for a media asset the caller owns.
 * The handler stream-decodes the audio and stores the structured inspection
 * (BS.1770 loudness, true peak, clipping, spectrum, speech/music heuristic,
 * silence, noise floor, waveform) on the GangziiProcess row. Long media is
 * NEVER analyzed inside this HTTP handler.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, notFound, unauthorized } from "@/lib/process-helpers";
import { getOwnedMedia } from "@/lib/process-helpers";
import { jobManager } from "@/lib/job-runner";
import { JOB_TYPE_GANGZII_ANALYZE } from "@/lib/job-helpers";

const Schema = z.object({ mediaId: z.string().min(1).max(64) });

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("Invalid request: mediaId required.");
  const media = await getOwnedMedia(parsed.data.mediaId, user);
  if (!media) return notFound();
  if (!media.hasAudio) return badRequest("This media has no audio stream.");

  const row = await db.gangziiProcess.create({
    data: {
      userId: user.id,
      sourceAssetId: media.id,
      kind: "ANALYSIS",
      status: "QUEUED",
      name: null,
    },
  });
  const jobId = await jobManager.createJob(user.id, JOB_TYPE_GANGZII_ANALYZE, { processId: row.id });
  await db.gangziiProcess.update({ where: { id: row.id }, data: { jobId } });
  return NextResponse.json({ processId: row.id, jobId });
}
