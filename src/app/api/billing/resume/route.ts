/**
 * M25 P2 — resume a scheduled cancellation (undo cancel-at-period-end).
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { unauthorized, badRequest } from "@/lib/process-helpers";
import { ensureSubscription } from "@/lib/billing/entitlements";

export const runtime = "nodejs";

export async function POST() {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const current = await ensureSubscription(user.id);
  if (current.planId === "free") {
    return badRequest("The Free plan has no billing period to resume.");
  }
  if (!current.cancelAtPeriodEnd) return NextResponse.json({ unchanged: true, cancelAtPeriodEnd: false });
  const updated = await db.subscription.update({ where: { userId: user.id }, data: { cancelAtPeriodEnd: false, status: "ACTIVE" } });
  await db.billingEvent.create({ data: { userId: user.id, type: "CANCEL_RESUMED", detailJson: JSON.stringify({ planId: updated.planId }), subscriptionId: updated.id } });
  return NextResponse.json({ cancelAtPeriodEnd: false, status: updated.status });
}
