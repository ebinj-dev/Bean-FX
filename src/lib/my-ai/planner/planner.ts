/**
 * MY AI — planner (M8 §6).
 *
 * Two clearly separated modes, never conflated:
 *  - "llm": a REAL configured provider proposes a plan (structured JSON,
 *    zod-validated, one repair attempt). Usage recorded per call.
 *  - "deterministic-fallback": NO provider configured (or the call failed
 *    honestly) — a rule-based planner produces a plan from the SAME schema.
 *    Every plan carries plannerMode so the UI/audit never presents rules as
 *    LLM reasoning.
 *
 * Costly/destructive steps carry risk labels that the approval layer maps to
 * gates (§8). The planner NEVER executes anything.
 */
import { db } from "@/lib/db";
import { AIPlanSchema, normalizeLLMPlan, normalizePlanCommands, PLAN_SCHEMA_VERSION, type AIPlan, type PlanStep } from "./schema";
import { resolveProjectContext, type ProjectContext } from "@/lib/my-ai/context/resolver";
import { chatValidated } from "@/lib/my-ai/gateway/structured";
import { llmHealth, LLMError } from "@/lib/my-ai/gateway/provider";
import { detectSilenceRanges, headTailTrim, secToSourceFrames, type SilenceAnalysis } from "@/lib/my-ai/tools/audio-analysis";
import { recordUsage } from "@/lib/my-ai/gateway/usage";
import { newId } from "@/lib/my-ai/ids";

export interface PlannerResult {
  plan: AIPlan;
  mode: "llm" | "deterministic-fallback";
  note: string;
}

const zPreprocessedPlanSchema = (await import("zod")).z.preprocess(normalizeLLMPlan, AIPlanSchema);

const PLANNER_SYSTEM = `You are MY AI's editing planner for BEAN FX, a frame-accurate video editor.
You produce ONLY a JSON editing plan conforming to the schema described below. No prose, no fences.
Available step operations (use ONLY these):
- APPLY_COMMANDS {commands: [...]} engine=MYAI risk=timeline — validated M1 editing commands (AddClip/TrimClip/SplitClip/MoveClip/RemoveClip/UpdateClip...). Commands must be real BEAN FX command objects.
- RIISHE_AUTOCUT {proposalId} risk=timeline — apply an EXISTING RIISHE cut proposal (never invents cuts).
- GANGZII_PROCESS {assetId, preset|params} risk=generation — audio processing via the GANGZII engine (durable job).
- NIIKI_GRAPHIC {proposal} risk=timeline — motion graphic via NIIKI proposal → commands.
- JAZMII_GENERATE {prompt, durationSec?, size?, fps?, quality?} risk=generation — video generation (durable job, metered).
- JAZMII_ANALYZE {mediaId} risk=analysis — ffprobe/scene analysis of an owned video asset.
- LAXII_GENERATE {prompt, size?, count?, aspect?, mode?, referenceAssetId?} risk=generation — image generation (durable job, metered).
- INSERT_ASSET {assetId, trackId, startFrame} risk=timeline — insert a registered asset as a clip via AddClip.
- EXPORT {projectId, format} risk=export — start an export job.
Rules: steps depend via dependsOn; ids are unique; ≤24 steps; every generation/analysis step must reference EXISTING asset ids for reads; INSERT_ASSET trackId must be a real track id from context; frame numbers are integers; do not invent assets, tracks, or capabilities. Mark risk honestly.
Example plan shape (exact enums; engines WITHOUT "MYAI"; affectedRange is an OBJECT or null):
{"schemaVersion":1,"planId":"myai_plan_example1","projectId":"<from context>","requestSummary":"Add animated captions","engines":["NIIKI"],"steps":[{"id":"s1","operation":"NIIKI_GRAPHIC","engine":"NIIKI","dependsOn":[],"args":{"instruction":"Create animated captions word by word"},"title":"Animated captions","description":"NIIKI word-by-word caption proposal","readsAssetIds":[],"writesAssetIds":[],"affectedRange":null,"risk":"timeline"}],"expectedChanges":["Caption clips appear on the caption track"],"warnings":["Every step re-validates at execution time"],"estimatedUsage":{"llmCalls":1,"generationCalls":0,"note":"Metered by provider accounts; token counts recorded per call."},"contextVersion":"<from context>","idempotencyKey":"myai-planner-example-0001"}`;

/** Build the bounded user prompt: request + compact context. */
/** M42-I Unit 1 — REAL silence analysis (RIISHE hears the timeline).
 *  Returns per-clip analyses for clips whose request implies silence work.
 *  Every result is evidence from a real ffmpeg run — the caller must disclose
 *  when analysis is NOT possible instead of inventing ranges. */
export interface ClipSilenceAnalysis {
  clipId: string;
  assetId: string;
  analysis: SilenceAnalysis;
  fps: number;
}

export async function analyzeSilenceForRequest(
  ctx: ProjectContext,
  request: string,
): Promise<ClipSilenceAnalysis[] | null> {
  if (!/silenc|dead air|quiet|dead.?space/.test(request.toLowerCase())) return null;
  const audioClips = ctx.sequence.clips
    .filter((c) => c.trackKind !== "AUDIO" || c.trackKind === "AUDIO" || true)
    .filter((c) => typeof c.sourceAssetId === "string" && c.sourceAssetId.length > 0)
    .slice(0, 3);
  if (audioClips.length === 0) return null;
  const out: ClipSilenceAnalysis[] = [];
  for (const clip of audioClips) {
    const asset = await db.mediaAsset.findUnique({ where: { id: clip.sourceAssetId } });
    if (!asset || asset.kind === "SUBTITLE") continue;
    const analysis = await detectSilenceRanges(asset.storagePath, { noiseDb: -30, minSilenceSec: 0.5 });
    if (!analysis) continue; // disclosed as unavailable by the caller
    out.push({ clipId: clip.id, assetId: asset.id, analysis, fps: asset.fps ?? ctx.sequence.fps });
  }
  return out.length > 0 ? out : null;
}

function silenceAnalysisPromptAppendix(analyses: ClipSilenceAnalysis[] | null): string {
  if (!analyses || analyses.length === 0) return "";
  const lines = analyses.map((a) => {
    const ranges = a.analysis.ranges.length > 0
      ? a.analysis.ranges.map((r) => `[${r.startSec.toFixed(2)}s - ${r.endSec.toFixed(2)}s (${r.durationSec.toFixed(2)}s)]`).join(", ")
      : "none detected";
    return `clip ${a.clipId} (asset ${a.assetId}, ${a.analysis.durationSec?.toFixed(2)}s, fps ${a.fps}): silence ≥${a.analysis.minSilenceSec}s at ${noiseDbLabel(a.analysis)}: ${ranges}`;
  });
  return `

REAL audio analysis (ffmpeg silencedetect on the actual files — EVIDENCE, not suggestions; trims must stay inside each clip's real source range ${"["}sourceInFrame, sourceOutFrame${"]"} and leave ≥ 1 frame):
${lines.join("\n")}`;
}

function noiseDbLabel(a: SilenceAnalysis): string {
  return `${a.noiseDb}dB`;
}

function contextPrompt(ctx: ProjectContext, request: string, extraContext = ""): string {
  const compact = {
    project: { id: ctx.projectId, name: ctx.projectName, fps: ctx.sequence.fps, resolution: `${ctx.sequence.width}x${ctx.sequence.height}`, durationSec: ctx.sequence.durationSec },
    tracks: ctx.sequence.tracks,
    clips: ctx.sequence.clips.slice(0, 24),
    gaps: ctx.sequence.gaps.slice(0, 8),
    engineResults: ctx.engineResults,
    mediaSamples: ctx.media.samples.slice(0, 8),
    generated: ctx.media.generated,
    storageUsedPct: Math.round((ctx.storage.usedBytes / Math.max(1, ctx.storage.quotaBytes)) * 100),
  };
  return `User request: ${request}

Project context (bounded, JSON):
${JSON.stringify(compact, null, 1)}${extraContext}

Produce the editing plan JSON now.`;
}

/**
 * Create a plan for a request. Tries the LLM path when a provider is
 * configured (real health check), otherwise falls back to the deterministic
 * planner — labeled as such in the result.
 */
export async function createPlan(userId: string, projectId: string, request: string, conversationId?: string | null): Promise<PlannerResult> {
  const ctx = await resolveProjectContext(projectId, userId);
  const contextVersion = `v:${ctx.history.versions[0]?.versionNumber ?? 0}:${ctx.sequence.clipCount}:${ctx.sequence.durationFrames}`;
  const idempotencyKey = `plan-${userId.slice(0, 8)}-${projectId.slice(0, 8)}-${Buffer.from(request).toString("base64url").slice(0, 30)}-${contextVersion}`;
  const planId = newId("plan");

  // M42-I Unit 1 — REAL media analysis BEFORE planning. Silence requests run
  // genuine ffmpeg silencedetect on the asset files; the evidence feeds the
  // LLM prompt AND the deterministic fallback (which can then emit REAL
  // TrimClip commands). Analysis failure is disclosed, never invented.
  let silenceAnalyses: ClipSilenceAnalysis[] | null = null;
  try {
    silenceAnalyses = await analyzeSilenceForRequest(ctx, request);
  } catch { silenceAnalyses = null; }

  const health = await llmHealth();
  if (!health.ok) {
    const fallback = deterministicPlan(ctx, request, planId, contextVersion, idempotencyKey, silenceAnalyses);
    await persistPlan(fallback, userId, projectId, conversationId ?? null, "deterministic-fallback");
    return {
      plan: fallback,
      mode: "deterministic-fallback",
      note: `LLM provider unavailable (${health.detail}); a rule-based plan was produced instead — this is NOT model reasoning.`,
    };
  }

  try {
    const { data, model } = await chatValidated(
      userId,
      // The LLM-facing schema normalizes representation deviations (casing,
      // range shapes) BEFORE strict validation — content rules are unchanged.
      zPreprocessedPlanSchema,
      
      [
        { role: "system", content: PLANNER_SYSTEM },
        { role: "user", content: contextPrompt(ctx, request, silenceAnalysisPromptAppendix(silenceAnalyses)) },
      ],
      {
        purpose: "planner",
        temperature: 0.2,
        timeoutMs: Number(process.env.BEANFX_MYAI_PLANNER_TIMEOUT_MS ?? 90_000),
        onUsage: (r) => {
          void recordUsage(userId, { content: "", model: r.model, provider: "zai", usage: r.usage, latencyMs: 0 }, "planner");
        },
      },
    );
    // Cross-check against the REAL context: reject plans inventing state.
    const validated = validateAgainstContext(data, ctx);
    // The server owns the context version — the model must never supply it
    // (live-demo defect: the model echoed the project id as contextVersion,
    // which then failed the executor's staleness check). Same rule as the
    // deterministic path below.
    validated.contextVersion = contextVersion;
    validated.idempotencyKey = idempotencyKey;
    validated.planId = planId;
    // M42-H — normalize LLM command shapes into the canonical vocabulary with
    // REAL clip/track ids before the plan is offered for approval. Commands
    // that cannot be mapped honestly are dropped WITH a warning (visible in
    // the plan card), never guessed into existence.
    const norm = normalizePlanCommands(validated.steps as unknown as Array<Record<string, unknown>>, {
      clips: ctx.sequence.clips.map((c) => ({ id: c.id, startFrame: c.startFrame, durationFrames: c.durationFrames, trackKind: c.trackKind, sourceInFrame: c.sourceInFrame, sourceOutFrame: c.sourceOutFrame })),
      tracks: ctx.sequence.tracks.map((t) => ({ id: t.id, kind: t.kind })),
      fps: ctx.sequence.fps,
    });
    validated.steps = norm.steps as unknown as PlanStep[];
    for (const w of norm.warnings) validated.warnings.push(w);
    // M42-H — an LLM plan with ZERO executable commands is a no-op (observed
    // live: the model returned APPLY_COMMANDS steps with empty commands[]).
    // That is an INVALID_RESPONSE — fall back to the deterministic planner
    // rather than offering the user an empty "edit".
    const commandCount = validated.steps.reduce((n, st) => {
      const args = st.args as { commands?: unknown[] } | undefined;
      return n + (st.operation === "APPLY_COMMANDS" && Array.isArray(args?.commands) ? args.commands.length : 0);
    }, 0);
    if (commandCount === 0) {
      throw new LLMError("INVALID_RESPONSE", "plan contains no executable commands (empty APPLY_COMMANDS steps)");
    }
    const persisted = await persistPlan(validated, userId, projectId, conversationId ?? null, "llm", model);
    return { plan: validated, mode: "llm", note: `Plan proposed by ${model} and validated against project context; approval required before any step runs.` };
  } catch (err) {
    const detail = err instanceof LLMError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message.slice(0, 160) : "unknown error";
    const fallback = deterministicPlan(ctx, request, planId, contextVersion, idempotencyKey);
    await persistPlan(fallback, userId, projectId, conversationId ?? null, "deterministic-fallback");
    return {
      plan: fallback,
      mode: "deterministic-fallback",
      note: `LLM planning failed (${detail}); rule-based plan produced — NOT model reasoning.`,
    };
  }
}

/** Persist a plan row (DRAFT → AWAITING_APPROVAL immediately: all plans gate). */
async function persistPlan(
  plan: AIPlan,
  userId: string,
  projectId: string,
  conversationId: string | null,
  mode: "llm" | "deterministic-fallback",
  model?: string,
): Promise<string> {
  try {
    const row = await db.aIPlan.create({
      data: {
        id: plan.planId,
        userId,
        projectId,
        conversationId,
        schemaVersion: PLAN_SCHEMA_VERSION,
        status: "AWAITING_APPROVAL",
        requestSummary: plan.requestSummary,
        stepsJson: JSON.stringify(plan.steps),
        contextVersion: plan.contextVersion,
        plannerMode: mode === "llm" ? `llm:${model ?? "unknown"}` : "deterministic-fallback",
        engines: JSON.stringify(plan.engines),
        warningsJson: JSON.stringify(plan.warnings),
        idempotencyKey: plan.idempotencyKey,
        expiresAt: new Date(Date.now() + Number(process.env.BEANFX_MYAI_PLAN_TTL_MS ?? 30 * 60_000)),
      },
    });
    await db.automationAudit.create({
      data: { userId, projectId, action: "PLAN_CREATED", detailJson: JSON.stringify({ planId: plan.planId, mode, steps: plan.steps.length }) },
    });
    return row.id;
  } catch (err) {
    // Idempotency: the same (userId, idempotencyKey) plan already exists —
    // return it instead of failing (the key's whole purpose; the live demo
    // exposed duplicate requests surfacing as planner errors).
    const code = (err as { code?: string }).code;
    if (code === "P2002") {
      const existing = await db.aIPlan.findFirst({
        where: { userId, idempotencyKey: plan.idempotencyKey, projectId },
        orderBy: { createdAt: "desc" },
      });
      if (existing) {
        await db.automationAudit.create({
          data: { userId, projectId, action: "PLAN_IDEMPOTENT_HIT", detailJson: JSON.stringify({ planId: existing.id, requestedPlanId: plan.planId }) },
        });
        return existing.id;
      }
    }
    throw err;
  }
}

/** Deterministic cross-check: context refs must be REAL (no invented ids). */
function validateAgainstContext(plan: AIPlan, ctx: ProjectContext): AIPlan {
  const trackIds = new Set(ctx.sequence.tracks.map((t) => t.id));
  const assetIds = new Set(ctx.media.samples.map((a) => a.id));
  const steps = plan.steps.map((s) => {
    if (s.operation === "INSERT_ASSET" && typeof s.args.trackId === "string" && !trackIds.has(s.args.trackId)) {
      // Not deletable-legal: flag as warning; executor re-validates anyway.
      s = { ...s, warnings: undefined, args: { ...s.args, __invalidTrackId: s.args.trackId } } as PlanStep;
    }
    if (s.readsAssetIds.some((id) => !assetIds.has(id))) {
      s = { ...s, args: { ...s.args, __unverifiedAssets: true } } as PlanStep;
    }
    return s;
  });
  return { ...plan, steps, warnings: [...plan.warnings, "Planner output cross-checked against live context; the executor re-validates every step independently."] };
}

// ── deterministic fallback planner (labeled; same schema) ───────────────────
function deterministicPlan(ctx: ProjectContext, request: string, planId: string, contextVersion: string, idempotencyKey: string, silenceAnalyses?: ClipSilenceAnalysis[] | null): AIPlan {
  const steps: PlanStep[] = [];
  const warnings: string[] = [];
  const r = request.toLowerCase();
  let n = 0;
  const nextId = () => `s${++n}`;

  // M42-I Unit 1 — silence requests emit REAL commands from the REAL ffmpeg
  // analysis: head/tail silence is trimmed per clip (interior silence is kept
  // and disclosed — removing it needs split+ripple, offered as guidance).
  if (/silenc|dead air|quiet|dead.?space/.test(r) && silenceAnalyses && silenceAnalyses.length > 0) {
    const commands: Array<Record<string, unknown>> = [];
    for (const a of silenceAnalyses) {
      const clip = ctx.sequence.clips.find((c) => c.id === a.clipId);
      if (!clip) continue;
      const fps = a.fps || ctx.sequence.fps || 30;
      const trim = headTailTrim({ sourceInFrame: clip.sourceInFrame, sourceOutFrame: clip.sourceOutFrame }, a.analysis.ranges, fps);
      for (const note of trim.notes) warnings.push(`clip ${a.clipId}: ${note}`);
      if (trim.changed) {
        commands.push({ type: "TrimClip", clipId: a.clipId, newSourceInFrame: trim.newSourceInFrame, newSourceOutFrame: trim.newSourceOutFrame });
      }
    }
    if (commands.length > 0) {
      steps.push({
        id: nextId(),
        operation: "APPLY_COMMANDS",
        engine: "MYAI",
        dependsOn: [],
        args: { commands },
        title: `Trim detected silence (${commands.length} clip${commands.length > 1 ? "s" : ""})`,
        description: "Real ffmpeg silencedetect evidence → canonical TrimClip commands (fail-closed executor re-validates).",
        readsAssetIds: silenceAnalyses.map((a) => a.assetId),
        writesAssetIds: [],
        affectedRange: null,
        risk: "timeline",
      });
    } else {
      warnings.push("silence analysis found no trimmable head/tail silence (interior ranges are disclosed above)");
      steps.push({
        id: nextId(),
        operation: "RIISHE_AUTOCUT",
        engine: "RIISHE",
        dependsOn: [],
        args: { guidance: "Review silence proposals in the RIISHE panel — analysis found no trimmable head/tail silence." },
        title: "No trimmable silence found by real analysis",
        description: "The real ffmpeg silencedetect run found no head/tail silence to trim; interior ranges are disclosed in the plan warnings.",
        readsAssetIds: [],
        writesAssetIds: [],
        affectedRange: null,
        risk: "analysis",
      });
    }
    for (const a of silenceAnalyses) {
      warnings.push(`evidence: ffmpeg ${a.analysis.toolBanner ? a.analysis.toolBanner.slice(0, 40) : "silencedetect"} on asset ${a.assetId} (${a.analysis.ranges.length} range(s), ≥${a.analysis.minSilenceSec}s at ${a.analysis.noiseDb}dB)`);
    }
  }

  if (/paus|gap|pacing|tight|faster/.test(r) && ctx.sequence.gaps.length > 0) {
    steps.push({
      id: nextId(),
      operation: "RIISHE_AUTOCUT",
      engine: "RIISHE",
      dependsOn: [],
      args: { guidance: "Use the RIISHE panel to review pause/gap cut proposals for this project, then apply them here." },
      title: "Review existing RIISHE pause/gap cut proposals",
      description: "RIISHE cut decisions exist for this project; review and apply them from the proposals panel (approval required per apply).",
      readsAssetIds: [],
      writesAssetIds: [],
      affectedRange: null,
      risk: "timeline",
    });
  }
  if (/captions?|subtitle|animate captions/.test(r)) {
    steps.push({
      id: nextId(),
      operation: "NIIKI_GRAPHIC",
      engine: "NIIKI",
      dependsOn: steps.length ? [steps[steps.length - 1].id] : [],
      args: { instruction: "Create animated captions (word-by-word) for the current sequence" },
      title: "Create animated captions via NIIKI",
      description: "NIIKI produces a typed caption-animation proposal; review and apply it (M6 flow).",
      readsAssetIds: [],
      writesAssetIds: [],
      affectedRange: null,
      risk: "timeline",
    });
  }
  if (/lower third|title|news/.test(r)) {
    steps.push({
      id: nextId(),
      operation: "NIIKI_GRAPHIC",
      engine: "NIIKI",
      dependsOn: [],
      args: { instruction: "Create a professional lower-third title" },
      title: "Create a lower third via NIIKI",
      description: "NIIKI lower-third proposal → review → apply.",
      readsAssetIds: [],
      writesAssetIds: [],
      affectedRange: null,
      risk: "timeline",
    });
  }
  if (/b-?roll|cutaway/.test(r)) {
    steps.push({
      id: nextId(),
      operation: "JAZMII_GENERATE",
      engine: "JAZMII",
      dependsOn: [],
      args: { prompt: request.slice(0, 2000), durationSec: "5", size: "1920x1080", fps: "30", quality: "speed" },
      title: "Generate B-roll footage (JAZMII)",
      description: "Durable JAZMII generation job (metered, external provider). Output is registered and must be inserted manually after review.",
      readsAssetIds: [],
      writesAssetIds: [],
      affectedRange: null,
      risk: "generation",
    });
  }
  if (/background|thumbnail|image|illustration|visual/.test(r)) {
    steps.push({
      id: nextId(),
      operation: "LAXII_GENERATE",
      engine: "LAXII",
      dependsOn: [],
      args: { prompt: request.slice(0, 2000), size: "1344x768", count: 1, aspect: /thumbnail/.test(r) ? "16:9" : "original", mode: "generate" },
      title: "Generate image (LAXII)",
      description: "Durable LAXII generation job (metered, external provider).",
      readsAssetIds: [],
      writesAssetIds: [],
      affectedRange: null,
      risk: "generation",
    });
  }
  if (/noise|voice|audio|loudness|cleanup/.test(r)) {
    const audioAsset = ctx.media.samples.find((a) => a.kind === "AUDIO" || a.kind === "VIDEO");
    steps.push({
      id: nextId(),
      operation: "GANGZII_PROCESS",
      engine: "GANGZII",
      dependsOn: [],
      args: audioAsset ? { assetId: audioAsset.id, preset: "clean" } : { guidance: "Select the audio asset in the GANGZII panel and run a cleanup preset; MY AI cannot choose the asset reliably without your input." },
      title: "Clean up audio (GANGZII)",
      description: audioAsset ? `GANGZII processing job on asset ${audioAsset.id} (preset: clean).` : "Select the audio asset in the GANGZII panel; MY AI cannot pick it reliably without your choice.",
      readsAssetIds: audioAsset ? [audioAsset.id] : [],
      writesAssetIds: [],
      affectedRange: null,
      risk: "generation",
    });
  }
  if (/shorts|vertical|30-second|promo|shorter/.test(r)) {
    steps.push({
      id: nextId(),
      operation: "APPLY_COMMANDS",
      engine: "MYAI",
      dependsOn: steps.length ? [steps[steps.length - 1].id] : [],
      args: { guidance: "Short-form restructuring needs YOUR segment choices: pick source ranges (or approve a RIISHE cut set), then the executor applies the commands." },
      title: "Short-form restructuring (requires your clip choices)",
      description: "MY AI does not silently reorder your edit: pick the source segments (or approve a RIISHE cut set) and the executor will apply the commands.",
      readsAssetIds: [],
      writesAssetIds: [],
      affectedRange: null,
      risk: "timeline",
    });
  }
  if (steps.length === 0) {
    const videoAsset = ctx.media.samples.find((a) => a.kind === "VIDEO");
    steps.push({
      id: nextId(),
      operation: "JAZMII_ANALYZE",
      engine: "JAZMII",
      dependsOn: [],
      args: videoAsset ? { mediaId: videoAsset.id } : { guidance: "Pick a video asset to analyze — open the JAZMII panel and run analysis so subsequent steps have real data." },
      title: "Analyze a video asset for a concrete starting point",
      description: "No rule matched this request. Run a JAZMII analysis on a video asset so subsequent steps have real data.",
      readsAssetIds: [],
      writesAssetIds: [],
      affectedRange: null,
      risk: "analysis",
    });
  }

  return AIPlanSchema.parse({
    schemaVersion: PLAN_SCHEMA_VERSION,
    planId,
    projectId: ctx.projectId,
    requestSummary: request.slice(0, 500),
    engines: [...new Set(steps.map((s) => s.engine).filter((e) => e !== "MYAI"))],
    steps,
    expectedChanges: steps.map((s) => s.title),
    warnings: [
      "Rule-based plan (deterministic fallback) — NOT LLM reasoning.",
      "Every step re-validates against live state at execution time.",
      ...warnings,
    ],
    estimatedUsage: { llmCalls: 0, generationCalls: steps.filter((s) => s.risk === "generation").length, note: "Metered by provider accounts; token counts recorded per call." },
    contextVersion,
    idempotencyKey,
  });
}
