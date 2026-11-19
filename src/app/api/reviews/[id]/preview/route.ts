/** M30 — reviewable preview streaming. Authenticated collaborators with
 * project access or guests with an ACTIVE link session for THIS revision.
 * Streams the pipeline-validated review render ONLY — never original
 * high-resolution media, never other projects' files. */
import { NextRequest, NextResponse } from "next/server";
import { stat } from "fs/promises";
import { createReadStream, existsSync } from "fs";
import { db } from "@/lib/db";
import { resolveReviewActor } from "@/lib/review-access";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const r = await resolveReviewActor(id, req);
  if (!r.ok) return r.error;
  const { revision } = r;
  if (!revision.previewExportId) {
    return NextResponse.json({ error: "The review preview is not ready.", status: revision.status }, { status: 409 });
  }
  const preview = await db.exportFile.findUnique({ where: { id: revision.previewExportId } });
  if (!preview || !preview.storagePath || !existsSafe(preview.storagePath)) {
    return NextResponse.json({ error: "The review preview is not available." }, { status: 410 });
  }
  // Defense in depth: the streamed file must be the registered preview.
  const st = await stat(preview.storagePath);
  const stream = createReadStream(preview.storagePath) as unknown as ReadableStream;
  return new NextResponse(stream, {
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(st.size),
      // Reviews stream inline; no attachment downloads for guests.
      "Content-Disposition": `inline; filename="${sanitizeName(preview.filename)}"`,
      "Cache-Control": "private, no-store",
      "X-Review-Revision": revision.id,
    },
  });
}

function existsSafe(p: string): boolean {
  return existsSync(p);
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "review.mp4";
}
