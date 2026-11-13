/**
 * MY AI — approval system (M8 §8).
 *
 * Every plan is born AWAITING_APPROVAL: timeline mutations, generation,
 * export — all are gated (§8 rules). approve/reject/expire/cancel with
 * ownership checks, TTL expiry, audit rows. The executor re-checks status
 * before EVERY step, so a revoked/expired plan cannot run to completion.
 */
import { db } from "@/lib/db";

export const PLAN_TTL_MS = Number(process.env.BEANFX_MYAI_PLAN_TTL_MS ?? 30 * 60_000);

export interface PlanRow {
  id: string;
  userId: string;
  projectId: string | null;
  status: string;
  expiresAt: Date | null;
  stepsJson: string;
  resultJson: string | null;
  contextVersion: string | null;
}

export async function loadOwnedPlan(planId: string, userId: string): Promise<PlanRow | null> {
  const row = await db.aIPlan.findFirst({ where: { id: planId, userId } });
  if (!row) return null;
  return row as unknown as PlanRow;
}

/** Expire plans past their TTL (idempotent sweep; called on read/execute). */
export async function expireStalePlans(): Promise<number> {
  const res = await db.aIPlan.updateMany({
    where: { status: { in: ["DRAFT", "AWAITING_APPROVAL", "APPROVED", "QUEUED"] }, expiresAt: { lt: new Date() } },
    data: { status: "EXPIRED" },
  });
  return res.count;
}

export async function approvePlan(planId: string, userId: string): Promise<{ ok: boolean; error?: string; status?: string }> {
  await expireStalePlans();
  const plan = await loadOwnedPlan(planId, userId);
  if (!plan) return { ok: false, error: "Plan not found or not owned by the caller." };
  if (plan.status === "EXPIRED") return { ok: false, error: "Plan expired — create a fresh plan." };
  if (plan.status !== "AWAITING_APPROVAL" && plan.status !== "DRAFT") {
    return { ok: false, error: `Plan cannot be approved from status ${plan.status}.` };
  }
  await db.aIPlan.update({ where: { id: planId }, data: { status: "APPROVED" } });
  await db.automationAudit.create({
    data: { userId, projectId: plan.projectId, action: "PLAN_APPROVED", detailJson: JSON.stringify({ planId }) },
  });
  return { ok: true, status: "APPROVED" };
}

export async function rejectPlan(planId: string, userId: string, reason?: string): Promise<{ ok: boolean; error?: string }> {
  const plan = await loadOwnedPlan(planId, userId);
  if (!plan) return { ok: false, error: "Plan not found or not owned by the caller." };
  if (["RUNNING", "COMPLETED", "FAILED", "PARTIALLY_COMPLETED"].includes(plan.status)) {
    return { ok: false, error: `Plan cannot be rejected from status ${plan.status} — cancel instead.` };
  }
  await db.aIPlan.update({ where: { id: planId }, data: { status: "CANCELLED" } });
  await db.automationAudit.create({
    data: { userId, projectId: plan.projectId, action: "PLAN_REJECTED", detailJson: JSON.stringify({ planId, reason: (reason ?? "").slice(0, 200) }) },
  });
  return { ok: true };
}

export async function cancelPlan(planId: string, userId: string): Promise<{ ok: boolean; error?: string }> {
  const plan = await loadOwnedPlan(planId, userId);
  if (!plan) return { ok: false, error: "Plan not found or not owned by the caller." };
  if (!["AWAITING_APPROVAL", "APPROVED", "QUEUED", "RUNNING"].includes(plan.status)) {
    return { ok: false, error: `Plan cannot be cancelled from status ${plan.status}.` };
  }
  await db.aIPlan.update({ where: { id: planId }, data: { status: "CANCELLED" } });
  await db.automationAudit.create({
    data: { userId, projectId: plan.projectId, action: "PLAN_CANCELLED", detailJson: JSON.stringify({ planId }) },
  });
  return { ok: true };
}

/** The §8 approval display: what will happen, engines, affected assets, risk. */
export function planApprovalSummary(stepsJson: string, warningsJson: string | null, engines: string | null): {
  steps: { id: string; operation: string; title: string; risk: string; description: string; readsAssetIds: string[]; writesAssetIds: string[] }[];
  warnings: string[];
  engines: string[];
  externalCalls: { engine: string; kind: string }[];
} {
  const steps = JSON.parse(stepsJson) as Array<{ id: string; operation: string; title: string; risk: string; description: string; readsAssetIds: string[]; writesAssetIds: string[] }>;
  const warnings = warningsJson ? (JSON.parse(warningsJson) as string[]) : [];
  const engineList = engines ? (JSON.parse(engines) as string[]) : [];
  const externalCalls = steps
    .filter((s) => s.risk === "generation")
    .map((s) => ({ engine: s.operation.startsWith("JAZMII") ? "JAZMII" : s.operation.startsWith("LAXII") ? "LAXII" : s.operation.startsWith("GANGZII") ? "GANGZII" : "NIIKI", kind: s.operation }));
  return { steps, warnings, engines: engineList, externalCalls };
}
