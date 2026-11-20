import { NextRequest, NextResponse } from "next/server";
import { existsSync } from "fs";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { enqueueMediaJob, JOB_TYPE_PROJECT_ARCHIVE } from "@/lib/job-helpers";

/** M29 — start a project package. Modes: FULL (originals + proxies),
 *  NO_PROXIES, METADATA (manifest + timeline only). Duplicate-request
 *  prevention: one active ARCHIVE job per project per user. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { mode?: string };

  const project = await db.project.findUnique({ where: { id } });
  if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });
  { const { getProjectAccess, canEdit } = await import("@/lib/collab");
    const access = await getProjectAccess(user.id, project);
    if (!canEdit(access)) return NextResponse.json({ error: "Project not found." }, { status: 404 }); }

  const mode = ["FULL", "NO_PROXIES", "METADATA"].includes(body.mode ?? "") ? body.mode! : "FULL";
  const active = await db.job.findFirst({
    where: { userId: user.id, type: JOB_TYPE_PROJECT_ARCHIVE, status: { in: ["QUEUED", "PROCESSING"] }, paramsJson: { contains: "" } },
    select: { id: true },
  });
  if (active) {
    // One packaging job at a time per user (I/O-heavy; serialized like renders).
    const anyActive = await db.projectArchive.findFirst({ where: { userId: user.id, direction: "ARCHIVE", status: { in: ["QUEUED", "BUILDING"] } }, select: { id: true } });
    if (anyActive) return NextResponse.json({ error: "A packaging job is already running.", archiveId: anyActive.id }, { status: 409 });
  }

  const archive = await db.projectArchive.create({
    data: { userId: user.id, projectId: project.id, mode, direction: "ARCHIVE", status: "QUEUED", formatVersion: "beanfx-project/1", schemaVersion: "sequence-zod-2026.11" },
  });
  const jobId = await enqueueMediaJob(user.id, JOB_TYPE_PROJECT_ARCHIVE, { archiveId: archive.id });
  await db.projectArchive.update({ where: { id: archive.id }, data: { jobId } });
  return NextResponse.json({ archiveId: archive.id, jobId, mode }, { status: 202 });
}

/** GET: latest archive for this project (progress polling + download id). */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { id } = await ctx.params;
  const rows = await db.projectArchive.findMany({
    where: { projectId: id, userId: user.id, direction: "ARCHIVE" },
    orderBy: { createdAt: "desc" },
    take: 1,
    select: { id: true, projectId: true, mode: true, direction: true, status: true, progress: true, stage: true, sizeBytes: true, assetCount: true, error: true, formatVersion: true, createdAt: true },
  });
  if (rows.length === 0) return NextResponse.json({ error: "Archive not found." }, { status: 404 });
  return NextResponse.json({ archive: rows[0], downloadReady: rows[0].status === "COMPLETED" });
}
