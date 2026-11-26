/**
 * M45-A — conversation history restore.
 *
 * GET /api/my-ai/conversations/[id]/messages → the persisted turns of one of
 * the caller's conversations (bounded). The chat-first home restores history
 * from the SERVER after reload or login from another device — localStorage is
 * never authoritative for production history.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { id } = await ctx.params;

  const conversation = await db.conversation.findFirst({
    where: { id, userId: user.id },
    select: { id: true, title: true, projectId: true },
  });
  if (!conversation) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  const linkedProduction = conversation ? await db.production.findFirst({ where: { conversationId: conversation.id, userId: user.id }, orderBy: { createdAt: "asc" }, select: { id: true } }) : null;

  const messages = await db.conversationMessage.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: "asc" },
    take: 200,
    select: { id: true, role: true, content: true, metaJson: true, createdAt: true },
  });

  return NextResponse.json({
    conversation: { ...conversation, productionId: linkedProduction?.id ?? null },
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      meta: m.metaJson ? JSON.parse(m.metaJson) : null,
      createdAt: m.createdAt.toISOString(),
    })),
  });
}
