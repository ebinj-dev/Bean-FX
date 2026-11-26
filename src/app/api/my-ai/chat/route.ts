/**
 * MY AI conversation — POST /api/my-ai/chat (M8 §10).
 *
 * One round trip: resolve bounded project context → (LLM or deterministic
 * answer) → persist both messages → return the response with its provenance
 * clearly labeled ("llm:<model>" vs "deterministic"). The LLM receives ONLY
 * the request text + bounded structured context — never media.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { assertWithinLimit, PlanLimitError, planLimitResponse } from "@/lib/billing/entitlements";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, notFound, unauthorized } from "@/lib/process-helpers";
import { resolveProjectContext } from "@/lib/my-ai/context/resolver";
import { createPlan } from "@/lib/my-ai/planner/planner";
import { llmHealth, llmProvider, LLMError } from "@/lib/my-ai/gateway/provider";
import { recordUsage } from "@/lib/my-ai/gateway/usage";

const Schema = z.object({
  projectId: z.string().max(64).nullable().default(null),
  conversationId: z.string().max(64).nullable().default(null),
  message: z.string().min(1).max(2000),
});

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  // M25 P2 — plan entitlement: monthly AI call budget (server-side).
  try {
    await assertWithinLimit(user.id, "monthlyAiCalls");
  } catch (err) {
    if (err instanceof PlanLimitError) {
      const { body: limitBody, status } = planLimitResponse(err);
      return NextResponse.json(limitBody, { status });
    }
    throw err;
  }
  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("Invalid chat payload.");

  const { projectId, conversationId } = parsed.data;
  let ctxSummary: string | null = null;
  if (projectId) {
    const owned = await db.project.findFirst({ where: { id: projectId, userId: user.id } });
    if (!owned) return notFound();
    const ctx = await resolveProjectContext(projectId, user.id);
    ctxSummary = JSON.stringify({
      project: ctx.projectName,
      fps: ctx.sequence.fps,
      resolution: `${ctx.sequence.width}x${ctx.sequence.height}`,
      durationSec: ctx.sequence.durationSec,
      tracks: ctx.sequence.tracks.map((t) => `${t.kind}:${t.name}(${t.clipCount} clips${t.locked ? ", locked" : ""})`),
      gaps: ctx.sequence.gaps.slice(0, 5),
      captions: ctx.engineResults.riishe.captionsPresent,
      gangzii: ctx.engineResults.gangzii.latestStatus,
      generated: ctx.media.generated,
      boundedNote: ctx.boundedNote,
    });
  }

  // Conversation (create if needed; user-owned, project-scoped).
  let convoId = conversationId;
  if (convoId) {
    const convo = await db.conversation.findFirst({ where: { id: convoId, userId: user.id } });
    if (!convo) return badRequest("Conversation not found or not owned.");
  } else {
    const convo = await db.conversation.create({
      data: { userId: user.id, projectId, title: parsed.data.message.slice(0, 60) },
    });
    convoId = convo.id;
  }
  await db.conversationMessage.create({
    data: { conversationId: convoId, role: "user", content: parsed.data.message, metaJson: ctxSummary ? JSON.stringify({ contextProvided: true }) : null },
  });

  // M44 — chat → structured plan loop. Detection is DETERMINISTIC so a
  // structured editing plan is reliably proposed regardless of what the LLM
  // emits in prose. Plans are created through the EXISTING planner
  // (createPlan) and ride the existing approval/execution surface.
  const planRequest = await resolvePlanRequest(user.id, convoId, parsed.data.message, projectId);

  const health = await llmHealth();
  if (!health.ok) {
    // Honest deterministic assistant answer (no provider): route to panels/plans.
    const text = deterministicAnswer(parsed.data.message, Boolean(projectId), health.detail);
    const attached = planRequest ? await attachPlan(user.id, projectId!, planRequest, convoId, text) : null;
    const reply = attached ? `${text}\n\n${attached.replyNote}` : text;
    await db.conversationMessage.create({ data: { conversationId: convoId, role: "assistant", content: reply, metaJson: JSON.stringify({ mode: "deterministic", planId: attached?.planId ?? null }) } });
    return NextResponse.json({ conversationId: convoId, reply, mode: "deterministic", providerDetail: health.detail, ...(attached?.summary ? { plan: attached.summary } : {}) });
  }

  try {
    const provider = llmProvider();
    const system = `You are MY AI, the editing assistant inside BEAN FX, a frame-accurate professional video editor with five engines:
RIISHE (transcription, captions, auto-cut), GANGZII (audio analysis/cleanup/loudness), NIIKI (motion graphics, animated captions, titles), JAZMII (AI video generation + shot analysis), LAXII (AI image generation, backgrounds, thumbnails).
Answer concisely (≤180 words), concrete and practical. When the user asks for an edit, describe WHICH engines and steps fit and offer to create an approval-gated plan (a plan is required before anything runs). Never invent capabilities; if something is unsupported (e.g. color grading tools, transparency in AI images), say so plainly. Private media never leaves the deployment; only this text and the bounded project summary below are visible to you.`;
    const messages = [
      { role: "system" as const, content: system },
      ...(ctxSummary ? [{ role: "system" as const, content: `Current project context (bounded): ${ctxSummary}` }] : []),
      { role: "user" as const, content: parsed.data.message },
    ];
    const res = await provider.chat(messages, { purpose: "chat", timeoutMs: 60_000, temperature: 0.4 });
    await recordUsage(user.id, res, "chat");
    const reply = `${res.content}\n\n— mode: LLM (${res.model}); tokens: ${res.usage?.totalTokens ?? "n/a"}`;
    const attached = planRequest ? await attachPlan(user.id, projectId!, planRequest, convoId, reply) : null;
    const finalReply = attached ? `${reply}\n\n${attached.replyNote}` : reply;
    await db.conversationMessage.create({ data: { conversationId: convoId, role: "assistant", content: finalReply, metaJson: JSON.stringify({ mode: "llm", model: res.model, usage: res.usage, planId: attached?.planId ?? null }) } });
    return NextResponse.json({ conversationId: convoId, reply: finalReply, mode: "llm", model: res.model, usage: res.usage, ...(attached?.summary ? { plan: attached.summary } : {}) });
  } catch (err) {
    const detail = err instanceof LLMError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message.slice(0, 160) : "unknown";
    const text = deterministicAnswer(parsed.data.message, Boolean(projectId), detail);
    const attached = planRequest ? await attachPlan(user.id, projectId!, planRequest, convoId, text) : null;
    const finalReply = attached ? `${text}\n\n${attached.replyNote}` : text;
    await db.conversationMessage.create({ data: { conversationId: convoId, role: "assistant", content: finalReply, metaJson: JSON.stringify({ mode: "deterministic", reason: detail, planId: attached?.planId ?? null }) } });
    return NextResponse.json({ conversationId: convoId, reply: finalReply, mode: "deterministic", providerDetail: detail, ...(attached?.summary ? { plan: attached.summary } : {}) });
  }
}

/** M44 — decide whether this chat turn should produce a structured plan. */
const PLAN_REQUEST_RE = /\b(?:create|make|build|draft|propose|generate)\b[^.?!]{0,40}\bplan\b/i;
const PLAN_CONFIRM_RE = /^(?:yes|yeah|yep|ok(?:ay)?|sure|please|go ahead|proceed|do it|confirm)\b/i;
const EDIT_REQUEST_RE = /\b(?:edit|cut|trim|split|caption|subtitle|b-?roll|thumbnail|montage|reel|trailer|music|audio|volume|marker|transition|title|pacing|tighten|shorten|silence|remove|intro|ending)\b/i;
const IMPERATIVE_EDIT_RE = /^(?:please\s+)?(?:create|make|build|generate|add|produce|turn|edit|cut|remove|tighten)\b/i;

async function resolvePlanRequest(userId: string, conversationId: string, message: string, projectId: string | null): Promise<string | null> {
  if (!projectId) return null;
  if (PLAN_REQUEST_RE.test(message)) return message;
  if (IMPERATIVE_EDIT_RE.test(message) && EDIT_REQUEST_RE.test(message)) return message;
  if (PLAN_CONFIRM_RE.test(message)) {
    // A confirmation ("yes, create the plan") refers to the most recent edit
    // request in this conversation — find it instead of planning from "yes".
    const recent = await db.conversationMessage.findMany({
      where: { conversationId, role: "user" },
      orderBy: { createdAt: "desc" },
      take: 12,
    });
    // The current message was already persisted — skip it.
    const prior = recent.filter((row) => row.content !== message);
    const editRequest = prior.find((row) => EDIT_REQUEST_RE.test(row.content) && !PLAN_CONFIRM_RE.test(row.content.trim()));
    return editRequest?.content.slice(0, 500) ?? null;
  }
  return null;
}

interface AttachedPlan {
  planId: string | null;
  replyNote: string;
  summary: {
    planId: string;
    mode: string;
    note: string;
    engines?: string[];
    steps?: { id: string; operation: string; title: string; risk: string; description: string }[];
    status?: string;
    warnings?: string[];
  } | null;
}

async function attachPlan(userId: string, projectId: string, request: string, conversationId: string, _replySoFar: string): Promise<AttachedPlan | null> {
  try {
    const plan = await createPlan(userId, projectId, request, conversationId);
    return {
      planId: plan.plan.planId,
      replyNote: `📋 Structured plan **${plan.plan.planId}** created (${plan.plan.steps.length} step(s), mode ${plan.mode}). Review it below — approve to apply through the canonical command system (fully undoable), reject to discard, or tell me to adjust it first. A plan is NOT an applied edit until you approve.`,
      summary: {
        planId: plan.plan.planId,
        mode: plan.mode,
        note: plan.note,
        engines: plan.plan.engines,
        steps: plan.plan.steps.map((s) => ({ id: s.id, operation: s.operation, title: s.title, risk: s.risk, description: s.description })),
        status: "AWAITING_APPROVAL",
        warnings: plan.plan.warnings,
      },
    };
  } catch (err) {
    // Honest failure — never pretend a plan exists (summary omitted so the
    // client never receives an actionable plan row for a failed creation).
    return {
      planId: null,
      replyNote: `⚠️ I tried to create a structured plan but it failed honestly: ${err instanceof Error ? err.message.slice(0, 160) : "unknown error"}. Use the PLAN button with a concrete request to retry.`,
      summary: null,
    };
  }
}

function deterministicAnswer(message: string, hasProject: boolean, providerDetail: string): string {
  const r = message.toLowerCase();
  const parts: string[] = [];
  parts.push(`No LLM provider available right now (${providerDetail}) — this is the rule-based assistant, not model reasoning.`);
  if (/pause|gap|pacing|tight/.test(r)) parts.push("For pacing: open the RIISHE panel, review the pause/gap cut proposals, and apply the ones you approve (M4 flow).");
  if (/caption|subtitle/.test(r)) parts.push("For captions: RIISHE transcribes and creates caption clips; NIIKI can animate them word-by-word (M6 proposal).");
  if (/b-?roll|cutaway|footage/.test(r)) parts.push("For B-roll: use the JAZMII panel — suggestions come from your captions/labels, then approve a generation (metered).");
  if (/background|thumbnail|image/.test(r)) parts.push("For images: the LAXII panel generates backgrounds/thumbnails (metered; no transparency or negative prompts).");
  if (/noise|voice|loud|audio/.test(r)) parts.push("For audio: GANGZII presets (clean, loudness…) run as durable jobs on your selected asset.");
  if (/shorts|vertical/.test(r)) parts.push("For short-form: create a 9:16 sequence via version restore flows and re-edit — MY AI does not silently restructure your timeline.");
  if (parts.length === 1) parts.push(hasProject ? "Describe the edit you want (cuts, captions, B-roll, thumbnails, audio cleanup) and I will map it to the right engine and an approval-gated plan." : "Open a project first — context-aware assistance needs it.");
  return parts.join(" ");
}
