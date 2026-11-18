import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import {
  ProjectNotFoundError,
  restoreTimelineVersion,
  VersionConflictError,
} from "@/lib/editor/persistence";

export const dynamic = "force-dynamic";

/** POST — rollback to an older version as a NEW append-only version.
 *  Body: { versionNumber: number, baseVersion: number } */
export async function POST(req: NextRequest, ctx: { params: Promise<{ projectId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { projectId } = await ctx.params;
  const body = await req.json().catch(() => null);
  const versionNumber = Number((body as { versionNumber?: unknown } | null)?.versionNumber);
  const baseVersion = Number((body as { baseVersion?: unknown } | null)?.baseVersion);
  if (!Number.isInteger(versionNumber) || versionNumber < 1 || !Number.isInteger(baseVersion) || baseVersion < 1) {
    return NextResponse.json({ error: "versionNumber and baseVersion must be positive integers." }, { status: 400 });
  }
  try {
    const result = await restoreTimelineVersion(projectId, user.id, versionNumber, baseVersion);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof VersionConflictError) {
      return NextResponse.json({ error: err.message, headVersion: err.headVersion, sequence: err.headSequence }, { status: 409 });
    }
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ error: "Project not found." }, { status: 404 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "Restore failed." }, { status: 400 });
  }
}
