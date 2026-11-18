/**
 * M25 P2 — cancel at period end. Access continues until the period rolls;
 * the account then moves to Free (no payments involved anywhere).
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
    return badRequest("The Free plan has no billing period to cancel.");
  }
  if (current.cancelAtPeriodEnd) return NextResponse.json({ unchanged: true, cancelAtPeriodEnd: true });
  const updated = await db.subscription.update({ where: { userId: user.id }, data: { cancelAtPeriodEnd: true } });
  await db.billingEvent.create({
    data: { userId: user.id, type: "CANCEL_SCHEDULED", detailJson: JSON.stringify({ planId: updated.planId, endsAt: updated.currentPeriodEnd, note: "access continues until the period ends; then the account moves to Free — no payments involved" }), subscriptionId: updated.id },
  });
  return NextResponse.json({ cancelAtPeriodEnd: true, status: updated.status, currentPeriodEnd: updated.currentPeriodEnd });
}
