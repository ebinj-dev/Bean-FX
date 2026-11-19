/** M30 — guest preview streaming via link token. Same constraints as the
 * authenticated preview: only the validated review render, inline, no
 * download. The link must be ACTIVE and unexpired; password links require
 * ?password= (or an established guest session). */
import { NextRequest, NextResponse } from "next/server";
import { stat } from "fs/promises";
import { createReadStream, existsSync } from "fs";
import { db } from "@/lib/db";
import { sha256Hex } from "@/lib/collab";

export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const link = await db.reviewLink.findUnique({
    where: { tokenHash: sha256Hex(token.trim()) },
    include: { revision: { select: { id: true, previewExportId: true, status: true } } },
  });
  if (!link || link.state !== "ACTIVE" || link.expiresAt <= new Date()) {
    return NextResponse.json({ error: "This review link is no longer valid." }, { status: 410 });
  }
  if (link.passwordHash) {
    // Accept either the query password or an established guest session.
    const provided = new URL(req.url).searchParams.get("password");
    const cookie = req.headers.get("cookie") ?? "";
    const session = cookie.split(";").map((c) => c.trim()).find((c) => c.startsWith("beanfx_review="))?.slice("beanfx_review=".length);
    let ok = false;
    if (provided !== null && sha256Hex(provided) === link.passwordHash) ok = true;
    if (!ok && session) {
      const [linkId, guestToken] = decodeURIComponent(session).split(".");
      if (linkId === link.id && guestToken && sha256Hex(guestToken) === link.tokenHash) ok = true;
    }
    if (!ok) return NextResponse.json({ error: "Password required.", passwordRequired: true }, { status: 401 });
  }
  if (!link.revision.previewExportId) {
    return NextResponse.json({ error: "The review preview is not ready.", status: link.revision.status }, { status: 409 });
  }
  const preview = await db.exportFile.findUnique({ where: { id: link.revision.previewExportId } });
  if (!preview?.storagePath || !existsSync(preview.storagePath)) {
    return NextResponse.json({ error: "The review preview is not available." }, { status: 410 });
  }
  const st = await stat(preview.storagePath);
  await db.reviewLink.update({ where: { id: link.id }, data: { accessCount: { increment: 1 }, lastAccessAt: new Date() } }).catch(() => undefined);
  const stream = createReadStream(preview.storagePath) as unknown as ReadableStream;
  return new NextResponse(stream, {
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(st.size),
      "Content-Disposition": "inline",
      "Cache-Control": "private, no-store",
      "X-Review-Revision": link.revision.id,
    },
  });
}
