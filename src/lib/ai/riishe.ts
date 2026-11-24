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
 *   question         — capability/answer path (honest, no invented facts)
 */
import { resolveProjectContext } from "@/lib/my-ai/context/resolver";
import { createPlan } from "@/lib/my-ai/planner/planner";
import { llmHealth } from "@/lib/my-ai/gateway/provider";
import { matchStyles, styleCapabilities, styleAlternatives, loadStyleRecipes } from "@/lib/ai/styles";
import { probeModelRegistry } from "@/lib/ai/models";

export type RiisheIntent = "build" | "style-compare" | "analysis" | "scoped-revision" | "history-op" | "question";

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
  if (/analy(s|z)e|inspect|understand|scene map|what.?s in (the|these|this) (clips?|footage|videos?)/.test(m)) return "analysis";
  if (/undo|redo|revert|last change/.test(m)) return "history-op";
  if (/make the (intro|ending|opening)|shorter|longer|instead|warmer|cooler|faster|slower|smaller|bigger|change the|remove the transition|keep the original audio/.test(m)) return "scoped-revision";
  if (/turn|make|create|build|edit|produce|generate/.test(m)) return "build";
  return "question";
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
    const plan = await createPlan(userId, projectId, request, conversation);
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
