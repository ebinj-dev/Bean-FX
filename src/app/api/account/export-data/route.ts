/**
 * M19 §10 — data export: a JSON report of everything this account owns
 * (profile, projects, media metadata, recent jobs, AI usage). File bytes are
 * NOT included (they stay downloadable in the app).
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser, AuthError } from "@/lib/auth";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

export async function GET() {
  try {
    const user = await requireUser();
    const projects = await db.project.findMany({ where: { userId: user.id }, select: { id: true, name: true, createdAt: true, updatedAt: true } });
    const media = await db.mediaAsset.findMany({ where: { userId: user.id }, select: { id: true, originalName: true, kind: true, createdAt: true } });
    const jobs = await db.job.findMany({ where: { userId: user.id }, select: { id: true, type: true, status: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 200 });
    const usage = await db.aIUsage.findMany({ where: { userId: user.id }, select: { provider: true, purpose: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 200 });
    await audit("account.data_exported", { userId: user.id });
    return NextResponse.json({
      exportedAt: new Date().toISOString(),
      profile: { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt },
      projects,
      media,
      recentJobs: jobs,
      aiUsage: usage,
    });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
