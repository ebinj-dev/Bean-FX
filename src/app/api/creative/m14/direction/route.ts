/**
 * M14 API — Art Direction (§4/§12).
 * GET  /api/creative/m14/direction?projectId=…    batch + approved direction
 * POST /api/creative/m14/direction                {projectId, brief} → 3 candidates
 * PATCH /api/creative/m14/direction               {projectId, directionId, action: approve|discard}
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/process-helpers";
import { DirectionBriefSchema } from "@/lib/creative/m14/contracts";
import { approveDirection, generateDirections, getApprovedDirection } from "@/lib/creative/m14/direction";

export const runtime = "nodejs";

const CreateSchema = z.object({ projectId: z.string().min(1).max(64), brief: DirectionBriefSchema, consentVisual: z.boolean().default(false) });
const PatchSchema = z.object({ projectId: z.string().min(1).max(64), directionId: z.string().min(1).max(64), action: z.enum(["approve", "discard"]) });

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const projectId = new URL(req.url).searchParams.get("projectId");
  if (!projectId) return badRequest("projectId is required.");
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project || project.userId !== user.id) return badRequest("Project not found or not owned by the caller.");
  const [rows, approved] = await Promise.all([
    db.artDirection.findMany({ where: { userId: user.id, projectId }, orderBy: { updatedAt: "desc" }, take: 12 }),
    getApprovedDirection(user.id, projectId),
  ]);
  return NextResponse.json({
    approved: approved ? { id: approved.id, direction: approved.direction } : null,
    candidates: rows.filter((r) => r.status === "PROPOSED").map((r) => ({ id: r.id, name: r.name, direction: JSON.parse(r.payloadJson), provider: r.provider, model: r.model, updatedAt: r.updatedAt.toISOString() })),
  });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const parsed = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  try {
    const result = await generateDirections(user.id, parsed.data.projectId, parsed.data.brief, { consentVisual: parsed.data.consentVisual });
    await db.automationAudit.create({ data: { userId: user.id, projectId: parsed.data.projectId, action: "M14_ART_DIRECTION_CREATED", detailJson: JSON.stringify({ batchId: result.batchId, count: result.directions.length }) } }).catch(() => undefined);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return badRequest(`Direction generation failed honestly: ${(err as Error).message.slice(0, 300)}`);
  }
}

export async function PATCH(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  try {
    if (parsed.data.action === "approve") {
      const approved = await approveDirection(user.id, parsed.data.projectId, parsed.data.directionId);
      await db.automationAudit.create({ data: { userId: user.id, projectId: parsed.data.projectId, action: "M14_DIRECTION_APPROVED", detailJson: JSON.stringify({ directionId: parsed.data.directionId }) } }).catch(() => undefined);
      return NextResponse.json({ approved: approved });
    }
    await db.artDirection.updateMany({ where: { id: parsed.data.directionId, userId: user.id, projectId: parsed.data.projectId }, data: { status: "DISCARDED" } });
    return NextResponse.json({ discarded: true });
  } catch (err) {
    return badRequest((err as Error).message.slice(0, 300));
  }
}
