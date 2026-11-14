/**
 * M11 API — integrated transcription (§4).
 * POST /api/creative/analyze/transcribe              enqueue TRANSCRIBE_PROJECT
 * GET  /api/creative/analyze/transcripts?projectId=  transcript versions + staleness
 * PATCH /api/creative/analyze/transcripts/[id]       {action:"approve"|"discard", applyCaptions?}
 * Approval creates a NEW SRT asset; existing captions are never overwritten.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, notFound, unauthorized } from "@/lib/process-helpers";
import { enqueueTranscribeProject } from "@/lib/creative/multimodal-jobs";
import { approveTranscript, discardTranscript } from "@/lib/creative/transcription";

export const runtime = "nodejs";

const PostSchema = z.object({ projectId: z.string().min(1).max(64) });
const PatchSchema = z.object({ action: z.enum(["approve", "discard"]), applyCaptions: z.boolean().default(true) });

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const parsed = PostSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("projectId required.");
  const project = await db.project.findUnique({ where: { id: parsed.data.projectId } });
  if (!project || project.userId !== user.id) return badRequest("Project not found or not owned by the caller.");
  const { jobId } = await enqueueTranscribeProject(user.id, parsed.data.projectId);
  return NextResponse.json({ jobId }, { status: 202 });
}

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const projectId = new URL(req.url).searchParams.get("projectId");
  if (!projectId) return badRequest("projectId is required.");
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project || project.userId !== user.id) return badRequest("Project not found or not owned by the caller.");
  const rows = await db.transcriptVersion.findMany({ where: { userId: user.id, projectId }, orderBy: [{ updatedAt: "desc" }, { versionNo: "desc" }], take: 30 });
  return NextResponse.json({
    transcripts: rows.map((r) => ({
      id: r.id,
      sourceAssetId: r.sourceAssetId,
      versionNo: r.versionNo,
      language: r.language,
      provider: r.provider,
      wordsAvailable: r.wordsAvailable,
      segments: r.segmentsJson ? (JSON.parse(r.segmentsJson) as { start: number; end: number; text: string }[]).length : 0,
      textExcerpt: r.text.slice(0, 280),
      warnings: r.warningsJson ? (JSON.parse(r.warningsJson) as string[]) : [],
      status: r.status,
      staleReason: r.staleReason,
      captionAssetId: r.captionAssetId,
      createdAt: r.createdAt.toISOString(),
    })),
  });
}
