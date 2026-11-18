/**
 * JAZMII API — POST /api/jazmii/generate  (M7 §6A/§13)
 *
 * Queues a durable JAZMII_GENERATE job from validated params. The provider
 * runs server-side; clients never see credentials or provider endpoints.
 * Rate limiting: per-user concurrency is enforced by the worker (1 active
 * video generation per user); the route additionally rejects a request when
 * the user already has a QUEUED/PROCESSING JAZMII generation.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/process-helpers";
import { jobManager } from "@/lib/job-runner";
import { JOB_TYPE_JAZMII_GENERATE } from "@/lib/job-helpers";
import { JazmiiGenerateParamsSchema } from "@/lib/jazmii/types";
import { jazmiiProviderIds } from "@/lib/jazmii/providers";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  if (jazmiiProviderIds().length === 0) {
    return NextResponse.json({ error: "No JAZMII generation provider is configured on this deployment." }, { status: 503 });
  }
  const parsed = JazmiiGenerateParamsSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid generation parameters: ${parsed.error.issues.map((i) => i.message).join("; ")}`);

  const active = await db.job.findFirst({ where: { userId: user.id, type: JOB_TYPE_JAZMII_GENERATE, status: { in: ["QUEUED", "PROCESSING"] } } });
  if (active) return NextResponse.json({ error: "You already have a JAZMII generation in progress — wait for it to finish or cancel it." }, { status: 429 });

  const jobId = await jobManager.createJob(user.id, JOB_TYPE_JAZMII_GENERATE, parsed.data);
  return NextResponse.json({ jobId });
}
