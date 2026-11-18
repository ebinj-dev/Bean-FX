/**
 * M25 P2 — plan catalog (authenticated): honest entitlements, no prices,
 * paymentsEnabled:false until the owner authorizes a provider.
 */
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { unauthorized } from "@/lib/process-helpers";
import { PLAN_CATALOG, ensurePlans } from "@/lib/billing/entitlements";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  await ensurePlans();
  return NextResponse.json({
    plans: PLAN_CATALOG.map((p) => ({ id: p.id, name: p.name, sort: p.sort, entitlements: p.entitlements })),
    paymentsEnabled: false,
  });
}
