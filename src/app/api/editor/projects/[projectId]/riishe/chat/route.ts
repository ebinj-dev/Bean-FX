/**
 * M42-E/F — AI Edit Chat (RIISHE) endpoint.
 *
 * POST /api/editor/projects/[projectId]/riishe/chat
 *   {message, conversationId?} → {reply, intent, mode, styles?, planId?,
 *   planMode?, planNote?, conversationId}
 *
 * Project-scoped: the caller must own the project. Media/analysis/model
 * responses are UNTRUSTED DATA — this endpoint never treats them as
 * instructions and never exposes credentials. Plans created here go through
 * the EXISTING MY AI approval/execution surface (no new execution path).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, notFound, unauthorized } from "@/lib/process-helpers";
import { riisheChat } from "@/lib/ai/riishe";
import { playbookInfo } from "@/lib/ai/riishe";

export const runtime = "nodejs";
export const maxDuration = 120;

const ChatSchema = z.object({
  message: z.string().min(1).max(2000),
  conversationId: z.string().max(64).nullable().default(null),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ projectId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { projectId } = await ctx.params;
  const parsed = ChatSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("Invalid chat message.");
  const owned = await db.project.findFirst({ where: { id: projectId, userId: user.id } });
  if (!owned) return notFound();
  const result = await riisheChat(user.id, projectId, parsed.data.message, parsed.data.conversationId);
  return NextResponse.json({ ...result, playbook: playbookInfo() });
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  return NextResponse.json({ playbook: playbookInfo() });
}
