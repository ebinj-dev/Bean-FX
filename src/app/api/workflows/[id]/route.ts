/**
 * M26 P7 — single workflow run: GET ticks the run (dispatch next / poll job /
 * surface approvals — durable state in WorkflowRun), POST performs actions:
 *   { action: "approve", stepId }   — pass an approval gate
 *   { action: "cancel" }            — cancel run + its waiting job
 *   { action: "retry-step", stepId }— re-dispatch a failed whitelisted step
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { unauthorized, badRequest } from "@/lib/process-helpers";
import { tickWorkflow, approveStep, cancelWorkflow, retryStep, parseRun } from "@/lib/workflows/executor";

export const runtime = "nodejs";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const run = await db.workflowRun.findFirst({ where: { id, userId: user.id } });
  if (!run) return badRequest("Workflow run not found.");
  // GET ticks: every poll advances the run honestly (dispatch/poll/approvals).
  const result = await tickWorkflow(user.id, id).catch((err: unknown) => ({ status: "FAILED", error: err instanceof Error ? err.message : "tick failed" }));
  const fresh = await db.workflowRun.findUniqueOrThrow({ where: { id } });
  const state = parseRun(fresh);
  return NextResponse.json({
    run: {
      id: fresh.id,
      templateId: fresh.templateId,
      name: fresh.name,
      projectId: fresh.projectId,
      status: fresh.status,
      error: fresh.error,
      createdAt: fresh.createdAt,
      updatedAt: fresh.updatedAt,
      steps: state.steps.map((s) => ({ id: s.id, kind: s.kind, label: s.label, status: s.status, stepError: s.stepError, approvalRequired: !!s.approvalRequired })),
    },
  });
}

const ActionSchema = z.object({
  action: z.enum(["approve", "cancel", "retry-step"]),
  stepId: z.string().max(64).optional(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const parsed = ActionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("action required.");
  try {
    if (parsed.data.action === "cancel") {
      const r = await cancelWorkflow(user.id, id);
      return NextResponse.json(r);
    }
    if (!parsed.data.stepId) return badRequest("stepId required for this action.");
    const r =
      parsed.data.action === "approve"
        ? await approveStep(user.id, id, parsed.data.stepId)
        : await retryStep(user.id, id, parsed.data.stepId);
    return NextResponse.json(r);
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : "Action failed.");
  }
}
