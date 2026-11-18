/**
 * M9 API — one thumbnail draft (§3).
 * GET    /api/publish/thumbnails/[id]    fetch draft (with asset details)
 * PATCH  /api/publish/thumbnails/[id]    edit prompt / layout / selection / reference
 * DELETE /api/publish/thumbnails/[id]    delete draft (assets are untouched)
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, notFound, unauthorized } from "@/lib/process-helpers";
import { ThumbnailLayoutSchema } from "@/lib/publish/thumbnails";

export const runtime = "nodejs";

const PatchSchema = z
  .object({
    prompt: z.string().max(400).optional(),
    layout: ThumbnailLayoutSchema.nullable().optional(),
    selectedAssetId: z.string().max(64).nullable().optional(),
    referenceAssetId: z.string().max(64).nullable().optional(),
  })
  .strict();

async function ownedDraft(userId: string, id: string) {
  const row = await db.thumbnailDraft.findUnique({ where: { id } });
  if (!row || row.userId !== userId) return null;
  return row;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const draft = await ownedDraft(user.id, id);
  if (!draft) return notFound();
  const candidateIds = draft.candidateIdsJson ? (JSON.parse(draft.candidateIdsJson) as string[]) : [];
  const assets = candidateIds.length ? await db.mediaAsset.findMany({ where: { id: { in: candidateIds }, userId: user.id } }) : [];
  const composite = draft.compositedAssetId ? await db.mediaAsset.findUnique({ where: { id: draft.compositedAssetId } }) : null;
  const selected = draft.selectedAssetId ? await db.mediaAsset.findUnique({ where: { id: draft.selectedAssetId } }) : null;
  return NextResponse.json({
    draft: {
      id: draft.id,
      projectId: draft.projectId,
      platform: draft.platform,
      status: draft.status,
      prompt: draft.prompt,
      layout: draft.layoutJson ? JSON.parse(draft.layoutJson) : null,
      referenceAssetId: draft.provenanceJson ? ((JSON.parse(draft.provenanceJson) as { referenceAssetId?: string }).referenceAssetId ?? null) : null,
      selectedAssetId: draft.selectedAssetId,
      compositedAssetId: draft.compositedAssetId,
      provenance: draft.provenanceJson ? JSON.parse(draft.provenanceJson) : null,
      error: draft.error,
      jobId: draft.jobId,
      updatedAt: draft.updatedAt.toISOString(),
    },
    candidates: assets.map((a) => ({ id: a.id, mimeType: a.mimeType, width: a.width, height: a.height, provider: a.provider, model: a.model, prompt: a.prompt, attribution: a.attribution, createdAt: a.createdAt.toISOString() })),
    composite: composite ? { id: composite.id, mimeType: composite.mimeType, width: composite.width, height: composite.height, createdAt: composite.createdAt.toISOString() } : null,
    selected: selected ? { id: selected.id, mimeType: selected.mimeType, width: selected.width, height: selected.height, originalName: selected.originalName } : null,
  });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const draft = await ownedDraft(user.id, id);
  if (!draft) return notFound();
  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);

  const data: Record<string, unknown> = {};
  if (parsed.data.prompt !== undefined) data.prompt = parsed.data.prompt;
  if (parsed.data.layout !== undefined) data.layoutJson = parsed.data.layout ? JSON.stringify(parsed.data.layout) : null;
  if (parsed.data.referenceAssetId !== undefined) data.provenanceJson = JSON.stringify({ ...(draft.provenanceJson ? JSON.parse(draft.provenanceJson) : {}), referenceAssetId: parsed.data.referenceAssetId });

  if (parsed.data.selectedAssetId !== undefined) {
    if (parsed.data.selectedAssetId === null) {
      data.selectedAssetId = null;
    } else {
      const asset = await db.mediaAsset.findUnique({ where: { id: parsed.data.selectedAssetId } });
      if (!asset || asset.userId !== user.id || asset.kind !== "IMAGE") return badRequest("Selected asset not found, not owned by the caller, or not an image.");
      data.selectedAssetId = parsed.data.selectedAssetId;
    }
  }
  const updated = await db.thumbnailDraft.update({ where: { id }, data });
  return NextResponse.json({ ok: true, draft: { id: updated.id, status: updated.status, selectedAssetId: updated.selectedAssetId, compositedAssetId: updated.compositedAssetId } });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const draft = await ownedDraft(user.id, id);
  if (!draft) return notFound();
  await db.thumbnailDraft.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
