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
import { DemonstrationPlanSchema } from "@/lib/production/showcase/types";
import { getPrimitive } from "@/lib/production/showcase/compositions";
import { logEvent, providerStatus, recordDecision, reconcileAfterRestart, syncJobBackedStages } from "@/lib/production/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function loadOwned(id: string, userId: string) {
  const production = await db.production.findUnique({ where: { id }, include: { stages: { orderBy: { order: "asc" } }, decisions: { orderBy: { createdAt: "asc" } }, assets: { orderBy: { createdAt: "asc" } }, events: { orderBy: { createdAt: "desc" }, take: 100 }, tasks: { orderBy: { seq: "asc" } } } });
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
      product: production.productJson ? JSON.parse(production.productJson) : null,
      approvedBudgetCents: production.approvedBudgetCents,
      estimatedCostCents: production.estimatedCostCents,
      actualCostCents: production.actualCostCents,
      pendingCostCents: production.pendingCostCents,
    },
    stages: production.stages.map((s) => ({ key: s.key, state: s.state, order: s.order, jobId: s.jobId, startedAt: s.startedAt, completedAt: s.completedAt, output: s.outputJson ? JSON.parse(s.outputJson) : null, error: s.error, costs: stageCosts.find((c) => c.key === s.key) ?? null })),
    decisions: production.decisions.map((d) => ({ id: d.id, kind: d.kind, value: JSON.parse(d.valueJson), createdAt: d.createdAt })),
    tasks: production.tasks.map((t) => ({ id: t.id, stageKey: t.stageKey, seq: t.seq, agent: t.agent, roleLabel: t.roleLabel, tool: t.tool, status: t.status, criteria: t.criteria, error: t.error, jobId: t.jobId, startedAt: t.startedAt, completedAt: t.completedAt, input: t.inputJson ? JSON.parse(t.inputJson) : null, output: t.outputJson ? JSON.parse(t.outputJson) : null })),
    assets: production.assets.map((a) => ({ id: a.id, sceneKey: a.sceneKey, category: a.category, description: a.description, sourceType: a.sourceType, provider: a.provider, licenseState: a.licenseState, attribution: a.attribution, status: a.status, costUnknown: a.costUnknown, costCents: a.costCents, mediaAssetId: a.mediaAssetId })),
    events: production.events.map((e) => ({ id: e.id, kind: e.kind, stageKey: e.stageKey, detail: e.detailJson ? JSON.parse(e.detailJson) : null, createdAt: e.createdAt })),
    brief, concept, script, storyboard,
    product: production.productJson ? JSON.parse(production.productJson) : null,
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

    // ── SHOWCASE Phase 3: storyboard editing (persisted; approved scenes are
    // never silently changed — an explicit reApprove flag flips them to
    // PENDING and the change is logged) ─────────────────────────────────────
    case "scene-edit": {
      const sb = production.storyboardJson ? (JSON.parse(production.storyboardJson) as { scenes: Array<Record<string, unknown>> }) : null;
      if (!sb) return NextResponse.json({ error: "No storyboard." }, { status: 400 });
      const idx = sb.scenes.findIndex((s) => s.sceneKey === body.sceneKey);
      if (idx < 0) return NextResponse.json({ error: "Unknown sceneKey." }, { status: 400 });
      const scene = sb.scenes[idx];
      if (scene.approval === "APPROVED" && body.reApprove !== true) {
        return NextResponse.json({ error: "Scene is APPROVED — pass reApprove:true to un-approve and edit it (the change is logged)." }, { status: 409 });
      }
      const editable = ["durationSec", "textOverlay", "productElement", "transition", "compositionPrimitive", "generationInstructions", "demonstration", "storyPurpose", "requiredAssetKind"] as const;
      const patch: Record<string, unknown> = {};
      for (const k of editable) {
        if (body.patch && k in body.patch) patch[k] = body.patch[k];
      }
      if (patch.durationSec !== undefined && (!Number.isFinite(Number(patch.durationSec)) || Number(patch.durationSec) < 0.5 || Number(patch.durationSec) > 120)) {
        return NextResponse.json({ error: "durationSec must be 0.5..120." }, { status: 400 });
      }
      if (patch.compositionPrimitive !== undefined && patch.compositionPrimitive !== null && typeof getPrimitive(String(patch.compositionPrimitive)) !== "object") {
        return NextResponse.json({ error: `Unknown composition primitive "${String(patch.compositionPrimitive)}".` }, { status: 400 });
      }
      if (patch.demonstration !== undefined && patch.demonstration !== null) {
        const d = DemonstrationPlanSchema.safeParse(patch.demonstration);
        if (!d.success) return NextResponse.json({ error: `Invalid demonstration plan: ${d.error.issues.map((i) => i.message).join("; ")}` }, { status: 400 });
        if (d.data.sourceMediaId) {
          const owned = await db.mediaAsset.findFirst({ where: { id: d.data.sourceMediaId, userId: user.id } });
          if (!owned) return NextResponse.json({ error: "Demonstration source media not found or not owned by the caller." }, { status: 404 });
        }
        patch.demonstration = d.data;
      }
      sb.scenes[idx] = { ...scene, ...patch, approval: body.reApprove === true ? "PENDING" : scene.approval };
      await db.production.update({ where: { id }, data: { storyboardJson: JSON.stringify(sb) } });
      await logEvent(id, "scene.edited", "STORYBOARD", { sceneKey: body.sceneKey, fields: Object.keys(patch), reApproved: body.reApprove === true });
      return NextResponse.json({ ok: true, scene: sb.scenes[idx] });
    }
    case "scene-reorder": {
      const sb = production.storyboardJson ? (JSON.parse(production.storyboardJson) as { scenes: Array<Record<string, unknown>> }) : null;
      if (!sb) return NextResponse.json({ error: "No storyboard." }, { status: 400 });
      const idx = sb.scenes.findIndex((s) => s.sceneKey === body.sceneKey);
      if (idx < 0) return NextResponse.json({ error: "Unknown sceneKey." }, { status: 400 });
      const to = Number(body.toIndex);
      if (!Number.isInteger(to) || to < 0 || to >= sb.scenes.length) return NextResponse.json({ error: `toIndex must be 0..${sb.scenes.length - 1}.` }, { status: 400 });
      const [moved] = sb.scenes.splice(idx, 1);
      sb.scenes.splice(to, 0, moved);
      sb.scenes.forEach((s, i) => { s.sceneNumber = i + 1; });
      await db.production.update({ where: { id }, data: { storyboardJson: JSON.stringify(sb) } });
      await logEvent(id, "scene.reordered", "STORYBOARD", { sceneKey: body.sceneKey, from: idx, to });
      return NextResponse.json({ ok: true });
    }
    case "scene-duplicate": {
      const sb = production.storyboardJson ? (JSON.parse(production.storyboardJson) as { scenes: Array<Record<string, unknown>> }) : null;
      if (!sb) return NextResponse.json({ error: "No storyboard." }, { status: 400 });
      if (sb.scenes.length >= 60) return NextResponse.json({ error: "Storyboard cap is 60 scenes." }, { status: 400 });
      const idx = sb.scenes.findIndex((s) => s.sceneKey === body.sceneKey);
      if (idx < 0) return NextResponse.json({ error: "Unknown sceneKey." }, { status: 400 });
      const copy = { ...sb.scenes[idx], sceneKey: `scene-${Date.now().toString(36)}`, approval: "PENDING" };
      sb.scenes.splice(idx + 1, 0, copy);
      sb.scenes.forEach((s, i) => { s.sceneNumber = i + 1; });
      await db.production.update({ where: { id }, data: { storyboardJson: JSON.stringify(sb) } });
      await logEvent(id, "scene.duplicated", "STORYBOARD", { from: body.sceneKey, newKey: copy.sceneKey });
      return NextResponse.json({ ok: true, sceneKey: copy.sceneKey });
    }
    case "scene-remove": {
      const sb = production.storyboardJson ? (JSON.parse(production.storyboardJson) as { scenes: Array<Record<string, unknown>> }) : null;
      if (!sb) return NextResponse.json({ error: "No storyboard." }, { status: 400 });
      if (sb.scenes.length <= 1) return NextResponse.json({ error: "A storyboard needs at least one scene." }, { status: 400 });
      const idx = sb.scenes.findIndex((s) => s.sceneKey === body.sceneKey);
      if (idx < 0) return NextResponse.json({ error: "Unknown sceneKey." }, { status: 400 });
      const [removed] = sb.scenes.splice(idx, 1);
      sb.scenes.forEach((s, i) => { s.sceneNumber = i + 1; });
      await db.production.update({ where: { id }, data: { storyboardJson: JSON.stringify(sb) } });
      await logEvent(id, "scene.removed", "STORYBOARD", { sceneKey: removed.sceneKey, storyPurpose: removed.storyPurpose ?? "" });
      return NextResponse.json({ ok: true });
    }
    case "scene-regenerate": {
      // Re-derive one scene's planned fields from its script line (deterministic),
      // un-approve it, and log the regeneration. No silent changes to approvals.
      const sb = production.storyboardJson ? (JSON.parse(production.storyboardJson) as { scenes: Array<Record<string, unknown>> }) : null;
      const script = production.scriptJson ? (JSON.parse(production.scriptJson) as { lines: Array<Record<string, unknown>> }) : null;
      if (!sb || !script) return NextResponse.json({ error: "Storyboard and script required." }, { status: 400 });
      const idx = sb.scenes.findIndex((s) => s.sceneKey === body.sceneKey);
      if (idx < 0 || idx >= script.lines.length) return NextResponse.json({ error: "Unknown sceneKey (or no matching script line)." }, { status: 400 });
      const line = script.lines[idx];
      const scene = sb.scenes[idx];
      sb.scenes[idx] = {
        ...scene,
        durationSec: Number(line.durationSec) > 0 ? Number(line.durationSec) : scene.durationSec,
        storyPurpose: String(line.onScreenText ?? "") || String(line.narration ?? "") || scene.storyPurpose,
        textOverlay: String(line.onScreenText ?? "").slice(0, 120),
        transition: String(line.transition ?? "cut").slice(0, 60),
        approval: "PENDING",
      };
      await db.production.update({ where: { id }, data: { storyboardJson: JSON.stringify(sb) } });
      await logEvent(id, "scene.regenerated", "STORYBOARD", { sceneKey: body.sceneKey, fromScriptLine: idx + 1 });
      return NextResponse.json({ ok: true, scene: sb.scenes[idx] });
    }
    case "product-approval": {
      const product = production.productJson ? (JSON.parse(production.productJson) as { approval?: string }) : null;
      if (!product) return NextResponse.json({ error: "No product-understanding artifact yet — run UNDERSTAND first." }, { status: 400 });
      if (!["APPROVED", "REJECTED", "PENDING"].includes(body.decision)) return NextResponse.json({ error: "decision must be APPROVED|REJECTED|PENDING." }, { status: 400 });
      product.approval = body.decision;
      await db.production.update({ where: { id }, data: { productJson: JSON.stringify(product) } });
      await recordDecision(id, "product-understanding", { decision: body.decision });
      await logEvent(id, "product.approval", "PRODUCT_UNDERSTANDING", { decision: body.decision });
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
