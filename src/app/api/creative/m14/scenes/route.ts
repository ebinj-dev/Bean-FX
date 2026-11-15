/**
 * M14 API — Scene Plan (§5/§12).
 * GET   /api/creative/m14/scenes?projectId=…         latest plan
 * POST  /api/creative/m14/scenes                     build (RIISHE-verbatim + AI suggestions)
 * PATCH /api/creative/m14/scenes                     edits: {planId, order?, durations?, approve?, note?}
 * PUT   /api/creative/m14/scenes                     regenerate ONE scene: {planId, sceneId}
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/process-helpers";
import { buildScenePlan, editScenePlan, regenerateScene } from "@/lib/creative/m14/scenes";

export const runtime = "nodejs";

const CreateSchema = z.object({
  projectId: z.string().min(1).max(64),
  artDirectionId: z.string().max(64).nullable().default(null),
  brief: z.object({ format: z.enum(["16:9", "9:16", "1:1", "4:5"]).default("16:9"), language: z.enum(["en", "ta"]).default("en"), storyOrProduct: z.string().max(1200).default("project") }).prefault({}),
});
const PatchSchema = z.object({
  projectId: z.string().min(1).max(64),
  planId: z.string().min(1).max(64),
  order: z.array(z.string().max(96)).max(60).optional(),
  durations: z.array(z.object({ sceneId: z.string().max(96), startSec: z.number().min(0).optional(), endSec: z.number().min(0).optional() })).max(60).optional(),
  approve: z.array(z.string().max(96)).max(60).optional(),
  note: z.string().max(200).optional(),
});
const RegenSchema = z.object({ projectId: z.string().min(1).max(64), planId: z.string().min(1).max(64), sceneId: z.string().min(1).max(96) });

async function ownedProject(userId: string, projectId: string) {
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project || project.userId !== userId) throw new Error("Project not found or not owned by the caller.");
}

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const projectId = new URL(req.url).searchParams.get("projectId");
  if (!projectId) return badRequest("projectId is required.");
  try {
    await ownedProject(user.id, projectId);
  } catch (err) {
    return badRequest((err as Error).message);
  }
  const plan = await db.scenePlan.findFirst({ where: { userId: user.id, projectId }, orderBy: { updatedAt: "desc" } });
  return NextResponse.json({ plan: plan ? { id: plan.id, version: plan.version, artDirectionId: plan.artDirectionId, language: plan.language, doc: JSON.parse(plan.scenesJson) } : null });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const parsed = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  try {
    await ownedProject(user.id, parsed.data.projectId);
    const doc = await buildScenePlan(user.id, parsed.data.projectId, { brief: { format: parsed.data.brief.format, language: parsed.data.brief.language, storyOrProduct: parsed.data.brief.storyOrProduct }, artDirectionId: parsed.data.artDirectionId });
    await db.automationAudit.create({ data: { userId: user.id, projectId: parsed.data.projectId, action: "M14_SCENE_PLAN_BUILT", detailJson: JSON.stringify({ scenes: doc.scenes.length }) } }).catch(() => undefined);
    return NextResponse.json({ plan: doc }, { status: 201 });
  } catch (err) {
    return badRequest(`Scene planning failed honestly: ${(err as Error).message.slice(0, 300)}`);
  }
}

export async function PATCH(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  try {
    const doc = await editScenePlan(user.id, parsed.data.projectId, parsed.data.planId, parsed.data);
    return NextResponse.json({ plan: doc });
  } catch (err) {
    return badRequest((err as Error).message.slice(0, 300));
  }
}

export async function PUT(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const parsed = RegenSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  try {
    const doc = await regenerateScene(user.id, parsed.data.projectId, parsed.data.planId, parsed.data.sceneId);
    return NextResponse.json({ plan: doc });
  } catch (err) {
    return badRequest(`Scene regeneration failed honestly: ${(err as Error).message.slice(0, 300)}`);
  }
}
