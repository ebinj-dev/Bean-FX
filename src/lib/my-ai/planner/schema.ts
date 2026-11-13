/**
 * MY AI — plan schema, version 1 (M8 §6).
 *
 * Plans are DATA validated at every boundary. The LLM proposes; this schema
 * decides what is legal. Anything outside it is rejected — arbitrary LLM
 * output never reaches the execution layer, and there is no code-eval path.
 *
 * Operations are typed and map 1:1 onto REAL engine entry points:
 *  - APPLY_COMMANDS        → M1 command engine (server-side apply + version)
 *  - RIISHE_AUTOCUT        → existing M4 proposal/apply flow (approval-gated)
 *  - GANGZII_PROCESS       → durable GangziiProcess job (M5)
 *  - NIIKI_GRAPHIC         → M6 typed proposal → commands
 *  - JAZMII_GENERATE       → durable JAZMII_GENERATE job (M7)
 *  - LAXII_GENERATE        → durable LAXII_GENERATE job (M7)
 *  - JAZMII_ANALYZE        → durable JAZMII_ANALYZE job (M7)
 *  - INSERT_ASSET          → M1 AddClip of a registered asset
 *  - EXPORT                → existing export pipeline
 */
import { z } from "zod";

export const PLAN_SCHEMA_VERSION = 1;

export const PlanOperation = z.enum([
  "APPLY_COMMANDS",
  "RIISHE_AUTOCUT",
  "GANGZII_PROCESS",
  "NIIKI_GRAPHIC",
  "JAZMII_GENERATE",
  "JAZMII_ANALYZE",
  "LAXII_GENERATE",
  "INSERT_ASSET",
  "EXPORT",
]);

export const PlanStepSchema = z
  .object({
    id: z.string().min(1).max(64),
    operation: PlanOperation,
    title: z.string().min(1).max(200),
    /** Engine supplying the operation (informational + routing). */
    engine: z.enum(["MYAI", "RIISHE", "GANGZII", "NIIKI", "JAZMII", "LAXII"]),
    /** Step ids that must complete first. */
    dependsOn: z.array(z.string().max(64)).max(12).default([]),
    /** Typed arguments — validated per operation below. */
    args: z.record(z.string(), z.unknown()),
    /** Human-facing description shown in the approval UI. */
    description: z.string().min(1).max(500),
    /** Which assets this step reads (references) and creates. */
    readsAssetIds: z.array(z.string().max(64)).max(20).default([]),
    writesAssetIds: z.array(z.string().max(64)).max(20).default([]),
    /** Timeline range affected (frames) when applicable. */
    affectedRange: z.object({ startFrame: z.number().int().min(0).max(2_000_000), endFrame: z.number().int().min(0).max(2_000_000) }).nullable().default(null),
    /** Declared risk class for approval routing. */
    risk: z.enum(["timeline", "generation", "export", "analysis"]).default("analysis"),
  })
  .superRefine((step, ctx) => {
    // Per-operation argument validation (deterministic, no LLM trust).
    const a = step.args as Record<string, unknown>;
    switch (step.operation) {
      case "APPLY_COMMANDS":
      case "NIIKI_GRAPHIC":
      case "INSERT_ASSET": {
        if (step.operation === "INSERT_ASSET") {
          if (typeof a.assetId !== "string" || a.assetId.length === 0) ctx.addIssue({ code: "custom", message: "INSERT_ASSET requires assetId" });
          if (typeof a.trackId !== "string" || a.trackId.length === 0) ctx.addIssue({ code: "custom", message: "INSERT_ASSET requires trackId" });
          if (typeof a.startFrame !== "number" || !Number.isInteger(a.startFrame) || a.startFrame < 0) ctx.addIssue({ code: "custom", message: "INSERT_ASSET requires integer startFrame ≥ 0" });
        } else if (step.operation === "NIIKI_GRAPHIC") {
          // Either concrete commands OR an instruction the executor resolves
          // server-side through the NIIKI proposal engine.
          const hasCommands = Array.isArray(a.commands) && a.commands.length > 0;
          const hasInstruction = typeof a.instruction === "string" && (a.instruction as string).length > 2;
          if (!hasCommands && !hasInstruction) ctx.addIssue({ code: "custom", message: "NIIKI_GRAPHIC requires a commands array or an instruction" });
        } else {
          const hasCommands = Array.isArray(a.commands) && a.commands.length > 0;
          const guided = typeof a.guidance === "string";
          if (!hasCommands && !guided) ctx.addIssue({ code: "custom", message: "APPLY_COMMANDS requires a non-empty commands array or guidance" });
          else if (hasCommands && (a.commands as unknown[]).length > 200) ctx.addIssue({ code: "custom", message: "commands array exceeds 200 items (bulk ops need explicit approval chunks)" });
        }
        break;
      }
      case "RIISHE_AUTOCUT": {
        // Either a concrete reference to an existing analysis, or explicit
        // guidance text (the executor ROUTES such steps honestly — never fakes).
        if (!a.jobId && !a.proposalId && typeof a.guidance !== "string") {
          ctx.addIssue({ code: "custom", message: "RIISHE_AUTOCUT requires jobId/proposalId or guidance" });
        }
        break;
      }
      case "GANGZII_PROCESS": {
        const guided = typeof a.guidance === "string";
        if (!guided && typeof a.assetId !== "string") ctx.addIssue({ code: "custom", message: "GANGZII_PROCESS requires assetId or guidance" });
        if (!guided && typeof a.preset !== "string" && !a.params) ctx.addIssue({ code: "custom", message: "GANGZII_PROCESS requires preset or params" });
        break;
      }
      case "JAZMII_GENERATE": {
        if (typeof a.prompt !== "string" || (a.prompt as string).length < 3) ctx.addIssue({ code: "custom", message: "JAZMII_GENERATE requires prompt" });
        if (a.durationSec !== undefined && !["5", "10"].includes(String(a.durationSec))) ctx.addIssue({ code: "custom", message: "JAZMII durationSec must be 5 or 10 (provider contract)" });
        break;
      }
      case "JAZMII_ANALYZE": {
        if (typeof a.mediaId !== "string" && typeof a.guidance !== "string") ctx.addIssue({ code: "custom", message: "JAZMII_ANALYZE requires mediaId or guidance" });
        break;
      }
      case "LAXII_GENERATE": {
        if (typeof a.prompt !== "string" || (a.prompt as string).length < 3) ctx.addIssue({ code: "custom", message: "LAXII_GENERATE requires prompt" });
        if (a.count !== undefined && (!Number.isInteger(a.count) || (a.count as number) < 1 || (a.count as number) > 4)) ctx.addIssue({ code: "custom", message: "LAXII count must be 1..4" });
        break;
      }
      case "EXPORT": {
        if (typeof a.projectId !== "string") ctx.addIssue({ code: "custom", message: "EXPORT requires projectId" });
        if (a.format !== undefined && !["mp4", "webm"].includes(String(a.format))) ctx.addIssue({ code: "custom", message: "EXPORT format must be mp4 or webm" });
        break;
      }
    }
  });

export const AIPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    planId: z.string().min(6).max(64),
    projectId: z.string().max(64),
    requestSummary: z.string().min(1).max(500),
    /** Engines the plan needs — used for routing + capability checks. */
    engines: z.array(z.enum(["RIISHE", "GANGZII", "NIIKI", "JAZMII", "LAXII"])).max(5).default([]),
    steps: z.array(PlanStepSchema).min(1).max(24),
    /** What the user should expect to change (shown at approval). */
    expectedChanges: z.array(z.string().max(300)).max(12).default([]),
    warnings: z.array(z.string().max(300)).max(12).default([]),
    /** Provider metering estimate (token/call counts only — no invented $). */
    estimatedUsage: z
      .object({
        llmCalls: z.number().int().min(0).max(50).default(0),
        generationCalls: z.number().int().min(0).max(20).default(0),
        note: z.string().max(200).default("Metered by provider accounts; token counts recorded per call."),
      })
      .default({ llmCalls: 0, generationCalls: 0, note: "Metered by provider accounts; token counts recorded per call." }),
    /** Context this plan was computed against — stale plans are rejected. */
    contextVersion: z.string().max(64).nullable().default(null),
    idempotencyKey: z.string().min(6).max(80),
  })
  .superRefine((plan, ctx) => {
    // Dependency integrity: ids unique, deps exist, no cycles (bounded).
    const ids = new Set(plan.steps.map((s) => s.id));
    if (ids.size !== plan.steps.length) ctx.addIssue({ code: "custom", message: "duplicate step ids" });
    for (const s of plan.steps) {
      for (const d of s.dependsOn) {
        if (!ids.has(d)) ctx.addIssue({ code: "custom", message: `step ${s.id} depends on missing step ${d}` });
      }
    }
    // Cycle check via DFS (≤24 steps → trivial).
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (id: string, stack: string[]): string | null => {
      if (done.has(id)) return null;
      if (visiting.has(id)) return [...stack, id].join("→");
      visiting.add(id);
      const step = plan.steps.find((x) => x.id === id);
      for (const d of step?.dependsOn ?? []) {
        const cyc = visit(d, [...stack, id]);
        if (cyc) return cyc;
      }
      visiting.delete(id);
      done.add(id);
      return null;
    };
    for (const s of plan.steps) {
      const cyc = visit(s.id, []);
      if (cyc) {
        ctx.addIssue({ code: "custom", message: `dependency cycle: ${cyc}` });
        break;
      }
    }
  });


/** Deterministic normalization of common LLM REPRESENTATION deviations —
 *  never content invention: enum casing, engine lists, range shapes, risk
 *  labels. Anything it cannot map is left for zod to reject. */
const ENGINE_IDS = ["RIISHE", "GANGZII", "NIIKI", "JAZMII", "LAXII", "MYAI"] as const;
const RISK_IDS = ["timeline", "generation", "export", "analysis"] as const;

function coerceEngine(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const up = v.trim().toUpperCase();
  return (ENGINE_IDS as readonly string[]).includes(up) ? up : null;
}

const OPERATION_IDS = ["APPLY_COMMANDS", "RIISHE_AUTOCUT", "GANGZII_PROCESS", "NIIKI_GRAPHIC", "JAZMII_GENERATE", "JAZMII_ANALYZE", "LAXII_GENERATE", "INSERT_ASSET", "EXPORT"] as const;

/** Common LLM key aliases → canonical names (representation mapping only). */
function coerceStepKeys(step: Record<string, unknown>): Record<string, unknown> {
  const out = { ...step };
  if (out.id === undefined && typeof out.stepId === "string") out.id = out.stepId;
  if (out.operation === undefined) {
    for (const key of ["type", "kind", "op"] as const) {
      const v = out[key];
      if (typeof v === "string") {
        const up = v.trim().toUpperCase();
        if ((OPERATION_IDS as readonly string[]).includes(up)) {
          out.operation = up;
          break;
        }
      }
    }
  }
  if (out.title === undefined && typeof out.name === "string") out.title = out.name;
  if (out.description === undefined && typeof out.summary === "string") out.description = out.summary;
  return out;
}

export function normalizeLLMPlan(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const r = { ...(raw as Record<string, unknown>) };
  // Top-level aliases.
  if (r.requestSummary === undefined && typeof r.summary === "string") r.requestSummary = r.summary;
  if (r.requestSummary === undefined && typeof r.request === "string") r.requestSummary = r.request;
  if (r.idempotencyKey === undefined && typeof r.idempotency_key === "string") r.idempotencyKey = r.idempotency_key;
  if (r.planId === undefined && typeof r.plan_id === "string") r.planId = r.plan_id;
  if (r.contextVersion === undefined && typeof r.context_version === "string") r.contextVersion = r.context_version;
  if (Array.isArray(r.engines)) {
    r.engines = r.engines.map(coerceEngine).filter((v): v is string => v !== null && v !== "MYAI");
  }
  if (Array.isArray(r.steps)) {
    r.steps = (r.steps as Record<string, unknown>[]).map((st) => {
      const step = { ...st };
      const eng = coerceEngine(step.engine);
      if (eng) step.engine = eng;
      const risk = typeof step.risk === "string" ? step.risk.trim().toLowerCase() : "";
      if (!(RISK_IDS as readonly string[]).includes(risk)) step.risk = "analysis";
      // affectedRange "a-b" | "a..b" | number → object; null stays null.
      const ar = step.affectedRange;
      if (typeof ar === "string") {
        const m = ar.match(/(\d+)\s*(?:-|\.\.|to)\s*(\d+)/);
        step.affectedRange = m ? { startFrame: Number(m[1]), endFrame: Number(m[2]) } : null;
      } else if (typeof ar === "number") {
        step.affectedRange = { startFrame: ar, endFrame: ar };
      } else if (ar !== null && (typeof ar !== "object" || Array.isArray(ar))) {
        step.affectedRange = null;
      }
      // args must be an object.
      if (typeof step.args !== "object" || step.args === null || Array.isArray(step.args)) step.args = {};
      for (const k of ["readsAssetIds", "writesAssetIds", "dependsOn"]) {
        if (!Array.isArray(step[k])) step[k] = [];
      }
      if (typeof step.title !== "string" || step.title.length === 0) step.title = String(step.description ?? step.operation ?? "Step");
      if (typeof step.description !== "string" || step.description.length === 0) step.description = String(step.title ?? "Step");
      return step;
    });
  }
  if (typeof r.estimatedUsage !== "object" || r.estimatedUsage === null) {
    r.estimatedUsage = { llmCalls: 1, generationCalls: 0, note: "Metered by provider accounts; token counts recorded per call." };
  }
  return r;
}

export type AIPlan = z.infer<typeof AIPlanSchema>;
export type PlanStep = z.infer<typeof PlanStepSchema>;
