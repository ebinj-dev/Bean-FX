import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { removeFileQuiet } from "@/lib/media-storage";

async function getOwnedAsset(id: string, userId: string) {
  const asset = await db.mediaAsset.findUnique({ where: { id } });
  if (!asset || asset.userId !== userId) return null;
  return asset;
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { id } = await ctx.params;
  const asset = await getOwnedAsset(id, user.id);
  if (!asset) return NextResponse.json({ error: "Media not found." }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const data: { role?: string | null; notes?: string | null } = {};
  if ("role" in body) data.role = body.role === "BROLL" ? "BROLL" : null;
  if ("notes" in body) data.notes = String(body.notes ?? "").slice(0, 500) || null;

  const updated = await db.mediaAsset.update({ where: { id }, data });
  return NextResponse.json({ ok: true, role: updated.role, notes: updated.notes });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { id } = await ctx.params;
  const asset = await getOwnedAsset(id, user.id);
  if (!asset) return NextResponse.json({ error: "Media not found." }, { status: 404 });

  const exportsUsing = await db.exportFile.count({ where: { mediaId: id } });
  await db.mediaAsset.delete({ where: { id } });
  await removeFileQuiet(asset.storagePath);

  return NextResponse.json({ ok: true, note: exportsUsing > 0 ? "Media deleted. Existing exports were kept." : undefined });
}
