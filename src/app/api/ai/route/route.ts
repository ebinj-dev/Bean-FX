/**
 * MY AI API — POST /api/ai/route  (M7 §10)
 * Deterministic intent routing across engines → typed proposal envelope.
 * Proposals are never executed here: commands are applied client-side via
 * the editor session (M1-validated); generation requests require explicit
 * approval and go through /api/jazmii/generate or /api/laxii/generate.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/process-helpers";
import { routeIntent } from "@/lib/ai/registry";

const Schema = z.object({
  instruction: z.string().min(1).max(500),
  fps: z.number().min(1).max(240).default(30),
  sequenceFrames: z.number().int().min(24).max(2_000_000).default(900),
  atFrame: z.number().int().min(0).max(2_000_000).default(0),
  texts: z.array(z.string().max(500)).max(40).default([]),
  selectedClipId: z.string().max(64).nullable().default(null),
});

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("Invalid routing payload.");

  const proposal = routeIntent(parsed.data.instruction, {
    fps: parsed.data.fps,
    sequenceFrames: parsed.data.sequenceFrames,
    atFrame: parsed.data.atFrame,
    texts: parsed.data.texts,
    selectedClipId: parsed.data.selectedClipId,
    newId: (kind) => `ai-${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
  });
  if (!proposal) {
    return NextResponse.json(
      {
        ok: false,
        error: "No engine matched that instruction. Supported: B-roll/cutaway suggestions (JAZMII), background/thumbnail/illustration/alternatives (LAXII), captions/lower thirds/titles (NIIKI), audio (GANGZII), cuts (RIISHE).",
      },
      { status: 422 },
    );
  }
  return NextResponse.json({ ok: true, proposal });
}
