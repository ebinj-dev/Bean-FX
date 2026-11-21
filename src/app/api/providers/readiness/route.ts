/**
 * M32 Track E — provider readiness API: REAL probe results + capability
 * reports + honest cost state. No secrets, no fake READY.
 */
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { videoProviderReadiness, imageProviderReadiness, buildVideoCapabilityReport, buildImageCapabilityReport, READINESS_STATUSES } from "@/lib/providers/readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const [video, image] = await Promise.all([videoProviderReadiness(), imageProviderReadiness()]);
  return NextResponse.json({
    statuses: READINESS_STATUSES,
    video: { readiness: video, capabilities: buildVideoCapabilityReport() },
    image: { readiness: image, capabilities: buildImageCapabilityReport() },
  });
}
