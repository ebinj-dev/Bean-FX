/**
 * MY AI provider health — GET /api/my-ai/health (M8 §4/§12).
 * Connection test: a REAL round trip against the configured LLM provider.
 */
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { unauthorized } from "@/lib/process-helpers";
import { llmHealth, myAiModel, myAiProviderId } from "@/lib/my-ai/gateway/provider";
import { usageSummary } from "@/lib/my-ai/gateway/usage";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const force = req.nextUrl.searchParams.get("force") === "1";
  const health = await llmHealth(force);
  return NextResponse.json({
    provider: myAiProviderId(),
    model: myAiModel(),
    ok: health.ok,
    detail: health.detail,
    cached: health.cached,
    usage: await usageSummary(user.id),
  });
}
