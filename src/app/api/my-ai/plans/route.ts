/**
 * MY AI plans API — POST /api/my-ai/plans (create), GET (list).
 * Plan approval/execution lives on the [planId] route.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, notFound, unauthorized } from "@/lib/process-helpers";
import { createPlan } from "@/lib/my-ai/planner/planner";
import { expireStalePlans } from "@/lib/my-ai/approvals";

const CreateSchema = z.object({
  projectId: z.string().min(1).max(64),
  request: z.string().min(3).max(500),
  conversationId: z.string().max(64).nullable().default(null),
});

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const parsed = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("Invalid plan request.");
  const owned = await db.project.findFirst({ where: { id: parsed.data.projectId, userId: user.id } });
  if (!owned) return notFound();
  const result = await createPlan(user.id, parsed.data.projectId, parsed.data.request, parsed.data.conversationId);
  return NextResponse.json({
    planId: result.plan.planId,
    mode: result.mode,
    note: result.note,
    plan: { engines: result.plan.engines, steps: result.plan.steps.length, warnings: result.plan.warnings, expectedChanges: result.plan.expectedChanges, estimatedUsage: result.plan.estimatedUsage, contextVersion: result.plan.contextVersion },
  });
}

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  await expireStalePlans();
  const projectId = req.nextUrl.searchParams.get("projectId");
  const plans = await db.aIPlan.findMany({
    where: { userId: user.id, ...(projectId ? { projectId } : {}) },
    orderBy: { updatedAt: "desc" },
    take: 20,
    select: { id: true, projectId: true, status: true, requestSummary: true, plannerMode: true, engines: true, createdAt: true, updatedAt: true, expiresAt: true },
  });
  return NextResponse.json({ plans });
}
