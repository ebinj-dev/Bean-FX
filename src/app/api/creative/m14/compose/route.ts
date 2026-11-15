/**
 * M14 API — Composition + render (§8/§9/§12).
 * GET   /api/creative/m14/compose?projectId=…&compositionId=…  list/get with versions
 * POST  /api/creative/m14/compose                             create {projectId, name, doc}
 * PATCH /api/creative/m14/compose                            commit {compositionId, projectId, expectedVersion, doc, note}
 * PUT   /api/creative/m14/compose                            switch version {compositionId, projectId, targetVersion} (undo/redo)
 * POST /api/creative/m14/render                              enqueue render {projectId, compositionId, fromFrame?, toFrame?}
 * GET  /api/creative/m14/render?projectId=…&compositionId=…  latest render status/result
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/process-helpers";
import { attachLayerToTrack, commitComposition, createComposition, detachLayerFromTrack, getComposition, listCompositions, switchCompositionVersion } from "@/lib/creative/m14/compose";
import { enqueueCompositionRender } from "@/lib/creative/m14/render";

export const runtime = "nodejs";

const CreateSchema = z.object({ projectId: z.string().min(1).max(64), name: z.string().min(1).max(80), doc: z.record(z.string(), z.unknown()) });
const CommitSchema = z.object({ projectId: z.string().min(1).max(64), compositionId: z.string().min(1).max(64), expectedVersion: z.number().int().min(1), doc: z.record(z.string(), z.unknown()), note: z.string().max(200).default("edited") });
const SwitchSchema = z.object({ projectId: z.string().min(1).max(64), compositionId: z.string().min(1).max(64), targetVersion: z.number().int().min(1) });
const AttachSchema = z.object({ projectId: z.string().min(1).max(64), compositionId: z.string().min(1).max(64), expectedVersion: z.number().int().min(1), layerId: z.string().min(1).max(64), temporalTrackId: z.string().min(1).max(96), sourceAssetId: z.string().min(1).max(64), attachedFrameRange: z.object({ startFrame: z.number().int().min(0), endFrame: z.number().int().min(1) }), offsetX: z.number().optional(), offsetY: z.number().optional(), detach: z.boolean().default(false) });
const RenderSchema = z.object({ projectId: z.string().min(1).max(64), compositionId: z.string().min(1).max(64), fromFrame: z.number().int().min(0).optional(), toFrame: z.number().int().min(1).optional() });

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId");
  const compositionId = url.searchParams.get("compositionId");
  if (!projectId) return badRequest("projectId is required.");
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project || project.userId !== user.id) return badRequest("Project not found or not owned by the caller.");
  if (compositionId) {
    try {
      return NextResponse.json(await getComposition(user.id, projectId, compositionId));
    } catch (err) {
      return badRequest((err as Error).message.slice(0, 300));
    }
  }
  return NextResponse.json({ compositions: await listCompositions(user.id, projectId) });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const parsed = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  try {
    const created = await createComposition(user.id, parsed.data.projectId, parsed.data.name, parsed.data.doc);
    await db.automationAudit.create({ data: { userId: user.id, projectId: parsed.data.projectId, action: "M14_COMPOSITION_CREATED", detailJson: JSON.stringify({ compositionId: created.id, issues: created.issues.slice(0, 3) }) } }).catch(() => undefined);
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    return badRequest((err as Error).message.slice(0, 320));
  }
}

export async function PATCH(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const body = await req.json().catch(() => null);
  const attach = AttachSchema.safeParse(body);
  if (attach.success) {
    try {
      const result = attach.data.detach
        ? await detachLayerFromTrack(user.id, attach.data.projectId, attach.data.compositionId, attach.data.expectedVersion, attach.data.layerId)
        : await attachLayerToTrack(user.id, attach.data.projectId, attach.data.compositionId, attach.data.expectedVersion, attach.data.layerId, attach.data.temporalTrackId, attach.data.sourceAssetId, attach.data.attachedFrameRange, { x: attach.data.offsetX, y: attach.data.offsetY });
      await db.automationAudit.create({ data: { userId: user.id, projectId: attach.data.projectId, action: attach.data.detach ? "M14_TRACK_DETACHED" : "M14_TRACK_ATTACHED", detailJson: JSON.stringify({ layerId: attach.data.layerId, track: attach.data.temporalTrackId }) } }).catch(() => undefined);
      return NextResponse.json(result);
    } catch (err) {
      return badRequest((err as Error).message.slice(0, 320));
    }
  }
  const parsed = CommitSchema.safeParse(body);
  if (parsed.success) {
    try {
      const result = await commitComposition(user.id, parsed.data.projectId, parsed.data.compositionId, parsed.data.expectedVersion, parsed.data.doc, parsed.data.note);
      return NextResponse.json(result);
    } catch (err) {
      return badRequest((err as Error).message.slice(0, 320));
    }
  }
  const switchReq = SwitchSchema.safeParse(body);
  if (switchReq.success) {
    try {
      const result = await switchCompositionVersion(user.id, switchReq.data.projectId, switchReq.data.compositionId, switchReq.data.targetVersion);
      return NextResponse.json(result);
    } catch (err) {
      return badRequest((err as Error).message.slice(0, 320));
    }
  }
  return badRequest("Invalid request: expected commit/attach/switch payload.");
}
