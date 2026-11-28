import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { readLutForProject, deleteLutFile } from "@/lib/editor/lut-store";
import { ProjectNotFoundError } from "@/lib/editor/persistence";

export const dynamic = "force-dynamic";

/** GET /api/editor/projects/[projectId]/luts/[lutId] — serve the cube text
 *  (preview WebGL texture + render bridge). Ownership + registry membership
 *  required; unknown luts answer the same 404 (no existence leak). */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ projectId: string; lutId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { projectId, lutId } = await ctx.params;
  try {
    const cube = await readLutForProject(projectId, user.id, lutId);
    return new NextResponse(cube, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ error: "LUT not found." }, { status: 404 });
    }
    return NextResponse.json({ error: "Failed to read LUT." }, { status: 500 });
  }
}

/** DELETE — remove the stored cube for a lutId the caller owns and that is
 *  no longer referenced by the sequence registry (cleanup after RemoveLut). */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ projectId: string; lutId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { projectId, lutId } = await ctx.params;
  try {
    // readLutForProject performs BOTH checks before we touch the filesystem.
    await readLutForProject(projectId, user.id, lutId);
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ error: "LUT not found." }, { status: 404 });
    }
    return NextResponse.json({ error: "Failed to remove LUT." }, { status: 500 });
  }
  await deleteLutFile(projectId, lutId);
  return NextResponse.json({ ok: true });
}
