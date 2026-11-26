/**
 * M45 — media poster/thumbnail endpoint.
 *
 * GET /api/media/[id]/thumbnail → the deterministic poster JPEG extracted at
 * probe time (`posterPathFor`). Owner-scoped like the rest of /api/media;
 * 404 when the asset has no thumbnail (honest absence, no placeholder). The
 * id feeding the path is regex-validated and the resolved path is refused
 * unless it stays inside the media root (defense in depth).
 */
import { NextResponse } from "next/server";
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { Readable } from "stream";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

import { isInsideMediaRoot, posterPathFor } from "@/lib/media-storage";

const ID_RE = /^[a-z0-9]{8,64}$/i;

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { id } = await ctx.params;
  if (!ID_RE.test(id)) return NextResponse.json({ error: "Invalid media id." }, { status: 400 });

  const asset = await db.mediaAsset.findUnique({ where: { id }, select: { userId: true, kind: true } });
  if (!asset || asset.userId !== user.id) return NextResponse.json({ error: "Media asset not found." }, { status: 404 });
  if (asset.kind !== "VIDEO" && asset.kind !== "IMAGE") return NextResponse.json({ error: "This asset kind has no thumbnail." }, { status: 404 });

  const poster = posterPathFor(id);
  if (!isInsideMediaRoot(poster) || !(await stat(poster).then(() => true).catch(() => false))) {
    return NextResponse.json({ error: "Thumbnail not available yet." }, { status: 404 });
  }

  const info = await stat(poster);
  const stream = createReadStream(poster);
  return new NextResponse(Readable.toWeb(stream) as unknown as ReadableStream, {
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(info.size),
      "Cache-Control": "private, max-age=86400",
    },
  });
}
