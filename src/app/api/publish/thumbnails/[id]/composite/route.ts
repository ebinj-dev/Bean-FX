/**
 * M9 API — composite thumbnail overlay (§3).
 * POST /api/publish/thumbnails/[id]/composite {layout}
 * Applies the editable title overlay to the SELECTED base image at the
 * platform's thumbnail dimensions and registers a NEW asset (never
 * overwrites). Synchronous — compositing is fast (PIL), unlike generation.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, notFound, unauthorized } from "@/lib/process-helpers";
import { ThumbnailLayoutSchema } from "@/lib/publish/thumbnails";
import { compositeAndRegisterThumbnail } from "@/lib/publish/jobs";

export const runtime = "nodejs";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const parsed = z.object({ layout: ThumbnailLayoutSchema }).strict().safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid layout: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  try {
    const result = await compositeAndRegisterThumbnail(user.id, id, parsed.data.layout);
    return NextResponse.json({ ok: true, assetId: result.assetId, width: result.dims.width, height: result.dims.height });
  } catch (err) {
    if (err instanceof Error && err.message.includes("not found")) return notFound();
    return badRequest(err instanceof Error ? err.message : "Compositing failed.");
  }
}
