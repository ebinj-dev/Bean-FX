/**
 * M25 P2/P7 — admin billing operations (server-gated by requireAdmin).
 * GET  /api/admin/billing — per-user subscription + period summary (safe fields)
 * POST /api/admin/billing — manually assign a plan by email; the ONLY path to
 *                           paid tiers while payments are disabled. Audited.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { badRequest } from "@/lib/process-helpers";
import { PLAN_CATALOG, ensurePlans, ensureSubscription, getUsage } from "@/lib/billing/entitlements";
import { clientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function GET() {
  try {
    const admin = await requireAdmin();
    await audit("admin.billing_listed", { userId: admin.id, ip: clientIp(new Request("http://x")) });
    await ensurePlans();
    const subs = await db.subscription.findMany({
      include: { user: { select: { id: true, email: true, name: true } }, plan: true },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });
    return NextResponse.json({
      subscriptions: subs.map((s) => ({
        userId: s.userId,
        email: s.user.email,
        name: s.user.name,
        planId: s.planId,
        planName: s.plan?.name ?? s.planId,
        status: s.status,
        cancelAtPeriodEnd: s.cancelAtPeriodEnd,
        currentPeriodEnd: s.currentPeriodEnd,
      })),
      plans: PLAN_CATALOG.map((p) => ({ id: p.id, name: p.name, requiresPayment: p.entitlements.requiresPayment })),
    });
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : "admin billing failed");
  }
}

const AssignSchema = z.object({ email: z.string().min(3).max(200), planId: z.string().min(1).max(40) });

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin();
    const parsed = AssignSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return badRequest("email and planId required.");
    await ensurePlans();
    const target = PLAN_CATALOG.find((p) => p.id === parsed.data.planId && p.active);
    if (!target) return badRequest("Unknown plan.");
    const user = await db.user.findUnique({ where: { email: parsed.data.email.toLowerCase() } });
    if (!user) return badRequest("User not found.");
    const current = await ensureSubscription(user.id);
    const updated = await db.subscription.update({
      where: { userId: user.id },
      data: { planId: target.id, status: "ACTIVE", cancelAtPeriodEnd: false, provider: "none" },
    });
    await db.billingEvent.create({
      data: { userId: user.id, type: "ADMIN_OVERRIDE", detailJson: JSON.stringify({ from: current.planId, to: target.id, byAdmin: admin.email, note: target.entitlements.requiresPayment ? "manual assignment — payments disabled on this deployment" : "assignment" }), subscriptionId: updated.id },
    });
    await audit("admin.billing_assigned", { userId: admin.id, detail: JSON.stringify({ target: user.email, planId: target.id }) });
    return NextResponse.json({ assigned: { userId: user.id, email: user.email, planId: updated.planId } });
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : "assignment failed");
  }
}
