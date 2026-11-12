import { NextRequest, NextResponse } from "next/server";
import { createReadStream, existsSync, statSync } from "fs";
import path from "path";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export const runtime = "nodejs";

const MIME_BY_FORMAT: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  mp4: "video/mp4",
  mov: "video/quicktime",
  srt: "application/x-subrip",
  vtt: "text/vtt",
  json: "application/json",
};

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { id } = await ctx.params;

  const record = await db.exportFile.findUnique({ where: { id } });
  if (!record || record.userId !== user.id) {
    return NextResponse.json({ error: "Export not found." }, { status: 404 });
  }
  if (!existsSync(record.storagePath)) {
    return NextResponse.json({ error: "Export file is missing from storage." }, { status: 410 });
  }

  const stat = statSync(record.storagePath);
  const ext = path.extname(record.storagePath).replace(".", "").toLowerCase();
  const mime = MIME_BY_FORMAT[ext] ?? "application/octet-stream";
  const stream = createReadStream(record.storagePath);

  return new NextResponse(stream as unknown as ReadableStream, {
    headers: {
      "Content-Type": mime,
      "Content-Length": String(stat.size),
      "Content-Disposition": `attachment; filename="${encodeURIComponent(record.filename)}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
