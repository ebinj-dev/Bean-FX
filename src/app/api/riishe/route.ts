import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { runRiisheInference, validateRiisheInput, isProviderUnavailable } from "@/lib/riishe-inference";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * RIISHE — content-aware editing intelligence (spec §6).
 *
 * This endpoint is a thin compatibility wrapper around the ONE shared
 * inference implementation (src/lib/riishe-inference.ts). The unified
 * pipeline (/api/autocut/analyze) calls the same function as its stage 9 —
 * there is no second inference code path. When the provider is unavailable
 * or returns malformed output, the endpoint returns an explicit failure; the
 * client keeps the deterministic audio-evidence classification clearly
 * labeled as such. No fake inference.
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  const parsed = validateRiisheInput(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: `Invalid RIISHE request: ${parsed.error.issues.map((i) => i.message).join("; ")}` },
      { status: 400 }
    );
  }
  if (parsed.data.candidates.length === 0) {
    return NextResponse.json({ error: "No candidate ranges supplied for inference." }, { status: 400 });
  }

  try {
    const out = await runRiisheInference(parsed.data);
    return NextResponse.json({
      ok: true,
      model: out.model,
      suggestions: out.suggestions,
      summary: out.summary,
      candidatesClassified: out.candidatesClassified,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown inference error.";
    console.error("[riishe]", message);
    return NextResponse.json(
      {
        error: `RIISHE inference ${isProviderUnavailable(err) ? "unavailable" : "failed"}: ${message}. Deterministic suggestions remain available.`,
        unavailable: isProviderUnavailable(err),
      },
      { status: 502 }
    );
  }
}
