/**
 * M10 API — A/B Studio variants (§6).
 * GET  /api/creative/variants?projectId=…[&kind=]    list (+ comparison view)
 * POST /api/creative/variants                        {projectId, kind, language, instruction?, reviewId?}
 *                                                    → durable CREATIVE_VARIANTS job (text kinds)
 *                                                    OR {projectId, action:"register-thumbnails", platform}
 *                                                    → reuse M9 LAXII candidates (no duplication)
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/process-helpers";
import { enqueueMediaJob, JOB_TYPE_CREATIVE_VARIANTS } from "@/lib/job-helpers";
import { compareVariants, registerThumbnailVariants } from "@/lib/creative/variants";

export const runtime = "nodejs";

const GenSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("generate"),
    projectId: z.string().min(1).max(64),
    kind: z.enum(["hook", "title", "description", "cta", "narration-section"]),
    language: z.enum(["en", "ta"]).default("en"),
    instruction: z.string().max(400).nullable().default(null),
    reviewId: z.string().max(64).nullable().default(null),
  }),
  z.object({
    action: z.literal("register-thumbnails"),
    projectId: z.string().min(1).max(64),
    platform: z.string().min(2).max(40),
  }),
]);

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const params = new URL(req.url).searchParams;
  const projectId = params.get("projectId");
  if (!projectId) return badRequest("projectId is required.");
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project || project.userId !== user.id) return badRequest("Project not found or not owned by the caller.");
  const kind = params.get("kind");
  const rows = await db.creativeVariant.findMany({ where: { userId: user.id, projectId, ...(kind ? { kind } : {}) }, orderBy: { createdAt: "desc" } });
  return NextResponse.json({ variants: compareVariants(rows) });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const parsed = GenSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const project = await db.project.findUnique({ where: { id: parsed.data.projectId } });
  if (!project || project.userId !== user.id) return badRequest("Project not found or not owned by the caller.");

  if (parsed.data.action === "register-thumbnails") {
    const ids = await registerThumbnailVariants(user.id, parsed.data.projectId, parsed.data.platform);
    return NextResponse.json({ registered: ids.length, variantIds: ids, note: ids.length ? "M9 LAXII candidates registered as comparable thumbnail variants." : "No M9 thumbnail candidates exist for this project+platform yet — generate them in Publishing ▸ Thumbnail first." });
  }

  const { reviewId } = parsed.data;
  if (reviewId) {
    const review = await db.creativeReview.findUnique({ where: { id: reviewId } });
    if (!review || review.userId !== user.id) return badRequest("Referenced review not found or not owned.");
  }
  const jobId = await enqueueMediaJob(user.id, JOB_TYPE_CREATIVE_VARIANTS, { projectId: parsed.data.projectId, reviewId, kind: parsed.data.kind, language: parsed.data.language, instruction: parsed.data.instruction });
  return NextResponse.json({ jobId }, { status: 202 });
}
