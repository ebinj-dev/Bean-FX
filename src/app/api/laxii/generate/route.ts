/**
 * LAXII API — POST /api/laxii/generate  (M7 §7A/§13)
 * Queues a durable LAXII_GENERATE job from validated params. Per-user rate
 * limit: one active image generation job (worker-enforced + route check).
 * Reference assets must be owned by the caller (checked in the job).
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { assertWithinLimit, PlanLimitError, planLimitResponse } from "@/lib/billing/entitlements";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/process-helpers";
import { jobManager } from "@/lib/job-runner";
import { JOB_TYPE_LAXII_GENERATE } from "@/lib/job-helpers";
import { LaxiiGenerateParamsSchema } from "@/lib/laxii/types";
import { laxiiProviderIds } from "@/lib/laxii/providers";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  // M25 P2 — plan entitlement: monthly AI call budget (server-side).
  try {
    await assertWithinLimit(user.id, "monthlyAiCalls");
  } catch (err) {
    if (err instanceof PlanLimitError) {
      const { body: limitBody, status } = planLimitResponse(err);
      return NextResponse.json(limitBody, { status });
    }
    throw err;
  }
  if (laxiiProviderIds().length === 0) {
    return NextResponse.json({ error: "No LAXII generation provider is configured on this deployment." }, { status: 503 });
  }
  const parsed = LaxiiGenerateParamsSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid generation parameters: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  if (parsed.data.mode === "edit" && !parsed.data.referenceAssetId) {
    return badRequest("mode=edit requires referenceAssetId.");
  }

  const active = await db.job.findFirst({ where: { userId: user.id, type: JOB_TYPE_LAXII_GENERATE, status: { in: ["QUEUED", "PROCESSING"] } } });
  if (active) return NextResponse.json({ error: "You already have an image generation in progress — wait for it or cancel it." }, { status: 429 });

  const jobId = await jobManager.createJob(user.id, JOB_TYPE_LAXII_GENERATE, parsed.data);
  return NextResponse.json({ jobId });
}
