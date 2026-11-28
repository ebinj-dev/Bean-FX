/**
 * M45-A — conversation history restore (GET).
 * M48-G1 — durable turn append (POST): the editor AI dock records its user
 * instruction and the RIISHE proposal turn here so the conversation survives
 * reloads and remounts, riding the SAME Conversation/ConversationMessage store
 * the chat service uses. Idempotency: a POST carrying a clientTurnId that was
 * already persisted returns the EXISTING message (200) instead of writing a
 * duplicate — safe retries cannot double-append. Ordering: reads use
 * (createdAt asc, id asc) for a deterministic total order.
 *
 * Conversation content is never logged (diagnostics carry no message text).
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

export const runtime = "nodejs";

const CONTENT_MAX = 8000;
const META_MAX = 4000;
const TURN_ID_MAX = 64;
const ROLES = new Set(["user", "assistant", "tool", "system"]);

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
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 200,
    select: { id: true, role: true, content: true, metaJson: true, clientTurnId: true, createdAt: true },
  });

  return NextResponse.json({
    conversation: { ...conversation, productionId: linkedProduction?.id ?? null },
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      meta: m.metaJson ? JSON.parse(m.metaJson) : null,
      clientTurnId: m.clientTurnId,
      createdAt: m.createdAt.toISOString(),
    })),
  });
}

/** Serialize a message row for the wire. */
function toWire(m: {
  id: string; role: string; content: string; metaJson: string | null; clientTurnId: string | null; createdAt: Date;
}) {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    meta: m.metaJson ? JSON.parse(m.metaJson) : null,
    clientTurnId: m.clientTurnId,
    createdAt: m.createdAt.toISOString(),
  };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  // M48-G2 — per-user rate limit (after authentication, so the limiter
  // never reveals whether another user’s resource exists).
  const limited = enforceRateLimit(req, "convAppend", user.id, RATE_LIMITS.api);
  if (limited) return limited;
  const { id } = await ctx.params;

  // Ownership: only the conversation's owner may append to it (isolation).
  const conversation = await db.conversation.findFirst({
    where: { id, userId: user.id },
    select: { id: true },
  });
  if (!conversation) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });

  const body = await req.json().catch(() => null) as {
    role?: unknown; content?: unknown; meta?: unknown; clientTurnId?: unknown;
  } | null;
  if (!body) return NextResponse.json({ error: "Invalid request body." }, { status: 400 });

  const role = typeof body.role === "string" ? body.role : "";
  if (!ROLES.has(role)) {
    return NextResponse.json({ error: "role must be one of user | assistant | tool | system." }, { status: 400 });
  }
  const content = typeof body.content === "string" ? body.content : "";
  if (!content.trim() || content.length > CONTENT_MAX) {
    return NextResponse.json({ error: `content is required and must be at most ${CONTENT_MAX} characters.` }, { status: 400 });
  }
  let metaJson: string | null = null;
  if (body.meta !== undefined && body.meta !== null) {
    if (typeof body.meta !== "object") {
      return NextResponse.json({ error: "meta must be an object when present." }, { status: 400 });
    }
    metaJson = JSON.stringify(body.meta);
    if (metaJson.length > META_MAX) {
      return NextResponse.json({ error: `meta must serialize to at most ${META_MAX} characters.` }, { status: 400 });
    }
  }
  const clientTurnId = typeof body.clientTurnId === "string" && body.clientTurnId.trim()
    ? body.clientTurnId.trim().slice(0, TURN_ID_MAX)
    : null;

  // Idempotent retry: the unique (conversationId, clientTurnId) index turns a
  // duplicate append into a P2002; resolve it to the existing turn.
  try {
    const message = await db.conversationMessage.create({
      data: { conversationId: conversation.id, role, content, metaJson, clientTurnId },
    });
    await db.conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });
    return NextResponse.json({ message: toWire(message), appended: true }, { status: 201 });
  } catch (err) {
    if ((err as { code?: string }).code !== "P2002") throw err;
    const existing = await db.conversationMessage.findUnique({
      where: { conversationId_clientTurnId: { conversationId: conversation.id, clientTurnId: clientTurnId as string } },
    });
    if (!existing) return NextResponse.json({ error: "Turn append conflict." }, { status: 409 });
    return NextResponse.json({ message: toWire(existing), appended: false });
  }
}
