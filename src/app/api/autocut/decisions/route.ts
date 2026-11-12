import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { MEDIA_ROOT } from "@/lib/media-storage";

export const runtime = "nodejs";

const RESULTS_DIR = path.join(MEDIA_ROOT, "analysis-results");
/** Only completed RIISHE analysis jobs carry candidates that can be decided. */
const ANALYSIS_JOB_TYPE = "autocut-analysis";

const DECISION_VALUES = ["APPROVE", "REJECT", "KEEP"] as const;

const jobIdSchema = z.string().regex(/^[a-z0-9]{20,40}$/, "Invalid analysis job id.");
const saveSchema = z.object({
  jobId: jobIdSchema,
  candidateId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "Invalid candidate id."),
  decision: z.enum(DECISION_VALUES),
});

/**
 * Load the immutable result payload for an analysis job and collect its
 * candidate ids. The result file stays the single source of truth: decisions
 * are never accepted for a candidate that is not in this exact payload, so a
 * candidate id from a different analysis can never be smuggled through.
 */
async function loadResultCandidates(
  jobId: string
): Promise<{ ok: true; ids: Set<string> } | { ok: false; status: number; error: string }> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(RESULTS_DIR, `${jobId}.json`), "utf8");
  } catch {
    return {
      ok: false,
      status: 410,
      error:
        "The analysis result is no longer available in storage — decisions cannot be validated against it. Re-run the analysis to create a new result.",
    };
  }
  let payload: { candidates?: { id?: unknown }[] };
  try {
    payload = JSON.parse(raw);
  } catch {
    return { ok: false, status: 410, error: "The stored analysis result is malformed — decisions cannot be validated against it." };
  }
  if (!Array.isArray(payload.candidates)) {
    return { ok: false, status: 410, error: "The stored analysis result is malformed — decisions cannot be validated against it." };
  }
  const ids = new Set<string>();
  for (const c of payload.candidates) {
    if (c && typeof c.id === "string") ids.add(c.id);
  }
  return { ok: true, ids };
}

/**
 * GET /api/autocut/decisions?jobId=<analysis job id>
 * Returns the persisted decisions of one specific analysis result for the
 * current user. Used to restore decisions when an analysis is reopened.
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  const parsed = jobIdSchema.safeParse(req.nextUrl.searchParams.get("jobId") ?? "");
  if (!parsed.success) {
    return NextResponse.json({ error: "A valid analysis job id is required (jobId query parameter)." }, { status: 400 });
  }

  const job = await db.job.findUnique({ where: { id: parsed.data } });
  if (!job || job.userId !== user.id || job.type !== ANALYSIS_JOB_TYPE) {
    return NextResponse.json({ error: "Analysis job not found." }, { status: 404 });
  }

  const rows = await db.cutDecision.findMany({
    where: { userId: user.id, jobId: job.id },
    orderBy: { updatedAt: "asc" },
  });
  return NextResponse.json({
    ok: true,
    jobId: job.id,
    decisions: rows.map((r) => ({ candidateId: r.candidateId, decision: r.decision, createdAt: r.createdAt, updatedAt: r.updatedAt })),
  });
}

/**
 * POST /api/autocut/decisions  { jobId, candidateId, decision }
 * Saves or updates the user's decision (APPROVE | REJECT | KEEP) for one
 * candidate of one completed analysis. Every write is validated against the
 * immutable result payload (membership) and recorded as an append-only
 * history event, so previous decisions are preserved, never overwritten.
 * Duplicate requests converge on the same row — they cannot create
 * inconsistent records.
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const parsed = saveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid decision payload — expected jobId, candidateId and decision (APPROVE | REJECT | KEEP)." }, { status: 400 });
  }
  const { jobId, candidateId, decision } = parsed.data;

  const job = await db.job.findUnique({ where: { id: jobId } });
  if (!job || job.userId !== user.id || job.type !== ANALYSIS_JOB_TYPE) {
    return NextResponse.json({ error: "Analysis job not found." }, { status: 404 });
  }
  if (job.status !== "COMPLETED") {
    return NextResponse.json(
      { error: `Analysis is not finished (status: ${job.status}) — decisions can only be saved for a completed analysis.` },
      { status: 409 }
    );
  }

  const result = await loadResultCandidates(jobId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  if (!result.ids.has(candidateId)) {
    return NextResponse.json({ error: "This candidate does not belong to the requested analysis." }, { status: 400 });
  }

  try {
    const saved = await db.$transaction(async (tx) => {
      const row = await tx.cutDecision.upsert({
        where: { userId_jobId_candidateId: { userId: user.id, jobId, candidateId } },
        create: { userId: user.id, jobId, candidateId, decision },
        update: { decision },
      });
      await tx.cutDecisionEvent.create({
        data: { userId: user.id, jobId, candidateId, decision },
      });
      return row;
    });
    return NextResponse.json({
      ok: true,
      decision: { candidateId: saved.candidateId, decision: saved.decision, createdAt: saved.createdAt, updatedAt: saved.updatedAt },
    });
  } catch (err) {
    console.error("[autocut-decisions] failed to persist decision", { jobId, candidateId, err });
    return NextResponse.json({ error: "The decision could not be saved. Nothing was changed." }, { status: 500 });
  }
}
