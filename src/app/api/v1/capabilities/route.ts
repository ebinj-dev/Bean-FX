/**
 * M21 P2 — GET /api/v1/capabilities
 * Capability discovery (M21 spec §12). Open to any authenticated surface
 * (session OR integration token) — no secrets, no user data.
 */
import { NextRequest, NextResponse } from "next/server";
import { SERVER_CAPABILITIES } from "@/lib/core/types";
import { apiVersionGuard, verifyIntegrationToken } from "@/lib/integration-tokens";
import { getCurrentUser } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const guard = apiVersionGuard(req.headers.get("x-beanfx-api-version"));
  if (!guard.ok) {
    return NextResponse.json({ code: guard.code, error: guard.error }, { status: guard.status });
  }
  const bearer = req.headers.get("authorization");
  const auth = bearer ? await verifyIntegrationToken(bearer) : null;
  if (!auth) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ code: "UNAUTHORIZED", error: "Sign in or present an integration token." }, { status: 401 });
  }
  return NextResponse.json(SERVER_CAPABILITIES);
}
