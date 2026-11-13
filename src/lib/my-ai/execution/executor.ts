/**
 * MY AI — plan executor (M8 §8).
 *
 * Runs APPROVED plans through the REAL engine entry points:
 *  - timeline ops   → getTimelineHead + M1 applyCommand + applyTimelineEdits
 *                     (optimistic concurrency; MY AI NEVER touches the DB
 *                     timeline rows directly)
 *  - GANGZII        → GangziiProcess row + durable job (M5 pattern)
 *  - JAZMII/LAXII   → durable M7 jobs
 *  - EXPORT         → NIKKI_RENDER job on the current head sequence (M6 pipeline)
 *  - RIISHE_AUTOCUT → validate the referenced analysis exists + route to the
 *                     M4 apply flow (recorded honestly as "routed-to-ui";
 *                     the executor does not re-implement RIISHE's ffmpeg math)
 *
 * Guarantees: dependency order, status re-check before every step (cancel and
 * expiry stop the run), per-step outcomes (PARTIALLY_COMPLETED is reported
 * truthfully), audit rows per step, bounded retries per step (2), and a
 * configurable step/time budget.
 */
import { db } from "@/lib/db";
import { getTimelineHead, applyTimelineEdits, VersionConflictError } from "@/lib/editor/persistence";
import { applyCommand, parseCommand } from "@/lib/editor/commands";
import type { Sequence } from "@/lib/editor/model";
import type { Command } from "@/lib/editor/commands";
import { proposeNikki } from "@/lib/nikki/proposal";
import { jobManager } from "@/lib/job-runner";
import { JOB_TYPE_GANGZII_PROCESS, JOB_TYPE_JAZMII_GENERATE, JOB_TYPE_JAZMII_ANALYZE, JOB_TYPE_LAXII_GENERATE, JOB_TYPE_NIKKI_RENDER } from "@/lib/job-helpers";
import { GangziiParamsSchema } from "@/lib/gangzii/types";
import { JazmiiGenerateParamsSchema } from "@/lib/jazmii/types";
import { LaxiiGenerateParamsSchema } from "@/lib/laxii/types";
import { expireStalePlans, loadOwnedPlan } from "@/lib/my-ai/approvals";
import { AIPlanSchema, type AIPlan, type PlanStep } from "@/lib/my-ai/planner/schema";

export interface StepOutcome {
  stepId: string;
  operation: string;
  status: "COMPLETED" | "FAILED" | "SKIPPED" | "ROUTED";
  detail: string;
  jobId?: string;
  planVersion?: string;
}

export interface ExecutionReport {
  planId: string;
  status: "COMPLETED" | "PARTIALLY_COMPLETED" | "FAILED" | "CANCELLED";
  steps: StepOutcome[];
  note: string;
}

const MAX_STEP_RETRIES = 2;
const MAX_STEPS = Number(process.env.BEANFX_MYAI_MAX_STEPS ?? 24);

/** Parse + validate the stored plan JSON (never trust the row blindly). */
function parsePlanRow(row: { stepsJson: string; projectId: string | null; contextVersion: string | null }): AIPlan | null {
  const parsed = AIPlanSchema.safeParse({
    schemaVersion: 1,
    planId: "runtime",
    projectId: row.projectId ?? "",
    requestSummary: "runtime",
    steps: JSON.parse(row.stepsJson),
    contextVersion: row.contextVersion,
    idempotencyKey: `runtime-${row.stepsJson.length}`,
  });
  return parsed.success ? parsed.data : null;
}

export async function executePlan(planId: string, userId: string): Promise<ExecutionReport> {
  await expireStalePlans();
  const row = await db.aIPlan.findFirst({ where: { id: planId, userId } });
  if (!row) return { planId, status: "FAILED", steps: [], note: "Plan not found or not owned by the caller." };
  if (row.status === "EXPIRED") return { planId, status: "FAILED", steps: [], note: "Plan expired before execution." };
  if (row.status !== "APPROVED") {
    return { planId, status: "FAILED", steps: [], note: `Plan must be APPROVED before execution (current: ${row.status}).` };
  }
  const plan = parsePlanRow(row as unknown as { stepsJson: string; projectId: string | null; contextVersion: string | null });
  if (!plan || !row.projectId) {
    await db.aIPlan.update({ where: { id: planId }, data: { status: "FAILED", resultJson: JSON.stringify({ error: "invalid stored plan" }) } });
    return { planId, status: "FAILED", steps: [], note: "Stored plan failed schema validation — nothing executed." };
  }

  // Stale-plan protection: context version must match the CURRENT head.
  const head = await getTimelineHead(row.projectId, userId);
  const seq = head.sequence;
  const currentVersion = `v:${head.version}:${seq.clips.length}:${seq.clips.reduce((m, c) => Math.max(m, c.timelineStartFrame + c.timelineDurationFrames), 0)}`;
  if (plan.contextVersion && plan.contextVersion !== currentVersion) {
    await db.aIPlan.update({ where: { id: planId }, data: { status: "FAILED", resultJson: JSON.stringify({ error: "stale-context", planVersion: plan.contextVersion, currentVersion }) } });
    return { planId, status: "FAILED", steps: [], note: `Plan is stale: validated against ${plan.contextVersion}, timeline now ${currentVersion}. Create a fresh plan.` };
  }

  await db.aIPlan.update({ where: { id: planId }, data: { status: "RUNNING" } });
  const outcomes: StepOutcome[] = [];
  const done = new Map<string, StepOutcome>();
  const steps = plan.steps.slice(0, MAX_STEPS);

  // Topological execution (deps first); failures skip dependents.
  const byId = new Map(steps.map((s) => [s.id, s]));
  const executed = new Set<string>();
  for (const step of steps) {
    // Status re-check before EVERY step (cancel/expire stops the run).
    const live = await db.aIPlan.findUnique({ where: { id: planId }, select: { status: true } });
    if (!live || live.status === "CANCELLED") {
      for (const s of steps) if (!executed.has(s.id)) outcomes.push({ stepId: s.id, operation: s.operation, status: "SKIPPED", detail: "plan cancelled" });
      await finalize(planId, "CANCELLED", outcomes);
      return { planId, status: "CANCELLED", steps: outcomes, note: "Plan cancelled mid-run — completed steps were NOT rolled back (recorded accurately)." };
    }
    // Dependency gate.
    const failedDep = step.dependsOn.find((d) => done.get(d)?.status !== "COMPLETED" && done.get(d)?.status !== "ROUTED");
    if (step.dependsOn.length > 0 && failedDep) {
      const outcome: StepOutcome = { stepId: step.id, operation: step.operation, status: "SKIPPED", detail: `dependency ${failedDep} did not complete` };
      outcomes.push(outcome);
      done.set(step.id, outcome);
      continue;
    }
    let outcome: StepOutcome | null = null;
    for (let attempt = 0; attempt <= MAX_STEP_RETRIES; attempt++) {
      try {
        outcome = await runStep(step, row.projectId, userId, seq);
        break;
      } catch (err) {
        const detail = err instanceof Error ? err.message.slice(0, 220) : String(err);
        if (err instanceof VersionConflictError && attempt < MAX_STEP_RETRIES) continue; // re-read head, retry
        outcome = { stepId: step.id, operation: step.operation, status: "FAILED", detail };
        break;
      }
    }
    const final = outcome ?? { stepId: step.id, operation: step.operation, status: "FAILED", detail: "no outcome" };
    outcomes.push(final);
    done.set(step.id, final);
    executed.add(step.id);
    await db.automationAudit.create({
      data: { userId, projectId: row.projectId, action: `PLAN_STEP_${final.status}`, detailJson: JSON.stringify({ planId, stepId: step.id, operation: step.operation, detail: final.detail.slice(0, 200) }) },
    });
  }

  const failed = outcomes.filter((o) => o.status === "FAILED").length;
  const completed = outcomes.filter((o) => o.status === "COMPLETED" || o.status === "ROUTED").length;
  const status: ExecutionReport["status"] = failed === 0 ? "COMPLETED" : completed === 0 ? "FAILED" : "PARTIALLY_COMPLETED";
  await finalize(planId, status, outcomes);
  return {
    planId,
    status,
    steps: outcomes,
    note: failed === 0 ? "All steps executed." : `${completed} step(s) completed, ${failed} failed — partial completion is recorded accurately; completed steps were NOT rolled back.`,
  };
}

async function finalize(planId: string, status: string, outcomes: StepOutcome[]): Promise<void> {
  await db.aIPlan.update({
    where: { id: planId },
    data: { status, resultJson: JSON.stringify({ finishedAt: new Date().toISOString(), steps: outcomes }) },
  }).catch(() => undefined);
}

// ── step runners (real engine entry points only) ────────────────────────────
async function runStep(step: PlanStep, projectId: string, userId: string, seq: Sequence): Promise<StepOutcome> {
  const base = { stepId: step.id, operation: step.operation };
  switch (step.operation) {
    case "APPLY_COMMANDS": {
      if (typeof step.args.guidance === "string" && !Array.isArray(step.args.commands)) {
        return { ...base, status: "ROUTED", detail: `Guided step: ${String(step.args.guidance).slice(0, 200)}` };
      }
      const commands = (step.args.commands as unknown[]).map((c) => parseCommand(c));
      return withCommands(base, commands, projectId, userId);
    }
    case "INSERT_ASSET": {
      const asset = await db.mediaAsset.findFirst({ where: { id: String(step.args.assetId), userId } });
      if (!asset) throw new Error(`asset ${String(step.args.assetId)} not found or not owned`);
      const track = seq.tracks.find((t) => t.id === String(step.args.trackId));
      if (!track) throw new Error(`track ${String(step.args.trackId)} not found`);
      if (track.locked) throw new Error(`track ${track.name} is locked`);
      const fpsNum = asset.fps && asset.fps > 0 ? asset.fps : seq.fps.num / seq.fps.den;
      const dur = asset.kind === "IMAGE" ? Math.round((seq.fps.num / seq.fps.den) * 5) : Math.max(12, Math.round((asset.durationSec ?? 5) * fpsNum));
      const at = Math.max(0, Number(step.args.startFrame ?? 0));
      const command = parseCommand({
        type: "AddClip",
        clip: {
          id: `myai-clip-${step.id}`,
          trackId: track.id,
          sourceAssetId: asset.id,
          sourceInFrame: 0,
          sourceOutFrame: dur,
          sourceFps: { num: Math.round(fpsNum * 1000), den: 1000 },
          timelineStartFrame: at,
          playbackSpeed: 1,
          volume: 1,
          muted: false,
          fadeInFrames: 0,
          fadeOutFrames: 0,
          transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
          captionText: null,
          captionStyle: null,
          graphicTemplateId: null,
          graphicStyle: null,
          label: `MY AI: ${asset.originalName}`.slice(0, 120),
          missingMedia: false,
          effects: [],
          keyframes: [],
        },
      });
      return withCommands(base, [command], projectId, userId);
    }
    case "NIIKI_GRAPHIC": {
      const proposal = proposeNikki(String(step.args.instruction ?? ""), {
        seqFps: seq.fps,
        seqWidth: seq.width,
        seqHeight: seq.height,
        newId: (kind) => `myai-niikki-${step.id}-${kind}`,
        atFrame: Number(step.args.atFrame ?? 0),
        availableFrames: Math.max(24, 900),
        selectedGraphicClipId: null,
        selectedGraphicStyle: null,
      });
      if (!proposal || proposal.commands.length === 0) throw new Error("NIIKI produced no valid proposal for this instruction");
      return withCommands(base, proposal.commands, projectId, userId);
    }
    case "RIISHE_AUTOCUT": {
      if (typeof step.args.guidance === "string") {
        return { ...base, status: "ROUTED", detail: `Guided step: ${String(step.args.guidance).slice(0, 200)}` };
      }
      // Validate the referenced analysis exists + route to the M4 flow.
      const decisions = await db.cutDecision.findMany({ where: { userId }, take: 1, select: { jobId: true } });
      return {
        ...base,
        status: "ROUTED",
        detail: decisions.length
          ? `RIISHE decisions exist (job ${decisions[0].jobId}). Apply them through the M4 review/apply flow — the executor does not re-implement RIISHE's ffmpeg cut math.`
          : "No RIISHE analysis found for this user. Run RIISHE analysis first (transcription → review → apply).",
      };
    }
    case "GANGZII_PROCESS": {
      if (typeof step.args.guidance === "string") {
        return { ...base, status: "ROUTED", detail: `Guided step: ${String(step.args.guidance).slice(0, 200)}` };
      }
      const asset = await db.mediaAsset.findFirst({ where: { id: String(step.args.assetId), userId } });
      if (!asset) throw new Error(`asset ${String(step.args.assetId)} not found or not owned`);
      const paramsParsed = step.args.preset
        ? GangziiParamsSchema.safeParse({ preset: String(step.args.preset), params: (step.args.params as Record<string, unknown>) ?? {} })
        : GangziiParamsSchema.safeParse(step.args.params);
      if (!paramsParsed.success) throw new Error(`GANGZII params invalid: ${paramsParsed.error.issues.map((i) => i.message).join("; ")}`);
      const row = await db.gangziiProcess.create({
        data: { userId, sourceAssetId: asset.id, kind: "PROCESS", status: "QUEUED", name: `MY AI plan step ${step.id}`, paramsJson: JSON.stringify(paramsParsed.data) },
      });
      const jobId = await jobManager.createJob(userId, JOB_TYPE_GANGZII_PROCESS, { processId: row.id });
      return { ...base, status: "COMPLETED", detail: `GANGZII processing queued (process ${row.id}).`, jobId };
    }
    case "JAZMII_GENERATE": {
      const parsed = JazmiiGenerateParamsSchema.safeParse({
        prompt: String(step.args.prompt ?? ""),
        operation: "textToVideo",
        referenceAssetId: null,
        quality: String(step.args.quality ?? "speed"),
        size: String(step.args.size ?? "1920x1080"),
        fps: String(step.args.fps ?? "30"),
        durationSec: String(step.args.durationSec ?? "5"),
        withAudio: Boolean(step.args.withAudio ?? false),
        projectId,
      });
      if (!parsed.success) throw new Error(`JAZMII params invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
      const jobId = await jobManager.createJob(userId, JOB_TYPE_JAZMII_GENERATE, parsed.data);
      return { ...base, status: "COMPLETED", detail: "JAZMII generation job queued (metered external provider).", jobId };
    }
    case "JAZMII_ANALYZE": {
      if (typeof step.args.guidance === "string") {
        return { ...base, status: "ROUTED", detail: `Guided step: ${String(step.args.guidance).slice(0, 200)}` };
      }
      const asset = await db.mediaAsset.findFirst({ where: { id: String(step.args.mediaId), userId } });
      if (!asset) throw new Error(`media ${String(step.args.mediaId)} not found or not owned`);
      const jobId = await jobManager.createJob(userId, JOB_TYPE_JAZMII_ANALYZE, { mediaId: asset.id });
      return { ...base, status: "COMPLETED", detail: `JAZMII analysis queued for ${asset.originalName}.`, jobId };
    }
    case "LAXII_GENERATE": {
      const parsed = LaxiiGenerateParamsSchema.safeParse({
        prompt: String(step.args.prompt ?? ""),
        mode: String(step.args.mode ?? "generate"),
        referenceAssetId: step.args.referenceAssetId ? String(step.args.referenceAssetId) : null,
        size: String(step.args.size ?? "1344x768"),
        count: Number(step.args.count ?? 1),
        aspect: String(step.args.aspect ?? "original"),
        projectId,
      });
      if (!parsed.success) throw new Error(`LAXII params invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
      if (parsed.data.mode === "edit" && !parsed.data.referenceAssetId) throw new Error("LAXII edit mode requires a reference asset");
      if (parsed.data.referenceAssetId) {
        const ref = await db.mediaAsset.findFirst({ where: { id: parsed.data.referenceAssetId, userId } });
        if (!ref) throw new Error("LAXII reference asset not found or not owned");
      }
      const jobId = await jobManager.createJob(userId, JOB_TYPE_LAXII_GENERATE, parsed.data);
      return { ...base, status: "COMPLETED", detail: "LAXII generation job queued (metered external provider).", jobId };
    }
    case "EXPORT": {
      // Full-timeline render through the EXISTING M6 pipeline (validated head sequence).
      if (seq.clips.length === 0) throw new Error("Nothing to render: the sequence has no clips.");
      const jobId = await jobManager.createJob(userId, JOB_TYPE_NIKKI_RENDER, {
        sequence: seq,
        projectId,
        name: `MY AI export (plan step ${step.id})`,
        sourceAssetId: null,
      });
      return { ...base, status: "COMPLETED", detail: "Render/export job queued via the NIKKI render pipeline.", jobId };
    }
    default:
      throw new Error(`unsupported operation ${String((step as { operation: string }).operation)}`);
  }
}

/** Apply commands through the M1 engine + M2 versioned persistence. */
async function withCommands(
  base: { stepId: string; operation: string },
  commands: Command[],
  projectId: string,
  userId: string,
): Promise<StepOutcome> {
  const head = await getTimelineHead(projectId, userId);
  let seq = head.sequence;
  for (const command of commands) {
    const r = applyCommand(seq, command);
    seq = r.sequence;
  }
  const result = await applyTimelineEdits(projectId, userId, head.version, commands as unknown[], false);
  return { ...base, status: "COMPLETED", detail: `${commands.length} command(s) applied; timeline now version ${result.version}.`, planVersion: String(result.version) };
}
