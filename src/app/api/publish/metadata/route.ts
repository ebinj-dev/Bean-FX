/**
 * M9 API — AI publishing metadata (§4).
 * GET  /api/publish/metadata?projectId=…[&platform=…]   list rows (draft + approved kept separate)
 * POST /api/publish/metadata                            generate/refresh a draft via MY AI
 *      {projectId, platform, language} → validated AI suggestions in draftJson
 *      (approvedJson untouched; provider unavailability = honest error)
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/process-helpers";
import { getExportProfile } from "@/lib/publish/profiles";
import { generatePublishFields, MetadataLanguage, PublishFieldsSchema, type MetadataDraft } from "@/lib/publish/metadata";

export const runtime = "nodejs";

const GenSchema = z.object({
  projectId: z.string().min(1).max(64),
  platform: z.string().min(2).max(40),
  language: MetadataLanguage.default("en"),
});

function serializeMeta(row: { id: string; projectId: string; platform: string; language: string; status: string; draftJson: string | null; approvedJson: string | null; provider: string | null; model: string | null; fieldHistoryJson: string | null; updatedAt: Date }) {
  return {
    id: row.id,
    projectId: row.projectId,
    platform: row.platform,
    language: row.language,
    status: row.status,
    draft: row.draftJson ? (JSON.parse(row.draftJson) as MetadataDraft) : null,
    approved: row.approvedJson ? (JSON.parse(row.approvedJson) as unknown) : null,
    provider: row.provider,
    model: row.model,
    fieldHistory: row.fieldHistoryJson ? (JSON.parse(row.fieldHistoryJson) as unknown[]) : [],
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const params = new URL(req.url).searchParams;
  const projectId = params.get("projectId");
  if (!projectId) return badRequest("projectId is required.");
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project || project.userId !== user.id) return badRequest("Project not found or not owned by the caller.");
  const platform = params.get("platform");
  const rows = await db.publishMetadata.findMany({
    where: { userId: user.id, projectId, ...(platform ? { platform } : {}) },
    orderBy: { updatedAt: "desc" },
  });
  return NextResponse.json({ metadata: rows.map(serializeMeta) });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const parsed = GenSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const { projectId, platform, language } = parsed.data;
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project || project.userId !== user.id) return badRequest("Project not found or not owned by the caller.");
  if (!getExportProfile(platform)) return badRequest(`Unknown platform profile "${platform}".`);

  const row = await db.publishMetadata.upsert({
    where: { projectId_platform: { projectId, platform } },
    create: { userId: user.id, projectId, platform, language, status: "DRAFT" },
    update: { language },
  });

  // Preserve any already-approved fields across regeneration (they win).
  const seedApproved = row.approvedJson ? (PublishFieldsSchema.safeParse(JSON.parse(row.approvedJson)).data ?? null) : null;

  try {
    const result = await generatePublishFields(user.id, projectId, platform, language, { seedApproved });
    const prevHistory = row.fieldHistoryJson ? (JSON.parse(row.fieldHistoryJson) as unknown[]) : [];
    const draft: MetadataDraft = {
      fields: result.fields,
      provenance: {
        provider: "configured-gateway",
        model: result.model,
        generatedAt: new Date().toISOString(),
        fields: { title: result.model },
      },
      chaptersSource: result.chaptersSource,
    };
    const updated = await db.publishMetadata.update({
      where: { id: row.id },
      data: {
        status: row.status === "APPROVED" ? "APPROVED" : "GENERATED",
        draftJson: JSON.stringify(draft),
        provider: "configured-gateway",
        model: result.model,
        fieldHistoryJson: JSON.stringify([...prevHistory.slice(-19), { at: new Date().toISOString(), kind: "full-generate", model: result.model }]),
      },
    });
    return NextResponse.json({ metadata: serializeMeta(updated) });
  } catch (err) {
    // Honest failure — no placeholder content is written.
    return NextResponse.json({ error: err instanceof Error ? err.message : "Metadata generation failed.", unavailable: true }, { status: 503 });
  }
}
