/**
 * M25 P2 — billing: plan catalog + current subscription + usage.
 * GET /api/billing/plans        — the honest catalog (no prices: payments disabled)
 * GET /api/billing/subscription — current plan, entitlements, real usage, period
 * POST /api/billing/subscription— self-serve plan switch (payments-disabled aware)
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { unauthorized, badRequest } from "@/lib/process-helpers";
import { PLAN_CATALOG, ensurePlans, ensureSubscription, getPlanForUser, getUsage } from "@/lib/billing/entitlements";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { subscription, entitlements } = await getPlanForUser(user.id);
  const usage = await getUsage(user.id, subscription.currentPeriodStart);
  const plan = await db.subscriptionPlan.findUnique({ where: { id: subscription.planId } });
  return NextResponse.json({
    subscription: {
      planId: subscription.planId,
      planName: plan?.name ?? "Free",
      status: subscription.status,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      provider: subscription.provider,
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
    },
    entitlements,
    usage,
    paymentsEnabled: false,
  });
}

const SwitchSchema = z.object({ planId: z.string().min(1).max(40) });

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const parsed = SwitchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("planId required.");
  await ensurePlans();
  const target = PLAN_CATALOG.find((p) => p.id === parsed.data.planId && p.active);
  if (!target) return badRequest("Unknown plan.");
  const current = await ensureSubscription(user.id);
  if (target.id === current.planId) return NextResponse.json({ subscription: { planId: current.planId }, unchanged: true });

  // Payments are disabled: only self-serve, non-payment plans can be chosen.
  if (target.entitlements.requiresPayment || !target.entitlements.selfServe) {
    await db.billingEvent.create({
      data: { userId: user.id, type: "PAYMENTS_DISABLED_BLOCK", detailJson: JSON.stringify({ attempted: target.id, current: current.planId }) },
    });
    return NextResponse.json(
      { error: "Payments are not enabled on this deployment. Paid plans are assigned manually by the workspace owner.", code: "PAYMENTS_DISABLED", planId: target.id },
      { status: 403 },
    );
  }
  const updated = await db.subscription.update({
    where: { userId: user.id },
    data: { planId: target.id, status: "ACTIVE", cancelAtPeriodEnd: false },
  });
  await db.billingEvent.create({
    data: { userId: user.id, type: "PLAN_CHANGED_SELF_SERVE", detailJson: JSON.stringify({ from: current.planId, to: target.id }), subscriptionId: updated.id },
  });
  return NextResponse.json({ subscription: { planId: updated.planId, status: updated.status, cancelAtPeriodEnd: updated.cancelAtPeriodEnd } });
}
