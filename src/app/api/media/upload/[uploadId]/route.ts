import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { MEDIA_ROOT } from "@/lib/media-storage";

export const runtime = "nodejs";

/**
 * M3.1 — resumable-upload protocol.
 *
 * GET    /api/media/upload/[uploadId]  → session state incl. per-part sizes,
 *                                         missing indexes and mismatches, so
 *                                         a client can recover from any
 *                                         interruption without re-sending
 *                                         everything.
 * DELETE /api/media/upload/[uploadId]  → explicit cancellation (client or user):
 *                                         session → CANCELLED, scratch removed.
 *                                         Never touches any original media.
 */

async function ownedSession(uploadId: string, userId: string) {
  const session = await db.uploadSession.findUnique({ where: { id: uploadId } });
  // A 404 for both "missing" and "not yours" avoids leaking session ids.
  if (!session || session.userId !== userId) return null;
  return session;
}

function partsDirFor(uploadId: string) {
  return path.join(MEDIA_ROOT, "tmp", `up_${uploadId}`);
}

interface PartInfo {
  index: number;
  size: number;
  ok: boolean;
}

/** Snapshot of on-disk parts vs the declared chunk layout. */
async function partStatus(session: {
  id: string;
  chunkTotal: number;
  chunkSize: number;
  declaredSize: bigint;
}): Promise<{ parts: PartInfo[]; missing: number[]; mismatched: number[] }> {
  const entries = await fs.readdir(partsDirFor(session.id)).catch(() => [] as string[]);
  const sizes = new Map<number, number>();
  for (const entry of entries) {
    const match = /^(\d{6})\.part$/.exec(entry);
    if (!match) continue;
    const index = Number(match[1]);
    const st = await fs.stat(path.join(partsDirFor(session.id), entry)).catch(() => null);
    if (st) sizes.set(index, st.size);
  }
  const chunkSize = session.chunkSize > 0 ? session.chunkSize : Math.ceil(Number(session.declaredSize) / session.chunkTotal);
  const expectedSize = (index: number) =>
    index >= session.chunkTotal - 1 ? Number(session.declaredSize) - chunkSize * (session.chunkTotal - 1) : chunkSize;

  const parts: PartInfo[] = [];
  const missing: number[] = [];
  const mismatched: number[] = [];
  for (let i = 0; i < session.chunkTotal; i++) {
    const size = sizes.get(i);
    if (size === undefined) {
      missing.push(i);
      continue;
    }
    const ok = size === expectedSize(i);
    if (!ok) mismatched.push(i);
    parts.push({ index: i, size, ok });
  }
  return { parts: parts.sort((a, b) => a.index - b.index), missing, mismatched };
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ uploadId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { uploadId } = await ctx.params;

  const session = await ownedSession(uploadId, user.id);
  if (!session) return NextResponse.json({ error: "Upload session not found." }, { status: 404 });

  const { parts, missing, mismatched } = await partStatus(session);
  return NextResponse.json({
    uploadId: session.id,
    status: session.status,
    originalName: session.originalName,
    kind: session.kind,
    declaredSize: session.declaredSize.toString(),
    chunkSize: session.chunkSize,
    chunkTotal: session.chunkTotal,
    receivedCount: session.receivedCount,
    partsOnDisk: parts.length,
    missing,
    mismatched,
    parts: session.status === "OPEN" ? parts : undefined,
    mediaAssetId: session.mediaAssetId,
    createdAt: session.createdAt.toISOString(),
    lastChunkAt: session.lastChunkAt.toISOString(),
  });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ uploadId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { uploadId } = await ctx.params;

  const session = await ownedSession(uploadId, user.id);
  if (!session) return NextResponse.json({ error: "Upload session not found." }, { status: 404 });
  if (session.status === "COMPLETED") {
    return NextResponse.json({ error: "Upload already completed — cancel is not possible; delete the media instead." }, { status: 409 });
  }

  await db.uploadSession.updateMany({
    where: { id: session.id, status: { in: ["OPEN", "FAILED"] } },
    data: { status: "CANCELLED" },
  });
  await fs.rm(partsDirFor(session.id), { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(path.join(MEDIA_ROOT, "tmp", `asm_${session.id}`), { force: true }).catch(() => undefined);

  return NextResponse.json({ ok: true, uploadId: session.id, status: "CANCELLED" });
}
