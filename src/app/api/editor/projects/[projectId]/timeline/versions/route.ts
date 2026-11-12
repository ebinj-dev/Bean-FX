import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listTimelineVersions, ProjectNotFoundError } from "@/lib/editor/persistence";

export const dynamic = "force-dynamic";

/** GET — version history (newest first, paginated). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ projectId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { projectId } = await ctx.params;
  const url = new URL(req.url);
  const take = Number(url.searchParams.get("take") ?? "50");
  const skip = Number(url.searchParams.get("skip") ?? "0");
  try {
    const versions = await listTimelineVersions(projectId, user.id, Number.isFinite(take) ? take : 50, Number.isFinite(skip) ? skip : 0);
    return NextResponse.json({ versions });
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ error: "Project not found." }, { status: 404 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to list versions." }, { status: 500 });
  }
}
