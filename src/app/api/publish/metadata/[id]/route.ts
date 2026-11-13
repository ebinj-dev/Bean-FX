/**
 * M9 API — one metadata row (§4).
 * GET    /api/publish/metadata/[id]   fetch (draft and approved kept separate)
 * PATCH  /api/publish/metadata/[id]   {approved: fields} → validate + store as USER-APPROVED
 *                                       {unapprove: true} → clear approval
 * DELETE /api/publish/metadata/[id]   delete row
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, notFound, unauthorized } from "@/lib/process-helpers";
import { PublishFieldsSchema } from "@/lib/publish/metadata";

export const runtime = "nodejs";

const PatchSchema = z
  .object({
    approved: PublishFieldsSchema.nullable().optional(),
    unapprove: z.boolean().optional(),
  })
  .strict();

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const row = await db.publishMetadata.findUnique({ where: { id } });
  if (!row || row.userId !== user.id) return notFound();
  return NextResponse.json({
    metadata: {
      id: row.id,
      projectId: row.projectId,
      platform: row.platform,
      language: row.language,
      status: row.status,
      draft: row.draftJson ? JSON.parse(row.draftJson) : null,
      approved: row.approvedJson ? JSON.parse(row.approvedJson) : null,
      provider: row.provider,
      model: row.model,
      fieldHistory: row.fieldHistoryJson ? JSON.parse(row.fieldHistoryJson) : [],
      updatedAt: row.updatedAt.toISOString(),
    },
  });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const row = await db.publishMetadata.findUnique({ where: { id } });
  if (!row || row.userId !== user.id) return notFound();
  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);

  if (parsed.data.unapprove) {
    const updated = await db.publishMetadata.update({ where: { id }, data: { status: row.draftJson ? "GENERATED" : "DRAFT", approvedJson: null } });
    return NextResponse.json({ ok: true, status: updated.status });
  }
  if (parsed.data.approved !== undefined) {
    // User-approved values are schema-validated at the boundary, then stored
    // verbatim — the approved fields ARE the user's edit, not AI output.
    const updated = await db.publishMetadata.update({
      where: { id },
      data: { status: "APPROVED", approvedJson: JSON.stringify(parsed.data.approved) },
    });
    return NextResponse.json({ ok: true, status: updated.status });
  }
  return badRequest("Nothing to update: send {approved: fields} or {unapprove: true}.");
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const row = await db.publishMetadata.findUnique({ where: { id } });
  if (!row || row.userId !== user.id) return notFound();
  await db.publishMetadata.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
