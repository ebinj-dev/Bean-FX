/**
 * M9 API — generate thumbnail alternatives (§3).
 * POST /api/publish/thumbnails/[id]/generate {count?, prompt?, referenceAssetId?}
 * Enqueues a durable PUBLISH_THUMBNAIL job on the EXISTING worker; previous
 * candidates/selections are preserved (regeneration never overwrites).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, notFound, unauthorized } from "@/lib/process-helpers";
import { enqueueMediaJob, JOB_TYPE_PUBLISH_THUMBNAIL } from "@/lib/job-helpers";

export const runtime = "nodejs";

const Schema = z
  .object({
    count: z.number().int().min(1).max(4).default(2),
    prompt: z.string().max(400).optional(),
    referenceAssetId: z.string().max(64).nullable().optional(),
  })
  .strict();

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const draft = await db.thumbnailDraft.findUnique({ where: { id } });
  if (!draft || draft.userId !== user.id) return notFound();
  const parsed = Schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);

  if (parsed.data.referenceAssetId) {
    const ref = await db.mediaAsset.findUnique({ where: { id: parsed.data.referenceAssetId } });
    if (!ref || ref.userId !== user.id || !ref.mimeType.startsWith("image/")) {
      return badRequest("Reference asset not found, not owned by the caller, or not an image.");
    }
  }

  const jobId = await enqueueMediaJob(user.id, JOB_TYPE_PUBLISH_THUMBNAIL, {
    draftId: draft.id,
    count: parsed.data.count,
    prompt: parsed.data.prompt ?? draft.prompt,
    referenceAssetId: parsed.data.referenceAssetId ?? null,
  });
  await db.thumbnailDraft.update({ where: { id: draft.id }, data: { jobId, status: "GENERATING" } });
  return NextResponse.json({ jobId, draftId: draft.id }, { status: 202 });
}
