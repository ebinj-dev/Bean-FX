/**
 * M9 API — download a publication package (§7).
 * GET /api/publish/packages/[id]/download — streams the READY zip with its
 * sha256 header. Ownership-checked; FAILED/BUILDING packages download nothing.
 */
import { NextRequest, NextResponse } from "next/server";
import { createReadStream, existsSync, statSync } from "fs";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, notFound, unauthorized } from "@/lib/process-helpers";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const pkg = await db.publishPackage.findUnique({ where: { id } });
  if (!pkg || pkg.userId !== user.id) return notFound();
  if (pkg.status !== "READY" || !pkg.storagePath) return badRequest(`Package is ${pkg.status}; nothing to download${pkg.error ? `: ${pkg.error}` : ""}.`);
  if (!existsSync(pkg.storagePath)) return NextResponse.json({ error: "Package file is missing from storage." }, { status: 410 });
  const stat = statSync(pkg.storagePath);
  const stream = createReadStream(pkg.storagePath);
  return new NextResponse(stream as unknown as ReadableStream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(stat.size),
      "Content-Disposition": `attachment; filename="beanfx_package_${pkg.id}.zip"`,
      ...(pkg.manifestSha256 ? { "X-Manifest-Sha256": pkg.manifestSha256 } : {}),
    },
  });
}
