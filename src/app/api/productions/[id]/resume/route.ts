/**
 * M31 — resume a production from its last verified checkpoint. RUNNING stages
 * are re-derived (never trusted); SUCCEEDED stages never re-run; provider
 * calls are never duplicated (asset rows keep their state).
 */
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { ProductionError, resumeProduction } from "@/lib/production/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const r = await resumeProduction(id, user.id);
    return NextResponse.json(r);
  } catch (err) {
    if (err instanceof ProductionError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    throw err;
  }
}
