import { NextRequest, NextResponse } from "next/server";
import { mkdir, writeFile, stat } from "fs/promises";
import path from "path";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { pathInsideMediaRoot, sniffContainer, MAX_UPLOAD_BYTES } from "@/lib/media-storage";
import { enqueueMediaJob, JOB_TYPE_PROJECT_IMPORT } from "@/lib/job-helpers";
import { PACKAGE_FORMAT_VERSION } from "@/lib/project-archive";

/** M29 — import a project package (.zip, STORED entries, manifest-gated).
 *  Staged under tmp; the worker validates + restores atomically; the staged
 *  file is deleted on success. Never trusts MIME: signature sniff + structure
 *  validation decide. */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  // M29 — expire stale IMPORT rows whose durable job is gone or terminal
  // (a killed test/server would otherwise lock the user out forever).
  const stale = await db.projectArchive.findMany({ where: { userId: user.id, direction: "IMPORT", status: { in: ["QUEUED", "BUILDING"] } }, select: { id: true, jobId: true } });
  for (const row of stale) {
    const job = row.jobId ? await db.job.findUnique({ where: { id: row.jobId }, select: { status: true } }) : null;
    if (!job || !["QUEUED", "PROCESSING"].includes(job.status)) {
      await db.projectArchive.update({ where: { id: row.id }, data: { status: "FAILED", error: "Import interrupted — retry with the package file." } }).catch(() => undefined);
    }
  }
  const active = await db.projectArchive.findFirst({ where: { userId: user.id, direction: "IMPORT", status: { in: ["QUEUED", "BUILDING"] } }, select: { id: true } });
  if (active) return NextResponse.json({ error: "An import job is already running.", archiveId: active.id }, { status: 409 });

  const body = await req.arrayBuffer().catch(() => null);
  if (!body || body.byteLength === 0) return NextResponse.json({ error: "Package file is required." }, { status: 400 });
  if (body.byteLength > MAX_UPLOAD_BYTES) return NextResponse.json({ error: "Package exceeds the upload size limit." }, { status: 413 });

  const head = Buffer.from(body.slice(0, 4));
  // Zip local-header magic (STORED/DEFLATE both start with PK\x03\x04) — the
  // structural validation happens in the worker; here we reject non-zips.
  if (!(head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04)) {
    return NextResponse.json({ error: "Not a zip archive — project packages are .zip files." }, { status: 400 });
  }

  const staging = pathInsideMediaRoot("tmp", `import_${user.id}_${Date.now().toString(36)}.zip`);
  await mkdir(path.dirname(staging), { recursive: true });
  await writeFile(staging, Buffer.from(body));
  const st = await stat(staging);

  const archive = await db.projectArchive.create({
    data: {
      userId: user.id, direction: "IMPORT", status: "QUEUED",
      formatVersion: PACKAGE_FORMAT_VERSION, schemaVersion: "sequence-zod-2026.11",
      storagePath: staging, sizeBytes: st.size, stage: "Queued",
    },
  });
  const jobId = await enqueueMediaJob(user.id, JOB_TYPE_PROJECT_IMPORT, { archiveId: archive.id });
  await db.projectArchive.update({ where: { id: archive.id }, data: { jobId } });
  return NextResponse.json({ archiveId: archive.id, jobId }, { status: 202 });
}
