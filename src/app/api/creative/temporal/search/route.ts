/**
 * M13 API — Temporal visual search (§7/§13).
 * POST /api/creative/temporal/search {projectId, query, assetId?, trackId?,
 *                                     timeStartSec?, timeEndSec?, limit?}
 *
 * Searches REAL temporal observations (tracks, motion, camera records,
 * events) — never filenames or isolated descriptions. Requires a completed
 * temporal index. Provider ranking runs only with stored consent.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/process-helpers";
import { TemporalSearchRequestSchema, type TemporalIndex } from "@/lib/creative/visual/temporal/contracts";
import { searchTemporalIndex } from "@/lib/creative/visual/temporal/search";

export const runtime = "nodejs";

const BodySchema = TemporalSearchRequestSchema.extend({ projectId: z.string().min(1).max(64) });

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const { projectId, ...search } = parsed.data;
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project || project.userId !== user.id) return badRequest("Project not found or not owned by the caller.");

  const indexRow = await db.creativeAnalysisArtifact.findFirst({ where: { userId: user.id, projectId, kind: "temporal-index", status: "COMPLETED" }, orderBy: { updatedAt: "desc" } });
  if (!indexRow?.resultJson) {
    return NextResponse.json({ available: false, method: "none", results: [], notes: ["No completed temporal index exists for this project — run Motion Analysis first (temporal search uses REAL tracked observations)."] });
  }
  let index: TemporalIndex;
  try {
    index = JSON.parse(indexRow.resultJson) as TemporalIndex;
  } catch {
    return NextResponse.json({ available: false, method: "none", results: [], notes: ["Stored temporal index is unreadable — re-run Motion Analysis."] });
  }
  const response = await searchTemporalIndex(index, search, { consentVisual: indexRow.consentVisual });
  await db.automationAudit.create({ data: { userId: user.id, projectId, action: "TEMPORAL_SEARCH", detailJson: JSON.stringify({ query: parsed.data.query.slice(0, 200), method: response.method, results: response.results.length }) } }).catch(() => undefined);
  return NextResponse.json(response);
}
