/**
 * MY AI conversations — GET (list) / POST (create) / DELETE (retention:
 * user-initiated delete). Messages are user-owned and deletable per §11.
 *
 * M48-G1 — POST creates a durable conversation row (optionally linked to one
 * of the caller's projects). The editor AI dock uses this to attach to the
 * canonical Conversation system instead of keeping an ephemeral transcript;
 * no second chat system or store is introduced — this is the same
 * Conversation/ConversationMessage schema the chat service writes.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { unauthorized } from "@/lib/process-helpers";

export const runtime = "nodejs";

const TITLE_MAX = 120;

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

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  // M48-G2 — per-user rate limit (after authentication, so the limiter
  // never reveals whether another user’s resource exists).
  const limited = enforceRateLimit(req, "convCreate", user.id, RATE_LIMITS.convCreate);
  if (limited) return limited;
  const body = await req.json().catch(() => null) as { projectId?: unknown; title?: unknown } | null;
  if (!body) return NextResponse.json({ error: "Invalid request body." }, { status: 400 });

  const projectId = typeof body.projectId === "string" && body.projectId ? body.projectId : null;
  if (projectId) {
    // Ownership: a conversation may only be linked to a project the caller owns.
    const project = await db.project.findFirst({ where: { id: projectId, userId: user.id }, select: { id: true } });
    if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, TITLE_MAX) : "Conversation";

  const conversation = await db.conversation.create({
    data: { userId: user.id, projectId, title },
    select: { id: true, projectId: true, title: true, createdAt: true, updatedAt: true },
  });
  return NextResponse.json({ conversation }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required." }, { status: 400 });
  const res = await db.conversation.deleteMany({ where: { id, userId: user.id } });
  return NextResponse.json({ deleted: res.count });
}
