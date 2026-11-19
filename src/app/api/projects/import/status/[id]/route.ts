import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

/** M29 — import progress polling (owner-only; never exposes paths). */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { id } = await ctx.params;
  const row = await db.projectArchive.findFirst({ where: { id, userId: user.id, direction: "IMPORT" } });
  if (!row) return NextResponse.json({ error: "Import not found." }, { status: 404 });
  return NextResponse.json({ archive: { status: row.status, progress: row.progress, stage: row.stage, error: row.error, projectId: row.projectId, assetCount: row.assetCount } });
}
