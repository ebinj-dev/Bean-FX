/**
 * M12 API — Natural-language footage search (§5/§12).
 * POST /api/creative/visual/search  {projectId, query, assetId?, timeStartSec?,
 *                                    timeEndSec?, limit?}
 *
 * Searches the REAL visual index (analyzed frames — never filenames). The
 * response states `available:false` with the reason when no completed index
 * exists. Provider ranking runs ONLY when the stored index was created WITH
 * consent (its scenes carry semantic descriptions); otherwise the honest
 * local keyword path is used.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/process-helpers";
import { VisualSearchRequestSchema, type VisualIndex } from "@/lib/creative/visual/contracts";
import { searchVisualIndex } from "@/lib/creative/visual/search";

export const runtime = "nodejs";

const BodySchema = VisualSearchRequestSchema.extend({ projectId: z.string().min(1).max(64) });

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const { projectId, ...search } = parsed.data;
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project || project.userId !== user.id) return badRequest("Project not found or not owned by the caller.");

  const indexRow = await db.creativeAnalysisArtifact.findFirst({ where: { userId: user.id, projectId, kind: "visual-index", status: "COMPLETED" }, orderBy: { updatedAt: "desc" } });
  if (!indexRow?.resultJson) {
    return NextResponse.json({ available: false, method: "none", results: [], notes: ["No completed visual index exists for this project — run Visual Intelligence first (search uses REAL indexed frames, not filenames)."] });
  }
  let index: VisualIndex;
  try {
    index = JSON.parse(indexRow.resultJson) as VisualIndex;
  } catch {
    return NextResponse.json({ available: false, method: "none", results: [], notes: ["Stored visual index is unreadable — re-run Visual Intelligence."] });
  }
  const response = await searchVisualIndex(index, search as Parameters<typeof searchVisualIndex>[1], { consentVisual: indexRow.consentVisual });
  await db.automationAudit.create({ data: { userId: user.id, projectId, action: "VISUAL_SEARCH", detailJson: JSON.stringify({ query: parsed.data.query.slice(0, 200), method: response.method, results: response.results.length }) } }).catch(() => undefined);
  return NextResponse.json(response);
}
