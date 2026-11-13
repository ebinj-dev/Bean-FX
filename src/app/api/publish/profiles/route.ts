/**
 * M9 API — GET /api/publish/profiles
 * The versioned export profile registry (§6). `source` records whether the
 * deployment serves the built-in registry or a validated env override.
 */
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { exportProfileRegistry, listExportProfiles } from "@/lib/publish/profiles";
import { thumbnailDimsForProfile } from "@/lib/publish/thumbnails";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const registry = exportProfileRegistry();
  const profiles = listExportProfiles().map((p) => {
    let thumbnail: { width: number; height: number } | null = null;
    try {
      thumbnail = thumbnailDimsForProfile(p.id);
    } catch {
      thumbnail = null;
    }
    return { ...p, thumbnailDims: thumbnail };
  });
  return NextResponse.json({ version: registry.version, source: registry.source, profiles });
}
