/**
 * M10 API — one A/B variant: apply / discard / promote scene-sequence (§6).
 * GET   /api/creative/variants/[id]                fetch
 * PATCH /api/creative/variants/[id]                {action:"apply"|"discard", decisionNote?}
 *       text → M9 approved metadata; thumbnail → M9 draft selection;
 *       scene-sequence → converted to an executable recommendation (approval flow).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, notFound, unauthorized } from "@/lib/process-helpers";
import { applyVariant, parseSceneSequencePayload } from "@/lib/creative/variants";
import { getTimelineHead } from "@/lib/editor/persistence";

export const runtime = "nodejs";

const PatchSchema = z.object({
  action: z.enum(["apply", "discard"]),
  decisionNote: z.string().max(300).nullable().default(null),
});

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const v = await db.creativeVariant.findUnique({ where: { id } });
  if (!v || v.userId !== user.id) return notFound();
  return NextResponse.json({
    variant: {
      id: v.id,
      projectId: v.projectId,
      reviewId: v.reviewId,
      kind: v.kind,
      label: v.label,
      description: v.description,
      changedElements: v.changedElementsJson ? JSON.parse(v.changedElementsJson) : null,
      payload: JSON.parse(v.payloadJson),
      provenance: v.provenanceJson ? JSON.parse(v.provenanceJson) : null,
      status: v.status,
      decisionNote: v.decisionNote,
      appliedAt: v.appliedAt?.toISOString() ?? null,
    },
  });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const v = await db.creativeVariant.findUnique({ where: { id } });
  if (!v || v.userId !== user.id) return notFound();

  if (parsed.data.action === "discard") {
    await db.creativeVariant.update({ where: { id }, data: { status: "DISCARDED", decisionNote: parsed.data.decisionNote?.slice(0, 300) ?? null } });
    return NextResponse.json({ ok: true, status: "DISCARDED" });
  }

  // scene-sequence → promote into the approval flow as a recommendation.
  const parsedPayload = parseSceneSequencePayload(v.payloadJson);
  if (parsedPayload) {
    const head = await getTimelineHead(v.projectId, user.id);
    const review = await db.creativeReview.create({
      data: {
        userId: user.id,
        projectId: v.projectId,
        scope: "retention",
        language: "en",
        status: "COMPLETED",
        stage: "Scene-sequence variant (A/B)",
        contextVersion: `v:${head.version}:${head.sequence.clips.length}:${head.sequence.clips.reduce((m, c) => Math.max(m, c.timelineStartFrame + c.timelineDurationFrames), 0)}`,
        headVersion: head.version,
        evidenceSourcesJson: JSON.stringify([{ engine: "MYAI", detail: "A/B scene-sequence variant" }]),
        missingEvidenceJson: JSON.stringify({ items: [] }),
      },
    });
    const rec = await db.creativeRecommendation.create({
      data: {
        reviewId: review.id,
        userId: user.id,
        projectId: v.projectId,
        recNo: 1,
        kind: "executable",
        engine: "MYAI",
        title: `Apply scene-sequence variant: ${v.label}`.slice(0, 160),
        detail: `Applying A/B variant "${v.label}" — ${v.description.slice(0, 200)}. Commands validated against the live timeline; a new version is created (undo intact).`,
        targetJson: null,
        proposalJson: JSON.stringify({ kind: "timeline-commands", commands: parsedPayload.commands }),
        previewJson: JSON.stringify({ commands: parsedPayload.commands.map((c) => (c as { type: string }).type) }),
        requiresApproval: true,
        status: "PROPOSED",
        timelineVersionAtProposal: head.version,
      },
    });
    await db.creativeVariant.update({ where: { id }, data: { status: "SELECTED", decisionNote: parsed.data.decisionNote?.slice(0, 300) ?? `promoted to recommendation ${rec.id}` } });
    return NextResponse.json({ ok: true, promotedRecommendationId: rec.id, note: "Scene-sequence variants go through the SAME approval flow as other timeline changes — approve it under Smart Recommendations." });
  }

  try {
    const result = await applyVariant(user.id, id, parsed.data.decisionNote);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof Error && err.message.includes("not found")) return notFound();
    return badRequest(err instanceof Error ? err.message : "Variant application failed.");
  }
}
