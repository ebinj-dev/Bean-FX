/**
 * Studio plan detail — GET /api/studio/plans/[planId] (scenes + status),
 * PATCH (scene field edits + reorder + add/delete via {sceneOps}).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, notFound, unauthorized } from "@/lib/process-helpers";
import { refreshPlanJson } from "@/lib/studio/planner";
import { footageSourcingStatus } from "@/lib/studio/assets";

export const runtime = "nodejs";

const TRANSITIONS = ["CUT", "CROSS_DISSOLVE", "FADE_TO_BLACK", "FADE_FROM_BLACK", "WIPE_LEFT", "WIPE_RIGHT", "SLIDE_LEFT", "SLIDE_RIGHT"] as const;

const PatchSchema = z.object({
  /** Edit one scene's fields. */
  sceneEdit: z.object({
    sceneId: z.string().max(64),
    narration: z.string().max(1200).optional(),
    visualDescription: z.string().max(500).optional(),
    footageNeed: z.string().max(400).optional(),
    brollNote: z.string().max(300).optional(),
    onScreenText: z.string().max(200).optional(),
    captionText: z.string().max(400).optional(),
    audioNote: z.string().max(200).optional(),
    durationSec: z.number().int().min(2).max(60).optional(),
    transition: z.enum(TRANSITIONS).optional(),
  }).optional(),
  /** Reorder: scene ids in the desired order (scene numbers reassigned). */
  reorder: z.array(z.string().max(64)).min(1).max(40).optional(),
  /** Add an empty scene (appended). */
  addScene: z.object({ afterSceneNumber: z.number().int().min(0).max(59).nullable().default(null), durationSec: z.number().int().min(2).max(60).default(5) }).optional(),
  /** Delete a scene (numbers re-closed). */
  deleteSceneId: z.string().max(64).optional(),
});

export async function GET(_req: NextRequest, ctx: { params: Promise<{ planId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { planId } = await ctx.params;
  const plan = await db.studioPlan.findFirst({ where: { id: planId, userId: user.id } });
  if (!plan) return notFound();
  const scenes = await db.studioScene.findMany({ where: { planId }, orderBy: { sceneNumber: "asc" } });
  const narration = scenes.some((s) => s.narrationAssetId);
  const assets = scenes.every((s) => s.assetId);
  return NextResponse.json({
    planId: plan.id,
    projectId: plan.projectId,
    status: plan.status,
    plannerMode: plan.plannerMode,
    brief: JSON.parse(plan.briefJson),
    plan: plan.planJson ? JSON.parse(plan.planJson) : null,
    assembly: plan.assemblyJson ? JSON.parse(plan.assemblyJson) : null,
    scenes,
    readiness: { narration: narration ? "ready" : "missing", assets: assets ? "ready" : "missing" },
    footage: footageSourcingStatus(),
  });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ planId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { planId } = await ctx.params;
  const plan = await db.studioPlan.findFirst({ where: { id: planId, userId: user.id } });
  if (!plan) return notFound();
  if (plan.status === "ASSEMBLED") return badRequest("Plan already assembled — edit the timeline in the editor (or create a new plan).");
  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid scene operation: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const ops = parsed.data;

  if (ops.sceneEdit) {
    const scene = await db.studioScene.findFirst({ where: { id: ops.sceneEdit.sceneId, userId: user.id, planId } });
    if (!scene) return notFound();
    const { sceneId, ...fields } = ops.sceneEdit;
    void sceneId;
    // Editing narration invalidates the narration audio + captions readiness.
    const narrationChanged = fields.narration !== undefined && fields.narration !== scene.narration;
    await db.studioScene.update({
      where: { id: scene.id },
      data: {
        ...fields,
        ...(narrationChanged ? { narrationAssetId: null, status: scene.assetId ? "ASSET_READY" : "EMPTY" } : {}),
        ...(fields.captionText === undefined && fields.narration !== undefined ? { captionText: (fields.narration ?? "").slice(0, 400) } : {}),
      },
    });
  }

  if (ops.reorder) {
    const ids = ops.reorder;
    const scenes = await db.studioScene.findMany({ where: { planId, userId: user.id } });
    if (new Set(ids).size !== ids.length || ids.some((id) => !scenes.some((s) => s.id === id))) {
      return badRequest("reorder must contain each scene id exactly once.");
    }
    for (let i = 0; i < ids.length; i++) {
      await db.studioScene.update({ where: { id: ids[i] }, data: { sceneNumber: i + 1 } });
    }
  }

  if (ops.addScene) {
    const scenes = await db.studioScene.findMany({ where: { planId }, orderBy: { sceneNumber: "asc" } });
    const at = ops.addScene.afterSceneNumber;
    const insertAt = at === null || at === 0 ? scenes.length + 1 : Math.min(scenes.length + 1, at + 1);
    const created = await db.studioScene.create({
      data: { planId, userId: user.id, sceneNumber: 99, durationSec: ops.addScene.durationSec, narration: "", visualDescription: "", status: "EMPTY", transition: "CUT" },
    });
    // Reassign numbers with the new scene inserted.
    const others = scenes.filter((s) => s.id !== created.id);
    let n = 1;
    for (const s of others) {
      if (n === insertAt) n += 1;
      if (s.sceneNumber !== n) await db.studioScene.update({ where: { id: s.id }, data: { sceneNumber: n } });
      n += 1;
    }
    await db.studioScene.update({ where: { id: created.id }, data: { sceneNumber: insertAt } });
  }

  if (ops.deleteSceneId) {
    const scene = await db.studioScene.findFirst({ where: { id: ops.deleteSceneId, userId: user.id, planId } });
    if (!scene) return notFound();
    await db.studioScene.delete({ where: { id: scene.id } });
    const remaining = await db.studioScene.findMany({ where: { planId }, orderBy: { sceneNumber: "asc" } });
    let n = 1;
    for (const s of remaining) {
      if (s.sceneNumber !== n) await db.studioScene.update({ where: { id: s.id }, data: { sceneNumber: n } });
      n += 1;
    }
  }

  await refreshPlanJson(planId, user.id);
  await db.studioPlan.update({ where: { id: planId }, data: { sceneCount: await db.studioScene.count({ where: { planId } }) } }).catch(() => undefined);
  const scenes = await db.studioScene.findMany({ where: { planId }, orderBy: { sceneNumber: "asc" } });
  return NextResponse.json({ ok: true, scenes });
}
