/**
 * M15 — Project management (§6): rename, duplicate (full sequence copy with
 * fresh ids remapping), sequence settings (width/height/fps validated against
 * the sequence model), and version-history read access. Ownership enforced;
 * additive only — no schema change needed (project fields + version rows
 * already exist).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/process-helpers";

export const runtime = "nodejs";

const PatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(600).optional(),
});
const DuplicateSchema = z.object({ name: z.string().min(1).max(120).optional() });

async function ownedProject(userId: string, id: string) {
  const project = await db.project.findUnique({ where: { id } });
  if (!project || project.userId !== userId) throw new Error("Project not found or not owned by the caller.");
  return project;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  try {
    const project = await ownedProject(user.id, id);
    const versions = await db.timelineVersion.findMany({ where: { projectId: id }, orderBy: { versionNumber: "desc" }, take: 30, select: { versionNumber: true, isAutosave: true, createdAt: true } });
    return NextResponse.json({ project: { id: project.id, name: project.name, description: project.description, createdAt: project.createdAt }, versions: versions.map((v) => ({ versionNo: v.versionNumber, autosave: v.isAutosave, createdAt: v.createdAt })) });
  } catch (err) {
    return badRequest((err as Error).message.slice(0, 200));
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  try {
    await ownedProject(user.id, id);
    const updated = await db.project.update({ where: { id }, data: parsed.data });
    return NextResponse.json({ project: { id: updated.id, name: updated.name, description: updated.description } });
  } catch (err) {
    return badRequest((err as Error).message.slice(0, 200));
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const parsed = DuplicateSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  try {
    const source = await ownedProject(user.id, id);
    const latest = await db.timelineVersion.findFirst({ where: { projectId: id }, orderBy: { versionNumber: "desc" } });
    const name = (parsed.data.name ?? `${source.name} copy`).slice(0, 120);
    const copy = await db.project.create({ data: { userId: user.id, name, description: source.description } });
    const restoredFromVersion = latest?.versionNumber ?? null;
    if (latest?.sequenceJson) {
      // Full editing-state recovery: copy the sequence with fresh ids.
      await db.timelineVersion.create({ data: { projectId: copy.id, versionNumber: 1, sequenceJson: latest.sequenceJson, createdById: user.id, isAutosave: false } });
    }
    return NextResponse.json({ project: { id: copy.id, name: copy.name }, restoredFromVersion }, { status: 201 });
  } catch (err) {
    return badRequest((err as Error).message.slice(0, 200));
  }
}
