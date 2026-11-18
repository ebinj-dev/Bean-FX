import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import {
  applyTimelineEdits,
  getTimelineHead,
  ProjectNotFoundError,
  VersionConflictError,
} from "@/lib/editor/persistence";
import { parseCommand } from "@/lib/editor/commands";

export const dynamic = "force-dynamic";

/** GET /api/editor/projects/[projectId]/timeline — head version + sequence. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ projectId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { projectId } = await ctx.params;
  try {
    const head = await getTimelineHead(projectId, user.id);
    return NextResponse.json({ version: head.version, sequence: head.sequence, isAutosave: head.isAutosave });
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ error: "Project not found." }, { status: 404 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to load timeline." }, { status: 500 });
  }
}

/** POST — apply a batch of validated commands as the next version.
 *  Body: { baseVersion: number, edits: Command[], isAutosave?: boolean }
 *  409 on stale baseVersion (conflict carries the authoritative head). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ projectId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { projectId } = await ctx.params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Request body must be a JSON object." }, { status: 400 });
  }
  const baseVersion = Number((body as { baseVersion?: unknown }).baseVersion);
  if (!Number.isInteger(baseVersion) || baseVersion < 1) {
    return NextResponse.json({ error: "baseVersion must be a positive integer — GET the head first." }, { status: 400 });
  }
  const edits = (body as { edits?: unknown[] }).edits;
  if (!Array.isArray(edits) || edits.length === 0) {
    return NextResponse.json({ error: "edits must be a non-empty array of commands." }, { status: 400 });
  }
  // Validate every command up front so malformed payloads fail before any
  // write attempt (structured error naming the offending index).
  for (let i = 0; i < edits.length; i++) {
    try {
      parseCommand(edits[i]);
    } catch (err) {
      return NextResponse.json(
        { error: `edits[${i}] is invalid: ${err instanceof Error ? err.message : "unknown"}` },
        { status: 400 },
      );
    }
  }
  const isAutosave = Boolean((body as { isAutosave?: unknown }).isAutosave);
  try {
    const result = await applyTimelineEdits(projectId, user.id, baseVersion, edits, isAutosave);
    return NextResponse.json({ version: result.version, sequence: result.sequence, warnings: result.warnings, isAutosave: result.isAutosave });
  } catch (err) {
    if (err instanceof VersionConflictError) {
      return NextResponse.json(
        { error: err.message, headVersion: err.headVersion, sequence: err.headSequence },
        { status: 409 },
      );
    }
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ error: "Project not found." }, { status: 404 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to apply edits." }, { status: 400 });
  }
}
