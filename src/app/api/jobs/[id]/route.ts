import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { jobManager } from "@/lib/job-runner";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { id } = await ctx.params;

  const job = await db.job.findUnique({ where: { id } });
  if (!job || job.userId !== user.id) {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }
  return NextResponse.json({
    job: {
      id: job.id,
      type: job.type,
      status: job.status,
      progress: job.progress,
      stage: job.stage,
      message: job.message,
      exportId: job.exportId,
      error: job.status === "FAILED" ? job.message : null,
    },
  });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { id } = await ctx.params;
  const cancelled = await jobManager.cancel(id, user.id);
  if (!cancelled) return NextResponse.json({ error: "Job cannot be cancelled." }, { status: 409 });
  return NextResponse.json({ ok: true });
}
