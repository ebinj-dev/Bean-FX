/**
 * M45-P1 — the crew task layer over the EXISTING production runner.
 *
 * Every stage execution becomes a real task record: the responsible agent
 * profile (role, not a new identity), the actual tool that will run, the
 * inputs it consumed, the artifact it produced, dependencies and completion
 * criteria. Statuses are written by the stage route from the runner's real
 * results — never fabricated.
 */
import { db } from "@/lib/db";

export type TaskMode = "deterministic" | "deterministic+llm" | "provider-job" | "ffmpeg-job" | "qa-suite" | "deterministic+job";

export const STAGE_TASK_META: Record<string, { agent: string; roleLabel: string; tool: string; criteria: string; mode: TaskMode; providerNote: string }> = {
  INTAKE: { agent: "RIISHE", roleLabel: "Executive Director", tool: "brief-parser (deterministic)", criteria: "Structured brief parsed from the user description and stored on the production." , mode: "deterministic", providerNote: "deterministic automation" },
  BRIEF: { agent: "RIISHE", roleLabel: "Executive Director", tool: "brief-parser (deterministic)", criteria: "Brief fields (title, duration, audience) extracted and approved." , mode: "deterministic", providerNote: "deterministic automation" },
  PRODUCT_UNDERSTANDING: { agent: "JAZMII", roleLabel: "Footage Intelligence", tool: "authorized-input analysis", criteria: "Product inputs summarized from user-authorized material only." , mode: "deterministic", providerNote: "deterministic automation" },
  RESEARCH: { agent: "JAZMII", roleLabel: "Footage Intelligence", tool: "research (honest absence recording)", criteria: "Research state recorded truthfully — no unverifiable citations." , mode: "deterministic", providerNote: "deterministic automation" },
  CONCEPT: { agent: "RIISHE", roleLabel: "Executive Director", tool: "concept engine (deterministic + LLM when configured)", criteria: "At least one concept option selected and recorded as a decision." , mode: "deterministic", providerNote: "deterministic automation" },
  SCRIPT: { agent: "Scriptwriter", roleLabel: "Scriptwriter · RIISHE", tool: "script engine (beat model)", criteria: "Beats cover the approved concept; durations consistent with the brief target." , mode: "deterministic", providerNote: "deterministic automation" },
  STORYBOARD: { agent: "Storyboard Artist", roleLabel: "Storyboard Artist · RIISHE", tool: "storyboard engine (scene planner)", criteria: "Every scene has purpose, shot type and required-asset kind." , mode: "deterministic", providerNote: "deterministic automation" },
  ASSET_PLANNING: { agent: "JAZMII", roleLabel: "Footage Intelligence", tool: "asset planner + production asset wall", criteria: "Every scene has an asset row; user_media rows bound to owned media." , mode: "deterministic", providerNote: "deterministic automation" },
  ASSET_GENERATION: { agent: "LAXII · NIIKI", roleLabel: "Image & VFX Specialists", tool: "generation router (provider jobs)", criteria: "Planned generation rows completed, honestly failed, or skipped." , mode: "deterministic", providerNote: "deterministic automation" },
  EDIT_PLANNING: { agent: "Assistant Editor", roleLabel: "Assistant Editor · RIISHE", tool: "assembly planner", criteria: "Edit plan prepared for canonical timeline application." , mode: "deterministic", providerNote: "deterministic automation" },
  TIMELINE_ASSEMBLY: { agent: "Video Editor", roleLabel: "Video Editor · RIISHE", tool: "canonical timeline commands (applyTimelineEdits)", criteria: "Canonical commands applied; new timeline revision recorded." , mode: "deterministic", providerNote: "deterministic automation" },
  ROUGH_CUT: { agent: "QC Editor", roleLabel: "Quality-Control Editor", tool: "timeline verification (clip/range/overlap checks)", criteria: "Timeline non-empty with valid clip ranges." , mode: "deterministic", providerNote: "deterministic automation" },
  REVIEW: { agent: "RIISHE", roleLabel: "Executive Director", tool: "M30 client review bridge", criteria: "Client review revision created and approved." , mode: "deterministic", providerNote: "deterministic automation" },
  FINAL_RENDER: { agent: "Render Pipeline", roleLabel: "Render Engineer", tool: "durable RENDER_TIMELINE job (ffmpeg)", criteria: "Render job completed with a real export artifact." , mode: "deterministic", providerNote: "deterministic automation" },
  QUALITY_ASSURANCE: { agent: "QC Editor", roleLabel: "Quality-Control Editor", tool: "ffprobe/blackdetect/loudness QA suite", criteria: "All ERROR-severity checks pass against the real render." , mode: "deterministic", providerNote: "deterministic automation" },
  DELIVERY: { agent: "Delivery Specialist", roleLabel: "Delivery Specialist", tool: "delivery manifest builder", criteria: "Delivery manifest lists the final artifact(s)." , mode: "deterministic", providerNote: "deterministic automation" },
  ANALYSIS: { agent: "JAZMII", roleLabel: "Footage Intelligence", tool: "scene/shot analysis", criteria: "Authorized footage analyzed; results recorded." , mode: "deterministic", providerNote: "deterministic automation" },
  CLIP_SELECTION: { agent: "Video Editor", roleLabel: "Video Editor", tool: "clip selection", criteria: "Selected clips recorded with sources." , mode: "deterministic", providerNote: "deterministic automation" },
};

export async function beginStageTask(productionId: string, stageKey: string, inputSummary: Record<string, unknown>, jobId?: string | null): Promise<string> {
  const meta = STAGE_TASK_META[stageKey] ?? { agent: "RIISHE", roleLabel: "Production Orchestrator", tool: "stage runner", criteria: "Stage completes without error.", mode: "deterministic" as TaskMode, providerNote: "deterministic automation" };
  const existing = await db.productionTask.findFirst({ where: { productionId, stageKey }, orderBy: { seq: "desc" } });
  const seq = (existing?.seq ?? 0) + 1;
  const row = await db.productionTask.create({
    data: {
      productionId,
      stageKey,
      seq,
      agent: meta.agent,
      roleLabel: meta.roleLabel,
      tool: meta.tool,
      criteria: meta.criteria,
      mode: meta.mode,
      providerNote: meta.providerNote,
      status: "RUNNING",
      inputJson: JSON.stringify({ at: new Date().toISOString(), ...inputSummary }),
      depsJson: JSON.stringify({ stageLevel: "enforced by the production state machine" }),
      jobId: jobId ?? null,
      startedAt: new Date(),
    },
  });
  return row.id;
}

export async function finishStageTask(taskId: string, status: "SUCCEEDED" | "FAILED" | "SKIPPED" | "RUNNING" | "PENDING", output: Record<string, unknown> | null, error?: string | null): Promise<void> {
  await db.productionTask.update({
    where: { id: taskId },
    data: { status, outputJson: output ? JSON.stringify(output) : null, error: error ?? null, completedAt: new Date() },
  }).catch(() => undefined);
}
