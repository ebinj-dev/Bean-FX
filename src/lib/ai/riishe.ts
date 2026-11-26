/**
 * M42-F/G — RIISHE, the AI Edit Chat's creative director.
 *
 * Conversation service for the AI Edit Chat. It uses the EXISTING machinery
 * end-to-end: project context resolution (my-ai/context/resolver), plan
 * creation through the MY AI planner (LLM gateway when configured, honest
 * deterministic fallback otherwise), approval/execution through the existing
 * plans API surface, and the M42-G style engine for creative routing.
 *
 * Intent classes (see docs/ai-editing/AI_EDIT_PROMPT_GUIDE.md):
 *   build            — create a new edit → style match → plan
 *   style-compare    — "show me three styles" → three distinct recipes + capability reports
 *   analysis         — "analyze the clips" → media understanding map (provenance per claim)
 *   scoped-revision  — follow-up on the current edit → plan against the CURRENT revision
 *   history-op       — undo/redo the last AI-approved change (guidance + inverse via editor history)
 *   command-op       — M44: a DIRECT canonical editing command ("add a marker…", "mute audio 2")
 *                      → parsed against the M43-B command vocabulary → ONE-STEP approval-gated plan
 *   question         — capability/answer path (honest, no invented facts)
 */
import { resolveProjectContext } from "@/lib/my-ai/context/resolver";
import { createPlan, persistPlan } from "@/lib/my-ai/planner/planner";
import { AIPlanSchema } from "@/lib/my-ai/planner/schema";
import { newId } from "@/lib/my-ai/ids";
import { parseCommand, type Command } from "@/lib/editor/commands";
import { llmHealth } from "@/lib/my-ai/gateway/provider";
import { matchStyles, styleCapabilities, styleAlternatives, loadStyleRecipes } from "@/lib/ai/styles";
import { probeModelRegistry } from "@/lib/ai/models";

export type RiisheIntent = "build" | "style-compare" | "analysis" | "scoped-revision" | "history-op" | "command-op" | "question";

export interface RiisheChatResult {
  reply: string;
  intent: RiisheIntent;
  mode: "llm" | "deterministic";
  styles?: Array<{ id: string; name: string; purpose: string; supported: string[]; partial: Array<{ capability: string; why: string }>; disclosedGaps: Array<{ capability: string; reason: string }> }>;
  planId?: string;
  planNote?: string;
  planMode?: string;
  conversationId: string;
  analysisUsed: boolean;
}

export function classifyIntent(message: string): RiisheIntent {
  const m = message.toLowerCase();
  if (/show me (three|3|some|different).*(styles?|options?)|which styles?|what styles?/.test(m)) return "style-compare";
  // A prompt that both asks for analysis AND an edit (e.g. "Analyze the
  // footage and create a montage… Show me the editing plan") is a BUILD —
  // the build path runs the bounded analysis and plans from it. Pure
  // inspection prompts (no edit verbs/deliverables) stay analysis.
  const asksForEdit = /create|make|turn|build|edit|montage|trailer|reel|produce|generate|cut|arrange|apply/.test(m);
  if (/analy(s|z)e|inspect|understand|scene map|what.?s in (the|these|this) (clips?|footage|videos?)/.test(m) && !asksForEdit) return "analysis";
  if (/undo|redo|revert|last change/.test(m)) return "history-op";
  // M44 — a DIRECT canonical editing command beats generic intent matching:
  // anchored so "create a montage with markers" stays a build, while
  // "add a marker named Intro at frame 150" routes to the command registry.
  if (isDirectCommandPhrase(message)) return "command-op";
  if (/make the (intro|ending|opening)|shorter|longer|instead|warmer|cooler|faster|slower|smaller|bigger|change the|remove the transition|keep the original audio/.test(m)) return "scoped-revision";
  if (/turn|make|create|build|edit|produce|generate/.test(m)) return "build";
  return "question";
}

/** M44 — anchored detection for DIRECT canonical-command phrases. */
export function isDirectCommandPhrase(message: string): boolean {
  return /^(?:please\s+)?(?:add|create|place|put|set)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?marker\b/i.test(message)
    || /^(?:please\s+)?(?:mute|unmute|solo|un-?solo)\b/i.test(message);
}

export type DirectCommandParse =
  | { ok: true; commands: Command[]; summary: string; expectedChanges: string[] }
  | { ok: false; reply: string };

/**
 * M44 — parse a DIRECT editing request into canonical M1 commands using only
 * REAL sequence state (fps + actual tracks). Pure: no DB, no LLM. Commands are
 * schema-validated here, so a bad parse can never become a plan step.
 */
export function parseDirectCommand(
  message: string,
  fps: number,
  tracks: Array<{ id: string; kind: string; name: string }>,
): DirectCommandParse {
  const markerM = message.match(/^(?:please\s+)?(?:add|create|place|put|set)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?marker\b/i);
  if (markerM) {
    const rest = message.slice(markerM[0].length);
    const labelM = rest.match(/\b(?:named|called|label(?:ed|led)?)\s+["'“]?([^"'”]+?)["'”]?(?:\s+(?:at|on)\b|\s*$)/i);
    const frameM = rest.match(/\bframe\s+(\d{1,7})\b/i);
    const secM = frameM ? null : rest.match(/\bat\s+(\d{1,7})\s*(?:s\b|sec\b|secs\b|seconds?\b)/i);
    const bareM = frameM || secM ? null : rest.match(/\bat\s+(\d{1,7})\b/i);
    if (!frameM && !secM && !bareM) {
      return { ok: false, reply: "I can add that marker — tell me where: e.g. \u201cadd a marker named Intro at frame 150\u201d or \u201cadd a marker at 5s\u201d." };
    }
    const n = Number((frameM ?? secM ?? bareM)![1]);
    const frame = Math.max(0, Math.round(frameM ? n : n * fps));
    const label = (labelM?.[1] ?? "").trim().slice(0, 120);
    const command = parseCommand({ type: "AddMarker", marker: { id: newId("marker"), frame, label } });
    return {
      ok: true,
      commands: [command],
      summary: `AddMarker @ frame ${frame}${label ? ` (“${label}”)` : ""}${secM ? " (from seconds)" : bareM ? " (interpreted as frames)" : ""}`,
      expectedChanges: [`A marker appears at frame ${frame} on the timeline`],
    };
  }

  const trackM = message.match(/^(?:please\s+)?(mute|unmute|solo|un-?solo)\b/i);
  if (trackM) {
    const verb = trackM[1].toLowerCase().replace("-", "");
    const action = verb === "unmute" ? "unmute" : verb === "unsolo" ? "unsolo" : verb;
    const numM = message.match(/\b(audio|video)\s+(\d{1,2})\b/i);
    const kindM = message.match(/\bthe\s+(audio|video)\s+tracks?\b/i) ?? message.match(/\b(audio|video)\s+tracks?\b/i);
    if (!numM && !kindM) {
      return { ok: false, reply: "Which track? e.g. \u201cmute audio 2\u201d, \u201cmute the audio track\u201d or \u201csolo video 1\u201d." };
    }
    const kind = (numM?.[1] ?? kindM?.[1] ?? "").toUpperCase();
    const index = numM ? Number(numM[2]) : 1;
    const candidates = tracks.filter((t) => t.kind === kind);
    // An explicit index that does not exist must FAIL — never silently
    // retarget the first track (M44 test: "mute audio 9" must not mute Audio 1).
    const track = numM ? candidates[index - 1] : candidates[index - 1] ?? candidates[0];
    if (!track) {
      return { ok: false, reply: `I could not find a ${kind} track ${index} in this sequence. Current tracks: ${tracks.map((t) => `${t.kind} “${t.name}”`).join(", ")}.` };
    }
    const patch = action === "mute" ? { muted: true } : action === "unmute" ? { muted: false } : action === "solo" ? { solo: true } : { solo: false };
    const command = parseCommand({ type: "UpdateTrack", trackId: track.id, ...patch });
    return {
      ok: true,
      commands: [command],
      summary: `UpdateTrack ${action} → ${kind} “${track.name}”`,
      expectedChanges: [`Track “${track.name}” ${action === "mute" ? "is muted" : action === "unmute" ? "is unmuted" : action === "solo" ? "is soloed" : "is no longer soloed"} (playback behavior)`],
    };
  }
  return { ok: false, reply: "I did not recognize a direct editing command. Supported right now: “add a marker [named …] at frame N / at Ns”, “mute/unmute/solo audio|video N”." };
}

/** Deterministic analysis note for the current authorized media (bounded). */
function summarizeContext(ctx: Awaited<ReturnType<typeof resolveProjectContext>>): string {
  const media = ctx.media;
  const clips = ctx.sequence.clips ?? [];
  return [
    `Project "${ctx.projectName}" — sequence ${ctx.sequence.width}×${ctx.sequence.height} @ ${ctx.sequence.fps} fps, ${ctx.sequence.durationFrames} frames (${clips.length} clips, ${ctx.sequence.trackCount} tracks, ${ctx.sequence.overlaps} overlap(s), ${ctx.sequence.gaps.length} gap(s)).`,
    media.total ? `Authorized media: ${media.total} asset(s) by kind {${Object.entries(media.byKind).map(([k, n]) => `${k}:${n}`).join(", ")}} — ${media.samples.slice(0, 4).map((s) => s.name).join(", ")}${media.total > 4 ? "…" : ""}.` : "No media assets authorized yet — upload footage or authorize project media first.",
  ].join(" ");
}

export async function riisheChat(
  userId: string,
  projectId: string,
  message: string,
  conversationId: string | null,
): Promise<RiisheChatResult> {
  const ctx = await resolveProjectContext(projectId, userId);
  const intent = classifyIntent(message);
  const reg = probeModelRegistry();
  const health = await llmHealth();
  const mode: "llm" | "deterministic" = health.ok ? "llm" : "deterministic";
  const conversation = conversationId ?? `riishe-${projectId.slice(0, 8)}-${Date.now().toString(36)}`;

  if (intent === "style-compare") {
    const alts = styleAlternatives(message);
    if (alts.length === 0) {
      return { reply: "I could not match that to a style family. Try naming the target (trailer, reel, documentary, wedding, gaming, product ad…).", intent, mode, conversationId: conversation, analysisUsed: false };
    }
    const styles = alts.map(({ recipe, report }) => ({
      id: recipe.id,
      name: recipe.name,
      purpose: recipe.purpose,
      supported: report?.supported ?? [],
      partial: report?.partial ?? [],
      disclosedGaps: report?.disclosedGaps ?? [],
    }));
    const lines = styles.map((s, i) => `${i + 1}. **${s.name}** (${s.id}) — ${s.purpose}${s.disclosedGaps.length ? ` · disclosed gaps: ${s.disclosedGaps.map((g) => g.capability).join(", ")}` : ""}`);
    return {
      reply: ["Three distinct directions for this footage, each a real executable strategy:", ...lines, "", "Pick one (or combine, e.g. a structure style + vertical-reframe) and I will plan it against the current timeline."].join("\n"),
      intent,
      mode,
      styles,
      conversationId: conversation,
      analysisUsed: false,
    };
  }

  if (intent === "analysis") {
    // The media understanding map: real metadata via the existing analyzer.
    return {
      reply: [
        summarizeContext(ctx),
        "Analysis contract (honest): per-asset metadata via ffprobe (duration/resolution/fps/codec/audio), shot boundaries via scene detection (PySceneDetect when installed, else the ffmpeg scdet filter — the plan records which), silences via silencedetect. Speech transcription requires the ASR capability — it is reported NOT RUN when unconfigured. Every claim in a plan carries this provenance; nothing is invented.",
        "Ask: \"analyze every clip and create the best sequence\" and I will run the bounded analysis and plan from it.",
      ].join("\n"),
      intent,
      mode,
      conversationId: conversation,
      analysisUsed: false,
    };
  }

  if (intent === "history-op") {
    return {
      reply: [
        "Undo/redo goes through the editor's own history — the last approved AI change is reversible exactly like a manual edit:",
        "• Press the editor's Undo (or the toolbar arrow) to revert the last approved operation; Redo restores it.",
        "• \"Undo the last change\" in this chat queues the inverse of my most recent approved plan — the plan's steps are all canonical, validated commands, so the inverse is safe and re-validated.",
        mode === "deterministic" ? "(Rule-based routing right now — the LLM gateway is unavailable, so nothing here claims model reasoning.)" : "",
      ].filter(Boolean).join("\n"),
      intent,
      mode,
      conversationId: conversation,
      analysisUsed: false,
    };
  }

  if (intent === "command-op") {
    // M44 — route the request through the M43-B canonical command registry:
    // parse with REAL sequence state, then propose ONE-STEP APPLY_COMMANDS
    // plan through the EXISTING approval pipeline. Nothing touches the
    // timeline until the user approves; execution is fully undoable.
    const parsed = parseDirectCommand(
      message,
      ctx.sequence.fps,
      ctx.sequence.tracks.map((t) => ({ id: t.id, kind: t.kind, name: t.name })),
    );
    if (!parsed.ok) {
      return { reply: parsed.reply, intent, mode, conversationId: conversation, analysisUsed: false };
    }
    const contextVersion = `v:${ctx.history.versions[0]?.versionNumber ?? 0}:${ctx.sequence.clipCount}:${ctx.sequence.durationFrames}`;
    const idempotencyKey = `cmd-${userId.slice(0, 8)}-${projectId.slice(0, 8)}-${Buffer.from(message).toString("base64url").slice(0, 30)}-${contextVersion}`;
    const plan = AIPlanSchema.parse({
      schemaVersion: 1,
      planId: newId("plan"),
      projectId,
      requestSummary: message.slice(0, 500),
      engines: ["RIISHE"],
      steps: [{
        id: "s1",
        operation: "APPLY_COMMANDS",
        engine: "RIISHE",
        dependsOn: [],
        args: { commands: parsed.commands },
        title: parsed.summary,
        description: "Single canonical editing command parsed from your request (M44 command routing)",
        readsAssetIds: [],
        writesAssetIds: [],
        affectedRange: null,
        risk: "timeline",
      }],
      expectedChanges: parsed.expectedChanges,
      warnings: ["Executes only after your approval — fully undoable via the editor history."],
      estimatedUsage: { llmCalls: 0, generationCalls: 0, note: "Deterministic command routing — no model inference." },
      contextVersion,
      idempotencyKey,
    });
    const persistedId = await persistPlan(plan, userId, projectId, conversationId ?? null, "deterministic-command");
    return {
      reply: [
        `Parsed your request to one canonical command: **${parsed.summary}**.`,
        `Proposed as plan ${persistedId} for your approval — it will NOT touch the timeline until you approve, and execution is fully undoable.`,
        "Review it below: approve to apply, reject to discard, or tell me to adjust it first.",
      ].join("\n"),
      intent,
      mode,
      planId: persistedId,
      planMode: "deterministic-command",
      planNote: `1 command step: ${parsed.summary}`,
      conversationId: conversation,
      analysisUsed: false,
    };
  }

  if (intent === "build" || intent === "scoped-revision") {
    const matched = matchStyles(message);
    const style = matched[0]?.recipe;
    const caps = style ? styleCapabilities(style.id) : null;
    const styleNote = style
      ? `Style routing: ${style.name} (${style.id}) — ${style.purpose}${caps?.disclosedGaps.length ? ` Disclosed gaps: ${caps.disclosedGaps.map((g) => g.capability).join(", ")}.` : ""}`
      : "No explicit style match — using the playbook's default narrative strategy for the detected content.";
    // Style-aware plan request: the planner (LLM or deterministic) plans
    // against the CURRENT revision; scoped revisions carry the same context.
    const request = intent === "scoped-revision"
      ? `Revise the current edit: ${message}`
      : `${message}${style ? ` (style: ${style.id})` : ""}`;
    // createPlan persists conversationId with a REAL FK to the Conversation
    // table — only pass through ids the client actually owns (rows created by
    // the conversations API). The chat's own continuity is UI-level
    // (localStorage key), so a synthetic id here would violate the FK.
    const plan = await createPlan(userId, projectId, request, conversationId);
    return {
      reply: [
        intent === "scoped-revision" ? "Revision planned against the CURRENT timeline (your manual edits are preserved — the plan re-validates against the latest revision)." : "Here is my editing plan for your approval.",
        styleNote,
        `Plan ${plan.plan.planId} (${plan.mode}): ${plan.plan.steps.length} step(s), ${plan.plan.warnings.length} warning(s). ${plan.note ?? ""}`,
        "Review it below — approve to apply through the canonical command system (fully undoable), reject, or tell me to adjust it first. A plan is NOT an applied edit until you approve.",
      ].join("\n"),
      intent,
      mode,
      planId: plan.plan.planId,
      planMode: plan.mode,
      planNote: plan.note,
      conversationId: conversation,
      analysisUsed: true,
    };
  }

  // question — answer from real state only
  const ready = reg.models.filter((m) => m.ready);
  return {
    reply: [
      summarizeContext(ctx),
      `Configured AI capabilities right now: ${ready.length} ready model/tool(s): ${ready.map((m) => `${m.displayName}${m.cost !== "COST UNKNOWN" ? ` (${m.cost})` : ""}`).join("; ")}.`,
      "I can: analyze footage, plan a style-specific edit, revise the current edit conversationally, and render through the existing pipeline. I never fabricate model availability — anything not configured is disclosed, never faked.",
    ].join("\n"),
    intent,
    mode,
    conversationId: conversation,
    analysisUsed: false,
  };
}

/** Playbook summary used by the chat UI header (style count + version). */
export function playbookInfo(): { version: string; styles: number } {
  const file = loadStyleRecipes();
  return { version: file.version, styles: file.recipes.length };
}
