/**
 * MY AI plan detail + lifecycle — /api/my-ai/plans/[planId]
 * GET (status + approval summary or results), POST (approve | execute | cancel).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, notFound, unauthorized } from "@/lib/process-helpers";
import { approvePlan, cancelPlan, expireStalePlans, loadOwnedPlan, planApprovalSummary } from "@/lib/my-ai/approvals";
import { executePlan } from "@/lib/my-ai/execution/executor";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 300;

const ActionSchema = z.object({ action: z.enum(["approve", "execute", "cancel"]) });

export async function GET(_req: NextRequest, ctx: { params: Promise<{ planId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  await expireStalePlans();
  const { planId } = await ctx.params;
  const row = await loadOwnedPlan(planId, user.id);
  if (!row) return notFound();
  const dbRow = await db.aIPlan.findUnique({ where: { id: planId } });
  const approval = row.status === "AWAITING_APPROVAL" ? planApprovalSummary(row.stepsJson, null, null) : null;
  return NextResponse.json({
    planId: row.id,
    status: row.status,
    projectId: row.projectId,
    contextVersion: row.contextVersion,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    approvalSummary: approval,
    result: dbRow?.resultJson ? JSON.parse(dbRow.resultJson) : null,
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ planId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { planId } = await ctx.params;
  const parsed = ActionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("action must be approve | execute | cancel");
  if (parsed.data.action === "approve") {
    const r = await approvePlan(planId, user.id);
    return r.ok ? NextResponse.json({ ok: true, status: r.status }) : badRequest(r.error ?? "approval failed");
  }
  if (parsed.data.action === "cancel") {
    const r = await cancelPlan(planId, user.id);
    return r.ok ? NextResponse.json({ ok: true }) : badRequest(r.error ?? "cancel failed");
  }
  const report = await executePlan(planId, user.id);
  return NextResponse.json(report);
}
