import { NextRequest, NextResponse } from "next/server";
import { createReadStream, existsSync, statSync } from "fs";
import path from "path";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export const runtime = "nodejs";

const MIME_BY_EXT: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".m4v": "video/x-m4v",
};

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { id } = await ctx.params;

  const asset = await db.mediaAsset.findUnique({ where: { id } });
  if (!asset || asset.userId !== user.id) {
    return NextResponse.json({ error: "Media not found." }, { status: 404 });
  }
  if (!existsSync(asset.storagePath)) {
    return NextResponse.json({ error: "Media file is missing from storage." }, { status: 410 });
  }

  const ext = path.extname(asset.storagePath).toLowerCase();
  const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
  const stat = statSync(asset.storagePath);
  const size = stat.size;

  // Range support (single range): browsers issue these when seeking in
  // <video>/<audio> previews — without it every seek re-downloads the file.
  const rangeHeader = req.headers.get("range");
  const match = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;
  if (rangeHeader && match) {
    const [, rawStart, rawEnd] = match;
    let start: number;
    let end: number;
    if (rawStart === "" && rawEnd !== "") {
      // Suffix range: last N bytes.
      const suffixLen = Math.min(Number(rawEnd), size);
      start = Math.max(0, size - suffixLen);
      end = size - 1;
    } else {
      start = Number(rawStart);
      end = rawEnd !== "" ? Math.min(Number(rawEnd), size - 1) : size - 1;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= size || start > end) {
      return new NextResponse(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    }
    const stream = createReadStream(asset.storagePath, { start, end });
    return new NextResponse(stream as unknown as ReadableStream, {
      status: 206,
      headers: {
        "Content-Type": mime,
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Disposition": `inline; filename="${encodeURIComponent(asset.originalName)}"`,
        "Cache-Control": "private, max-age=3600",
        "Accept-Ranges": "bytes",
      },
    });
  }

  const stream = createReadStream(asset.storagePath);
  return new NextResponse(stream as unknown as ReadableStream, {
    headers: {
      "Content-Type": mime,
      "Content-Length": String(size),
      "Content-Disposition": `inline; filename="${encodeURIComponent(asset.originalName)}"`,
      "Cache-Control": "private, max-age=3600",
      "Accept-Ranges": "bytes",
    },
  });
}
