/**
 * JAZMII API — POST /api/jazmii/analyze  (M7 §6C)
 * Queues a durable JAZMII_ANALYZE job for an owned video asset.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, notFound, unauthorized } from "@/lib/process-helpers";
import { jobManager } from "@/lib/job-runner";
import { JOB_TYPE_JAZMII_ANALYZE } from "@/lib/job-helpers";

const Schema = z.object({ mediaId: z.string().min(1).max(64) });

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("mediaId required.");

  const asset = await db.mediaAsset.findUnique({ where: { id: parsed.data.mediaId } });
  if (!asset || asset.userId !== user.id) return notFound();
  if (asset.kind !== "VIDEO") return badRequest("JAZMII analysis applies to VIDEO assets.");

  const jobId = await jobManager.createJob(user.id, JOB_TYPE_JAZMII_ANALYZE, parsed.data);
  return NextResponse.json({ jobId });
}
