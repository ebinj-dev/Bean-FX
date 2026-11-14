/**
 * M10 API — one recommendation: preview / approve+execute / reject (§5).
 * GET   /api/creative/recommendations/[id]                  fetch (payload + status)
 * PATCH /api/creative/recommendations/[id]                  {action:"preview"|"approve-execute"|"reject", note?}
 * Execution goes through the M1 engine + versioned persistence with stale
 * protection; nothing runs without the explicit approve-execute action.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, notFound, unauthorized } from "@/lib/process-helpers";
import { approveAndExecuteRecommendation, rejectRecommendation } from "@/lib/creative/recommendations";

export const runtime = "nodejs";

const PatchSchema = z.object({
  action: z.enum(["preview", "approve-execute", "reject"]),
  note: z.string().max(300).nullable().default(null),
});

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const rec = await db.creativeRecommendation.findUnique({ where: { id } });
  if (!rec || rec.userId !== user.id) return notFound();
  return NextResponse.json({
    recommendation: {
      id: rec.id,
      reviewId: rec.reviewId,
      recNo: rec.recNo,
      kind: rec.kind,
      engine: rec.engine,
      title: rec.title,
      detail: rec.detail,
      target: rec.targetJson ? JSON.parse(rec.targetJson) : null,
      payload: JSON.parse(rec.proposalJson),
      preview: rec.previewJson ? JSON.parse(rec.previewJson) : null,
      requiresApproval: rec.requiresApproval,
      status: rec.status,
      timelineVersionAtProposal: rec.timelineVersionAtProposal,
      executedVersion: rec.executedVersion,
      result: rec.resultJson ? JSON.parse(rec.resultJson) : null,
    },
  });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const owned = await db.creativeRecommendation.findUnique({ where: { id } });
  if (!owned || owned.userId !== user.id) return notFound();

  try {
    if (parsed.data.action === "preview") {
      const result = await approveAndExecuteRecommendation(user.id, id, true);
      return NextResponse.json({ ok: true, ...result });
    }
    if (parsed.data.action === "approve-execute") {
      const result = await approveAndExecuteRecommendation(user.id, id, false);
      return NextResponse.json({ ok: true, ...result });
    }
    await rejectRecommendation(user.id, id, parsed.data.note);
    return NextResponse.json({ ok: true, status: "REJECTED" });
  } catch (err) {
    if (err instanceof Error && err.message.includes("not found")) return notFound();
    return badRequest(err instanceof Error ? err.message : "Recommendation action failed.");
  }
}
