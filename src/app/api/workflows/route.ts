/**
 * M26 P7 — workflow automation API (template-whitelisted; no arbitrary steps).
 * GET  /api/workflows           — templates + the user's runs
 * POST /api/workflows           — start a run from a template (+ required inputs)
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { unauthorized, badRequest } from "@/lib/process-helpers";
import { WORKFLOW_TEMPLATES, templateById, tickWorkflow, parseRun, type RunState } from "@/lib/workflows/executor";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

const StartSchema = z.object({
  templateId: z.string().min(1).max(60),
  projectId: z.string().min(1).max(64),
  inputs: z.record(z.string(), z.string().max(200)).optional(),
});

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const runs = await db.workflowRun.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, templateId: true, name: true, status: true, createdAt: true, updatedAt: true, stepsJson: true, error: true, projectId: true },
  });
  return NextResponse.json({
    templates: WORKFLOW_TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description, requiredInputs: t.requiredInputs, steps: t.steps.map((s) => ({ id: s.id, kind: s.kind, label: s.label, approvalRequired: !!s.approvalRequired })) })),
    runs: runs.map((r) => {
      const state = parseRun({ stepsJson: r.stepsJson }) as RunState;
      return {
        id: r.id,
        templateId: r.templateId,
        name: r.templateId,
        projectId: r.projectId,
        status: r.status,
        error: r.error,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        steps: state.steps.map((s) => ({ id: s.id, kind: s.kind, label: s.label, status: s.status, stepError: s.stepError, approvalRequired: !!s.approvalRequired })),
      };
    }),
  });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const parsed = StartSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest("templateId and projectId required.");
  const template = templateById(parsed.data.templateId);
  if (!template) return badRequest("Unknown template (runs are created ONLY from the whitelisted library).");
  const project = await db.project.findFirst({ where: { id: parsed.data.projectId, userId: user.id } });
  if (!project) return badRequest("Project not found or not owned by the caller.");

  // Validate required inputs up-front (honest 400 before any dispatch).
  const inputs = parsed.data.inputs ?? {};
  const missing = template.requiredInputs.filter((k) => k !== "projectId" && !inputs[k]);
  if (missing.length > 0) return badRequest(`Missing inputs: ${missing.join(", ")}.`);

  // Merge inputs into step params by kind (whitelisted fields only).
  const steps = template.steps.map((s) => {
    const params: Record<string, unknown> = { ...s.params };
    if (s.kind === "GANGZII_PROCESS" && inputs.sourceAssetId) params.sourceAssetId = inputs.sourceAssetId;
    if (s.kind === "JAZMII_ANALYZE" && inputs.mediaId) params.mediaId = inputs.mediaId;
    if (s.kind === "LAXII_GENERATE" && inputs.prompt) params.prompt = inputs.prompt;
    return { ...s, params, status: "PENDING" as const };
  });

  const run = await db.workflowRun.create({
    data: {
      userId: user.id,
      projectId: project.id,
      templateId: template.id,
      name: template.name,
      status: "PENDING",
      stepsJson: JSON.stringify({ steps } satisfies { steps: typeof steps }),
    },
    select: { id: true, status: true },
  });
  await audit("workflow.started", { userId: user.id, detail: JSON.stringify({ runId: run.id, templateId: template.id }) });
  // First tick dispatches the first step immediately.
  const ticked = await tickWorkflow(user.id, run.id).catch(() => null);
  return NextResponse.json({ run: { id: run.id, status: ticked?.status ?? run.status } });
}
