/**
 * M10 — Creator Assistant (§8): project-aware conversational routing on the
 * EXISTING MY AI architecture. One turn:
 *   1. resolve the project + measured context (ownership enforced upstream);
 *   2. classify the request via a typed LLM decision (provider seam);
 *   3. route to the matching capability — reusing a FRESH review when one
 *      exists (same contextVersion), running a deterministic analysis inline
 *      for quick questions, or enqueueing a durable CREATIVE_REVIEW job;
 *   4. persist the exchange on the existing Conversation models;
 *   5. report ACTUAL results/queued jobs — never claim completion early.
 * No Ollama; provider failure = honest error, never a canned fake answer.
 */
import { db } from "@/lib/db";
import { getTimelineHead } from "@/lib/editor/persistence";
import { buildMeasuredContext, type MeasuredContext } from "./context";
import { analyzeRetention, RETENTION_DISCLAIMER } from "./retention";
import { decideAssistantIntent, type LlmOptions } from "./brief";
import { buildRecommendations, persistRecommendations } from "./recommendations";
import { contextVersionOf, type AssistantDecision } from "./contracts";
import type { AssistantIntentId } from "./contracts";

export interface AssistantTurnResult {
  intent: AssistantIntentId;
  reply: string;
  reviewId: string | null;
  reviewQueuedJobId: string | null;
  recommendationsCreated: number;
  usedFreshReview: boolean;
  decision: AssistantDecision;
}

async function findOrCreateConversation(userId: string, projectId: string): Promise<string> {
  const existing = await db.conversation.findFirst({ where: { userId, projectId }, orderBy: { updatedAt: "desc" } });
  if (existing) return existing.id;
  const created = await db.conversation.create({ data: { userId, projectId, title: "Creative Director" } });
  return created.id;
}

/** The latest COMPLETED review whose contextVersion still matches the head. */
export async function findFreshReview(userId: string, projectId: string): Promise<{ id: string; contextVersion: string } | null> {
  const head = await getTimelineHead(projectId, userId);
  const seq = head.sequence;
  const current = contextVersionOf(head.version, seq.clips.length, seq.clips.reduce((m, c) => Math.max(m, c.timelineStartFrame + c.timelineDurationFrames), 0));
  const review = await db.creativeReview.findFirst({
    where: { userId, projectId, status: "COMPLETED", contextVersion: current },
    orderBy: { updatedAt: "desc" },
  });
  return review ? { id: review.id, contextVersion: current } : null;
}

/** Enqueue a durable CREATIVE_REVIEW job (the API uses the same helper). */
export async function enqueueReview(userId: string, projectId: string, scope: "full" | "retention" | "scorecard" | "brief", language: "en" | "ta"): Promise<{ reviewId: string; jobId: string }> {
  const head = await getTimelineHead(projectId, userId);
  const seq = head.sequence;
  const contextVersion = contextVersionOf(head.version, seq.clips.length, seq.clips.reduce((m, c) => Math.max(m, c.timelineStartFrame + c.timelineDurationFrames), 0));
  const review = await db.creativeReview.create({
    data: { userId, projectId, scope, language, status: "QUEUED", stage: "Queued", contextVersion, headVersion: head.version },
  });
  const { JOB_TYPE_CREATIVE_REVIEW } = await import("@/lib/job-helpers");
  const jobId = await import("@/lib/job-helpers").then((h) => h.enqueueMediaJob(userId, JOB_TYPE_CREATIVE_REVIEW, { reviewId: review.id }, { timeoutSec: 30 * 60 }));
  await db.creativeReview.update({ where: { id: review.id }, data: { jobId } });
  return { reviewId: review.id, jobId };
}

function summarizeFindings(ctx: MeasuredContext, findings: ReturnType<typeof analyzeRetention>["findings"]): string {
  const top = findings.filter((f) => f.severity !== "info").slice(0, 4);
  const lines = top.length
    ? top.map((f) => `• [${f.severity}/${f.evidenceLabel}] ${f.category}${f.startSec !== null ? ` @ ${f.startSec.toFixed(1)}s` : ""}: ${f.explanation.slice(0, 140)}`)
    : ["• No moderate/major findings — the measured evidence is clean at current thresholds."];
  const missing = ctx.missingEvidence.length ? `\nNot inspected: ${ctx.missingEvidence.slice(0, 3).join(" ")}` : "";
  return `${lines.join("\n")}${missing}\n\n${RETENTION_DISCLAIMER}`;
}

/** Run one assistant turn. Throws honest errors (provider failures etc.). */
export async function runAssistantTurn(userId: string, projectId: string, message: string, language: "en" | "ta", opts: LlmOptions & { enqueueEvidence?: boolean } = {}): Promise<AssistantTurnResult> {
  const conversationId = await findOrCreateConversation(userId, projectId);
  await db.conversationMessage.create({ data: { conversationId, role: "user", content: message.slice(0, 4000) } });

  const ctx = await buildMeasuredContext(userId, projectId, { enqueueEvidence: false });
  const decision = await decideAssistantIntent(message, ctx, language, opts);

  let reply = decision.reply ?? "";
  let reviewId: string | null = null;
  let reviewQueuedJobId: string | null = null;
  let recommendationsCreated = 0;
  let usedFreshReview = false;

  const INTENTS_NEEDING_EVIDENCE: AssistantIntentId[] = ["review-project", "improve-opening", "find-pauses", "improve-captions", "suggest-broll", "strengthen-ending", "show-improvements", "prepare-export"];

  if (INTENTS_NEEDING_EVIDENCE.includes(decision.intent)) {
    const fresh = await findFreshReview(userId, projectId);
    if (fresh) {
      reviewId = fresh.id;
      usedFreshReview = true;
      const findings = await db.creativeFinding.findMany({ where: { reviewId: fresh.id }, orderBy: { findingNo: "asc" } });
      const recs = await db.creativeRecommendation.findMany({ where: { reviewId: fresh.id, status: "PROPOSED" }, orderBy: { recNo: "asc" } });
      const top = findings.filter((f) => f.severity === "major" || f.severity === "moderate").slice(0, 4);
      reply =
        reply ||
        [
          `Using the fresh review (${fresh.contextVersion}) — ${findings.length} findings, ${recs.length} open recommendation(s).`,
          top.length ? top.map((f) => `• [${f.severity}] ${f.category}: ${f.explanation.slice(0, 120)}`).join("\n") : "• No moderate/major findings in the fresh review.",
          recs.length ? `${recs.length} recommendation(s) await your approval in Smart Recommendations.` : "",
        ]
          .filter(Boolean)
          .join("\n");
    } else {
      // Deterministic inline analysis for immediate value; a durable full
      // review is offered/queued for the deeper interpretive pass.
      const enriched = decision.scope === "full" || decision.intent === "review-project" ? await buildMeasuredContext(userId, projectId, { enqueueEvidence: Boolean(opts.enqueueEvidence) }) : ctx;
      const { findings } = analyzeRetention(enriched);
      if (decision.intent !== "review-project") {
        const recs = buildRecommendations(enriched, findings);
        const scope = decision.scope ?? "retention";
        const head2 = await getTimelineHead(projectId, userId);
        const seq2 = head2.sequence;
        const cv = contextVersionOf(head2.version, seq2.clips.length, seq2.clips.reduce((m, c) => Math.max(m, c.timelineStartFrame + c.timelineDurationFrames), 0));
        const review = await db.creativeReview.create({
          data: {
            userId,
            projectId,
            scope: scope === "full" ? "retention" : scope,
            language,
            status: "COMPLETED",
            stage: "Deterministic analysis (assistant)",
            contextVersion: cv,
            headVersion: head2.version,
            provider: null,
            model: null,
            missingEvidenceJson: JSON.stringify(enriched.missingEvidence),
            evidenceSourcesJson: JSON.stringify(enriched.evidenceSources),
          },
        });
        reviewId = review.id;
        let n = 0;
        for (const f of findings) {
          n += 1;
          await db.creativeFinding.create({
            data: {
              reviewId: review.id,
              findingNo: f.findingNo,
              category: f.category,
              startSec: f.startSec,
              endSec: f.endSec,
              severity: f.severity,
              confidence: f.confidence,
              evidenceLabel: f.evidenceLabel,
              evidenceJson: JSON.stringify(f.evidence),
              explanation: f.explanation,
              suggestion: f.suggestion,
              engine: f.engine,
            },
          });
        }
        recommendationsCreated = await persistRecommendations(userId, projectId, review.id, head2.version, recs);
        reply =
          reply ||
          [
            `Ran a deterministic evidence pass (${enriched.evidenceSources.map((e) => e.engine).join(", ") || "timeline only"}): ${findings.length} findings, ${recs.length} recommendation(s) created for approval.`,
            summarizeFindings(enriched, findings),
          ].join("\n");
      } else {
        const queued = await enqueueReview(userId, projectId, "full", language);
        reviewId = queued.reviewId;
        reviewQueuedJobId = queued.jobId;
        reply =
          reply ||
          [
            `Queued a FULL review as durable job ${queued.jobId} (it will also fetch audio evidence). Meanwhile, the deterministic evidence pass found:`,
            summarizeFindings(ctx, analyzeRetention(ctx).findings),
          ].join("\n");
      }
    }
  }

  if (decision.intent === "compare-thumbnails") {
    reply =
      reply ||
      "Thumbnail comparison runs in the A/B Studio: it lists the LAXII candidates from your M9 Thumbnail Studio drafts side by side (creative evaluation — no performance prediction). Generate candidates in Publishing ▸ Thumbnail first if the list is empty.";
  }

  if (decision.intent === "general-question" && !reply) {
    reply = "I could not ground an answer in this project's measured context — please rephrase or run a review first.";
  }

  await db.conversationMessage.create({
    data: {
      conversationId,
      role: "assistant",
      content: reply.slice(0, 4000),
      metaJson: JSON.stringify({ intent: decision.intent, reviewId, jobId: reviewQueuedJobId, recommendationsCreated }),
    },
  });

  return { intent: decision.intent, reply, reviewId, reviewQueuedJobId, recommendationsCreated, usedFreshReview, decision };
}
