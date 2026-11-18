/**
 * M14 API — Visual Asset Studio (§6/§12).
 * POST /api/creative/m14/assets  {projectId, sceneId, role, prompt, alternatives?, mode?, referenceAssetId?}
 * Assets generate ONLY under an APPROVED art direction; registered via the
 * existing lifecycle; alpha verified from actual pixels.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/process-helpers";
import { generateSceneAsset } from "@/lib/creative/m14/assets";

export const runtime = "nodejs";

const CreateSchema = z.object({
  projectId: z.string().min(1).max(64),
  sceneId: z.string().min(1).max(96),
  role: z.enum(["background", "foreground", "character", "prop", "decorative", "cutout", "scene-artwork", "texture"]),
  prompt: z.string().min(1).max(900),
  alternatives: z.number().int().min(1).max(3).default(1),
  mode: z.enum(["generate", "edit"]).default("generate"),
  referenceAssetId: z.string().max(64).nullable().default(null),
});

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const parsed = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const project = await db.project.findUnique({ where: { id: parsed.data.projectId } });
  if (!project || project.userId !== user.id) return badRequest("Project not found or not owned by the caller.");
  try {
    const result = await generateSceneAsset(user.id, parsed.data.projectId, parsed.data);
    await db.automationAudit.create({ data: { userId: user.id, projectId: parsed.data.projectId, action: "M14_SCENE_ASSET_GENERATED", detailJson: JSON.stringify({ sceneId: parsed.data.sceneId, role: parsed.data.role, count: result.assets.length }) } }).catch(() => undefined);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return badRequest(`Asset generation failed honestly: ${(err as Error).message.slice(0, 320)}`);
  }
}
