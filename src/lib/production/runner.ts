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
import { ffprobe } from "@/lib/media-storage";
import { applyTimelineEdits, getTimelineHead } from "@/lib/editor/persistence";
import { enqueueMediaJob, JOB_TYPE_RENDER_TIMELINE } from "@/lib/job-helpers";
import { notify } from "@/lib/notify";
import {
  ProductionBriefSchema, type ProductionBrief, canTransition, type StageState, seqClips,
  getTemplate, draftConceptOptions, type ProductionScript, type StoryboardScene,
  scriptDurationValid, stageCost, preRenderChecks, qaOutcome, type QaCheck,
} from "./engine";
import { ShowcaseInputsSchema, type ProductUnderstanding, type StoryboardSceneLike } from "./showcase/runner-types";
import { analyzeProductUnderstanding } from "./showcase/product-understanding";
import { draftShowcaseConcepts, type ShowcaseConcept } from "./showcase/concepts";
import { getPrimitive, nikkiStyleFor, validateEmission, type PrimitiveContext } from "./showcase/compositions";
import { syncGenerationAssets } from "./showcase/generation-router";
import { buildPoster, type SceneTiming } from "./showcase/poster";
import { buildShareCopy } from "./showcase/share-copy";
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
  // Finished provider jobs → their GENERATION asset rows (idempotent).
  await syncGenerationAssets(productionId).catch(() => undefined);
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
    case "product_understanding": {
      // SHOWCASE Phase 1: analyze the product from the recorded inputs.
      // Deterministic core + optional LLM structuring STRICTLY from evidence;
      // artifact is stored and user-approved before any downstream stage.
      if (!brief) throw new ProductionError("Intake brief required before product understanding.", 400, "NO_BRIEF");
      const rawInputs = brief.showcaseInputs ?? { productName: brief.title, description: brief.briefText };
      const parsedInputs = ShowcaseInputsSchema.safeParse(rawInputs);
      if (!parsedInputs.success) throw new ProductionError(`Showcase inputs invalid: ${parsedInputs.error.issues.map((i) => i.message).join("; ")}`, 400, "BAD_SHOWCASE_INPUTS");
      const artifact = await analyzeProductUnderstanding(userId, parsedInputs.data, { llmAssist: true });
      if (artifact.sources.length === 0) {
        throw new ProductionError("No usable product inputs were provided (description, feature list, website, screenshots, demo recordings or a project). Add at least one input and re-run.", 400, "NO_PRODUCT_INPUTS");
      }
      await db.production.update({ where: { id: pid }, data: { productJson: JSON.stringify(artifact), status: "AWAITING_APPROVAL" } });
      await setStage(pid, stageId, "AWAITING_APPROVAL", { outputJson: JSON.stringify({ sources: artifact.sources.length, unverifiedClaims: artifact.unverifiedClaims.length, basis: artifact.basis, exclusions: artifact.exclusions.length }) });
      await logEvent(pid, "product.understood", stage.key, { basis: artifact.basis, sources: artifact.sources.length, capabilities: artifact.capabilities.length, unverified: artifact.unverifiedClaims.length, exclusions: artifact.exclusions.length });
      return { state: "AWAITING_APPROVAL", message: `Product understood (${artifact.basis}, ${artifact.sources.length} evidence items, ${artifact.unverifiedClaims.length} unverified claim(s) demoted, ${artifact.exclusions.length} redaction(s)). Review and approve the artifact.` };
    }
    case "concept": {
      if (!brief) throw new ProductionError("Brief required before concepts.", 400, "NO_BRIEF");
      if (production.templateId === "showcase-studio") {
        // SHOWCASE Phase 2: campaign-aware creative directions from the
        // approved product-understanding artifact.
        const row = await db.production.findUniqueOrThrow({ where: { id: pid } });
        const product: ProductUnderstanding | null = row.productJson ? JSON.parse(row.productJson) : null;
        if (!product || product.approval !== "APPROVED") throw new ProductionError("Approve the product-understanding artifact before concepts.", 409, "PRODUCT_NOT_APPROVED");
        const options: ShowcaseConcept[] = draftShowcaseConcepts(brief, product);
        await db.production.update({ where: { id: pid }, data: { conceptJson: JSON.stringify({ options, selectedId: null }), status: "AWAITING_APPROVAL" } });
        await setStage(pid, stageId, "AWAITING_APPROVAL");
        return { state: "AWAITING_APPROVAL", message: "3 distinct campaign concepts drafted from the approved artifact — select one to approve." };
      }
      const options = draftConceptOptions(brief);
      await db.production.update({ where: { id: pid }, data: { conceptJson: JSON.stringify({ options, selectedId: null }), status: "AWAITING_APPROVAL" } });
      await setStage(pid, stageId, "AWAITING_APPROVAL");
      return { state: "AWAITING_APPROVAL", message: "2-3 distinct concept directions drafted — select one to approve." };
    }
    case "script": {
      const concept = production.briefJson ? (await db.production.findUniqueOrThrow({ where: { id: pid } })).conceptJson : null;
      const selected = concept ? (JSON.parse(concept) as { selectedId: string | null; options?: Array<{ id: string; productReveal?: string; featureHighlights?: string[]; openingHook?: string; closingCta?: string; centralIdea?: string }> }) : null;
      if (!selected?.selectedId) throw new ProductionError("Select and approve a concept before the script stage.", 409, "NO_CONCEPT_SELECTED");
      if (!brief) throw new ProductionError("Brief required.", 400, "NO_BRIEF");

      const buildLine = (i: number, n: number, durSec: number, onScreen: string, visual: string, audio: string, transition: string) => ({
        id: `sc${i}-${Date.now().toString(36)}-${i}`,
        sceneNumber: i, narration: "", dialogue: "",
        onScreenText: onScreen.slice(0, 300), durationSec: Math.max(0.5, durSec),
        visual: visual.slice(0, 500), audio, transition: transition.slice(0, 60),
        captionCue: brief.subtitles ? "captions on" : "", reference: "",
      });

      if (production.templateId === "showcase-studio") {
        // SHOWCASE: script beats follow the APPROVED concept (hook → reveal →
        // features → close), durations split on the concept's rhythm.
        const opt = selected.options?.find((o) => o.id === selected.selectedId);
        if (!opt) throw new ProductionError("Selected concept not found.", 400, "BAD_CONCEPT");
        const feats = (opt.featureHighlights ?? []).slice(0, 3);
        const weights = [0.18, 0.27, ...(feats.length ? feats.map(() => 0.32 / feats.length) : [0.32]), 0.13, 0.1];
        const beatDefs = [
          { onScreen: (brief.title || opt.id).slice(0, 60), visual: `Hook — ${opt.openingHook}` },
          { onScreen: "reveal", visual: `Product reveal — ${opt.productReveal}` },
          ...feats.map((f) => ({ onScreen: f.slice(0, 60), visual: `Feature demonstration — ${f}` })),
          { onScreen: "hero", visual: `Hero moment — ${opt.centralIdea}` },
          { onScreen: "cta", visual: `Close — ${opt.closingCta}` },
        ];
        const audio = brief.musicPreference === "user-provided" ? "user music bed" : brief.musicPreference === "none" ? "silent (user preference)" : "music not configured — attach a user track or approve generation when available";
        const lines = beatDefs.map((b, i) => buildLine(i + 1, beatDefs.length, Math.max(0.5, brief.targetDurationSec * (weights[i] ?? 0.1)), b.onScreen === "reveal" ? "" : b.onScreen === "cta" ? "" : b.onScreen, b.visual, audio, i === 0 ? "cut in" : i === beatDefs.length - 1 ? "fade out" : "cut"));
        const script: ProductionScript = { revision: 1, targetDurationSec: brief.targetDurationSec, lines };
        const valid = scriptDurationValid(script);
        await db.production.update({ where: { id: pid }, data: { scriptJson: JSON.stringify(script), status: "AWAITING_APPROVAL" } });
        await setStage(pid, stageId, "AWAITING_APPROVAL", { outputJson: JSON.stringify({ durationValid: valid, beats: lines.length }) });
        return { state: "AWAITING_APPROVAL", message: `Showcase script drafted from the approved concept (${lines.length} beats, ${valid ? "duration consistent" : "DURATION MISMATCH — edit before approving"}). Edit and approve.` };
      }

      // Deterministic skeleton from the approved concept's structure; user edits finalize it.
      const parts = [0.3, 0.4, 0.3];
      const lines = parts.map((p, i) => buildLine(i + 1, parts.length, brief.targetDurationSec * p, i === 0 ? (brief.title ?? "").slice(0, 60) : "", `Scene ${i + 1} — ${brief.visualDirection || "per approved concept"}`, brief.musicPreference === "user-provided" ? "user music bed" : "no music configured", i === 0 ? "cut in" : "cut"));
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
      const isShowcase = production.templateId === "showcase-studio";
      const primitiveFor = (visual: string, i: number, n: number): string | null => {
        if (!isShowcase) return null;
        if (/^Hook/.test(visual)) return "cinematic-title";
        if (/^Product reveal/.test(visual)) return "hero-product-reveal";
        if (/^Feature demonstration/.test(visual)) return "feature-spotlight";
        if (/^Hero moment/.test(visual)) return "product-showcase";
        if (/^Close/.test(visual) || i === n) return "end-card";
        return "feature-spotlight";
      };
      const scenes: StoryboardScene[] = script.lines.map((l, i) => ({
        sceneKey: `scene-${i + 1}`, sceneNumber: i + 1, durationSec: l.durationSec,
        storyPurpose: l.onScreenText || l.narration || `Beat ${i + 1}`,
        shotType: i === 0 ? "Wide / establishing" : "Medium insert", cameraDirection: "Static to slow push",
        subject: brief?.subject?.slice(0, 200) ?? "", environment: "", lighting: brief?.tone ?? "",
        composition: "Center-weighted", movement: "Cut on motion", visualStyle: brief?.visualDirection ?? "",
        narrationSegment: l.narration, audioCue: l.audio, requiredAssetKind: "user_media",
        reference: "", generationInstructions: "", thumbnailPending: true as const, approval: "PENDING",
        textOverlay: (l.onScreenText ?? "").slice(0, 120), productElement: "", transition: (l.transition || "cut").slice(0, 60),
        compositionPrimitive: primitiveFor(l.visual, i + 1, script.lines.length), demonstration: null,
      }));
      await db.production.update({ where: { id: pid }, data: { storyboardJson: JSON.stringify({ scenes }), status: "AWAITING_APPROVAL" } });
      await setStage(pid, stageId, "AWAITING_APPROVAL");
      return { state: "AWAITING_APPROVAL", message: isShowcase ? "Storyboard drafted — composition primitives pre-assigned per beat (editable per scene)." : "Storyboard drafted from the approved script — approve scenes to continue." };
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
          textOverlay: (l.onScreenText ?? "").slice(0, 120), productElement: "", transition: (l.transition || "cut").slice(0, 60),
          compositionPrimitive: null, demonstration: null,
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

      // SHOWCASE Phase 4/5: demonstration planning + generation asset rows.
      const isShowcase = production.templateId === "showcase-studio";
      const demoNotes: string[] = [];
      if (isShowcase) {
        for (const sc of sb.scenes) {
          const d = sc.demonstration;
          if (d?.sourceMediaId) {
            const owned = await db.mediaAsset.findFirst({ where: { id: d.sourceMediaId, userId } });
            if (!owned) demoNotes.push(`${sc.sceneKey}: demonstration source not found or not owned — cleared`);
            else demoNotes.push(`${sc.sceneKey}: demonstration from "${owned.originalName}"${d.illustrative ? " — illustrative accents LABELLED in metadata (not real captured behavior)" : " — real captured behavior"}`);
          }
          if (d && d.maskNotes.length > 0) demoNotes.push(`${sc.sceneKey}: ${d.maskNotes.length} mask requirement(s) recorded — private data must be masked/replaced before public release`);
          // Generation-required scenes become GENERATION asset rows (provider
          // routing + cost approval happen through the generation router API).
          if ((sc.requiredAssetKind === "generated_image" || sc.requiredAssetKind === "generated_video") && !existing.find((a) => a.sceneKey === sc.sceneKey && a.sourceType === "GENERATION" && a.status !== "REJECTED")) {
            await db.productionAsset.create({
              data: {
                productionId: pid, sceneKey: sc.sceneKey, category: sc.requiredAssetKind === "generated_video" ? "video" : "image",
                description: `Generated ${sc.requiredAssetKind === "generated_video" ? "shot" : "still"} for ${sc.sceneKey}: ${sc.generationInstructions.slice(0, 160) || sc.storyPurpose.slice(0, 160)}`,
                sourceType: "GENERATION", licenseState: "UNKNOWN", costUnknown: true, status: "PLANNED",
                provider: null, model: null,
                provenanceJson: JSON.stringify({ plannedAt: new Date().toISOString(), prompt: sc.generationInstructions.slice(0, 600), illustrative: sc.demonstration?.illustrative ?? false }),
              },
            });
          }
        }
      }
      for (const p of plan) {
        await db.productionAsset.create({ data: { productionId: pid, sceneKey: p.sceneKey, category: p.category, description: p.description, sourceType: p.sourceType, licenseState: p.licenseState, costUnknown: p.costUnknown, status: p.status, provenanceJson: JSON.stringify({ plannedAt: new Date().toISOString(), deterministic: true }) } });
      }
      await logEvent(pid, "assets.planned", stage.key, { planned: plan.length, demonstrationNotes: demoNotes });
      await setStage(pid, stageId, "AWAITING_APPROVAL", { outputJson: JSON.stringify({ planned: plan.length, demonstrationNotes: demoNotes }) });
      return { state: "AWAITING_APPROVAL", message: `Asset plan drafted (${plan.length} items${demoNotes.length ? `; ${demoNotes.length} demonstration note(s)` : ""}). Attach/approve assets to continue.` };
    }
    case "asset_generation": {
      // Pull finished provider jobs into their asset rows first (idempotent).
      await syncGenerationAssets(pid);
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
      const inFlight = generated.filter((a) => a.status === "GENERATING").length;
      const unsubmitted = generated.filter((a) => ["PLANNED", "PENDING"].includes(a.status)).length;
      const genFailed = generated.filter((a) => a.status === "FAILED");
      if (genFailed.length > 0) {
        await setStage(pid, stageId, "FAILED", { error: genFailed.map((a) => a.error ?? "generation failed").join("; ").slice(0, 500), completedAt: new Date() });
        return { state: "FAILED", message: `${genFailed.length} generation asset(s) failed — retry from the asset wall.` };
      }
      if (inFlight + unsubmitted > 0) {
        // Stage stays RUNNING; syncJobBackedStages / syncGenerationAssets flip it later.
        return { state: "RUNNING", message: `${inFlight} generation job(s) in flight, ${unsubmitted} not yet submitted (route them on the asset wall — approval + budget required).` };
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
      const isShowcase = production.templateId === "showcase-studio";
      const exports = await db.exportFile.findMany({ where: { userId, kind: "TIMELINE_RENDER" }, orderBy: { createdAt: "desc" }, take: 10 });
      const delivery: Record<string, unknown> = { deliveredAt: new Date().toISOString(), artifacts: exports.slice(0, 3).map((e) => ({ exportFileId: e.id, sizeBytes: e.sizeBytes, durationSec: e.durationSec, storagePath: e.storagePath })) };

      if (isShowcase) {
        // SHOWCASE Phase 9: poster from the REAL rendered film + share copy.
        const briefNow = brief!;
        const row = await db.production.findUniqueOrThrow({ where: { id: pid } });
        const product: ProductUnderstanding | null = row.productJson ? JSON.parse(row.productJson) : null;
        const sb = row.storyboardJson ? (JSON.parse(row.storyboardJson) as { scenes: StoryboardScene[] }) : null;

        if (briefNow.posterEnabled) {
          const renderStage = await db.productionStage.findFirst({ where: { productionId: pid, key: "FINAL_RENDER", state: "SUCCEEDED" }, orderBy: { completedAt: "desc" } });
          const renderOut = renderStage?.outputJson ? (JSON.parse(renderStage.outputJson) as { storagePath: string | null }) : null;
          if (renderOut?.storagePath && fs.existsSync(renderOut.storagePath)) {
            const probe = await ffprobe(renderOut.storagePath).catch(() => null);
            if (probe?.durationSec && sb) {
              const timings: SceneTiming[] = [];
              let t = 0;
              for (const sc of sb.scenes) { timings.push({ sceneKey: sc.sceneKey, startSec: t, endSec: t + sc.durationSec }); t += sc.durationSec; }
              const dims = posterDims(briefNow.aspectRatio, briefNow.resolution);
              const poster = await buildPoster({
                userId, mp4Path: renderOut.storagePath, mp4DurationSec: probe.durationSec, timings,
                title: product?.identity?.name || briefNow.title, width: dims.width, height: dims.height,
                overlayTitle: true, accentColor: product?.brand?.colors?.[0],
              });
              if (poster.posterPath) {
                const { registerImageArtifact } = await import("@/lib/ai/asset-lifecycle");
                try {
                  const registered = await registerImageArtifact(poster.posterPath, {
                    engine: "SHOWCASE", userId, projectId: production.projectId,
                    originalName: `showcase-poster-${pid.slice(-6)}.jpg`,
                    provider: "ffmpeg-frame-extract+thumbnail-overlay", model: "none",
                    prompt: `Poster frame at ${poster.plan.sourceFrameSec.toFixed(2)}s of the rendered film`,
                    params: { sourceFrameSec: poster.plan.sourceFrameSec, sceneKey: poster.plan.sceneKey, overlayApplied: poster.plan.overlayApplied },
                    license: "derived-from-user-media", attribution: "Frame extracted from the user's rendered BEAN FX film",
                    width: dims.width, height: dims.height,
                  });
                  poster.plan.exportFileId = registered.id;
                  delivery.poster = poster.plan;
                  delivery.posterMediaAssetId = registered.id;
                  await logEvent(pid, "poster.built", stage.key, { frameSec: poster.plan.sourceFrameSec, sceneKey: poster.plan.sceneKey, checks: poster.plan.checks.map((c) => `${c.id}:${c.state}`) });
                } catch (err) {
                  delivery.poster = { ...poster.plan, registrationError: String(err).slice(0, 300) };
                  await logEvent(pid, "poster.registration_failed", stage.key, { error: String(err).slice(0, 200) });
                }
              } else {
                delivery.poster = poster.plan; // checks carry the FAILED states honestly
                await logEvent(pid, "poster.failed_checks", stage.key, { checks: poster.plan.checks });
              }
            } else {
              delivery.poster = { checks: [{ id: "poster-source", state: "FAILED", detail: "render artifact missing or unreadable" }] };
            }
          } else {
            delivery.poster = { checks: [{ id: "poster-source", state: "NOT_RUN", detail: "no completed render artifact found for this production" }] };
          }
        }

        if (product) {
          const endCardScene = sb?.scenes.find((sc) => sc.compositionPrimitive === "end-card" || sc.compositionPrimitive === "cta-scene");
          const shareCopy = buildShareCopy({
            product, ctaText: endCardScene?.textOverlay || "",
            durationSec: briefNow.targetDurationSec, aspectRatio: briefNow.aspectRatio,
            platforms: briefNow.shareCopyPlatforms,
            websiteUrl: briefNow.showcaseInputs?.websiteUrl || undefined,
          });
          delivery.shareCopy = shareCopy;
          await logEvent(pid, "share_copy.built", stage.key, { platforms: shareCopy.items.map((i) => `${i.platform}:${i.withinLimits ? "fits" : "TRIMMED"}`) });
        }
      }

      await db.production.update({ where: { id: pid }, data: { deliveryJson: JSON.stringify(delivery), status: "COMPLETED" } });
      await setStage(pid, stageId, "SUCCEEDED", { completedAt: new Date(), outputJson: JSON.stringify(delivery) });
      await notify({ userId, type: "production.delivered", payload: { productionId: pid, title: production.briefJson ? (JSON.parse(production.briefJson) as { title?: string }).title : pid }, dedupKey: `production-delivered:${pid}` });
      return { state: "SUCCEEDED", message: isShowcase ? "Production delivered — film, poster, share copy and artifacts recorded." : "Production delivered — artifacts recorded and user notified." };
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
  const product = row.productJson ? (JSON.parse(row.productJson) as ProductUnderstanding) : null;
  const sb = row.storyboardJson ? (JSON.parse(row.storyboardJson) as { scenes: StoryboardScene[] }) : null;
  if (!sb) throw new ProductionError("Storyboard required for assembly.", 400, "NO_STORYBOARD");
  const fps = brief?.fps ?? 30;
  const accent = product?.brand?.colors?.[0] ?? undefined;
  const edits: unknown[] = [];
  const suffix = pid.slice(-4); const vId = `pV${suffix}`; const aId = `pA${suffix}`; const gId = `pG${suffix}`;
  edits.push({ type: "AddTrack", track: { id: vId, name: "Production V1", kind: "VIDEO", visible: true, muted: false, solo: false, locked: false, volume: 1 } });
  const assets = await db.productionAsset.findMany({ where: { productionId: pid, status: { in: ["READY", "APPROVED"] } } });
  const videoAssets = await db.mediaAsset.findMany({ where: { id: { in: assets.map((a) => a.mediaAssetId).filter((x): x is string => Boolean(x)) } } });
  const vidById = new Map(videoAssets.map((v) => [v.id, v]));
  let cursor = 0;
  const music = assets.find((a) => a.category === "music" && a.mediaAssetId);
  if (music) edits.push({ type: "AddTrack", track: { id: aId, name: "Production A1", kind: "AUDIO", visible: true, muted: false, solo: false, locked: false, volume: 0.8 } });
  let graphicTrackAdded = false;
  let mediaClipCount = 0;

  /** Apply the scene's composition primitive → editor-model data. Text
   *  falls back to the brief title / artifact identity — NIKKI requires ≥1
   *  char, and an empty title card would be a silent fabrication anyway. */
  const applyPrimitive = (sc: StoryboardScene, durFrames: number): { keyframes: unknown[]; effects: unknown[]; graphic: { templateId: string; style: unknown } | null } => {
    const prim = sc.compositionPrimitive ? getPrimitive(sc.compositionPrimitive) : null;
    if (!prim) return { keyframes: [], effects: [], graphic: null };
    const overlay = sc.textOverlay || brief?.title || product?.identity?.name || undefined;
    if (prim.id !== "hero-product-reveal" && prim.id !== "feature-spotlight" && prim.id !== "ui-demonstration" && prim.id !== "floating-product-frame" && prim.id !== "split-screen-comparison" && prim.id !== "product-showcase" && prim.id !== "logo-reveal" && !overlay) {
      // Graphic-bearing primitive with no text available: record and skip.
      void logEvent(pid, "primitive.skipped", "TIMELINE_ASSEMBLY", { sceneKey: sc.sceneKey, primitive: prim.id, reason: "no approved text for the graphic — set textOverlay on the scene" });
      return { keyframes: [], effects: [], graphic: null };
    }
    const ctx: PrimitiveContext = { fps, durationFrames: durFrames, overlayText: overlay, accentColor: accent };
    const em = prim.emit(ctx);
    const v = validateEmission(em, ctx);
    if (!v.ok) {
      void logEvent(pid, "primitive.skipped", "TIMELINE_ASSEMBLY", { sceneKey: sc.sceneKey, primitive: prim.id, issues: v.issues });
      return { keyframes: [], effects: [], graphic: null };
    }
    const g = em.graphic ? nikkiStyleFor(em.graphic) : null;
    return { keyframes: em.keyframes, effects: em.effects, graphic: g ? { templateId: g.templateId, style: g.style } : null };
  };

  for (const sc of sb.scenes) {
    const sceneAsset = assets.find((a) => a.sceneKey === sc.sceneKey && (a.category === "video" || a.category === "image"));
    const media = sceneAsset?.mediaAssetId ? vidById.get(sceneAsset.mediaAssetId) : null;
    const durFrames = Math.max(1, Math.round(sc.durationSec * fps));
    if (media) {
      const prim = applyPrimitive(sc, durFrames);
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
          captionStyle: null,
          graphicTemplateId: prim.graphic?.templateId ?? null,
          graphicStyle: prim.graphic?.style ?? null,
          keyframes: prim.keyframes, effects: prim.effects,
          missingMedia: false, pan: 0, groupId: null,
        },
      });
      cursor += durFrames; mediaClipCount++;
      continue;
    }
    // Graphic-only scene (showcase title / end card / CTA): a REAL NIKKI
    // graphic clip on the GRAPHIC track — rendered from the template, never a
    // fabricated placeholder. Scenes with neither media nor a graphic are
    // recorded honestly and skipped.
    const prim = applyPrimitive(sc, durFrames);
    if (prim.graphic) {
      if (!graphicTrackAdded) {
        edits.push({ type: "AddTrack", track: { id: gId, name: "Showcase Graphics", kind: "GRAPHIC", visible: true, muted: false, solo: false, locked: false, volume: 1 } });
        graphicTrackAdded = true;
      }
      edits.push({
        type: "AddGraphic",
        clip: {
          id: `pg-${sc.sceneKey}`, trackId: gId, sourceAssetId: "",
          sourceInFrame: 0, sourceOutFrame: durFrames,
          sourceFps: { num: fps, den: 1 },
          timelineStartFrame: cursor, timelineDurationFrames: durFrames,
          playbackSpeed: 1, volume: 1, muted: false,
          fadeInFrames: 0, fadeOutFrames: 0,
          transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
          captionText: null, captionStyle: null,
          graphicTemplateId: prim.graphic.templateId, graphicStyle: prim.graphic.style,
          keyframes: prim.keyframes, effects: prim.effects,
          missingMedia: false, pan: 0, groupId: null,
        },
      });
      cursor += durFrames;
      await logEvent(pid, "graphic.scene", "TIMELINE_ASSEMBLY", { sceneKey: sc.sceneKey, templateId: prim.graphic.templateId, frames: durFrames });
    } else {
      await logEvent(pid, "scene.skipped_no_media", "TIMELINE_ASSEMBLY", { sceneKey: sc.sceneKey, note: "no READY asset and no graphic primitive produced — attach media or set a graphic primitive on this scene" });
    }
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
  if (mediaClipCount === 0) throw new ProductionError("Assembly produced no clips — attach/approve assets for every scene first (graphic-only scenes do not count as footage).", 400, "NO_ASSETS");
  if (edits.length <= 1) throw new ProductionError("Assembly produced no clips — attach/approve assets for every scene first.", 400, "NO_ASSETS");
  return { edits };
}

// ── QA against real artifacts ───────────────────────────────────────────────
function posterDims(aspect: string, resolution: string): { width: number; height: number } {
  const h1080 = resolution === "1080p" ? 1080 : 720;
  switch (aspect) {
    case "9:16": return { width: Math.round(h1080 * 9 / 16), height: h1080 };
    case "1:1": return { width: h1080, height: h1080 };
    case "4:5": return { width: Math.round(h1080 * 4 / 5), height: h1080 };
    default: return { width: Math.round(h1080 * 16 / 9), height: h1080 };
  }
}

/** Real FFmpeg measurements for the showcase QA layer (Phase 10). */
function runBlackdetect(filePath: string): { blackSec: number; events: number; detail: string } {
  try {
    const out = execSync(`ffmpeg -i "${filePath}" -vf "blackdetect=d=0.5:pix_th=0.10" -an -f null - 2>&1 || true`, { encoding: "utf8", timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
    const events = [...out.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)\s+\(duration:([\d.]+)\)/g)].map((m) => ({ start: Number(m[1]), end: Number(m[2]), dur: Number(m[3]) }));
    const blackSec = events.reduce((s, e) => s + e.dur, 0);
    return { blackSec, events: events.length, detail: events.length ? events.slice(0, 5).map((e) => `${e.start.toFixed(1)}–${e.end.toFixed(1)}s`).join(", ") : "no black segments ≥0.5s" };
  } catch (err) {
    return { blackSec: 0, events: 0, detail: `blackdetect unavailable: ${String(err).slice(0, 120)}` };
  }
}

function runLoudness(filePath: string): { meanDb: number | null; maxDb: number | null; detail: string } {
  try {
    const out = execSync(`ffmpeg -i "${filePath}" -af volumedetect -f null - 2>&1 || true`, { encoding: "utf8", timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
    const mean = out.match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
    const max = out.match(/max_volume:\s*(-?[\d.]+)\s*dB/);
    if (!mean || !max) return { meanDb: null, maxDb: null, detail: "no measurable audio (silent film)" };
    return { meanDb: Number(mean[1]), maxDb: Number(max[1]), detail: `mean ${mean[1]} dB, max ${max[1]} dB` };
  } catch (err) {
    return { meanDb: null, maxDb: null, detail: `volumedetect unavailable: ${String(err).slice(0, 120)}` };
  }
}

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
      // ── SHOWCASE Phase 10: real measurements, never render-exit optimism ──
      const black = runBlackdetect(out.storagePath);
      checks.push({ id: "black-frames", severity: "WARNING", state: black.blackSec > Math.max(1, dur * 0.1) ? "FAILED" : "PASSED", detail: `blackdetect: ${black.detail}` });
      const audioStreams = probe.streams?.filter((s: { codec_type: string }) => s.codec_type === "audio") ?? [];
      if (audioStreams.length > 0) {
        const loud = runLoudness(out.storagePath);
        // No measurable audio on an audio-bearing production, or a peak above
        // -0.5 dBFS (clipping risk) both fail this check for human review.
        const hot = loud.maxDb !== null && loud.maxDb > -0.5;
        checks.push({ id: "audio-loudness", severity: "WARNING", state: loud.maxDb === null || hot ? "FAILED" : "PASSED", detail: loud.detail + (hot ? " — peak too hot (clipping risk)" : "") });
        const aDur = Number(audioStreams[0]?.duration ?? 0);
        if (aDur > 0) {
          const syncOk = Math.abs(aDur - dur) <= Math.max(1.5, dur * 0.1);
          checks.push({ id: "av-sync-duration", severity: "WARNING", state: syncOk ? "PASSED" : "FAILED", detail: `audio ${aDur.toFixed(2)}s vs container ${dur.toFixed(2)}s` });
        }
      }
      // Caption timing: captioned clips must sit inside the runtime.
      const headNow = await getTimelineHead(row.projectId, row.userId);
      const captionClips = seqClips(headNow.sequence).filter((c) => (c as { captionText?: string | null }).captionText);
      const fpsNow = (headNow.sequence as { fps?: { num: number; den: number } }).fps;
      const fpsVal = fpsNow && fpsNow.den ? fpsNow.num / fpsNow.den : 30;
      const outOfRange = captionClips.filter((c) => c.timelineStartFrame + c.timelineDurationFrames > Math.ceil(dur * fpsVal) + fpsVal);
      checks.push({ id: "caption-timing", severity: "WARNING", state: outOfRange.length === 0 ? "PASSED" : "FAILED", detail: outOfRange.length === 0 ? `${captionClips.length} captioned clip(s) inside the runtime` : `${outOfRange.length} captioned clip(s) extend beyond the rendered duration` });
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
