/**
 * Social Video Studio — plans API (M8.1 §3/§4).
 * POST /api/studio/plans: create a plan (validates the brief, links/creates
 * the project with the platform's sequence settings, runs the planner).
 * GET /api/studio/plans: list.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { enforceRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { badRequest, unauthorized } from "@/lib/process-helpers";
import { StudioBriefSchema, validateBriefForProfile, profileSequenceSettings } from "@/lib/studio/brief";
import { createStudioPlan } from "@/lib/studio/planner";
import { footageSourcingStatus } from "@/lib/studio/assets";

export const runtime = "nodejs";
export const maxDuration = 300;

const CreateSchema = z.object({
  brief: StudioBriefSchema,
  /** Reuse an existing owned project, else a new one is created. */
  projectId: z.string().max(64).nullable().default(null),
});

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  // M48-G2 — per-user rate limit (after authentication, so the limiter
  // never reveals whether another user’s resource exists).
  const limited = enforceRateLimit(req, "studioPlans", user.id, RATE_LIMITS.ai);
  if (limited) return limited;
  const parsed = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid brief: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const brief = parsed.data.brief;
  const check = validateBriefForProfile(brief);
  if (!check.ok) return badRequest(check.error ?? "brief violates the platform profile");

  let projectId = parsed.data.projectId;
  if (projectId) {
    const owned = await db.project.findFirst({ where: { id: projectId, userId: user.id } });
    if (!owned) return badRequest("Project not found or not owned.");
  } else {
    const settings = profileSequenceSettings(brief.platform);
    const project = await db.project.create({
      data: {
        userId: user.id,
        name: `Studio: ${brief.topic.slice(0, 60)}`,
        description: `Social Video Studio plan — ${check.profile.label} (${check.profile.aspect}), ${brief.language === "ta" ? "Tamil" : "English"}`,
        settingsJson: JSON.stringify(settings),
      },
    });
    projectId = project.id;
  }

  const plan = await db.studioPlan.create({
    data: { userId: user.id, projectId, status: "DRAFT", briefJson: JSON.stringify(brief), plannerMode: "pending" },
  });
  const outcome = await createStudioPlan(user.id, plan.id, brief);
  const scenes = await db.studioScene.findMany({ where: { planId: plan.id }, orderBy: { sceneNumber: "asc" } });
  return NextResponse.json({
    planId: plan.id,
    projectId,
    mode: outcome.mode,
    note: outcome.note,
    profile: { platform: check.profile.platform, aspect: check.profile.aspect, width: check.profile.width, height: check.profile.height, maxDurationSec: check.profile.maxDurationSec },
    scenes,
    footage: footageSourcingStatus(),
  });
}

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const plans = await db.studioPlan.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
    take: 20,
    select: { id: true, projectId: true, status: true, plannerMode: true, sceneCount: true, briefJson: true, createdAt: true, updatedAt: true },
  });
  return NextResponse.json({ plans: plans.map((p) => ({ ...p, topic: (JSON.parse(p.briefJson) as { topic: string }).topic, briefJson: undefined })) });
}
