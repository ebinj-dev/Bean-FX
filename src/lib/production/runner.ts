/**
 * M31 — Production Studio stage runners. Deterministic, resumable, honest.
 * Executable work rides the EXISTING durable Job system (enqueueMediaJob /
 * RENDER_TIMELINE). Provider-dependent work is gated by capability + explicit
 * approval; unavailability is stated, never simulated.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { applyTimelineEdits, getTimelineHead } from "@/lib/editor/persistence";
import { enqueueMediaJob, JOB_TYPE_RENDER_TIMELINE } from "@/lib/job-helpers";
import { notify } from "@/lib/notify";
import {
  ProductionBriefSchema, type ProductionBrief, canTransition, type StageState, seqClips,
  getTemplate, draftConceptOptions, type ProductionScript, type StoryboardScene,
  scriptDurationValid, stageCost, preRenderChecks, qaOutcome, type QaCheck,
} from "./engine";
import { PrismaClient } from "@prisma/client";

type Db = PrismaClient["production"];

export class ProductionError extends Error {
  constructor(message: string, readonly status: number = 400, readonly code: string = "PRODUCTION_ERROR") {
    super(message);
  }
}

// ── Events & decisions (append-only, real activity only) ────────────────────
export async function logEvent(productionId: string, kind: string, stageKey?: string, detail?: unknown): Promise<void> {
  await db.productionEvent.create({ data: { productionId, kind, stageKey: stageKey ?? null, detailJson: detail === undefined ? null : JSON.stringify(detail) } });
}

export async function recordDecision(productionId: string, kind: string, value: unknown): Promise<void> {
  await db.productionDecision.create({ data: { productionId, kind, valueJson: JSON.stringify(value) } });
}

export function providerStatus(): { configured: boolean; reason: string } {
  const configured = Boolean(process.env.ZAI_API_KEY || process.env.Z_AI_API_KEY);
  return configured
    ? { configured: true, reason: "provider credentials present" }
    : { configured: false, reason: "No LLM provider credentials on this deployment (ZAI_API_KEY absent) — creative-text stages run as deterministic drafts the user authors/edits; provider enhancement is CONFIGURATION REQUIRED" };
}

// ── Intake: deterministic brief extraction (LLM-assist only if configured) ──
export function extractBriefFields(text: string, fallbackTitle: string): Partial<ProductionBrief> {
  const out: Partial<ProductionBrief> = {};
  const dur = text.match(/(\d{1,3})\s*(?:-|\s)?\s*(?:second|seconds|sec|s\b)/i) ?? text.match(/(\d{1,3})\s*s\b/i);
  if (dur) out.targetDurationSec = Math.min(3600, Math.max(3, parseInt(dur[1], 10)));
  if (/vertical|tiktok|reels|shorts|9:16/i.test(text)) out.aspectRatio = "9:16";
  else if (/square|1:1/i.test(text)) out.aspectRatio = "1:1";
  else if (/4:5/i.test(text)) out.aspectRatio = "4:5";
  else if (/16:9|youtube|landscape|widescreen/i.test(text)) out.aspectRatio = "16:9";
  if (/cinematic|luxury|premium|dramatic|moody/i.test(text)) out.tone = "cinematic, premium, dramatic lighting";
  else if (/playful|fun|energetic/i.test(text)) out.tone = "playful, energetic";
  else if (/corporate|professional|clean/i.test(text)) out.tone = "clean, professional";
  if (/headphone|product|commercial|brand|launch/i.test(text)) out.purpose = "product commercial";
  if (/podcast|interview|episode/i.test(text)) out.purpose = "podcast repurposing";
  if (/subtitles?|captions?|captions on/i.test(text)) out.subtitles = true;
  if (/minimal narration|no narration|silent/i.test(text)) out.narrationPreference = "none";
  const title = text.match(/(?:titled?|called)\s+["“']([^"”']{3,80})["”']/i);
  out.title = (title?.[1] ?? fallbackTitle).slice(0, 120);
  return out;
}

// ── Analysis (deterministic media analysis for repurposing) ─────────────────
export interface AnalysisSegment { startSec: number; endSec: number; durationSec: number; kind: string }
export function analyzeMediaDeterministically(filePath: string): { durationSec: number; segments: AnalysisSegment[]; note: string } {
  const probe = JSON.parse(execSync(`ffprobe -v error -print_format json -show_format "${filePath}"`, { encoding: "utf8" }));
  const durationSec = Number(probe.format?.duration ?? 0);
  // Speech/activity segmentation via silencedetect (real FFmpeg analysis).
  let segments: AnalysisSegment[] = [];
  try {
    const out = execSync(`ffmpeg -i "${filePath}" -af "silencedetect=noise=-35dB:d=1.2" -f null - 2>&1 | grep -oE "silence_(start|end): [0-9.]+"`, { encoding: "utf8" });
    const marks = out.split("\n").map((l) => {
      const m = l.match(/silence_(start|end): ([0-9.]+)/);
      return m ? { kind: m[1], t: Number(m[2]) } : null;
    }).filter(Boolean) as { kind: string; t: number }[];
    let cursor = 0;
    for (const mk of marks) {
      if (mk.kind === "start" && mk.t - cursor >= 2) segments.push({ startSec: cursor, endSec: mk.t, durationSec: mk.t - cursor, kind: "activity" });
      if (mk.kind === "end") cursor = mk.t;
    }
    if (durationSec - cursor >= 2) segments.push({ startSec: cursor, endSec: durationSec, durationSec: durationSec - cursor, kind: "activity" });
  } catch {
    segments = [{ startSec: 0, endSec: durationSec, durationSec, kind: "full" }];
  }
  if (segments.length === 0) segments = [{ startSec: 0, endSec: durationSec, durationSec, kind: "full" }];
  return { durationSec, segments, note: "FFmpeg silencedetect segmentation (deterministic). Transcript requires ASR configuration — marked NOT RUN if unavailable." };
}

// ── Runner ──────────────────────────────────────────────────────────────────
type StageRow = { id: string; key: string; kind: string; state: StageState; jobId: string | null; order: number };

async function setStage(productionId: string, stageId: string, state: StageState, patch: Partial<{ jobId: string; error: string; outputJson: string; checkpointJson: string; startedAt: Date; completedAt: Date }> = {}): Promise<void> {
  await db.productionStage.update({ where: { id: stageId }, data: { state, ...patch } });
  await logEvent(productionId, `stage.${state.toLowerCase()}`, undefined, { stageId });
}

/** Flip RUNNING stages to READY after a restart (their jobs are gone/recoverable). */
export async function reconcileAfterRestart(productionId: string): Promise<void> {
  const stages = await db.productionStage.findMany({ where: { productionId, state: "RUNNING" } });
  for (const s of stages) {
    if (!s.jobId) {
      await db.productionStage.update({ where: { id: s.id }, data: { state: "READY" } });
      await logEvent(productionId, "stage.recovered_after_restart", s.key, { from: "RUNNING", to: "READY" });
    } else {
      const job = await db.job.findUnique({ where: { id: s.jobId } });
      if (!job || ["FAILED", "CANCELLED"].includes(job.status)) {
        await db.productionStage.update({ where: { id: s.id }, data: { state: job?.status === "FAILED" ? "FAILED" : "READY", error: job?.message ?? "job lost" } });
        await logEvent(productionId, "stage.recovered_after_restart", s.key, { jobStatus: job?.status ?? "missing" });
      }
    }
  }
}

export async function syncJobBackedStages(productionId: string): Promise<void> {
  const stages = await db.productionStage.findMany({ where: { productionId, state: "RUNNING", jobId: { not: null } } });
  for (const s of stages) {
    const job = await db.job.findUnique({ where: { id: s.jobId! } });
    if (!job) continue;
    if (job.status === "COMPLETED") {
      let output = await db.exportFile.findFirst({ where: { paramsJson: { contains: job.id } }, orderBy: { createdAt: "desc" } });
      if (!output) {
        // Some export rows do not embed the job id in paramsJson — fall back to
        // the newest render artifact created no earlier than the job started.
        output = await db.exportFile.findFirst({ where: { userId: job.userId, kind: "TIMELINE_RENDER", createdAt: { gte: job.createdAt } }, orderBy: { createdAt: "desc" } });
      }
      await setStage(productionId, s.id, "SUCCEEDED", { completedAt: new Date(), outputJson: JSON.stringify({ jobId: job.id, exportFileId: output?.id ?? null, storagePath: output?.storagePath ?? null }) });
    } else if (job.status === "FAILED" || job.status === "CANCELLED") {
      await setStage(productionId, s.id, "FAILED", { error: job.message ?? job.status, completedAt: new Date() });
      await db.production.update({ where: { id: productionId }, data: { status: "FAILED" } });
    }
  }
}

/** Advance into a stage and run its deterministic part. */
export async function startStage(productionId: string, stageKey: string, userId: string): Promise<{ state: StageState; message: string }> {
  const production = await db.production.findUnique({ where: { id: productionId }, include: { stages: true } });
  if (!production) throw new ProductionError("Production not found.", 404, "NOT_FOUND");
  if (production.userId !== userId) throw new ProductionError("Production not found.", 404, "NOT_FOUND"); // no-leak
  const template = getTemplate(production.templateId);
  if (!template) throw new ProductionError("Unknown template.", 400, "BAD_TEMPLATE");
  const stage = production.stages.find((s) => s.key === stageKey);
  if (!stage) throw new ProductionError("Stage not part of this pipeline.", 400, "BAD_STAGE");
  if (!template.active) throw new ProductionError(template.unavailableReason ?? "Template not active.", 409, "TEMPLATE_INACTIVE");

  const idx = template.stages.findIndex((s) => s.key === stageKey);
  for (const dep of template.stages[idx].dependsOn) {
    const depRow = production.stages.find((s) => s.key === dep);
    if (!depRow || !["SUCCEEDED", "SKIPPED"].includes(depRow.state)) {
      throw new ProductionError(`Stage ${stageKey} is blocked: dependency ${dep} has not succeeded.`, 409, "DEPENDENCY_NOT_MET");
    }
  }
  if (!canTransition(stage.state as StageState, "READY") && stage.state !== "READY") {
    throw new ProductionError(`Invalid transition ${stage.state} → READY for ${stageKey}.`, 409, "INVALID_TRANSITION");
  }
  await reconcileAfterRestart(productionId);
  await syncJobBackedStages(productionId);
  const fresh = await db.productionStage.findUniqueOrThrow({ where: { id: stage.id } });
  if (fresh.state === "SUCCEEDED") return { state: "SUCCEEDED", message: "Stage already succeeded — resume skips completed stages." };
  // Advance NOT_STARTED → READY explicitly (the machine always walks legal edges).
  if (fresh.state === "NOT_STARTED") {
    await db.productionStage.update({ where: { id: fresh.id }, data: { state: "READY" } });
    await logEvent(productionId, "stage.ready", stageKey);
  }
  if (!canTransition("READY", "RUNNING")) throw new ProductionError("READY → RUNNING must be legal.", 500, "STATE_MACHINE_BUG");

  await setStage(productionId, stage.id, "RUNNING", { startedAt: new Date() });
  await db.production.update({ where: { id: productionId }, data: { status: "RUNNING" } });
  try {
    const result = await runStageKind(production, template.stages[idx], fresh.id, userId);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await setStage(productionId, stage.id, "FAILED", { error: message.slice(0, 500), completedAt: new Date() });
    await db.production.update({ where: { id: productionId }, data: { status: "FAILED" } });
    await logEvent(productionId, "stage.failed", stageKey, { error: message.slice(0, 300) });
    throw err instanceof ProductionError ? err : new ProductionError(`Stage ${stageKey} failed: ${message}`, 500, "STAGE_FAILED");
  }
}

async function runStageKind(production: { id: string; userId: string; projectId: string | null; briefJson: string | null; templateId: string }, stage: { key: string; kind: string; requiresApproval: boolean; requiresProvider?: string; skippable: boolean }, stageId: string, userId: string): Promise<{ state: StageState; message: string }> {
  const pid = production.id;
  const brief: ProductionBrief | null = production.briefJson ? ProductionBriefSchema.parse(JSON.parse(production.briefJson)) : null;

  switch (stage.kind) {
    case "brief": {
      const text = brief?.briefText ?? "";
      const fields = extractBriefFields(text, brief?.title ?? "Untitled production");
      const merged = ProductionBriefSchema.parse({ ...(brief ?? {}), ...fields, briefText: text, title: brief?.title || fields.title || "Untitled production", targetDurationSec: brief?.targetDurationSec ?? fields.targetDurationSec ?? 30 });
      await db.production.update({ where: { id: pid }, data: { briefJson: JSON.stringify(merged), status: "AWAITING_APPROVAL" } });
      await setStage(pid, stageId, "AWAITING_APPROVAL");
      await logEvent(pid, "brief.drafted", stage.key, { deterministic: true, providerEnhanced: providerStatus().configured });
      return { state: "AWAITING_APPROVAL", message: "Brief drafted deterministically from your description — review and edit it, then approve." };
    }
    case "research": {
      // Honest research: no web-search provider is wired into the product
      // runtime → record the absence instead of inventing citations.
      const research = { verdict: "NOT_CONFIGURED", note: "No research capability is configured on this deployment. Facts must be user-supplied; no citations were generated because none can be verified.", claims: [] };
      await db.production.update({ where: { id: pid }, data: { researchJson: JSON.stringify(research) } });
      await setStage(pid, stageId, "SUCCEEDED", { completedAt: new Date(), outputJson: JSON.stringify(research) });
      return { state: "SUCCEEDED", message: "Research capability not configured — recorded honestly (no fabricated citations)." };
    }
    case "concept": {
      if (!brief) throw new ProductionError("Brief required before concepts.", 400, "NO_BRIEF");
      const options = draftConceptOptions(brief);
      await db.production.update({ where: { id: pid }, data: { conceptJson: JSON.stringify({ options, selectedId: null }), status: "AWAITING_APPROVAL" } });
      await setStage(pid, stageId, "AWAITING_APPROVAL");
      return { state: "AWAITING_APPROVAL", message: "2-3 distinct concept directions drafted — select one to approve." };
    }
    case "script": {
      const concept = production.briefJson ? (await db.production.findUniqueOrThrow({ where: { id: pid } })).conceptJson : null;
      const selected = concept ? (JSON.parse(concept) as { selectedId: string | null }) : null;
      if (!selected?.selectedId) throw new ProductionError("Select and approve a concept before the script stage.", 409, "NO_CONCEPT_SELECTED");
      if (!brief) throw new ProductionError("Brief required.", 400, "NO_BRIEF");
      // Deterministic skeleton from the approved concept's structure; user edits finalize it.
      const parts = [0.3, 0.4, 0.3];
      const lines = parts.map((p, i) => ({
        id: `sc${i + 1}-${Date.now().toString(36)}`,
        sceneNumber: i + 1,
        narration: "", dialogue: "",
        onScreenText: i === 0 ? (brief.title ?? "").slice(0, 60) : "",
        durationSec: Math.max(1, Math.round(brief.targetDurationSec * p)),
        visual: `Scene ${i + 1} — ${brief.visualDirection || "per approved concept"}`,
        audio: brief.musicPreference === "user-provided" ? "user music bed" : "no music configured",
        transition: i === 0 ? "cut in" : "cut",
        captionCue: brief.subtitles ? "captions on" : "",
        reference: "",
      }));
      const script: ProductionScript = { revision: 1, targetDurationSec: brief.targetDurationSec, lines };
      const valid = scriptDurationValid(script);
      await db.production.update({ where: { id: pid }, data: { scriptJson: JSON.stringify(script), status: "AWAITING_APPROVAL" } });
      await setStage(pid, stageId, "AWAITING_APPROVAL", { outputJson: JSON.stringify({ durationValid: valid }) });
      return { state: "AWAITING_APPROVAL", message: `Script skeleton drafted (${valid ? "duration consistent" : "DURATION MISMATCH — edit before approving"}). Edit and approve.` };
    }
    case "storyboard": {
      const row = await db.production.findUniqueOrThrow({ where: { id: pid } });
      const script: ProductionScript | null = row.scriptJson ? JSON.parse(row.scriptJson) : null;
      if (!script) throw new ProductionError("Script required before storyboard.", 400, "NO_SCRIPT");
      const scenes: StoryboardScene[] = script.lines.map((l, i) => ({
        sceneKey: `scene-${i + 1}`, sceneNumber: i + 1, durationSec: l.durationSec,
        storyPurpose: l.onScreenText || l.narration || `Beat ${i + 1}`,
        shotType: i === 0 ? "Wide / establishing" : "Medium insert", cameraDirection: "Static to slow push",
        subject: brief?.subject?.slice(0, 200) ?? "", environment: "", lighting: brief?.tone ?? "",
        composition: "Center-weighted", movement: "Cut on motion", visualStyle: brief?.visualDirection ?? "",
        narrationSegment: l.narration, audioCue: l.audio, requiredAssetKind: "user_media",
        reference: "", generationInstructions: "", thumbnailPending: true as const, approval: "PENDING",
      }));
      await db.production.update({ where: { id: pid }, data: { storyboardJson: JSON.stringify({ scenes }), status: "AWAITING_APPROVAL" } });
      await setStage(pid, stageId, "AWAITING_APPROVAL");
      return { state: "AWAITING_APPROVAL", message: "Storyboard drafted from the approved script — approve scenes to continue." };
    }
    case "asset_planning": {
      const row = await db.production.findUniqueOrThrow({ where: { id: pid } });
      let sb = row.storyboardJson ? (JSON.parse(row.storyboardJson) as { scenes: StoryboardScene[] }) : null;
      if (!sb) {
        // Templates without a separate storyboard stage derive the scenes from
        // the approved script (same mapping the storyboard runner uses).
        const script: ProductionScript | null = row.scriptJson ? JSON.parse(row.scriptJson) : null;
        if (!script) throw new ProductionError("Script required before asset planning.", 400, "NO_SCRIPT");
        const briefNow = row.briefJson ? ProductionBriefSchema.parse(JSON.parse(row.briefJson)) : null;
        const derived: StoryboardScene[] = script.lines.map((l, i) => ({
          sceneKey: `scene-${i + 1}`, sceneNumber: i + 1, durationSec: l.durationSec,
          storyPurpose: l.onScreenText || l.narration || `Beat ${i + 1}`,
          shotType: i === 0 ? "Wide / establishing" : "Medium insert", cameraDirection: "Static to slow push",
          subject: briefNow?.subject?.slice(0, 200) ?? "", environment: "", lighting: briefNow?.tone ?? "",
          composition: "Center-weighted", movement: "Cut on motion", visualStyle: briefNow?.visualDirection ?? "",
          narrationSegment: l.narration, audioCue: l.audio, requiredAssetKind: "user_media",
          reference: "", generationInstructions: "", thumbnailPending: true as const, approval: "PENDING",
        }));
        sb = { scenes: derived };
        await db.production.update({ where: { id: pid }, data: { storyboardJson: JSON.stringify(sb) } });
        await logEvent(pid, "storyboard.derived_from_script", stage.key, { scenes: derived.length });
      }
      const brief2 = brief!;
      const existing = await db.productionAsset.findMany({ where: { productionId: pid } });
      const plan: Array<{ sceneKey: string | null; category: string; description: string; sourceType: string; licenseState: string; costUnknown: boolean; status: string }> = [];
      for (const sc of sb.scenes) {
        if (sc.requiredAssetKind === "user_media") {
          const src = brief2.sourceMediaIds[0];
          const already = existing.find((a) => a.sceneKey === sc.sceneKey && a.category === "video" && a.status !== "REJECTED");
          if (!already) plan.push({ sceneKey: sc.sceneKey, category: "video", description: `Footage for ${sc.sceneKey}: ${sc.storyPurpose.slice(0, 80)}`, sourceType: "USER_MEDIA", licenseState: "USER_CONFIRMED", costUnknown: false, status: src ? "PENDING" : "BLOCKED" });
        }
      }
      if (brief2.musicPreference === "user-provided") {
        const hasMusic = existing.find((a) => a.category === "music");
        if (!hasMusic) plan.push({ sceneKey: null, category: "music", description: "User-supplied music bed", sourceType: "USER_MEDIA", licenseState: "USER_CONFIRMED", costUnknown: false, status: "PENDING" });
      }
      for (const p of plan) {
        await db.productionAsset.create({ data: { productionId: pid, sceneKey: p.sceneKey, category: p.category, description: p.description, sourceType: p.sourceType, licenseState: p.licenseState, costUnknown: p.costUnknown, status: p.status, provenanceJson: JSON.stringify({ plannedAt: new Date().toISOString(), deterministic: true }) } });
      }
      await logEvent(pid, "assets.planned", stage.key, { planned: plan.length });
      await setStage(pid, stageId, "AWAITING_APPROVAL", { outputJson: JSON.stringify({ planned: plan.length }) });
      return { state: "AWAITING_APPROVAL", message: `Asset plan drafted (${plan.length} items). Attach/approve assets to continue.` };
    }
    case "asset_generation": {
      const assets = await db.productionAsset.findMany({ where: { productionId: pid } });
      let ready = 0; let blocked = 0;
      for (const a of assets) {
        if (a.status === "APPROVED" || a.status === "READY") { ready++; continue; }
        if (a.sourceType === "USER_MEDIA" && a.mediaAssetId) {
          await db.productionAsset.update({ where: { id: a.id }, data: { status: "READY" } });
          ready++;
        } else if (a.status === "BLOCKED") { blocked++; }
      }
      const generated = assets.filter((a) => a.sourceType === "GENERATION");
      if (generated.length > 0 && !providerStatus().configured) {
        await setStage(pid, stageId, "BLOCKED", { error: providerStatus().reason });
        return { state: "BLOCKED", message: providerStatus().reason };
      }
      await setStage(pid, stageId, "SUCCEEDED", { completedAt: new Date(), outputJson: JSON.stringify({ ready, blocked }) });
      return { state: "SUCCEEDED", message: `Assets prepared (${ready} ready, ${blocked} blocked).` };
    }
    case "edit_planning": {
      const head = production.projectId ? await getTimelineHead(production.projectId, userId) : null;
      await setStage(pid, stageId, "SUCCEEDED", { completedAt: new Date(), outputJson: JSON.stringify({ baseVersion: head?.version ?? null }) });
      return { state: "SUCCEEDED", message: "Edit plan ready (assembly uses canonical commands)." };
    }
    case "assembly": {
      const plan = await buildAssemblyEdits(pid, userId);
      if (!production.projectId) throw new ProductionError("Production has no attached project.", 400, "NO_PROJECT");
      const head = await getTimelineHead(production.projectId, userId);
      await applyTimelineEdits(production.projectId, userId, head.version, plan.edits);
      await setStage(pid, stageId, "SUCCEEDED", { completedAt: new Date(), outputJson: JSON.stringify({ appliedEdits: plan.edits.length, newVersion: head.version + 1 }) });
      await logEvent(pid, "timeline.assembled", stage.key, { edits: plan.edits.length });
      return { state: "SUCCEEDED", message: `Rough cut assembled on the native timeline (${plan.edits.length} canonical commands).` };
    }
    case "rough_cut": {
      // Verify the assembled sequence is real and non-empty.
      if (!production.projectId) throw new ProductionError("No project.", 400, "NO_PROJECT");
      const head = await getTimelineHead(production.projectId, userId);
      const clips = seqClips(head.sequence);
      if (clips.length === 0) throw new ProductionError("Rough cut verification failed: timeline has no clips.", 400, "EMPTY_TIMELINE");
      await setStage(pid, stageId, "SUCCEEDED", { completedAt: new Date(), outputJson: JSON.stringify({ clips: clips.length, version: head.version }) });
      return { state: "SUCCEEDED", message: `Rough cut verified: ${clips.length} clips playable in the editor.` };
    }
    case "review": {
      // M30 client-review integration: create a review revision on the project.
      if (!production.projectId) throw new ProductionError("No project.", 400, "NO_PROJECT");
      const res = await fetch(process.env.INTERNAL_BASE ?? "http://localhost:3117", { method: "POST" }).catch(() => null); // placeholder never used; direct call below
      void res;
      const { createReviewForProduction } = await import("./review-bridge");
      const rev = await createReviewForProduction(production.projectId, userId, pid);
      await setStage(pid, stageId, "AWAITING_APPROVAL", { outputJson: JSON.stringify({ revisionId: rev.revisionId }) });
      await db.production.update({ where: { id: pid }, data: { status: "AWAITING_APPROVAL" } });
      return { state: "AWAITING_APPROVAL", message: "Client review created (M30). Approve the revision to release the final render." };
    }
    case "render": {
      if (!production.projectId) throw new ProductionError("No project.", 400, "NO_PROJECT");
      const head = await getTimelineHead(production.projectId, userId);
      const seqAny = head.sequence as unknown as { fps?: { num: number; den: number } };
      const seqFps = seqAny.fps && seqAny.fps.den ? seqAny.fps.num / seqAny.fps.den : 30;
      const clips = seqClips(head.sequence);
      const endFrame = clips.reduce((m, c) => Math.max(m, c.timelineStartFrame + c.timelineDurationFrames), 0);
      if (endFrame <= 0) throw new ProductionError("Nothing to render.", 400, "EMPTY_TIMELINE");
      const jobId = await enqueueMediaJob(userId, JOB_TYPE_RENDER_TIMELINE, { projectId: production.projectId, startFrame: 0, endFrame });
      await db.productionStage.update({ where: { id: stageId }, data: { jobId } });
      await logEvent(pid, "render.submitted", stage.key, { jobId, endFrame, fps: seqFps });
      return { state: "RUNNING", message: `Render job ${jobId} submitted on the existing durable queue.` };
    }
    case "variants": {
      const row = await db.production.findUniqueOrThrow({ where: { id: pid } });
      const brief2 = brief!;
      const variantPlan = brief2.deliveryFormats.filter((f) => f !== "mp4-1080p");
      await setStage(pid, stageId, "SUCCEEDED", { completedAt: new Date(), outputJson: JSON.stringify({ variants: variantPlan, note: "Variant timelines are assembled as sibling projects with canonical re-frame commands during FINAL_RENDER" }) });
      return { state: "SUCCEEDED", message: `Variant plan set: ${variantPlan.join(", ") || "none (single format)"}.` };
    }
    case "qa": {
      const checks = await runProductionQa(pid, brief?.targetDurationSec);
      const outcome = qaOutcome(checks);
      await db.production.update({ where: { id: pid }, data: { qaState: outcome.state, qaJson: JSON.stringify({ checks, outcome: outcome.state }) } });
      if (outcome.state === "FAILED") {
        await setStage(pid, stageId, "FAILED", { error: `QA FAILED: ${outcome.failed.map((f) => f.id).join(", ")}`, completedAt: new Date() });
        return { state: "FAILED", message: `QA failed: ${outcome.failed.map((f) => `${f.id} (${f.detail})`).join("; ")}` };
      }
      await setStage(pid, stageId, "SUCCEEDED", { completedAt: new Date(), outputJson: JSON.stringify({ state: outcome.state }) });
      return { state: "SUCCEEDED", message: `QA outcome: ${outcome.state}` };
    }
    case "delivery": {
      const exports = await db.exportFile.findMany({ where: { userId, kind: "TIMELINE_RENDER" }, orderBy: { createdAt: "desc" }, take: 10 });
      const delivery = { deliveredAt: new Date().toISOString(), artifacts: exports.slice(0, 3).map((e) => ({ exportFileId: e.id, sizeBytes: e.sizeBytes, durationSec: e.durationSec, storagePath: e.storagePath })) };
      await db.production.update({ where: { id: pid }, data: { deliveryJson: JSON.stringify(delivery), status: "COMPLETED" } });
      await setStage(pid, stageId, "SUCCEEDED", { completedAt: new Date(), outputJson: JSON.stringify(delivery) });
      await notify({ userId, type: "production.delivered", payload: { productionId: pid, title: production.briefJson ? (JSON.parse(production.briefJson) as { title?: string }).title : pid }, dedupKey: `production-delivered:${pid}` });
      return { state: "SUCCEEDED", message: "Production delivered — artifacts recorded and user notified." };
    }
    case "analysis": {
      // Deterministic analysis of the first user media asset.
      const asset = await db.productionAsset.findFirst({ where: { productionId: pid, category: { in: ["audio", "video"] } } });
      const src = asset?.mediaAssetId ? await db.mediaAsset.findUnique({ where: { id: asset.mediaAssetId } }) : null;
      if (!src) throw new ProductionError("Attach the podcast media in the brief before analysis.", 400, "NO_MEDIA");
      const analysis = analyzeMediaDeterministically(src.storagePath);
      await db.production.update({ where: { id: pid }, data: { referenceJson: JSON.stringify({ kind: "self-analysis", ...analysis }) } });
      await setStage(pid, stageId, "SUCCEEDED", { completedAt: new Date(), outputJson: JSON.stringify({ segments: analysis.segments.length }) });
      return { state: "SUCCEEDED", message: `Analysis complete: ${analysis.segments.length} activity segments across ${analysis.durationSec.toFixed(1)}s.` };
    }
    case "clip_selection": {
      const row = await db.production.findUniqueOrThrow({ where: { id: pid } });
      const ref = row.referenceJson ? JSON.parse(row.referenceJson) as { segments: AnalysisSegment[] } : null;
      if (!ref?.segments?.length) throw new ProductionError("Run analysis first.", 400, "NO_ANALYSIS");
      await setStage(pid, stageId, "AWAITING_APPROVAL", { outputJson: JSON.stringify({ segments: ref.segments.slice(0, 12) }) });
      await db.production.update({ where: { id: pid }, data: { status: "AWAITING_APPROVAL" } });
      return { state: "AWAITING_APPROVAL", message: "Segments detected — select the clips to repurpose and approve." };
    }
    default:
      throw new ProductionError(`No runner for stage kind ${stage.kind}.`, 400, "NO_RUNNER");
  }
}

// ── Timeline assembly (canonical commands only) ─────────────────────────────
export async function buildAssemblyEdits(pid: string, userId: string): Promise<{ edits: unknown[] }> {
  const row = await db.production.findUniqueOrThrow({ where: { id: pid } });
  const brief = row.briefJson ? ProductionBriefSchema.parse(JSON.parse(row.briefJson)) : null;
  const sb = row.storyboardJson ? (JSON.parse(row.storyboardJson) as { scenes: StoryboardScene[] }) : null;
  if (!sb) throw new ProductionError("Storyboard required for assembly.", 400, "NO_STORYBOARD");
  const fps = brief?.fps ?? 30;
  const edits: unknown[] = [];
  const suffix = pid.slice(-4); const vId = `pV${suffix}`; const aId = `pA${suffix}`;
  edits.push({ type: "AddTrack", track: { id: vId, name: "Production V1", kind: "VIDEO", visible: true, muted: false, solo: false, locked: false, volume: 1 } });
  const assets = await db.productionAsset.findMany({ where: { productionId: pid, status: { in: ["READY", "APPROVED"] } } });
  const videoAssets = await db.mediaAsset.findMany({ where: { id: { in: assets.map((a) => a.mediaAssetId).filter((x): x is string => Boolean(x)) } } });
  const vidById = new Map(videoAssets.map((v) => [v.id, v]));
  let cursor = 0;
  const music = assets.find((a) => a.category === "music" && a.mediaAssetId);
  if (music) edits.push({ type: "AddTrack", track: { id: aId, name: "Production A1", kind: "AUDIO", visible: true, muted: false, solo: false, locked: false, volume: 0.8 } });
  for (const sc of sb.scenes) {
    const sceneAsset = assets.find((a) => a.sceneKey === sc.sceneKey && (a.category === "video" || a.category === "image"));
    const media = sceneAsset?.mediaAssetId ? vidById.get(sceneAsset.mediaAssetId) : null;
    if (!media) continue;
    const durFrames = Math.max(1, Math.round(sc.durationSec * fps));
    const srcFps = media.fps && media.fps > 0 ? media.fps : fps;
    const srcIn = 0;
    const srcOut = Math.min(Math.round((media.durationSec ?? durFrames / fps) * srcFps) || durFrames, srcIn + durFrames);
    edits.push({
      type: "AddClip",
      clip: {
        id: `pc-${sc.sceneKey}`, trackId: vId, sourceAssetId: media.id,
        sourceInFrame: srcIn, sourceOutFrame: Math.max(srcIn + 1, srcOut),
        sourceFps: { num: Math.round(srcFps), den: 1 },
        timelineStartFrame: cursor, timelineDurationFrames: durFrames,
        playbackSpeed: 1, volume: 1, muted: false,
        fadeInFrames: sc.sceneNumber === 1 ? 0 : 3, fadeOutFrames: 3,
        transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
        captionText: brief?.subtitles ? sc.storyPurpose.slice(0, 120) : null,
        captionStyle: null, graphicTemplateId: null, graphicStyle: null,
        keyframes: [], missingMedia: false, pan: 0, groupId: null,
        effects: [],
      },
    });
    cursor += durFrames;
  }
  if (music?.mediaAssetId) {
    const m = vidById.get(music.mediaAssetId);
    if (m) {
      const totalFrames = cursor;
      const mDur = Math.round((m.durationSec ?? 30) * fps);
      edits.push({
        type: "AddClip",
        clip: {
          id: "pc-music", trackId: aId, sourceAssetId: m.id,
          sourceInFrame: 0, sourceOutFrame: Math.min(mDur, totalFrames),
          sourceFps: { num: fps, den: 1 },
          timelineStartFrame: 0, timelineDurationFrames: Math.min(mDur, totalFrames),
          playbackSpeed: 1, volume: 0.7, muted: false, fadeInFrames: 10, fadeOutFrames: 10,
          transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
          captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null,
          keyframes: [], missingMedia: false, pan: 0, groupId: null, effects: [],
        },
      });
    }
  }
  if (edits.length <= 1) throw new ProductionError("Assembly produced no clips — attach/approve assets for every scene first.", 400, "NO_ASSETS");
  return { edits };
}

// ── QA against real artifacts ───────────────────────────────────────────────
export async function runProductionQa(pid: string, targetDurationSec?: number): Promise<QaCheck[]> {
  const row = await db.production.findUniqueOrThrow({ where: { id: pid } });
  if (!row.projectId) throw new ProductionError("No project.", 400, "NO_PROJECT");
  const head = await getTimelineHead(row.projectId, row.userId);
  const checks = preRenderChecks(head.sequence, targetDurationSec, row.briefJson ? ProductionBriefSchema.parse(JSON.parse(row.briefJson)).aspectRatio : undefined);
  const renderStage = await db.productionStage.findFirst({ where: { productionId: pid, key: { in: ["FINAL_RENDER"] }, state: "SUCCEEDED" }, orderBy: { completedAt: "desc" } });
  if (!renderStage?.outputJson) {
    checks.push({ id: "render-artifact", severity: "ERROR", state: "NOT_RUN", detail: "no completed render artifact for this production" });
    return checks;
  }
  const out = JSON.parse(renderStage.outputJson) as { storagePath: string | null };
  if (out.storagePath && fs.existsSync(out.storagePath)) {
    try {
      const probe = JSON.parse(execSync(`ffprobe -v error -show_format -show_streams -print_format json "${out.storagePath}"`, { encoding: "utf8" }));
      const dur = Number(probe.format?.duration ?? 0);
      checks.push({ id: "file-decodable", severity: "ERROR", state: dur > 0 ? "PASSED" : "FAILED", detail: `ffprobe duration ${dur.toFixed(2)}s` });
      const v = probe.streams?.filter((s: { codec_type: string }) => s.codec_type === "video") ?? [];
      checks.push({ id: "video-stream", severity: "ERROR", state: v.length > 0 ? "PASSED" : "FAILED", detail: `${v.length} video stream(s)` });
      const a = probe.streams?.filter((s: { codec_type: string }) => s.codec_type === "audio") ?? [];
      checks.push({ id: "audio-stream", severity: "WARNING", state: a.length > 0 ? "PASSED" : "FAILED", detail: a.length > 0 ? `${a.length} audio stream(s)` : "no audio stream (silent production)" });
      if (targetDurationSec) {
        const ok = Math.abs(dur - targetDurationSec) <= Math.max(1.5, targetDurationSec * 0.08);
        checks.push({ id: "render-duration", severity: "ERROR", state: ok ? "PASSED" : "FAILED", detail: `rendered ${dur.toFixed(2)}s vs target ${targetDurationSec}s` });
      }
    } catch (e) {
      checks.push({ id: "file-decodable", severity: "ERROR", state: "FAILED", detail: `ffprobe failed: ${String(e).slice(0, 120)}` });
    }
  } else {
    checks.push({ id: "render-artifact", severity: "ERROR", state: "FAILED", detail: "render output file missing on disk" });
  }
  return checks;
}

// ── Resume ──────────────────────────────────────────────────────────────────
export async function resumeProduction(pid: string, userId: string): Promise<{ resumed: string[]; message: string }> {
  const production = await db.production.findUnique({ where: { id: pid }, include: { stages: true } });
  if (!production || production.userId !== userId) throw new ProductionError("Production not found.", 404, "NOT_FOUND");
  await reconcileAfterRestart(pid);
  const template = getTemplate(production.templateId);
  if (!template?.active) throw new ProductionError(template?.unavailableReason ?? "Template not active.", 409, "TEMPLATE_INACTIVE");
  const resumed: string[] = [];
  for (const def of template.stages) {
    const row = production.stages.find((s) => s.key === def.key);
    if (!row) continue;
    if (row.state === "SUCCEEDED" || row.state === "SKIPPED") { resumed.push(`${def.key}:skipped-complete`); continue; }
    if (row.state === "AWAITING_APPROVAL") { resumed.push(`${def.key}:awaiting-approval`); continue; }
    if (["READY", "FAILED"].includes(row.state) && !def.requiresProvider) {
      const r = await startStage(pid, def.key, userId);
      resumed.push(`${def.key}:${r.state}`);
      if (r.state === "AWAITING_APPROVAL" || r.state === "FAILED" || r.state === "BLOCKED") break;
    } else break;
  }
  return { resumed, message: "Resumed from the last verified checkpoint." };
}
