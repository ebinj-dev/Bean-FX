/**
 * M42-D — AI model registry API (authenticated).
 *
 * GET /api/ai/models — the probed model capability registry: real providers
 * and models with honest readiness, costs ("COST UNKNOWN" where unknown) and
 * configuration reasons. Requires a signed-in user (the registry describes
 * THIS deployment's configured providers; it never exposes credentials).
 */
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { probeModelRegistry } from "@/lib/ai/models";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const reg = probeModelRegistry();
  return NextResponse.json({ ...reg });
}
