/**
 * BEAN FX — M38 §4: batch multi-format timeline export.
 *
 * ONE submission enqueues several M37 output formats (mp4/mov/wav/mp3) as
 * INDEPENDENT durable RENDER_TIMELINE jobs on the existing worker — the SAME
 * job type, the SAME FFmpeg graph (including the M37 transform evaluator),
 * the SAME schema-validated format contract as the single-export route.
 * No second queue, no parallel renderer, no placeholder states.
 *
 * Lifecycle per item: QUEUED → PROCESSING → (worker stages) → COMPLETED,
 * with the repository's real failure/cancellation conventions (DELETE
 * /api/jobs/[id]; recovery via the worker's stale-claim sweep). Batch
 * progress is computed from REAL item states only — a batch is complete
 * only when every item is terminal, and successful only when every item
 * COMPLETED. Duplicate protection: one ACTIVE (QUEUED/PROCESSING) job per
 * (project, format, range); completed items are reported as reused instead
 * of re-rendered; FAILED/CANCELLED items may be re-submitted (that is the
 * retry path).
 *
 * M39 §7 — per-item timeline ranges: each item may carry its OWN
 * startFrame/endFrame (`items: [{format, startFrame, endFrame}, …]`).
 * Ranges are validated per item (negative/malformed by schema; reversed
 * and out-of-bounds against the sequence) BEFORE anything is enqueued —
 * one invalid item rejects the whole request with per-item reasons and no
 * partial submission. The M38 common-range form (formats + shared range)
 * is preserved unchanged; the dedup identity (project, format, range)
 * distinguishes genuinely different ranges.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { badRequest, unauthorized } from "@/lib/process-helpers";
import { enqueueMediaJob, JOB_TYPE_RENDER_TIMELINE } from "@/lib/job-helpers";
import { assertWithinLimit, PlanLimitError, planLimitResponse } from "@/lib/billing/entitlements";
import { RENDER_OUTPUT_FORMATS } from "@/lib/publish/timeline-render";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

const formatEnum = z.enum(RENDER_OUTPUT_FORMATS as unknown as [string, ...string[]]);
const BatchItemSchema = z.object({
  format: formatEnum,
  startFrame: z.number().int().min(0).optional(),
  endFrame: z.number().int().min(1).optional(),
});
// M39 §7 — additive per-item timeline ranges: each batch item may carry its
// OWN start/end frames. The M38 common-range form (formats + shared
// startFrame/endFrame) is preserved unchanged; the two forms are mutually
// exclusive so a request can never mix them ambiguously. Every item is
// validated independently BEFORE anything is enqueued (all-or-nothing).
const BatchRenderSchema = z
  .object({
    formats: z.array(formatEnum).min(1).max(RENDER_OUTPUT_FORMATS.length).optional(),
    items: z.array(BatchItemSchema).min(1).max(24).optional(),
    startFrame: z.number().int().min(0).optional(),
    endFrame: z.number().int().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.items && v.formats !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Provide either per-item 'items' or the common 'formats' form — not both." });
    }
    if (!v.items && !v.formats) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Provide 'items' (per-item ranges) or 'formats' (common range)." });
    }
  });

interface RenderParams {
  projectId?: string;
  startFrame?: number;
  endFrame?: number;
  format?: string;
}

function sameRange(a: RenderParams, b: { startFrame?: number; endFrame?: number }): boolean {
  return (a.startFrame ?? undefined) === (b.startFrame ?? undefined) && (a.endFrame ?? undefined) === (b.endFrame ?? undefined);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ projectId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  // M48-G2 — per-user rate limit (after authentication, so the limiter
  // never reveals whether another user’s resource exists).
  const limited = enforceRateLimit(req, "editorRenderBatch", user.id, RATE_LIMITS.batchRender);
  if (limited) return limited;
  const { projectId } = await ctx.params;
  const project = await db.project.findFirst({ where: { id: projectId, userId: user.id } });
  if (!project) return badRequest("Project not found or not owned by the caller.");
  const parsed = BatchRenderSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")} (formats must be a subset of ${RENDER_OUTPUT_FORMATS.join(", ")})`);
  }
  // M30: workspace EDITORs may render shared projects (same as the single route).
  {
    const { getProjectAccess, canEdit } = await import("@/lib/collab");
    const access = await getProjectAccess(user.id, project);
    if (!canEdit(access)) return badRequest("Project not found or not owned by the caller.");
  }
  const { formats, items, startFrame, endFrame } = parsed.data;
  // Normalize to a per-item list: the legacy form fans the common range out
  // to every unique format (M38 behavior, unchanged); the items form keeps
  // each item's own range. Identical items collapse the same way M38
  // collapsed duplicate formats.
  const normalized: Array<{ format: string; startFrame?: number; endFrame?: number }> = items
    ? items
    : [...new Set(formats ?? [])].map((format) => ({ format, startFrame, endFrame }));
  const seen = new Set<string>();
  const batchItems = normalized.filter((it) => {
    const key = `${it.format}|${it.startFrame ?? ""}|${it.endFrame ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const version = await db.timelineVersion.findFirst({ where: { projectId }, orderBy: { versionNumber: "desc" } });
  if (!version) return badRequest("The project has no sequence to render yet.");
  const seq = JSON.parse(version.sequenceJson) as { clips?: Array<{ timelineStartFrame: number; timelineDurationFrames: number }>; fps?: { num: number; den: number } };
  const fps = seq.fps && seq.fps.den ? seq.fps.num / seq.fps.den : 30;
  const seqEnd = (seq.clips ?? []).reduce((m, c) => Math.max(m, c.timelineStartFrame + c.timelineDurationFrames), 0);

  // M39 §7 — validate EVERY item's range BEFORE enqueueing anything: one
  // invalid item rejects the whole request with per-item reasons and NO
  // partial submission (a failed item can never strand its batch mates).
  const rejected: Array<{ index: number; format: string; range: { startFrame?: number; endFrame?: number }; reason: string }> = [];
  batchItems.forEach((item, index) => {
    const { startFrame: s, endFrame: e } = item;
    const range = { startFrame: s, endFrame: e };
    if (s !== undefined && e !== undefined && e <= s) {
      rejected.push({ index, format: item.format, range, reason: `reversed range (end frame ${e} ≤ start frame ${s})` });
    } else if (seqEnd === 0 && (s !== undefined || e !== undefined)) {
      rejected.push({ index, format: item.format, range, reason: "out of bounds (sequence has no clips)" });
    } else if (e !== undefined && e > seqEnd) {
      rejected.push({ index, format: item.format, range, reason: `out of bounds (sequence ends at frame ${seqEnd})` });
    } else if (s !== undefined && s >= seqEnd) {
      rejected.push({ index, format: item.format, range, reason: `out of bounds (sequence ends at frame ${seqEnd})` });
    }
  });
  if (rejected.length > 0) {
    await audit("render.batch.reject", { userId: user.id, detail: JSON.stringify({ projectId, rejected }) });
    return NextResponse.json(
      { error: `Invalid batch item(s): ${rejected.map((r) => `#${r.index} ${r.format} — ${r.reason}`).join("; ")}`, rejected },
      { status: 400 },
    );
  }

  // M25 P2 — plan entitlements, metered per item (each item is a real render
  // measured by its own range).
  try {
    const estMinutes = batchItems.reduce((sum, item) => {
      const end = item.endFrame ?? seqEnd;
      const start = item.startFrame ?? 0;
      return sum + Math.max(1 / 60, (end - start) / Math.max(1, fps) / 60);
    }, 0);
    await assertWithinLimit(user.id, "maxConcurrentRenders");
    await assertWithinLimit(user.id, "monthlyExportMinutes", Math.ceil(estMinutes));
  } catch (err) {
    if (err instanceof PlanLimitError) {
      const { body, status } = planLimitResponse(err);
      return NextResponse.json(body, { status });
    }
    throw err;
  }

  const created: Array<{ format: string; jobId: string; reused: boolean; status: string; range: { startFrame?: number; endFrame?: number } }> = [];
  for (const item of batchItems) {
    // Duplicate-submission protection: one ACTIVE job per (project, format,
    // range) — the per-item range makes genuinely different ranges distinct
    // identities while identical ranges still dedup.
    const recent = await db.job.findMany({
      where: { userId: user.id, type: "RENDER_TIMELINE", status: { in: ["QUEUED", "PROCESSING"] } },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, status: true, paramsJson: true },
    });
    const active = recent.find((j) => {
      try {
        const p = JSON.parse(j.paramsJson ?? "{}") as RenderParams;
        return p.projectId === projectId && (p.format ?? "mp4") === item.format && sameRange(p, item);
      } catch {
        return false;
      }
    });
    if (active) {
      created.push({ format: item.format, jobId: active.id, reused: true, status: active.status, range: { startFrame: item.startFrame, endFrame: item.endFrame } });
      continue;
    }
    const jobId = await enqueueMediaJob(user.id, JOB_TYPE_RENDER_TIMELINE, {
      projectId,
      startFrame: item.startFrame,
      endFrame: item.endFrame,
      format: item.format,
    });
    created.push({ format: item.format, jobId, reused: false, status: "QUEUED", range: { startFrame: item.startFrame, endFrame: item.endFrame } });
  }
  await audit("render.batch", { userId: user.id, detail: JSON.stringify({ projectId, items: created.map((c) => ({ format: c.format, range: c.range })), reused: created.filter((c) => c.reused).length }) });
  return NextResponse.json({ batch: created, rejected: [], range: { startFrame, endFrame } }, { status: 202 });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ projectId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { projectId } = await ctx.params;
  const project = await db.project.findFirst({ where: { id: projectId, userId: user.id } });
  if (!project) return badRequest("Project not found.");

  const jobs = await db.job.findMany({
    where: { userId: user.id, type: "RENDER_TIMELINE", paramsJson: { contains: projectId } },
    orderBy: { createdAt: "desc" },
    take: 24,
    select: { id: true, status: true, stage: true, progress: true, message: true, createdAt: true, paramsJson: true, exportId: true },
  });
  const items: Array<{
    format: string;
    jobId: string;
    status: string;
    progress: number;
    stage: string | null;
    message: string | null;
    createdAt: string;
    range: { startFrame?: number; endFrame?: number };
    export: { id: string; filename: string; sizeBytes: number; durationSec: number | null; format: string } | null;
  }> = [];
  for (const j of jobs) {
    let p: RenderParams = {};
    try {
      p = JSON.parse(j.paramsJson ?? "{}") as RenderParams;
    } catch {
      continue;
    }
    if (p.projectId !== projectId) continue;
    let ex: { id: string; filename: string; sizeBytes: number; durationSec: number | null; format: string } | null = null;
    if (j.exportId) {
      const row = await db.exportFile.findUnique({ where: { id: j.exportId }, select: { id: true, filename: true, sizeBytes: true, durationSec: true, format: true } });
      if (row) ex = row;
    }
    items.push({
      format: p.format ?? "mp4",
      jobId: j.id,
      status: j.status,
      progress: j.progress,
      stage: j.stage,
      message: j.message,
      createdAt: j.createdAt.toISOString(),
      range: { startFrame: p.startFrame, endFrame: p.endFrame },
      export: ex,
    });
  }
  const terminal = items.filter((i) => ["COMPLETED", "FAILED", "CANCELLED"].includes(i.status));
  const allTerminal = items.length > 0 && terminal.length === items.length;
  const allSucceeded = allTerminal && items.every((i) => i.status === "COMPLETED");
  return NextResponse.json({
    items,
    batch: {
      total: items.length,
      completed: items.filter((i) => i.status === "COMPLETED").length,
      failed: items.filter((i) => i.status === "FAILED").length,
      cancelled: items.filter((i) => i.status === "CANCELLED").length,
      active: items.filter((i) => ["QUEUED", "PROCESSING"].includes(i.status)).length,
      batchComplete: allTerminal,
      allSucceeded,
    },
  });
}
