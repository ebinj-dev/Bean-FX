/**
 * M31 — Production board payload (real persisted state only) + brief/script/
 * storyboard/budget edits. Board sections map 1:1 to persisted rows: stages,
 * append-only decisions, asset wall, real event log, honest budget (unknown
 * costs render as unknown, never zero), QA outcome.
 */
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getTemplate, ProductionBriefSchema, ProductionScriptSchema, StoryboardSchema, scriptDurationValid, stageCost } from "@/lib/production/engine";
import { logEvent, providerStatus, recordDecision, reconcileAfterRestart, syncJobBackedStages } from "@/lib/production/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function loadOwned(id: string, userId: string) {
  const production = await db.production.findUnique({ where: { id }, include: { stages: { orderBy: { order: "asc" } }, decisions: { orderBy: { createdAt: "asc" } }, assets: { orderBy: { createdAt: "asc" } }, events: { orderBy: { createdAt: "desc" }, take: 100 } } });
  if (!production || production.userId !== userId) return null;
  return production;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { id } = await ctx.params;
  let production = await loadOwned(id, user.id);
  if (!production) return NextResponse.json({ error: "Production not found." }, { status: 404 });
  // Keep board state truthful: reconcile restart orphans and job completions.
  await reconcileAfterRestart(id);
  await syncJobBackedStages(id);
  production = await loadOwned(id, user.id);
  if (!production) return NextResponse.json({ error: "Production not found." }, { status: 404 });

  const template = getTemplate(production.templateId);
  const provider = providerStatus();
  const stageCosts = (template?.stages ?? []).map((s) => ({ key: s.key, ...stageCost(s, production.approvedBudgetCents, { configured: provider.configured }) }));
  const brief = production.briefJson ? JSON.parse(production.briefJson) : null;
  const concept = production.conceptJson ? JSON.parse(production.conceptJson) : null;
  const script = production.scriptJson ? JSON.parse(production.scriptJson) : null;
  const storyboard = production.storyboardJson ? JSON.parse(production.storyboardJson) : null;
  return NextResponse.json({
    production: {
      id: production.id, title: production.title, templateId: production.templateId,
      status: production.status, projectId: production.projectId,
      createdAt: production.createdAt, updatedAt: production.updatedAt,
      qaState: production.qaState, qa: production.qaJson ? JSON.parse(production.qaJson) : null,
      delivery: production.deliveryJson ? JSON.parse(production.deliveryJson) : null,
      research: production.researchJson ? JSON.parse(production.researchJson) : null,
      reference: production.referenceJson ? JSON.parse(production.referenceJson) : null,
      approvedBudgetCents: production.approvedBudgetCents,
      estimatedCostCents: production.estimatedCostCents,
      actualCostCents: production.actualCostCents,
      pendingCostCents: production.pendingCostCents,
    },
    stages: production.stages.map((s) => ({ key: s.key, state: s.state, order: s.order, jobId: s.jobId, startedAt: s.startedAt, completedAt: s.completedAt, output: s.outputJson ? JSON.parse(s.outputJson) : null, error: s.error, costs: stageCosts.find((c) => c.key === s.key) ?? null })),
    decisions: production.decisions.map((d) => ({ id: d.id, kind: d.kind, value: JSON.parse(d.valueJson), createdAt: d.createdAt })),
    assets: production.assets.map((a) => ({ id: a.id, sceneKey: a.sceneKey, category: a.category, description: a.description, sourceType: a.sourceType, provider: a.provider, licenseState: a.licenseState, attribution: a.attribution, status: a.status, costUnknown: a.costUnknown, costCents: a.costCents, mediaAssetId: a.mediaAssetId })),
    events: production.events.map((e) => ({ id: e.id, kind: e.kind, stageKey: e.stageKey, detail: e.detailJson ? JSON.parse(e.detailJson) : null, createdAt: e.createdAt })),
    brief, concept, script, storyboard,
    scriptDurationValid: script ? scriptDurationValid(script as never) : null,
    provider,
  });
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { id } = await ctx.params;
  const production = await loadOwned(id, user.id);
  if (!production) return NextResponse.json({ error: "Production not found." }, { status: 404 });
  const body = await req.json().catch(() => null);
  if (!body?.kind) return NextResponse.json({ error: "body.kind is required (brief|script|storyboard|budget|concept|decision)." }, { status: 400 });

  switch (body.kind) {
    case "brief": {
      const parsed = ProductionBriefSchema.safeParse({ ...(production.briefJson ? JSON.parse(production.briefJson) : {}), ...body.brief });
      if (!parsed.success) return NextResponse.json({ error: `Invalid brief: ${parsed.error.issues.map((i) => i.message).join("; ")}` }, { status: 400 });
      await db.production.update({ where: { id }, data: { briefJson: JSON.stringify(parsed.data) } });
      await logEvent(id, "brief.updated", "BRIEF", { by: "user" });
      return NextResponse.json({ ok: true, brief: parsed.data });
    }
    case "concept": {
      const concept = production.conceptJson ? JSON.parse(production.conceptJson) : null;
      if (!concept?.options) return NextResponse.json({ error: "No concept options drafted yet." }, { status: 400 });
      const selectedId = typeof body.selectedId === "string" ? body.selectedId : "";
      const option = concept.options.find((o: { id: string }) => o.id === selectedId);
      if (!option) return NextResponse.json({ error: "selectedId must match a drafted option." }, { status: 400 });
      await db.production.update({ where: { id }, data: { conceptJson: JSON.stringify({ ...concept, selectedId }) } });
      await recordDecision(id, "concept", { selectedId, title: option.title });
      return NextResponse.json({ ok: true });
    }
    case "script": {
      const parsed = ProductionScriptSchema.safeParse(body.script);
      if (!parsed.success) return NextResponse.json({ error: `Invalid script: ${parsed.error.issues.map((i) => i.message).join("; ")}` }, { status: 400 });
      const prev = production.scriptJson ? (JSON.parse(production.scriptJson) as { revision: number }) : null;
      const next = { ...parsed.data, revision: (prev?.revision ?? 0) + 1 };
      await db.production.update({ where: { id }, data: { scriptJson: JSON.stringify(next) } });
      await logEvent(id, "script.revised", "SCRIPT", { revision: next.revision, durationValid: scriptDurationValid(next) });
      return NextResponse.json({ ok: true, script: next, durationValid: scriptDurationValid(next) });
    }
    case "storyboard": {
      const parsed = StoryboardSchema.safeParse(body.storyboard);
      if (!parsed.success) return NextResponse.json({ error: `Invalid storyboard: ${parsed.error.issues.map((i) => i.message).join("; ")}` }, { status: 400 });
      await db.production.update({ where: { id }, data: { storyboardJson: JSON.stringify(parsed.data) } });
      return NextResponse.json({ ok: true });
    }
    case "scene-approval": {
      const sb = production.storyboardJson ? (JSON.parse(production.storyboardJson) as { scenes: Array<{ sceneKey: string; approval: string }> }) : null;
      if (!sb) return NextResponse.json({ error: "No storyboard." }, { status: 400 });
      const scene = sb.scenes.find((s) => s.sceneKey === body.sceneKey);
      if (!scene) return NextResponse.json({ error: "Unknown sceneKey." }, { status: 400 });
      if (!["APPROVED", "REJECTED", "PENDING"].includes(body.decision)) return NextResponse.json({ error: "decision must be APPROVED|REJECTED|PENDING." }, { status: 400 });
      scene.approval = body.decision;
      await db.production.update({ where: { id }, data: { storyboardJson: JSON.stringify(sb) } });
      await logEvent(id, "scene.approval", "STORYBOARD", { sceneKey: body.sceneKey, decision: body.decision });
      return NextResponse.json({ ok: true });
    }
    case "budget": {
      const cents = Number(body.approvedBudgetCents);
      if (!Number.isInteger(cents) || cents < 0 || cents > 100_000_00) return NextResponse.json({ error: "approvedBudgetCents must be an integer 0..10000000." }, { status: 400 });
      await db.production.update({ where: { id }, data: { approvedBudgetCents: cents } });
      await recordDecision(id, "budget", { approvedBudgetCents: cents });
      return NextResponse.json({ ok: true });
    }
    default:
      return NextResponse.json({ error: `Unknown kind ${body.kind}.` }, { status: 400 });
  }
}
