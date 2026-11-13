/**
 * Studio batch production — POST (dispatch), GET (status), DELETE (cancel).
 * M8.1 §11: validated dispatch onto the EXISTING durable queue.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/process-helpers";
import { db } from "@/lib/db";
import { StudioBriefSchema } from "@/lib/studio/brief";
import { dispatchBatch, batchStatus, cancelBatch } from "@/lib/studio/batch";

export const runtime = "nodejs";
export const maxDuration = 120;

const DispatchSchema = z.object({
  sharedBrief: StudioBriefSchema.nullable().default(null),
  topics: z.array(z.string().min(3).max(300)).min(1).max(10),
  batchId: z.string().max(64).nullable().default(null),
});

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const parsed = DispatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid batch request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  if (!parsed.data.sharedBrief) return badRequest("sharedBrief (validated brief with defaults) is required.");
  try {
    const r = await dispatchBatch(user.id, parsed.data.sharedBrief, parsed.data.topics);
    return NextResponse.json({ ...r, disclosure: "Each topic runs as a durable job; scene planning uses the LLM provider when configured. Asset generation requires separate approval per plan." });
  } catch (err) {
    return badRequest(err instanceof Error ? err.message.slice(0, 300) : "batch dispatch failed");
  }
}

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const batchId = req.nextUrl.searchParams.get("batchId");
  if (!batchId) {
    const batches = await db.studioBatch.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, status: true, topicsJson: true, createdAt: true, updatedAt: true },
    });
    return NextResponse.json({ batches: batches.map((b) => ({ ...b, topics: JSON.parse(b.topicsJson) as string[], topicsJson: undefined })) });
  }
  try {
    return NextResponse.json(await batchStatus(user.id, batchId));
  } catch (err) {
    return badRequest(err instanceof Error ? err.message.slice(0, 200) : "batch status failed");
  }
}

export async function DELETE(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const batchId = req.nextUrl.searchParams.get("batchId");
  if (!batchId) return badRequest("batchId required.");
  try {
    return NextResponse.json(await cancelBatch(user.id, batchId));
  } catch (err) {
    return badRequest(err instanceof Error ? err.message.slice(0, 200) : "batch cancel failed");
  }
}
