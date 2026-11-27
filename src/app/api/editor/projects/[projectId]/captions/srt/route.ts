import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getTimelineHead } from "@/lib/editor/persistence";
import { ProjectNotFoundError } from "@/lib/editor/persistence";
import { sequenceToSrt } from "@/lib/editor/captions";

export const runtime = "nodejs";

/**
 * M48-F — SRT caption sidecar for the project's canonical timeline head.
 * Generated from CAPTION-track clips at request time (never cached stale):
 * 404 without leaking existence for non-viewable projects, empty SRT (with
 * honest zero cues) when the timeline has no captions.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ projectId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { projectId } = await ctx.params;
  try {
    const head = await getTimelineHead(projectId, user.id);
    const srt = sequenceToSrt(head.sequence);
    return new NextResponse(srt, {
      headers: {
        "Content-Type": "application/x-subrip; charset=utf-8",
        "Content-Disposition": `attachment; filename="captions-${projectId}.srt"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ error: "Project not found or not viewable." }, { status: 404 });
    }
    return NextResponse.json({ error: "SRT export failed." }, { status: 500 });
  }
}
