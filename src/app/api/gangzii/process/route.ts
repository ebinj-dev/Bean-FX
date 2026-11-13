/**
 * GANGZII API — POST /api/gangzii/process
 *
 * Queues a durable GANGZII_PROCESS job: validates the parameter object with
 * the strict GangziiParams schema (clients cannot send FFmpeg arguments),
 * snapshots the latest completed inspection for measured-loudness targets,
 * and returns {processId, jobId}. The original asset is never modified — the
 * worker writes a derived copy.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, getOwnedMedia, notFound, unauthorized } from "@/lib/process-helpers";
import { jobManager } from "@/lib/job-runner";
import { JOB_TYPE_GANGZII_PROCESS } from "@/lib/job-helpers";
import { parseGangziiParams } from "@/lib/gangzii/dsp";
import { GangziiInspectionSchema } from "@/lib/gangzii/types";

const Schema = z.object({
  sourceAssetId: z.string().min(1).max(64),
  params: z.unknown(),
  name: z.string().min(1).max(80).optional(),
});

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const media = await getOwnedMedia(parsed.data.sourceAssetId, user);
  if (!media) return notFound();
  if (!media.hasAudio) return badRequest("This media has no audio stream.");

  // Strict parameter validation — the ONLY accepted input surface.
  let params;
  try {
    params = parseGangziiParams(parsed.data.params);
  } catch (err) {
    return badRequest(`Invalid GANGZII parameters: ${err instanceof Error ? err.message : "validation failed"}`);
  }

  // Snapshot the latest completed inspection (measured LUFS/TP for static
  // gain targets); its absence is honest — the job warns instead of guessing.
  const latestAnalysis = await db.gangziiProcess.findFirst({
    where: { userId: user.id, sourceAssetId: media.id, kind: "ANALYSIS", status: "COMPLETED" },
    orderBy: { createdAt: "desc" },
  });
  let analysisJson: string | null = null;
  if (latestAnalysis?.analysisJson) {
    const check = GangziiInspectionSchema.safeParse(JSON.parse(latestAnalysis.analysisJson));
    if (check.success) analysisJson = JSON.stringify(check.data);
  }

  const row = await db.gangziiProcess.create({
    data: {
      userId: user.id,
      sourceAssetId: media.id,
      kind: "PROCESS",
      status: "QUEUED",
      name: parsed.data.name ?? null,
      paramsJson: JSON.stringify(params),
      analysisJson,
    },
  });
  const jobId = await jobManager.createJob(user.id, JOB_TYPE_GANGZII_PROCESS, { processId: row.id });
  await db.gangziiProcess.update({ where: { id: row.id }, data: { jobId } });
  return NextResponse.json({ processId: row.id, jobId });
}
