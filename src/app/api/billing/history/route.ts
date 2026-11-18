/**
 * M25 P2 — billing history: the user's own billing events (no amounts —
 * payments are disabled; events record plan lifecycle only).
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { unauthorized } from "@/lib/process-helpers";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const events = await db.billingEvent.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, type: true, detailJson: true, createdAt: true },
  });
  return NextResponse.json({ events });
}
