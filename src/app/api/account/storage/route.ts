/**
 * M19 §10 — real storage usage for the account settings Storage section:
 * measured bytes of owned media and exports plus the configured per-user
 * quota (0/unset = unlimited, honestly surfaced).
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser, AuthError } from "@/lib/auth";
import { stat } from "fs/promises";

export const runtime = "nodejs";

const QUOTA_BYTES = Number(process.env.USER_STORAGE_QUOTA_BYTES ?? 0);

export async function GET() {
  try {
    const user = await requireUser();
    const assets = await db.mediaAsset.findMany({ where: { userId: user.id }, select: { storagePath: true, kind: true, sizeBytes: true } });
    const exports = await db.exportFile.findMany({ where: { userId: user.id }, select: { storagePath: true, sizeBytes: true } });
    let mediaBytes = 0;
    let mediaCount = 0;
    for (const a of assets) {
      let size = a.sizeBytes ?? 0;
      if (!size) {
        try { size = (await stat(a.storagePath)).size; } catch { size = 0; }
      }
      mediaBytes += size;
      mediaCount += 1;
    }
    let exportBytes = 0;
    let exportCount = 0;
    for (const e of exports) {
      let size = e.sizeBytes ?? 0;
      if (!size) {
        try { size = (await stat(e.storagePath)).size; } catch { size = 0; }
      }
      exportBytes += size;
      exportCount += 1;
    }
    const projects = await db.project.count({ where: { userId: user.id } });
    return NextResponse.json({
      storage: {
        mediaBytes,
        mediaCount,
        exportBytes,
        exportCount,
        projectCount: projects,
        quotaBytes: QUOTA_BYTES > 0 ? QUOTA_BYTES : null,
        unlimited: QUOTA_BYTES <= 0,
      },
    });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
