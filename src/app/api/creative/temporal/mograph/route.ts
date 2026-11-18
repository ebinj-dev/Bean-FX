/**
 * M13 API — Motion-graphics proposal from a validated track (§8/§13).
 * POST /api/creative/temporal/mograph {projectId, trackId, label?}
 *
 * Rebuilds (on demand) an approval-ready NIIKI graphic proposal for ONE
 * selected track from the completed temporal index: coordinate conversion
 * into the M6 evaluator's anchor-offset % space, clip-relative keyframes,
 * honest gap handling, real-frame preview overlays (registered IMAGE assets),
 * and the executable AddGraphic payload. Requires a GRAPHIC-capable command
 * validation at approval time (existing M1/M6 path); nothing is auto-applied.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/process-helpers";
import { getTimelineHead } from "@/lib/editor/persistence";
import { buildMographProposal } from "@/lib/creative/visual/temporal/mograph";
import type { TemporalIndex } from "@/lib/creative/visual/temporal/contracts";

export const runtime = "nodejs";

const BodySchema = z.object({
  projectId: z.string().min(1).max(64),
  trackId: z.string().min(1).max(96),
  label: z.string().max(60).optional(),
  primaryText: z.string().max(60).optional(),
});

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const project = await db.project.findUnique({ where: { id: parsed.data.projectId } });
  if (!project || project.userId !== user.id) return badRequest("Project not found or not owned by the caller.");

  const indexRow = await db.creativeAnalysisArtifact.findFirst({ where: { userId: user.id, projectId: parsed.data.projectId, kind: "temporal-index", status: "COMPLETED" }, orderBy: { updatedAt: "desc" } });
  if (!indexRow?.resultJson) return badRequest("No completed temporal index — run Motion Analysis first.");
  const index = JSON.parse(indexRow.resultJson) as TemporalIndex;
  const track = index.tracks.find((t) => t.trackId === parsed.data.trackId);
  if (!track) return badRequest(`Track ${parsed.data.trackId} not found in the temporal index.`);

  const head = await getTimelineHead(parsed.data.projectId, user.id);
  const seq = head.sequence;
  const fps = seq.fps.num / seq.fps.den;
  const graphicTrack = seq.tracks.find((t) => t.kind === "GRAPHIC" && !t.locked);
  const motion = index.motion.find((m) => m.trackId === track.trackId) ?? null;
  const built = await buildMographProposal(index, track, motion, {
    seqFps: fps,
    seqWidth: seq.width ?? index.width,
    seqHeight: seq.height ?? index.height,
    graphicTrackId: graphicTrack?.id ?? null,
    userId: user.id,
    projectId: parsed.data.projectId,
    previewFrames: new Map(), // index-only path: no temp frames here; previews from the job run remain valid
    label: parsed.data.label,
    primaryText: parsed.data.primaryText,
  });
  await db.automationAudit.create({ data: { userId: user.id, projectId: parsed.data.projectId, action: "MOGRAPH_PROPOSAL_BUILT", detailJson: JSON.stringify({ trackId: track.trackId, ok: Boolean(built.proposal), note: built.note.slice(0, 200) }) } }).catch(() => undefined);
  if (!built.proposal) return badRequest(built.note);
  return NextResponse.json({ proposal: built.proposal, note: built.note, warnings: built.warnings });
}
