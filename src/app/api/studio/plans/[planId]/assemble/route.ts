/**
 * Assembly + export readiness — POST /api/studio/plans/[planId]/assemble
 * (M8.1 §10: approval-gated conversion of approved scenes into a real,
 * editable BEAN FX timeline through the M1 command engine).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, notFound, unauthorized } from "@/lib/process-helpers";
import { assembleStudioTimeline } from "@/lib/studio/assemble";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 300;

const AssembleSchema = z.object({
  /** Explicit approval token from the UI — assembly is a timeline mutation. */
  confirm: z.literal("assemble"),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ planId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { planId } = await ctx.params;
  const parsed = AssembleSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest('Assembly requires {"confirm":"assemble"} — it modifies the project timeline.');
  const plan = await db.studioPlan.findFirst({ where: { id: planId, userId: user.id } });
  if (!plan) return notFound();
  try {
    const report = await assembleStudioTimeline(user.id, planId);
    await db.automationAudit.create({
      data: { userId: user.id, projectId: report.projectId, action: "STUDIO_ASSEMBLED", detailJson: JSON.stringify({ planId, scenes: report.scenes.length, version: report.version, captionsMode: report.captionsMode }) },
    });
    return NextResponse.json({ ...report, next: "Open the project in the editor — every scene is a labeled clip; export via the render pipeline (NIKKI render)." });
  } catch (err) {
    return badRequest(err instanceof Error ? err.message.slice(0, 300) : "assembly failed");
  }
}
