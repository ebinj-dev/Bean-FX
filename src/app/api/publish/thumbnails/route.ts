/**
 * M9 API — thumbnail drafts (§3).
 * GET  /api/publish/thumbnails?projectId=…          list drafts for a project
 * POST /api/publish/thumbnails                      create/ensure draft {projectId, platform(profileId), prompt?}
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/process-helpers";
import { getExportProfile } from "@/lib/publish/profiles";

export const runtime = "nodejs";

const CreateSchema = z.object({
  projectId: z.string().min(1).max(64),
  platform: z.string().min(2).max(40),
  prompt: z.string().max(400).default(""),
});

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const projectId = new URL(req.url).searchParams.get("projectId");
  if (!projectId) return badRequest("projectId is required.");
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project || project.userId !== user.id) return badRequest("Project not found or not owned by the caller.");
  const drafts = await db.thumbnailDraft.findMany({ where: { userId: user.id, projectId }, orderBy: { updatedAt: "desc" } });
  return NextResponse.json({
    drafts: drafts.map((d) => ({
      id: d.id,
      platform: d.platform,
      status: d.status,
      prompt: d.prompt,
      layout: d.layoutJson ? JSON.parse(d.layoutJson) : null,
      candidateIds: d.candidateIdsJson ? (JSON.parse(d.candidateIdsJson) as string[]) : [],
      selectedAssetId: d.selectedAssetId,
      compositedAssetId: d.compositedAssetId,
      provenance: d.provenanceJson ? JSON.parse(d.provenanceJson) : null,
      error: d.error,
      jobId: d.jobId,
      updatedAt: d.updatedAt.toISOString(),
    })),
  });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const parsed = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const project = await db.project.findUnique({ where: { id: parsed.data.projectId } });
  if (!project || project.userId !== user.id) return badRequest("Project not found or not owned by the caller.");
  if (!getExportProfile(parsed.data.platform)) return badRequest(`Unknown platform profile "${parsed.data.platform}".`);
  const draft = await db.thumbnailDraft.upsert({
    where: { projectId_platform: { projectId: parsed.data.projectId, platform: parsed.data.platform } },
    create: { userId: user.id, projectId: parsed.data.projectId, platform: parsed.data.platform, prompt: parsed.data.prompt },
    update: { prompt: parsed.data.prompt || undefined },
  });
  return NextResponse.json({ draft: { id: draft.id, platform: draft.platform, status: draft.status, prompt: draft.prompt } }, { status: 201 });
}
