import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { promises as fs } from "fs";
import path from "path";
import { MEDIA_ROOT } from "@/lib/media-storage";

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const kind = searchParams.get("kind");
  const exports = await db.exportFile.findMany({
    where: { userId: user.id, ...(kind ? { kind } : {}) },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return NextResponse.json({
    exports: exports.map((e) => ({
      id: e.id,
      kind: e.kind,
      format: e.format,
      filename: e.filename,
      sizeBytes: e.sizeBytes,
      durationSec: e.durationSec,
      mediaId: e.mediaId,
      params: e.paramsJson ? JSON.parse(e.paramsJson) : null,
      createdAt: e.createdAt.toISOString(),
    })),
  });
}

export async function DELETE(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });

  const record = await db.exportFile.findUnique({ where: { id } });
  if (!record || record.userId !== user.id) {
    return NextResponse.json({ error: "Export not found." }, { status: 404 });
  }
  await db.exportFile.delete({ where: { id } });
  if (record.storagePath.startsWith(MEDIA_ROOT)) {
    await fs.unlink(record.storagePath).catch(() => undefined);
  }
  return NextResponse.json({ ok: true });
}
