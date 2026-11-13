/**
 * MY AI conversations — GET (list) / DELETE (retention: user-initiated delete).
 * Messages are user-owned and deletable per §11.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { unauthorized } from "@/lib/process-helpers";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const projectId = req.nextUrl.searchParams.get("projectId");
  const conversations = await db.conversation.findMany({
    where: { userId: user.id, ...(projectId ? { projectId } : {}) },
    orderBy: { updatedAt: "desc" },
    take: 20,
    select: { id: true, projectId: true, title: true, createdAt: true, updatedAt: true },
  });
  return NextResponse.json({ conversations });
}

export async function DELETE(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required." }, { status: 400 });
  const res = await db.conversation.deleteMany({ where: { id, userId: user.id } });
  return NextResponse.json({ deleted: res.count });
}
