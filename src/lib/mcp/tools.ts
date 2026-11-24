/**
 * M21 P4 — shared MCP tool registry (internal stdio AND external HTTPS
 * transports call THIS code — one implementation, no per-host AI systems).
 *
 * Security model:
 *  - every tool declares the integration scope it needs; the transport
 *    resolves a TokenAuth (or web session) and the registry enforces it
 *  - read tools (projects.list, project.canonical, jobs.status,
 *    server.capabilities) run with read scopes
 *  - MUTATING tools (jobs.submit, jobs.cancel) additionally require a
 *    one-time, hash-bound McpApproval created by the human through the
 *    authenticated web session — agents alone can never mutate
 *  - every tool call is audited (userId, tool, arguments hash, verdict)
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { enqueueMediaJob, JOB_TYPE_RENDER_TIMELINE } from "@/lib/job-helpers";
import { sequenceToCanonical } from "@/lib/core/converters";
import { SERVER_CAPABILITIES, type TokenScope } from "@/lib/core/types";
import type { TokenAuth } from "@/lib/integration-tokens";

export interface McpCallContext {
  auth: TokenAuth; // session-authenticated calls are bridged to a synthetic TokenAuth
}

export interface McpToolDef {
  name: string;
  description: string;
  scope: TokenScope;
  mutates: boolean;
  input: z.ZodType<Record<string, unknown>>;
  handler: (ctx: McpCallContext, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

export function argsHash(action: string, args: Record<string, unknown>): string {
  return createHash("sha256").update(`${action}:${JSON.stringify(sortDeep(args))}`).digest("hex");
}

function sortDeep(v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sortDeep(x)]));
  }
  return v;
}

/** Verify (and consume) the one-time approval for a mutating call. */
export async function consumeApproval(userId: string, action: string, args: Record<string, unknown>, approvalId: string, by: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const row = await db.mcpApproval.findUnique({ where: { id: approvalId } });
  if (!row || row.userId !== userId || row.action !== action) return { ok: false, error: "approval not found for this user+action" };
  if (row.consumedAt) return { ok: false, error: "approval already consumed (one-time)" };
  if (row.expiresAt.getTime() < Date.now()) return { ok: false, error: "approval expired" };
  if (row.payloadHash !== argsHash(action, args)) return { ok: false, error: "approval payload hash mismatch — arguments changed since approval" };
  const upd = await db.mcpApproval.updateMany({ where: { id: approvalId, consumedAt: null }, data: { consumedAt: new Date(), consumedBy: by } });
  if (upd.count !== 1) return { ok: false, error: "approval already consumed (race-safe)" };
  return { ok: true };
}

async function audit(userId: string | null, tool: string, verdict: string, extra?: Record<string, unknown>) {
  await db.auditEvent.create({
    data: { userId, action: `mcp.${tool}.${verdict}`, detail: JSON.stringify(extra ?? {}) },
  }).catch(() => {});
}

// ---------- tools ----------

const SubmitArgs = z.object({
  projectId: z.string().min(1).max(64),
  startFrame: z.number().int().min(0).optional(),
  endFrame: z.number().int().min(1).optional(),
  approvalId: z.string().min(1).max(64),
});

const CancelArgs = z.object({ jobId: z.string().min(1).max(64), approvalId: z.string().min(1).max(64) });

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: "server.capabilities",
    description: "BEAN FX server capability descriptor (api version, format versions, features, limits).",
    scope: "projects:read",
    mutates: false,
    input: z.object({}),
    handler: async () => ({ capabilities: SERVER_CAPABILITIES }),
  },
  {
    name: "projects.list",
    description: "List the caller's projects (id, name, updatedAt).",
    scope: "projects:read",
    mutates: false,
    input: z.object({}),
    handler: async (ctx) => {
      const projects = await db.project.findMany({
        where: { userId: ctx.auth.userId },
        orderBy: { updatedAt: "desc" },
        take: 100,
        select: { id: true, name: true, updatedAt: true },
      });
      return { projects };
    },
  },
  {
    name: "project.canonical",
    description: "Export a project's current timeline as canonical beanfx-project-v1.",
    scope: "projects:read",
    mutates: false,
    input: z.object({ projectId: z.string().min(1).max(64) }),
    handler: async (ctx, args) => {
      const projectId = args.projectId as string;
      const project = await db.project.findUnique({ where: { id: projectId } });
      if (!project || project.userId !== ctx.auth.userId) throw new Error("project not found");
      const version = await db.timelineVersion.findFirst({ where: { projectId }, orderBy: { versionNumber: "desc" } });
      if (!version) throw new Error("project has no timeline yet");
      return { project: sequenceToCanonical(JSON.parse(version.sequenceJson), { projectId, baseVersion: version.versionNumber }) };
    },
  },
  {
    name: "jobs.status",
    description: "Read one durable job's status (id, type, status, progress, error).",
    scope: "jobs:read",
    mutates: false,
    input: z.object({ jobId: z.string().min(1).max(64) }),
    handler: async (ctx, args) => {
      const job = await db.job.findUnique({ where: { id: args.jobId as string } });
      if (!job || job.userId !== ctx.auth.userId) throw new Error("job not found");
      return { job: { id: job.id, type: job.type, status: job.status, progress: job.progress, error: job.message ?? undefined } };
    },
  },
  {
    name: "jobs.submit",
    description: "Submit a RENDER_TIMELINE job through the SAME durable pipeline the web editor uses. Requires a one-time human approval (approvalId) created in the web session; the approval is hash-bound to these arguments and consumed exactly once.",
    scope: "jobs:submit",
    mutates: true,
    input: SubmitArgs,
    handler: async (ctx, args) => {
      const parsed = SubmitArgs.parse(args);
      const project = await db.project.findUnique({ where: { id: parsed.projectId } });
      if (!project || project.userId !== ctx.auth.userId) throw new Error("project not found");
      const approval = await consumeApproval(ctx.auth.userId, "jobs.submit", { projectId: parsed.projectId, startFrame: parsed.startFrame, endFrame: parsed.endFrame }, parsed.approvalId, `token:${ctx.auth.tokenId}`);
      if (!approval.ok) throw new Error(`approval gate: ${approval.error}`);
      const version = await db.timelineVersion.findFirst({ where: { projectId: parsed.projectId }, orderBy: { versionNumber: "desc" } });
      if (!version) throw new Error("project has no timeline yet");
      const jobId = await enqueueMediaJob(ctx.auth.userId, JOB_TYPE_RENDER_TIMELINE, {
        projectId: parsed.projectId,
        startFrame: parsed.startFrame,
        endFrame: parsed.endFrame,
        createdBy: `mcp:token:${ctx.auth.tokenId}:approval:${parsed.approvalId}`,
      });
      return { jobId, status: "QUEUED" };
    },
  },
  {
    name: "jobs.cancel",
    description: "Cancel one of the caller's QUEUED/PROCESSING jobs. Requires a one-time human approval (approvalId).",
    scope: "jobs:cancel",
    mutates: true,
    input: CancelArgs,
    handler: async (ctx, args) => {
      const parsed = CancelArgs.parse(args);
      const job = await db.job.findUnique({ where: { id: parsed.jobId } });
      if (!job || job.userId !== ctx.auth.userId) throw new Error("job not found");
      const approval = await consumeApproval(ctx.auth.userId, "jobs.cancel", { jobId: parsed.jobId }, parsed.approvalId, `token:${ctx.auth.tokenId}`);
      if (!approval.ok) throw new Error(`approval gate: ${approval.error}`);
      const upd = await db.job.updateMany({
        where: { id: parsed.jobId, userId: ctx.auth.userId, status: { in: ["QUEUED", "PROCESSING"] } },
        data: { status: "CANCELLED", stage: "Cancelled", message: "Cancelled via MCP (approved)." },
      });
      if (upd.count === 0) throw new Error("job is not in a cancellable state");
      return { jobId: parsed.jobId, status: "CANCELLED" };
    },
  },
];

// M42-D — model capability registry tool (read-only; secrets never leave
// the registry — readiness/cost/config-state only).
MCP_TOOLS.push({
  name: "ai.models.list",
  description: "The deployment's probed AI model capability registry (provider, capabilities, readiness with reasons, cost strings — 'COST UNKNOWN' where unknown). Read-only.",
  scope: "projects:read",
  mutates: false,
  input: z.object({}),
  handler: async () => {
    const { probeModelRegistry } = await import("@/lib/ai/models");
    return { ...probeModelRegistry() } as unknown as Record<string, unknown>;
  },
});

export function toolByName(name: string): McpToolDef | undefined {
  return MCP_TOOLS.find((t) => t.name === name);
}

/** M21 P7 — register MY AI tools (kept separate to avoid an import cycle:
 *  the bridge imports consumeApproval from THIS module). */
export function registerTools(extra: McpToolDef[]): void {
  for (const t of extra) {
    if (!MCP_TOOLS.some((existing) => existing.name === t.name)) MCP_TOOLS.push(t);
  }
}

/** Registry entry point used by BOTH transports. Throws structured errors. */
export async function callTool(ctx: McpCallContext, name: string, rawArgs: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tool = toolByName(name);
  if (!tool) {
    await audit(ctx.auth.userId, name, "unknown_tool");
    throw new McpError(-32602, `unknown tool: ${name}`);
  }
  if (!ctx.auth.scopes.includes(tool.scope)) {
    await audit(ctx.auth.userId, tool.name, "scope_denied", { required: tool.scope });
    throw new McpError(-32003, `scope ${tool.scope} required for ${tool.name}`);
  }
  const parsed = tool.input.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    await audit(ctx.auth.userId, tool.name, "bad_args");
    throw new McpError(-32602, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  try {
    const out = await tool.handler(ctx, parsed.data);
    await audit(ctx.auth.userId, tool.name, "ok");
    return out;
  } catch (e) {
    await audit(ctx.auth.userId, tool.name, "error", { message: e instanceof Error ? e.message : String(e) });
    throw new McpError(-32000, e instanceof Error ? e.message : "tool failed");
  }
}

export class McpError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

/** Build the tools/list payload (JSON-Schema-ish descriptions). */
export function toolListPayload() {
  return {
    tools: MCP_TOOLS.map((t) => ({
      name: t.name,
      description: `${t.description}${t.mutates ? " [MUTATING — one-time human approval required]" : ""}`,
      inputSchema: { type: "object", properties: {}, required: [] as string[] },
      annotations: { mutates: t.mutates, scope: t.scope },
    })),
  };
}
