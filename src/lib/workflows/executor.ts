/**
 * M26 P7 — workflow automation: whitelisted template library + tick executor.
 *
 * SECURITY MODEL: runs are created ONLY from these server-side templates —
 * no user-supplied steps, no code execution. Every step maps to a REAL,
 * verified backend contract (same routes/rows/jobs the UI uses):
 *   RENDER_TIMELINE   — {projectId}            (M20 durable render)
 *   EXPORT_VARIANT    — {profileId}            (M9 variant pipeline; the
 *                        master = the run's earlier render output)
 *   GANGZII_PROCESS   — {sourceAssetId, presetId} (M5 processing row+job)
 *   JAZMII_ANALYZE    — {mediaId}              (M11 footage analysis job)
 *   LAXII_GENERATE    — {prompt, aspectId?}    (M11 image generation job)
 *   APPROVAL          — {}                     (human gate; consequential
 *                        steps wait until approved)
 */
import { db } from "@/lib/db";
import { jobManager } from "@/lib/job-runner";
import { JOB_TYPE_EXPORT_VARIANT, JOB_TYPE_GANGZII_PROCESS, JOB_TYPE_JAZMII_ANALYZE, JOB_TYPE_LAXII_GENERATE, JOB_TYPE_RENDER_TIMELINE } from "@/lib/job-helpers";
import { getExportProfile } from "@/lib/publish/profiles";
import { audit } from "@/lib/audit";

export interface WorkflowStepDef {
  id: string;
  kind: "RENDER_TIMELINE" | "EXPORT_VARIANT" | "GANGZII_PROCESS" | "JAZMII_ANALYZE" | "LAXII_GENERATE" | "APPROVAL";
  label: string;
  params: Record<string, unknown>;
  approvalRequired?: boolean;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  /** Placeholders the caller fills: projectId always; asset/media ids optional. */
  requiredInputs: string[];
  steps: Array<Omit<WorkflowStepDef, "status" | "jobId">>;
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "render-then-multi-aspect",
    name: "Render → review → multi-aspect exports",
    description: "Renders the current timeline, waits for your approval on the master, then fans out 16:9 + 9:16 variants through the real variant pipeline.",
    requiredInputs: ["projectId"],
    steps: [
      { id: "s1", kind: "RENDER_TIMELINE", label: "Render master (FFmpeg + FFprobe validation)", params: {} },
      { id: "s2", kind: "APPROVAL", label: "Review the rendered master before publishing variants", params: {}, approvalRequired: true },
      { id: "s3", kind: "EXPORT_VARIANT", label: "Variant: YouTube landscape (16:9)", params: { profileId: "youtube_landscape" } },
      { id: "s4", kind: "EXPORT_VARIANT", label: "Variant: vertical shorts (9:16)", params: { profileId: "youtube_shorts" } },
    ],
  },
  {
    id: "audio-cleanup-then-render",
    name: "GANGZII audio cleanup → render",
    description: "Runs the noise-cleanup GANGZII preset on a chosen asset, then renders the timeline with the cleaned audio in the library.",
    requiredInputs: ["projectId", "sourceAssetId"],
    steps: [
      { id: "s1", kind: "GANGZII_PROCESS", label: "GANGZII noise-cleanup on the selected asset", params: { presetId: "noise-cleanup" } },
      { id: "s2", kind: "RENDER_TIMELINE", label: "Render master", params: {} },
    ],
  },
  {
    id: "analyze-then-broll-approval",
    name: "Analyze footage → B-roll review (approval gate)",
    description: "Runs JAZMII footage analysis on a chosen asset and stops for your review before anything else happens.",
    requiredInputs: ["projectId", "mediaId"],
    steps: [
      { id: "s1", kind: "JAZMII_ANALYZE", label: "JAZMII footage analysis (real provider job)", params: {} },
      { id: "s2", kind: "APPROVAL", label: "Review the analysis report / suggested shots", params: {}, approvalRequired: true },
    ],
  },
  {
    id: "thumbnail-to-library",
    name: "LAXII thumbnail → library",
    description: "Generates a thumbnail image through the configured LAXII provider; the finished asset lands in the media library.",
    requiredInputs: ["projectId"],
    steps: [
      { id: "s1", kind: "LAXII_GENERATE", label: "Generate thumbnail (real provider job)", params: { purpose: "thumbnail" } },
    ],
  },
];

export function templateById(id: string): WorkflowTemplate | null {
  return WORKFLOW_TEMPLATES.find((t) => t.id === id) ?? null;
}

// ── runtime state helpers ────────────────────────────────────────────────────

export interface StepState {
  id: string;
  kind: WorkflowStepDef["kind"];
  label: string;
  params: Record<string, unknown>;
  approvalRequired?: boolean;
  status: "PENDING" | "WAITING_JOB" | "AWAITING_APPROVAL" | "DONE" | "FAILED" | "SKIPPED";
  jobId?: string;
  stepError?: string;
}

export interface RunState {
  steps: StepState[];
  /** The run's render output (ExportFile id) — feeds EXPORT_VARIANT steps. */
  masterExportId?: string;
  /** Output ids produced by steps (variant ids, asset ids, analysis rows). */
  outputs?: Record<string, string>;
}

function parseRun(run: { stepsJson: string }): RunState {
  return JSON.parse(run.stepsJson) as RunState;
}

/**
 * Tick the run: dispatch the next runnable step / poll the current job /
 * surface approvals. Returns the refreshed run state. Failure of any step
 * fails the run honestly (no fabricated success).
 */
export async function tickWorkflow(userId: string, runId: string): Promise<{ status: string; state: RunState; error?: string }> {
  const run = await db.workflowRun.findFirst({ where: { id: runId, userId } });
  if (!run) throw new Error("Workflow run not found.");
  if (run.status === "CANCELLED" || run.status === "COMPLETED" || run.status === "FAILED") {
    return { status: run.status, state: parseRun(run), error: run.error ?? undefined };
  }

  const state = parseRun(run);
  let status = "RUNNING";
  let error: string | undefined;

  const next = state.steps.find((s) => s.status === "PENDING" || s.status === "WAITING_JOB" || s.status === "AWAITING_APPROVAL");

  if (!next) {
    status = "COMPLETED";
  } else if (next.status === "AWAITING_APPROVAL") {
    status = "AWAITING_APPROVAL";
  } else if (next.status === "WAITING_JOB" && next.jobId) {
    const job = await db.job.findUnique({ where: { id: next.jobId } });
    if (!job) {
      next.status = "FAILED";
      next.stepError = "Dispatched job disappeared (worker cleanup?) — retry the step.";
      status = "FAILED";
      error = next.stepError;
    } else if (job.status === "COMPLETED") {
      // Harvest the step's output before moving on.
      try {
        await harvestOutput(state, next, job.id);
      } catch (err) {
        next.status = "FAILED";
        next.stepError = err instanceof Error ? err.message : "Output harvest failed.";
        status = "FAILED";
        error = next.stepError;
      }
      if (next.status !== "FAILED") next.status = "DONE";
    } else if (job.status === "FAILED") {
      next.status = "FAILED";
      next.stepError = (job.message ?? "Job failed.").slice(0, 300);
      status = "FAILED";
      error = next.stepError;
    } else if (job.status === "CANCELLED") {
      next.status = "FAILED";
      next.stepError = "Job was cancelled.";
      status = "CANCELLED";
      error = next.stepError;
    }
  } else if (next.status === "PENDING") {
    // Dispatch.
    try {
      const jobId = await dispatchStep(userId, run.projectId, next, state);
      next.status = next.kind === "APPROVAL" ? "AWAITING_APPROVAL" : "WAITING_JOB";
      if (next.kind === "APPROVAL") {
        status = "AWAITING_APPROVAL";
      } else {
        next.jobId = jobId ?? undefined;
        if (!next.jobId) {
          // Steps that complete synchronously (dispatch returned null) are done.
          next.status = "DONE";
        }
      }
    } catch (err) {
      next.status = "FAILED";
      next.stepError = (err instanceof Error ? err.message : "Dispatch failed.").slice(0, 300);
      status = "FAILED";
      error = next.stepError;
    }
  }

  const updated = await db.workflowRun.update({
    where: { id: run.id },
    data: { status, stepsJson: JSON.stringify(state), error: error ?? null },
  });
  return { status: updated.status, state, error };
}

/** Map a step onto the REAL backend contract. No other code paths exist. */
async function dispatchStep(userId: string, projectId: string | null, step: StepState, state: RunState): Promise<string | null> {
  switch (step.kind) {
    case "APPROVAL":
      return null; // waits for the approve action — no job
    case "RENDER_TIMELINE": {
      if (!projectId) throw new Error("Render step needs a project context.");
      const version = await db.timelineVersion.findFirst({ where: { projectId }, orderBy: { versionNumber: "desc" } });
      if (!version) throw new Error("The project has no sequence to render yet.");
      return jobManager.createJob(userId, JOB_TYPE_RENDER_TIMELINE, { projectId, startFrame: null, endFrame: null });
    }
    case "EXPORT_VARIANT": {
      if (!projectId) throw new Error("Variant step needs a project context.");
      const masterId = state.masterExportId;
      if (!masterId) throw new Error("No rendered master available for variants (the render step must complete first).");
      const profileId = String(step.params.profileId ?? "");
      const profile = getExportProfile(profileId);
      if (!profile) throw new Error(`Unknown export profile "${profileId}".`);
      const existing = await db.exportVariant.findFirst({
        where: { userId, profileId, sourceExportId: masterId, status: { in: ["QUEUED", "RENDERING", "COMPLETED"] } },
        select: { id: true },
      });
      if (existing) {
        state.outputs = { ...(state.outputs ?? {}), [step.id]: existing.id };
        return null; // already covered — do not duplicate
      }
      const variant = await db.exportVariant.create({
        data: {
          userId,
          projectId,
          profileId,
          profileVersion: String((profile as unknown as { version?: number }).version ?? 1),
          profileJson: JSON.stringify(profile),
          status: "QUEUED",
          sourceExportId: masterId,
        },
        select: { id: true },
      });
      state.outputs = { ...(state.outputs ?? {}), [step.id]: variant.id };
      return jobManager.createJob(userId, JOB_TYPE_EXPORT_VARIANT, { variantId: variant.id });
    }
    case "GANGZII_PROCESS": {
      const sourceAssetId = String(step.params.sourceAssetId ?? "");
      if (!sourceAssetId) throw new Error("GANGZII step needs sourceAssetId input.");
      const asset = await db.mediaAsset.findFirst({ where: { id: sourceAssetId, userId } });
      if (!asset) throw new Error("Source asset not found.");
      if (!asset.audioCodec) throw new Error("This media has no audio stream.");
      const row = await db.gangziiProcess.create({
        data: {
          userId,
          sourceAssetId,
          kind: "PROCESS",
          status: "QUEUED",
          name: `workflow:${step.id}`,
          paramsJson: JSON.stringify({ presetId: String(step.params.presetId ?? "noise-cleanup") }),
          analysisJson: null,
        },
        select: { id: true },
      });
      const jobId = await jobManager.createJob(userId, JOB_TYPE_GANGZII_PROCESS, { processId: row.id });
      await db.gangziiProcess.update({ where: { id: row.id }, data: { jobId } });
      state.outputs = { ...(state.outputs ?? {}), [step.id]: row.id };
      return jobId;
    }
    case "JAZMII_ANALYZE": {
      const mediaId = String(step.params.mediaId ?? "");
      if (!mediaId) throw new Error("JAZMII step needs mediaId input.");
      const asset = await db.mediaAsset.findFirst({ where: { id: mediaId, userId } });
      if (!asset) throw new Error("Media not found.");
      return jobManager.createJob(userId, JOB_TYPE_JAZMII_ANALYZE, { mediaId });
    }
    case "LAXII_GENERATE": {
      const { laxiiProviderIds } = await import("@/lib/laxii/providers");
      if (laxiiProviderIds().length === 0) throw new Error("No LAXII provider configured on this deployment (CONFIGURATION REQUIRED).");
      return jobManager.createJob(userId, JOB_TYPE_LAXII_GENERATE, {
        mode: "generate",
        prompt: String(step.params.prompt ?? `Thumbnail for video project — bold, high-contrast, professional`),
        aspectId: "square_social",
        purpose: "thumbnail",
      });
    }
    default:
      throw new Error(`Unknown step kind (template library is stale): ${String((step as { kind: string }).kind)}`);
  }
}

/** Harvest step outputs: render → the REAL ExportFile the job registered. */
async function harvestOutput(state: RunState, step: StepState, jobId: string): Promise<void> {
  if (step.kind === "RENDER_TIMELINE") {
    const job = await db.job.findUnique({ where: { id: jobId }, select: { exportId: true } });
    if (!job?.exportId) throw new Error("Render completed but no export was registered (worker contract changed?).");
    state.masterExportId = job.exportId;
  }
}

export async function approveStep(userId: string, runId: string, stepId: string): Promise<{ status: string }> {
  const run = await db.workflowRun.findFirst({ where: { id: runId, userId } });
  if (!run) throw new Error("Workflow run not found.");
  const state = parseRun(run);
  const step = state.steps.find((s) => s.id === stepId);
  if (!step || !step.approvalRequired) throw new Error("Step is not an approval gate.");
  if (step.status !== "AWAITING_APPROVAL") throw new Error("The gate is not waiting for approval.");
  step.status = "PENDING"; // re-enter the queue (dispatch on next tick)
  const updated = await db.workflowRun.update({ where: { id: run.id }, data: { status: "RUNNING", stepsJson: JSON.stringify(state), error: null } });
  await audit("workflow.approved", { userId, detail: JSON.stringify({ runId, stepId }) });
  return { status: updated.status };
}

export async function cancelWorkflow(userId: string, runId: string): Promise<{ status: string }> {
  const run = await db.workflowRun.findFirst({ where: { id: runId, userId } });
  if (!run) throw new Error("Workflow run not found.");
  if (["COMPLETED", "CANCELLED"].includes(run.status)) return { status: run.status };
  const state = parseRun(run);
  const waiting = state.steps.find((s) => s.status === "WAITING_JOB" && s.jobId);
  if (waiting?.jobId) await jobManager.cancel(waiting.jobId, userId).catch(() => undefined);
  const updated = await db.workflowRun.update({ where: { id: run.id }, data: { status: "CANCELLED", error: "Cancelled by the user." } });
  return { status: updated.status };
}

/** Retry a failed step (safe: re-dispatch the SAME whitelisted step). */
export async function retryStep(userId: string, runId: string, stepId: string): Promise<{ status: string }> {
  const run = await db.workflowRun.findFirst({ where: { id: runId, userId } });
  if (!run) throw new Error("Workflow run not found.");
  if (run.status !== "FAILED" && run.status !== "CANCELLED") throw new Error("Only failed runs can retry steps.");
  const state = parseRun(run);
  const step = state.steps.find((s) => s.id === stepId);
  if (!step || step.status !== "FAILED") throw new Error("Step is not in a failed state.");
  step.status = "PENDING";
  step.jobId = undefined;
  step.stepError = undefined;
  const updated = await db.workflowRun.update({ where: { id: run.id }, data: { status: "RUNNING", stepsJson: JSON.stringify(state), error: null } });
  return { status: updated.status };
}

export { parseRun };
