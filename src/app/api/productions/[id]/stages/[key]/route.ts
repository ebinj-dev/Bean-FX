/**
 * M31 — stage actions: start / approve / reject / skip / cancel / retry.
 * ALL state transitions are validated server-side against the engine's
 * transition table; approval-required stages cannot pass their gate without an
 * explicit decision; provider stages additionally require configuration.
 */
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { canTransition, type StageState } from "@/lib/production/engine";
import { logEvent, startStage, ProductionError } from "@/lib/production/runner";
import { beginStageTask, finishStageTask } from "@/lib/production/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string; key: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { id, key } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const action = typeof body.action === "string" ? body.action : "";
  const production = await db.production.findUnique({ where: { id }, include: { stages: true } });
  if (!production || production.userId !== user.id) return NextResponse.json({ error: "Production not found." }, { status: 404 });
  const stage = production.stages.find((s) => s.key === key);
  if (!stage) return NextResponse.json({ error: "Stage not part of this pipeline." }, { status: 400 });

  try {
    switch (action) {
      case "start": {
        // M45-P1 — every real stage execution is recorded as a crew task with
        // its inputs, responsible agent profile and honest result.
        const taskInput = { briefTextLength: (production.briefJson ?? "").length, projectId: production.projectId };
        const taskId = await beginStageTask(id, key, taskInput).catch(() => null);
        let r: { state: string; message: string };
        try {
          r = await startStage(id, key, user.id);
        } catch (err) {
          if (taskId) await finishStageTask(taskId, "FAILED", null, err instanceof Error ? err.message.slice(0, 300) : "stage failed");
          throw err;
        }
        if (taskId) await finishStageTask(taskId, r.state === "SUCCEEDED" ? "SUCCEEDED" : r.state === "RUNNING" ? "RUNNING" : "PENDING", { state: r.state, message: r.message });
        return NextResponse.json(r);
      }
      case "approve": {
        // Approval applies to the exact stage/artifact revision row.
        if (!canTransition(stage.state as StageState, "SUCCEEDED")) {
          return NextResponse.json({ error: `Invalid transition ${stage.state} → SUCCEEDED via approval.` }, { status: 409 });
        }
        await db.productionStage.update({ where: { id: stage.id }, data: { state: "SUCCEEDED", completedAt: new Date() } });
        await db.production.update({ where: { id }, data: { status: "PLANNED" } });
        await logEvent(id, "stage.approved", key, { by: "user" });
        return NextResponse.json({ ok: true, state: "SUCCEEDED" });
      }
      case "reject": {
        if (!canTransition(stage.state as StageState, "FAILED")) {
          return NextResponse.json({ error: `Invalid transition ${stage.state} → FAILED via rejection.` }, { status: 409 });
        }
        await db.productionStage.update({ where: { id: stage.id }, data: { state: "FAILED", error: "Rejected by user.", completedAt: new Date() } });
        await db.production.update({ where: { id }, data: { status: "FAILED" } });
        await logEvent(id, "stage.rejected", key, { by: "user" });
        return NextResponse.json({ ok: true, state: "FAILED" });
      }
      case "skip": {
        if (!canTransition(stage.state as StageState, "SKIPPED")) {
          return NextResponse.json({ error: `Invalid transition ${stage.state} → SKIPPED.` }, { status: 409 });
        }
        await db.productionStage.update({ where: { id: stage.id }, data: { state: "SKIPPED", completedAt: new Date() } });
        await logEvent(id, "stage.skipped", key, { by: "user" });
        return NextResponse.json({ ok: true, state: "SKIPPED" });
      }
      case "cancel": {
        const to: StageState = stage.state === "RUNNING" ? "CANCEL_REQUESTED" : "CANCELLED";
        if (!canTransition(stage.state as StageState, to)) {
          return NextResponse.json({ error: `Invalid transition ${stage.state} → ${to}.` }, { status: 409 });
        }
        await db.productionStage.update({ where: { id: stage.id }, data: { state: to, completedAt: new Date() } });
        if (stage.jobId) {
          const { jobManager } = await import("@/lib/job-runner");
          await jobManager.cancel(stage.jobId, user.id).catch(() => undefined);
        }
        await db.production.update({ where: { id }, data: { status: "CANCELLED" } });
        await logEvent(id, "stage.cancelled", key, { by: "user", requested: to === "CANCEL_REQUESTED" });
        return NextResponse.json({ ok: true, state: to });
      }
      case "retry": {
        if (!canTransition(stage.state as StageState, "READY")) {
          return NextResponse.json({ error: `Invalid transition ${stage.state} → READY (retry).` }, { status: 409 });
        }
        await db.productionStage.update({ where: { id: stage.id }, data: { state: "READY", error: null, jobId: null } });
        await logEvent(id, "stage.retry", key, { by: "user" });
        return NextResponse.json({ ok: true, state: "READY" });
      }
      default:
        return NextResponse.json({ error: "action must be start|approve|reject|skip|cancel|retry." }, { status: 400 });
    }
  } catch (err) {
    if (err instanceof ProductionError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    throw err;
  }
}
