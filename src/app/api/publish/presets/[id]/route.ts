/**
 * M9 API — one brand preset (§5).
 * GET    /api/publish/presets/[id]   fetch owned preset
 * PATCH  /api/publish/presets/[id]   edit (full validated payload)
 * POST   /api/publish/presets/[id]   duplicate
 * DELETE /api/publish/presets/[id]   delete
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, notFound, unauthorized } from "@/lib/process-helpers";
import { BrandPresetSchema, validatePresetData, type BrandPresetData } from "@/lib/publish/presets";

export const runtime = "nodejs";

async function ownedPreset(userId: string, id: string) {
  const row = await db.brandPreset.findUnique({ where: { id } });
  if (!row || row.userId !== userId) return null;
  return row;
}

function rowToDataLoose(row: Record<string, unknown>): BrandPresetData {
  return {
    name: String(row.name ?? ""),
    brandName: String(row.brandName ?? ""),
    logoAssetId: (row.logoAssetId as string | null) ?? null,
    watermarkAssetId: (row.watermarkAssetId as string | null) ?? null,
    primaryColor: String(row.primaryColor ?? "#d4a017"),
    secondaryColor: String(row.secondaryColor ?? "#111111"),
    fontFamily: ["inter", "nikki-sans", "nikki-tamil"].includes(String(row.fontFamily)) ? (String(row.fontFamily) as BrandPresetData["fontFamily"]) : "inter",
    captionStyle: row.captionStyleJson ? JSON.parse(row.captionStyleJson as string) : null,
    introAssetId: (row.introAssetId as string | null) ?? null,
    outroAssetId: (row.outroAssetId as string | null) ?? null,
    thumbnailStyle: row.thumbnailStyleJson ? JSON.parse(row.thumbnailStyleJson as string) : null,
    defaultExportProfile: (row.defaultExportProfile as string | null) ?? null,
  };
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const row = await ownedPreset(user.id, id);
  if (!row) return notFound();
  return NextResponse.json({ preset: row });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const row = await ownedPreset(user.id, id);
  if (!row) return notFound();
  const parsed = BrandPresetSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid preset: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  try {
    await validatePresetData(user.id, parsed.data);
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : "Preset validation failed.");
  }
  const d = parsed.data as BrandPresetData;
  const updated = await db.brandPreset.update({
    where: { id },
    data: {
      name: d.name,
      brandName: d.brandName,
      logoAssetId: d.logoAssetId,
      watermarkAssetId: d.watermarkAssetId,
      primaryColor: d.primaryColor,
      secondaryColor: d.secondaryColor,
      fontFamily: d.fontFamily,
      captionStyleJson: d.captionStyle ? JSON.stringify(d.captionStyle) : null,
      introAssetId: d.introAssetId,
      outroAssetId: d.outroAssetId,
      thumbnailStyleJson: d.thumbnailStyle ? JSON.stringify(d.thumbnailStyle) : null,
      defaultExportProfile: d.defaultExportProfile,
    },
  });
  return NextResponse.json({ preset: updated });
}

/** Duplicate the preset (§5 "creation, editing, duplication and deletion"). */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const row = await ownedPreset(user.id, id);
  if (!row) return notFound();
  const data = rowToDataLoose(row as unknown as Record<string, unknown>);
  await validatePresetData(user.id, data).catch(() => undefined);
  const copy = await db.brandPreset.create({
    data: {
      userId: user.id,
      name: `${row.name} (copy)`.slice(0, 80),
      brandName: data.brandName,
      logoAssetId: data.logoAssetId,
      watermarkAssetId: data.watermarkAssetId,
      primaryColor: data.primaryColor,
      secondaryColor: data.secondaryColor,
      fontFamily: data.fontFamily,
      captionStyleJson: row.captionStyleJson,
      introAssetId: data.introAssetId,
      outroAssetId: data.outroAssetId,
      thumbnailStyleJson: row.thumbnailStyleJson,
      defaultExportProfile: data.defaultExportProfile,
    },
  });
  return NextResponse.json({ preset: copy }, { status: 201 });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const row = await ownedPreset(user.id, id);
  if (!row) return notFound();
  await db.brandPreset.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
