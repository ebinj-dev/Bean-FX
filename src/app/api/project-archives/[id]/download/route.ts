import { NextRequest, NextResponse } from "next/server";
import { stat } from "fs/promises";
import { createReadStream, existsSync } from "fs";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

/** M29 — download a completed project package (auth + ownership; streams the
 *  stored zip; never exposes server paths). */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { id } = await ctx.params;

  const archive = await db.projectArchive.findUnique({ where: { id } });
  if (!archive || archive.userId !== user.id) return NextResponse.json({ error: "Archive not found." }, { status: 404 });
  if (archive.status !== "COMPLETED" || !archive.storagePath || !existsSync(archive.storagePath)) {
    return NextResponse.json({ error: "Package is not ready.", status: archive.status, progress: archive.progress, error_detail: archive.error }, { status: 409 });
  }
  const st = await stat(archive.storagePath);
  const projectName = (await db.project.findUnique({ where: { id: archive.projectId ?? "" }, select: { name: true } }))?.name ?? "project";
  const safeName = `${projectName.replace(/[^a-zA-Z0-9._-]+/g, "_")}.beanfx.zip`;
  const stream = createReadStream(archive.storagePath) as unknown as ReadableStream;
  return new NextResponse(stream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(st.size),
      "Content-Disposition": `attachment; filename="${safeName}"`,
    },
  });
}
