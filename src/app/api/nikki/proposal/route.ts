/**
 * NIIKI API — POST /api/nikki/proposal   (MY AI interface, M6 §11)
 *
 * Maps a natural-language instruction to structured COMMAND proposals
 * (deterministic intent table — no LLM inside NIIKI). The proposal is
 * returned, never executed: the caller applies the commands through the
 * editor session, where applyCommand re-validates everything and produces
 * undoable, autosaved edits.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, notFound, unauthorized } from "@/lib/process-helpers";
import { parseSequence } from "@/lib/editor/model";
import { proposeNikki, type ProposalContext } from "@/lib/nikki/proposal";

const Schema = z.object({
  sequence: z.unknown(),
  instruction: z.string().min(1).max(500),
  selectedClipId: z.string().max(64).nullable().default(null),
  atFrame: z.number().int().min(0).default(0),
});

export const runtime = "nodejs";

let counter = 0;
const newId = (kind: "clip" | "track" | "graphic"): string =>
  `nikki-${kind}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("Invalid request: sequence and instruction required.");

  let seq;
  try {
    seq = parseSequence(parsed.data.sequence);
  } catch (err) {
    return badRequest(`Invalid sequence snapshot: ${err instanceof Error ? err.message : "validation failed"}`);
  }

  const selected = parsed.data.selectedClipId
    ? seq.clips.find((c) => c.id === parsed.data.selectedClipId) ?? null
    : null;

  const ctx: ProposalContext = {
    seqFps: seq.fps,
    seqWidth: seq.width,
    seqHeight: seq.height,
    newId,
    atFrame: Math.min(parsed.data.atFrame, Math.max(0, Math.ceil(
      seq.clips.reduce((m, c) => Math.max(m, c.timelineStartFrame + c.timelineDurationFrames), 0),
    ))),
    availableFrames: Math.max(
      Math.round(24),
      Math.ceil(
        seq.clips.reduce((m, c) => Math.max(m, c.timelineStartFrame + c.timelineDurationFrames), 0),
      ) - parsed.data.atFrame,
    ),
    selectedGraphicClipId: selected?.graphicStyle ? selected.id : null,
    selectedGraphicStyle: selected?.graphicStyle ?? null,
  };

  const proposal = proposeNikki(parsed.data.instruction, ctx);
  if (!proposal || proposal.commands.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "No NIIKI intent matched that instruction. Supported examples: make these captions appear word by word, create a professional lower third, animate this title from the left, make the title larger and fade out, highlight \"word\".",
      },
      { status: 422 },
    );
  }
  return NextResponse.json({ ok: true, proposal });
}
