/**
 * M10 API — Creator Assistant (§8).
 * POST /api/creative/assistant {projectId, message, language?}
 * One project-aware turn: typed intent routing, evidence-backed replies,
 * durable full-review enqueue when needed. Errors are honest (provider
 * unavailability is never answered with canned fake analysis).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/process-helpers";
import { runAssistantTurn } from "@/lib/creative/assistant";

export const runtime = "nodejs";

const Schema = z.object({
  projectId: z.string().min(1).max(64),
  message: z.string().min(1).max(2000),
  language: z.enum(["en", "ta"]).default("en"),
});

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const project = await db.project.findUnique({ where: { id: parsed.data.projectId } });
  if (!project || project.userId !== user.id) return badRequest("Project not found or not owned by the caller.");
  try {
    const turn = await runAssistantTurn(user.id, parsed.data.projectId, parsed.data.message, parsed.data.language, { enqueueEvidence: true });
    return NextResponse.json(turn);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Assistant turn failed.";
    const unavailable = /not configured|LLM|provider|TIMEOUT/i.test(message);
    return NextResponse.json({ error: message, unavailable }, { status: unavailable ? 503 : 500 });
  }
}
