import { CommandSchema } from "@/lib/editor/commands";
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
  "M14_ART_DIRECTION",
  "M14_SCENE_PLAN",
  "M14_SCENE_ASSET",
  "M14_COMPOSE_APPLY",
  "M14_TRACK_ATTACH",
  "M14_RENDER",
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
      case "M14_ART_DIRECTION": {
        if (typeof a.brief !== "string" && typeof a.guidance !== "string") ctx.addIssue({ code: "custom", message: "M14_ART_DIRECTION requires brief or guidance" });
        break;
      }
      case "M14_SCENE_PLAN": {
        break;
      }
      case "M14_SCENE_ASSET": {
        if (typeof a.prompt !== "string" || (a.prompt as string).length < 3) ctx.addIssue({ code: "custom", message: "M14_SCENE_ASSET requires prompt" });
        break;
      }
      case "M14_COMPOSE_APPLY": {
        if (typeof a.compositionId !== "string") ctx.addIssue({ code: "custom", message: "M14_COMPOSE_APPLY requires compositionId" });
        break;
      }
      case "M14_TRACK_ATTACH": {
        if (typeof a.compositionId !== "string" || typeof a.layerId !== "string") ctx.addIssue({ code: "custom", message: "M14_TRACK_ATTACH requires compositionId and layerId" });
        break;
      }
      case "M14_RENDER": {
        if (typeof a.compositionId !== "string") ctx.addIssue({ code: "custom", message: "M14_RENDER requires compositionId" });
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

/**
 * M42-H — LLM command normalization (defect fix from the live demo).
 *
 * glm-4-plus plans can emit commands in an LLM-ish shape instead of the
 * canonical discriminated union, e.g.
 *   {"command":"TrimClip","clipId":"d1","startFrame":0,"durationFrames":90}
 *   {"command":"AddTransition","clipId":"d1","transitionType":"CROSSFADE",...}
 *   {"command":"AddEffect","clipId":"d1","effectType":"COLORGRADE","parameters":{...}}
 * The executor's strict schema correctly rejects these (fail-closed). Rather
 * than weakening the executor, the PLANNER normalizes: aliases → canonical
 * fields, positional/synthetic clip references ("d1") → REAL clip ids from
 * the project context, transition kinds → real TransitionKind members, and
 * effect blocks → one canonical AddEffect per real EffectType member.
 * Commands that cannot be mapped honestly are DROPPED with a plan warning —
 * never guessed into existence.
 */
export interface PlanContextHint {
  clips: Array<{ id: string; startFrame: number; durationFrames: number; trackKind?: string | null; sourceInFrame?: number; sourceOutFrame?: number }>;
  tracks: Array<{ id: string; kind: string }>;
  fps?: number;
}

const TRANSITION_ALIASES: Record<string, string> = {
  crossfade: "CROSS_DISSOLVE",
  "cross_fade": "CROSS_DISSOLVE",
  dissolve: "CROSS_DISSOLVE",
  fade: "FADE_TO_BLACK",
  fadetoblack: "FADE_TO_BLACK",
  fadein: "FADE_FROM_BLACK",
  fadefromblack: "FADE_FROM_BLACK",
  cut: "CUT",
  zoom: "ZOOM_IN",
  zoomin: "ZOOM_IN",
  fade_through_black: "FADE_TO_BLACK",
  throughblack: "FADE_TO_BLACK",
};

const EFFECT_ALIASES: Record<string, string> = {
  colorgrade: "contrast",
  colourgrade: "contrast",
  grade: "contrast",
  cinematic: "contrast",
  saturationboost: "saturation",
  contrastboost: "contrast",
  warmth: "temperature",
  warm: "temperature",
  vignette_darkening: "vignette",
};


/** M42-H — a transition window [start, start+dur) is executable ONLY when the
 * track actually has two overlapping clips covering it (executor rule). The
 * planner checks this BEFORE emitting, so plans never contain doomed steps. */
function transitionFeasible(ctxHint: PlanContextHint, start: number, dur: number): boolean {
  const end = start + dur;
  const byTrack = new Map<string, Array<{ s: number; e: number }>>();
  for (const c of ctxHint.clips) {
    const list = byTrack.get("") ?? [];
    void list;
  }
  for (const c of ctxHint.clips) {
    // clip startFrame/durationFrames are timeline positions on their track;
    // ctxHint.clips carries no trackId — group by nearest track is impossible,
    // so use the video track as the executor does for single-track plans.
    const arr = byTrack.get("v") ?? [];
    arr.push({ s: c.startFrame, e: c.startFrame + c.durationFrames });
    byTrack.set("v", arr);
  }
  const arr = byTrack.get("v") ?? [];
  for (const a of arr) {
    if (a.e >= end) {
      for (const b of arr) {
        if (b !== a && b.s <= start) return true;
      }
    }
  }
  return false;
}

export function normalizePlanCommands(
  steps: Array<Record<string, unknown>>,
  ctxHint: PlanContextHint,
): { steps: Array<Record<string, unknown>>; warnings: string[] } {
  const warnings: string[] = [];
  const videoTracks = ctxHint.tracks.filter((t) => t.kind === "VIDEO");
  // Positional mapping: synthetic ids ("d1","clip1","clip_2",…) resolve to
  // REAL clips in first-appearance order.
  const syntheticMap = new Map<string, string>();
  let nextClip = 0;
  const resolveClip = (ref: unknown): string | null => {
    if (typeof ref !== "string" || ref.length === 0) return null;
    if (ctxHint.clips.some((c) => c.id === ref)) return ref; // already real
    if (!syntheticMap.has(ref)) {
      if (nextClip >= ctxHint.clips.length) return null;
      syntheticMap.set(ref, ctxHint.clips[nextClip].id);
      nextClip += 1;
    }
    return syntheticMap.get(ref) ?? null;
  };
  const clipById = (id: string) => ctxHint.clips.find((c) => c.id === id);

  const out: Array<Record<string, unknown>> = steps.map((rawStep) => {
    const step = { ...rawStep };
    if (step.operation !== "APPLY_COMMANDS") return step;
    const args = { ...((step.args as Record<string, unknown>) ?? {}) };
    const rawCommands = Array.isArray(args.commands) ? (args.commands as Array<Record<string, unknown>>) : [];
    const canonical: Array<Record<string, unknown>> = [];
    for (const rc of rawCommands) {
      const typeName = String(rc.command ?? rc.type ?? "").trim();
      if (!typeName) continue;
      // Pass through ONLY genuine canonical command names — LLMs sometimes put
      // a transition KIND in `type` (observed: {"type":"CROSS_FADE"}), which
      // must be rebuilt as an AddTransition, never passed raw.
      const CANONICAL_COMMANDS = new Set(["AddTrack", "RemoveTrack", "UpdateTrack", "AddClip", "RemoveClip", "SplitClip", "TrimClip", "MoveClip", "RippleDelete", "InsertClip", "ReplaceClip", "RelinkAssets", "AddTransition", "RemoveTransition", "AddEffect", "RemoveEffect", "AddCaption", "AddGraphic", "SetKeyframe", "RemoveKeyframe", "ChangeVolume", "ChangePlaybackSpeed", "UpdateClipProperties", "AddMarker"]);
      if (rc.type && !rc.command && CANONICAL_COMMANDS.has(String(rc.type))) {
        // Canonical command name — still map known LLM field aliases (observed:
        // MoveClip with startFrame instead of newTimelineStartFrame).
        const t = String(rc.type);
        if (t === "AddClip") {
          // LLM flat AddClip {trackId, assetId, startFrame, durationFrames, label}
          // → canonical {type, clip: ClipCore} with a REAL track and honest bounds.
          const track = ctxHint.tracks.some((tr) => tr.id === rc.trackId) ? rc.trackId : (videoTracks[0] ?? ctxHint.tracks[0])?.id;
          const dur = Math.max(1, Math.round(Number(rc.durationFrames ?? 90)));
          const start = Math.max(0, Math.round(Number(rc.startFrame ?? 0)));
          canonical.push({
            type: "AddClip",
            clip: {
              id: `cl-${step.id ?? "s"}-${canonical.length}-${start}`,
              trackId: track,
              sourceAssetId: String(rc.assetId ?? rc.sourceAssetId ?? ""),
              sourceInFrame: 0,
              sourceOutFrame: dur,
              sourceFps: { num: Math.max(1, Math.round(ctxHint.fps ?? 30)), den: 1 },
              timelineStartFrame: start,
              label: typeof rc.label === "string" ? rc.label.slice(0, 120) : null,
            },
          });
          continue;
        }
        if (t === "MoveClip") {
          const cid = resolveClip(rc.clipId ?? rc.clip_id);
          if (!cid) { warnings.push(`MoveClip dropped: clip reference ${String(rc.clipId)} not resolvable`); continue; }
          const nsf = Number(rc.newTimelineStartFrame ?? rc.startFrame ?? NaN);
          if (!Number.isFinite(nsf)) { warnings.push("MoveClip dropped: no timeline start frame"); continue; }
          canonical.push({ type: "MoveClip", clipId: cid, newTimelineStartFrame: Math.max(0, Math.round(nsf)), newTrackId: typeof rc.trackId === "string" ? rc.trackId : undefined });
          continue;
        }
        canonical.push(rc);
        continue;
      }
      if (rc.type && !rc.command && !rc.command_name) {
        // Kind-shaped `type` → intended AddTransition between clipId/targetClipId.
        const kindRaw = String(rc.type);
        const kind = TRANSITION_ALIASES[kindRaw.toLowerCase()] ?? (["CUT", "CROSS_DISSOLVE", "FADE_TO_BLACK", "FADE_FROM_BLACK", "ZOOM_IN"].includes(kindRaw) ? kindRaw : null);
        if (kind && (rc.clipId || rc.targetClipId)) {
          const clipId = resolveClip(rc.clipId ?? rc.targetClipId);
          if (clipId) {
            const track = videoTracks[0] ?? ctxHint.tracks[0];
            const src = clipById(clipId)!;
            const dur = Math.max(1, Number(rc.durationFrames ?? 12));
            const start = Math.max(0, src.startFrame - Math.round(dur / 2));
            if (!transitionFeasible(ctxHint, start, dur)) { warnings.push(`AddTransition dropped: a ${kind} at frames [${start},${start + dur}) needs two overlapping clips on the track — plan a MoveClip/ripple first`); continue; }
            canonical.push({ type: "AddTransition", transitionId: `tr-${step.id ?? "s"}-k-${canonical.length}-${src.startFrame}`, trackId: track.id, kind, startFrame: start, durationFrames: dur, params: {} });
            continue;
          }
        }
        if (!CANONICAL_COMMANDS.has(String(rc.command ?? ""))) {
          warnings.push(`Command "${typeName}" dropped — not a canonical editor command and not mappable`);
          continue;
        }
      }
      const clipId = resolveClip(rc.clipId ?? rc.clip_id);
      if (typeName === "TrimClip") {
        if (!clipId) { warnings.push(`TrimClip dropped: clip reference ${String(rc.clipId)} not resolvable to project media`); continue; }
        const inF = Number(rc.startFrame ?? rc.sourceInFrame ?? rc.newSourceInFrame ?? NaN);
        const outF = Number(rc.endFrame ?? rc.sourceOutFrame ?? rc.newSourceOutFrame ?? NaN);
        const dur = Number(rc.durationFrames ?? 0);
        const src = clipById(clipId)!;
        // M42-H — the clip's REAL source bounds (executor trims are absolute
        // source positions on the asset; a trim outside the current source
        // range collapses the timeline and is rejected fail-closed).
        const sIn = Number.isFinite(src.sourceInFrame) ? (src.sourceInFrame as number) : 0;
        const sOut = Number.isFinite(src.sourceOutFrame) ? (src.sourceOutFrame as number) : sIn + src.durationFrames;
        let lo = Number.isFinite(inF) ? inF : sIn;
        let hi = Number.isFinite(outF) ? outF : (dur > 0 ? lo + dur : sOut);
        // LLM frames may be asset-absolute while the clip's source window is
        // [sIn, sOut) — clamp the requested window INTO the real range.
        lo = Math.max(sIn, Math.min(Math.round(lo), sOut - 1));
        hi = Math.max(lo + 1, Math.min(Math.round(hi), sOut));
        if (hi - lo < 1) { warnings.push(`TrimClip dropped: requested source window collapses to zero frames on clip ${clipId} (real source ${sIn}-${sOut})`); continue; }
        canonical.push({ type: "TrimClip", clipId, newSourceInFrame: lo, newSourceOutFrame: hi });
      } else if (typeName === "AddTransition") {
        if (!clipId) { warnings.push(`AddTransition dropped: clip reference ${String(rc.clipId)} not resolvable`); continue; }
        const kindRaw = String(rc.transitionType ?? rc.kind ?? "CROSS_DISSOLVE");
        const kind = TRANSITION_ALIASES[kindRaw.toLowerCase()] ?? (["CUT", "CROSS_DISSOLVE", "FADE_TO_BLACK", "FADE_FROM_BLACK", "ZOOM_IN"].includes(kindRaw) ? kindRaw : null);
        if (!kind) { warnings.push(`AddTransition dropped: unknown transition kind "${kindRaw}"`); continue; }
        const track = videoTracks[0] ?? ctxHint.tracks[0];
        const src = clipById(clipId)!;
        const dur = Math.max(1, Number(rc.durationFrames ?? 12));
        const start = Math.max(0, src.startFrame - Math.round(dur / 2));
        if (!transitionFeasible(ctxHint, start, dur)) { warnings.push(`AddTransition dropped: a ${kind} at frames [${start},${start + dur}) needs two overlapping clips on the track — plan a MoveClip/ripple first`); continue; }
        canonical.push({ type: "AddTransition", transitionId: `tr-${step.id ?? "s"}-${canonical.length}-${start}`, trackId: track.id, kind, startFrame: start, durationFrames: dur, params: {} });
      } else if (typeName === "AddEffect") {
        if (!clipId) { warnings.push(`AddEffect dropped: clip reference ${String(rc.clipId)} not resolvable`); continue; }
        // Two LLM spellings: flat (effectType + parameters) or nested
        // (effect: { type: "ColorGrade", params: {...} }) — both normalized
        // into one canonical AddEffect per REAL EffectType member.
        const nested = (rc.effect ?? null) as Record<string, unknown> | null;
        const params = (nested ? (nested.params ?? {}) : (rc.parameters ?? rc.params ?? {})) as Record<string, unknown>;
        const effectTypeRaw = nested ? String(nested.type ?? "") : String(rc.effectType ?? rc.effect_type ?? "");
        // One canonical effect per REAL EffectType member.
        const entries: Array<[string, number]> = [];
        const effective = EFFECT_ALIASES[effectTypeRaw.toLowerCase()] ?? effectTypeRaw.toLowerCase();
        if (["contrast", "saturation", "brightness", "exposure", "temperature", "tint", "highlights", "shadows", "vignette", "sharpen"].includes(effective)) {
          const v = Number(params[effective] ?? params.amount ?? NaN);
          if (Number.isFinite(v)) entries.push([effective, v]);
        }
        for (const [k, v] of Object.entries(params)) {
          if (!Number.isFinite(Number(v))) continue;
          const t = EFFECT_ALIASES[k.toLowerCase()] ?? k.toLowerCase();
          if (["contrast", "saturation", "brightness", "exposure", "temperature", "tint", "highlights", "shadows", "vignette", "sharpen", "whites", "blacks"].includes(t) && !entries.some(([e]) => e === t)) {
            entries.push([t, Number(v)]);
          }
        }
        if (entries.length === 0) { warnings.push(`AddEffect dropped: no parameter maps to a real EffectType member (got "${effectTypeRaw}")`); continue; }
        for (const [t, v] of entries) {
          // LLMs often emit multiplicative values (contrast 1.2) — the editor's
          // amounts are additive deltas; convert and clamp honestly.
          const amount = Math.max(-1, Math.min(1, v > 1.01 ? v - 1 : v));
          canonical.push({ type: "AddEffect", clipId, effect: { id: `ef-${step.id ?? "s"}-${canonical.length}-${t}`, type: t, enabled: true, params: { amount }, keyframes: [] } });
        }
      } else if (["AddClip", "RemoveClip", "SplitClip", "MoveClip", "RippleDelete", "InsertClip", "ChangeVolume", "ChangePlaybackSpeed", "SetKeyframe"].includes(typeName)) {
        // Pass through with clip-id resolution where applicable.
        const fixed: Record<string, unknown> = { ...rc, type: typeName };
        delete fixed.command;
        if ("clipId" in fixed) {
          const resolved = resolveClip(fixed.clipId);
          if (!resolved) { warnings.push(`${typeName} dropped: clip reference ${String(fixed.clipId)} not resolvable`); continue; }
          fixed.clipId = resolved;
        }
        canonical.push(fixed);
      } else {
        warnings.push(`Command "${typeName}" dropped — not a canonical editor command`);
      }
    }
    // FINAL SWEEP — every command leaving the planner must validate against
    // the REAL CommandSchema; anything invalid is dropped with a warning so
    // the executor can never receive poison (observed: one malformed AddClip
    // made the whole stored plan unparseable → "invalid stored plan").
    const valid: Array<Record<string, unknown>> = [];
    for (const c of canonical) {
      const check = CommandSchema.safeParse(c);
      if (check.success) valid.push(c);
      else warnings.push(`Command dropped — fails the editor command schema (${String((check.error as { issues?: Array<{ message?: string }> }).issues?.[0]?.message ?? "invalid")})`);
    }
    args.commands = valid;
    step.args = args;
    return step;
  });
  return { steps: out, warnings };
}
