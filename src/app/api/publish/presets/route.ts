/**
 * M9 API — Brand presets (§5).
 * GET    /api/publish/presets        list owned presets
 * POST   /api/publish/presets        create (validated, asset refs owner-checked)
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/process-helpers";
import { BrandPresetSchema, validatePresetData, type BrandPresetData } from "@/lib/publish/presets";

export const runtime = "nodejs";

function serialize(row: { id: string; name: string; brandName: string; logoAssetId: string | null; watermarkAssetId: string | null; primaryColor: string; secondaryColor: string; fontFamily: string; captionStyleJson: string | null; introAssetId: string | null; outroAssetId: string | null; thumbnailStyleJson: string | null; defaultExportProfile: string | null; createdAt: Date; updatedAt: Date }) {
  return {
    id: row.id,
    name: row.name,
    brandName: row.brandName,
    logoAssetId: row.logoAssetId,
    watermarkAssetId: row.watermarkAssetId,
    primaryColor: row.primaryColor,
    secondaryColor: row.secondaryColor,
    fontFamily: row.fontFamily,
    captionStyle: row.captionStyleJson ? JSON.parse(row.captionStyleJson) : null,
    introAssetId: row.introAssetId,
    outroAssetId: row.outroAssetId,
    thumbnailStyle: row.thumbnailStyleJson ? JSON.parse(row.thumbnailStyleJson) : null,
    defaultExportProfile: row.defaultExportProfile,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const rows = await db.brandPreset.findMany({ where: { userId: user.id }, orderBy: { updatedAt: "desc" } });
  return NextResponse.json({ presets: rows.map(serialize) });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const parsed = BrandPresetSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid preset: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  try {
    await validatePresetData(user.id, parsed.data);
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : "Preset validation failed.");
  }
  const d = parsed.data as BrandPresetData;
  const row = await db.brandPreset.create({
    data: {
      userId: user.id,
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
  return NextResponse.json({ preset: serialize(row) }, { status: 201 });
}
