/**
 * M10 API — creative reviews (§9/§10).
 * GET  /api/creative/reviews?projectId=…   list reviews (+ staleness vs head)
 * POST /api/creative/reviews               create + enqueue durable CREATIVE_REVIEW
 *      {projectId, scope, language, enqueueEvidence?}
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/process-helpers";
import { enqueueReview } from "@/lib/creative/assistant";

export const runtime = "nodejs";

const CreateSchema = z.object({
  projectId: z.string().min(1).max(64),
  scope: z.enum(["full", "retention", "scorecard", "brief"]).default("full"),
  language: z.enum(["en", "ta"]).default("en"),
  enqueueEvidence: z.boolean().default(true),
});

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const projectId = new URL(req.url).searchParams.get("projectId");
  if (!projectId) return badRequest("projectId is required.");
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project || project.userId !== user.id) return badRequest("Project not found or not owned by the caller.");
  const reviews = await db.creativeReview.findMany({ where: { userId: user.id, projectId }, orderBy: { createdAt: "desc" }, take: 30 });
  return NextResponse.json({
    reviews: reviews.map((r) => ({
      id: r.id,
      scope: r.scope,
      language: r.language,
      status: r.status,
      progress: r.progress,
      stage: r.stage,
      contextVersion: r.contextVersion,
      headVersion: r.headVersion,
      provider: r.provider,
      model: r.model,
      error: r.error,
      jobId: r.jobId,
      createdAt: r.createdAt.toISOString(),
    })),
  });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const parsed = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const project = await db.project.findUnique({ where: { id: parsed.data.projectId } });
  if (!project || project.userId !== user.id) return badRequest("Project not found or not owned by the caller.");
  const { reviewId, jobId } = await enqueueReview(user.id, parsed.data.projectId, parsed.data.scope, parsed.data.language);
  await db.automationAudit.create({ data: { userId: user.id, projectId: parsed.data.projectId, action: "CREATIVE_REVIEW_ENQUEUED", detailJson: JSON.stringify({ reviewId, jobId, scope: parsed.data.scope }) } }).catch(() => undefined);
  return NextResponse.json({ reviewId, jobId }, { status: 202 });
}
