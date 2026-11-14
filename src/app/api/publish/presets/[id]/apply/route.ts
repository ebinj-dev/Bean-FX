/**
 * M9 API — brand preset apply (§5).
 * GET    /api/publish/presets/[id]/apply?projectId=…   preview (no writes)
 * POST   /api/publish/presets/[id]/apply               apply — requires {"projectId","confirm":"apply"}
 * DELETE /api/publish/presets/[id]/apply?projectId=…   revert the last apply (audit-backed)
 */
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, notFound, unauthorized } from "@/lib/process-helpers";
import { applyPreset, previewPresetApply, revertLastPresetApply } from "@/lib/publish/presets";

export const runtime = "nodejs";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const projectId = new URL(req.url).searchParams.get("projectId");
  if (!projectId) return badRequest("projectId is required.");
  try {
    const preview = await previewPresetApply(user.id, id, projectId);
    return NextResponse.json({ preview });
  } catch (err) {
    if (err instanceof Error && err.message.includes("not found")) return notFound();
    return badRequest(err instanceof Error ? err.message : "Preview failed.");
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { projectId?: string; confirm?: string } | null;
  if (!body?.projectId) return badRequest("projectId is required.");
  if (body.confirm !== "apply") return badRequest("Explicit confirmation required: send {\"confirm\":\"apply\"} after reviewing the preview. Presets never silently modify approved project content.");
  try {
    const result = await applyPreset(user.id, id, body.projectId);
    return NextResponse.json({ applied: true, preview: result });
  } catch (err) {
    if (err instanceof Error && err.message.includes("not found")) return notFound();
    return badRequest(err instanceof Error ? err.message : "Apply failed.");
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  await ctx.params;
  const projectId = new URL(req.url).searchParams.get("projectId");
  if (!projectId) return badRequest("projectId is required.");
  try {
    const result = await revertLastPresetApply(user.id, projectId);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof Error && err.message.includes("not found")) return notFound();
    return badRequest(err instanceof Error ? err.message : "Revert failed.");
  }
}
