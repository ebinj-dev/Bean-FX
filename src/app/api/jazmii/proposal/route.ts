/**
 * JAZMII API — POST /api/jazmii/proposal  (M7 §6B/§10)
 * Deterministic shot suggestions from project context. Proposals only —
 * nothing is generated or inserted without explicit user approval.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/process-helpers";
import { suggestShots } from "@/lib/jazmii/shots";
import { JazmiiShotSuggestionSchema } from "@/lib/jazmii/types";

const Schema = z.object({
  texts: z.array(z.string().max(500)).max(40).default([]),
  fps: z.number().min(1).max(240).default(30),
  sequenceFrames: z.number().int().min(24).max(2_000_000).default(900),
});

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("Invalid context payload.");

  const suggestions = suggestShots({ fps: parsed.data.fps, texts: parsed.data.texts, sequenceFrames: parsed.data.sequenceFrames });
  return NextResponse.json({ ok: true, suggestions: suggestions.map((s) => JazmiiShotSuggestionSchema.parse(s)) });
}
