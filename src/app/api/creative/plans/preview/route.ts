/**
 * M11 API — plan preview / dry-run simulation (§8).
 * POST /api/creative/plans/preview
 *   { projectId, commands: Command[] }           — preview an arbitrary validated plan
 *   { projectId, recommendationId }              — preview a stored recommendation's plan
 * Runs the chain against the LIVE head IN MEMORY — no database writes ever.
 * Also supports { projectId, mode: "pause-surgery", thresholds } to preview
 * the planner's proposed removals against measured silence artifacts.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/process-helpers";
import { getTimelineHead } from "@/lib/editor/persistence";
import { previewPlan } from "@/lib/creative/preview";
import { planPauseSurgery, validateSurgeryOptions } from "@/lib/creative/pause-surgery";
import { contextVersionOf } from "@/lib/creative/contracts";

export const runtime = "nodejs";

const Schema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("commands"), projectId: z.string().max(64), commands: z.array(z.record(z.string(), z.unknown())).min(1).max(40), affectedClipIds: z.array(z.string().max(64)).max(40).default([]), cuts: z.array(z.object({ startSec: z.number().min(0), endSec: z.number().min(0) })).max(24).default([]) }),
  z.object({ mode: z.literal("recommendation"), projectId: z.string().max(64), recommendationId: z.string().max(64) }),
  z.object({ mode: z.literal("pause-surgery"), projectId: z.string().max(64), thresholds: z.record(z.string(), z.number()).nullable().default(null) }),
]);

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const project = await db.project.findUnique({ where: { id: parsed.data.projectId } });
  if (!project || project.userId !== user.id) return badRequest("Project not found or not owned by the caller.");

  const head = await getTimelineHead(parsed.data.projectId, user.id);

  if (parsed.data.mode === "commands") {
    const preview = previewPlan(head.sequence, parsed.data.commands, parsed.data.affectedClipIds, parsed.data.cuts);
    return NextResponse.json({ preview, headVersion: head.version, contextVersion: contextVersionOf(head.version, head.sequence.clips.length, head.sequence.clips.reduce((m, c) => Math.max(m, c.timelineStartFrame + c.timelineDurationFrames), 0)) });
  }

  if (parsed.data.mode === "recommendation") {
    const rec = await db.creativeRecommendation.findUnique({ where: { id: parsed.data.recommendationId } });
    if (!rec || rec.userId !== user.id) return badRequest("Recommendation not found or not owned by the caller.");
    let payload: { kind?: string; commands?: Record<string, unknown>[] } = {};
    try {
      payload = JSON.parse(rec.proposalJson) as { kind?: string; commands?: Record<string, unknown>[] };
    } catch {
      return badRequest("Recommendation payload unparseable.");
    }
    if (payload.kind === "informational" || !payload.commands) return badRequest("Informational recommendations have no timeline plan to preview.");
    if (head.version !== rec.timelineVersionAtProposal) {
      return NextResponse.json({ preview: { ok: false, error: `stale: proposal was made at v${rec.timelineVersionAtProposal}, head is v${head.version}`, before: null, after: null }, headVersion: head.version });
    }
    const preview = previewPlan(head.sequence, payload.commands, rec.targetJson ? [((JSON.parse(rec.targetJson) as { clipId?: string }).clipId ?? "")].filter(Boolean) : []);
    return NextResponse.json({ preview, headVersion: head.version });
  }

  // pause-surgery: preview the planner against the latest measured silence.
  const thresholds = validateSurgeryOptions(parsed.data.thresholds ?? {});
  const latestReview = await db.creativeReview.findFirst({ where: { userId: user.id, projectId: parsed.data.projectId, status: "COMPLETED" }, orderBy: { updatedAt: "desc" } });
  const audioSource = latestReview?.evidenceSourcesJson ? (JSON.parse(latestReview.evidenceSourcesJson) as { engine: string; detail: string }[]) : [];
  void audioSource;
  // Measured spans come from the review's findings (long-pause/dead-air are timeline-mapped already).
  const spans = latestReview
    ? (await db.creativeFinding.findMany({ where: { reviewId: latestReview.id, category: { in: ["long-pause", "dead-air"] }, evidenceLabel: "measured", startSec: { not: null } } })).map((f) => ({ start: f.startSec as number, end: (f.endSec as number) ?? (f.startSec as number) + 1 }))
    : [];
  if (!spans.length) return badRequest("No measured silence spans exist yet — run a multimodal review first.");
  const plan = planPauseSurgery(head.sequence, spans, thresholds, null);
  const commands = plan.removals.flatMap((r) => r.commands) as unknown[];
  const preview = previewPlan(head.sequence, commands, [...new Set(plan.removals.flatMap((r) => r.affectedClipIds))], plan.removals.map((r) => ({ startSec: r.spanSec.start, endSec: r.spanSec.end })));
  return NextResponse.json({ preview, plan: { removals: plan.removals.map((r) => ({ span: r.spanSec, kind: r.kind, affectedClips: r.affectedClipIds, removedFrames: r.removedTimelineFrames })), skipped: plan.skipped, warnings: plan.warnings }, headVersion: head.version });
}
