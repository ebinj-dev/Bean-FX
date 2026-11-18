import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

export const runtime = "nodejs";

const ANALYSIS_JOB_TYPE = "autocut-analysis";

const querySchema = z.object({
  mediaId: z.string().regex(/^[a-z0-9]{20,40}$/, "Invalid media id."),
});

/**
 * GET /api/autocut/analyses?mediaId=<media id>
 * Lists the current user's COMPLETED RIISHE analyses for one media asset,
 * newest first. This is the reopen path: the client uses the newest jobId to
 * fetch the immutable result payload plus its persisted decisions. Only owned
 * jobs are ever listed — cross-user access returns the media as not found.
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  const parsed = querySchema.safeParse({ mediaId: req.nextUrl.searchParams.get("mediaId") ?? "" });
  if (!parsed.success) {
    return NextResponse.json({ error: "A valid media id is required (mediaId query parameter)." }, { status: 400 });
  }
  const mediaId = parsed.data.mediaId;

  const media = await db.mediaAsset.findFirst({ where: { id: mediaId, userId: user.id }, select: { id: true } });
  if (!media) return NextResponse.json({ error: "Media not found." }, { status: 404 });

  // paramsJson is {"mediaId": "..."} — a plain JSON string in SQLite, so the
  // mediaId filter runs in JS over this user's (small) set of analysis jobs.
  const jobs = await db.job.findMany({
    where: { userId: user.id, type: ANALYSIS_JOB_TYPE, status: "COMPLETED" },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  const analyses = jobs
    .map((j) => {
      try {
        const params = JSON.parse(j.paramsJson ?? "{}") as { mediaId?: unknown };
        return params.mediaId === mediaId ? { jobId: j.id, createdAt: j.createdAt } : null;
      } catch {
        return null;
      }
    })
    .filter((a): a is { jobId: string; createdAt: Date } => a !== null)
    .slice(0, 20);

  return NextResponse.json({ ok: true, mediaId, analyses });
}
