/**
 * M11 API — one transcript version: approve (→ NEW SRT asset) / discard (§4).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, notFound, unauthorized } from "@/lib/process-helpers";
import { approveTranscript, discardTranscript } from "@/lib/creative/transcription";

export const runtime = "nodejs";

const PatchSchema = z.object({ action: z.enum(["approve", "discard"]), applyCaptions: z.boolean().default(true) });

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const owned = await db.transcriptVersion.findUnique({ where: { id } });
  if (!owned || owned.userId !== user.id) return notFound();
  try {
    if (parsed.data.action === "discard") {
      await discardTranscript(user.id, id);
      return NextResponse.json({ ok: true, status: "DISCARDED" });
    }
    const result = await approveTranscript(user.id, id, parsed.data.applyCaptions);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof Error && err.message.includes("not found")) return notFound();
    return badRequest(err instanceof Error ? err.message : "Transcript action failed.");
  }
}
