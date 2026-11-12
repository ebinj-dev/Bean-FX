import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { MEDIA_ROOT } from "@/lib/media-storage";

export const runtime = "nodejs";

const RESULTS_DIR = path.join(MEDIA_ROOT, "analysis-results");

/**
 * Result endpoint for background RIISHE analysis jobs.
 *
 * GET /api/autocut/analyze/result/[jobId] returns the exact same payload the
 * old synchronous endpoint produced — the client flow is unchanged apart from
 * polling. The job record is ownership-checked; the payload file is written
 * by the job when the pipeline (including inference, validation and plan)
 * genuinely completed. No partial or fabricated result is ever served.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  const { jobId } = await ctx.params;
  const job = await db.job.findUnique({ where: { id: jobId } });
  if (!job || job.userId !== user.id || job.type !== "autocut-analysis") {
    return NextResponse.json({ error: "Analysis job not found." }, { status: 404 });
  }
  if (job.status !== "COMPLETED") {
    return NextResponse.json(
      { error: `Analysis is not finished (status: ${job.status}${job.stage ? `, stage: ${job.stage}` : ""}).` },
      { status: 409 }
    );
  }

  try {
    const raw = await fs.readFile(path.join(RESULTS_DIR, `${jobId}.json`), "utf8");
    return new NextResponse(raw, { status: 200, headers: { "Content-Type": "application/json" } });
  } catch {
    return NextResponse.json(
      { error: "The analysis result is no longer available in storage. Re-run the analysis — completed transcription chunks are preserved, so it will be fast." },
      { status: 404 }
    );
  }
}
