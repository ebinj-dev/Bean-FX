/**
 * M43-B — MCP surface for the authoritative editing-command registry
 * (FilmCraft pattern: agents drive the SAME executor the UI uses, through
 * allowlisted, scope-scoped, audited tools).
 *
 * Security model (identical to jobs.submit/jobs.cancel):
 *  - read tools (list/describe/validate/preview) need only `projects:read`
 *  - MUTATING tools (run/batch) need `projects:write` PLUS a one-time,
 *    hash-bound McpApproval created by the human through the authenticated
 *    web session — agents alone can never mutate a timeline
 *  - every call is audited by the shared MCP registry; every mutation is
 *    additionally provenance-audited by the commands service
 */
import { z } from "zod";
import { consumeApproval, type McpToolDef } from "@/lib/mcp/tools";
import { commandsBatch, commandsDescribe, commandsList, commandsPreview, commandsRun, commandsValidate } from "@/lib/my-ai/commands-service";

const ProjectId = z.object({ projectId: z.string().min(1).max(64) });
const CommandId = z.object({ commandId: z.string().min(1).max(64) });
const Params = z.record(z.string(), z.unknown()).optional();
const Revision = z.number().int().min(0).optional();

function mcpCaller(tokenId: string) {
  return { kind: "MCP" as const, id: `mcp:token:${tokenId}` };
}

function errorPayload(e: unknown): Record<string, unknown> {
  return e instanceof Error
    ? { ok: false, code: (e as { code?: string }).code ?? "TOOL_ERROR", error: e.message }
    : { ok: false, code: "TOOL_ERROR", error: String(e) };
}

export const COMMANDS_MCP_TOOLS: McpToolDef[] = [
  {
    name: "commands.list",
    description: "M43-B command registry: every authoritative editing command with its live availability for a project (id, risk, approval requirement). Read-only.",
    scope: "projects:read",
    mutates: false,
    input: ProjectId,
    handler: async (ctx, args) => {
      const res = await commandsList(String(args.projectId), ctx.auth.userId);
      return res.ok ? { ok: true, headVersion: res.headVersion, commands: res.commands } : { ok: false, code: res.code, error: res.error };
    },
  },
  {
    name: "commands.describe",
    description: "Describe one registry command: typed parameter documentation, risk, approval policy, capabilities. Read-only.",
    scope: "projects:read",
    mutates: false,
    input: CommandId,
    handler: async (_ctx, args) => {
      const res = commandsDescribe(String(args.commandId));
      return res.ok ? { ok: true, descriptor: res.descriptor } : { ok: false, code: res.code, error: res.error };
    },
  },
  {
    name: "commands.validate",
    description: "Validate a proposed command against the CURRENT head revision without mutating anything (schema + availability + executor re-validation). Read-only.",
    scope: "projects:read",
    mutates: false,
    input: ProjectId.extend({ commandId: z.string().min(1).max(64), params: Params, expectedRevision: Revision }),
    handler: async (ctx, args) => {
      try {
        const res = await commandsValidate(String(args.projectId), ctx.auth.userId, String(args.commandId), args.params, args.expectedRevision as number | undefined);
        return res.ok ? { ok: true, warnings: res.warnings, headVersion: res.headVersion } : { ok: false, code: res.code, error: res.error };
      } catch (e) {
        return errorPayload(e);
      }
    },
  },
  {
    name: "commands.preview",
    description: "Before/after preview of a proposed command against the CURRENT head (runs the canonical executor on a clone; never persists). Read-only.",
    scope: "projects:read",
    mutates: false,
    input: ProjectId.extend({ commandId: z.string().min(1).max(64), params: Params, expectedRevision: Revision }),
    handler: async (ctx, args) => {
      const res = await commandsPreview(String(args.projectId), ctx.auth.userId, String(args.commandId), args.params, args.expectedRevision as number | undefined);
      return res.ok ? { ok: true, preview: res.preview, headVersion: res.headVersion } : { ok: false, code: res.code, error: res.error };
    },
  },
  {
    name: "commands.run",
    description: "Run ONE authoritative editing command through the canonical executor (revision-aware; returns the undo inverse). MUTATING — requires a one-time human approval bound to these arguments.",
    scope: "projects:write",
    mutates: true,
    input: ProjectId.extend({
      commandId: z.string().min(1).max(64),
      params: z.record(z.string(), z.unknown()),
      expectedRevision: z.number().int().min(0),
      approvalId: z.string().min(1).max(64),
    }),
    handler: async (ctx, args) => {
      const { projectId, commandId, params, expectedRevision, approvalId } = args as { projectId: string; commandId: string; params: Record<string, unknown>; expectedRevision: number; approvalId: string };
      const approval = await consumeApproval(ctx.auth.userId, "commands.run", { projectId, commandId, params, expectedRevision }, approvalId, `token:${ctx.auth.tokenId}`);
      if (!approval.ok) return { ok: false, code: "APPROVAL_GATE", error: `approval gate: ${approval.error}` };
      const res = await commandsRun(projectId, ctx.auth.userId, commandId, params, expectedRevision, mcpCaller(ctx.auth.tokenId), { source: "MCP_APPROVAL", reference: approvalId });
      return res.ok ? { ok: true, version: res.version, commandType: res.commandType, inverse: res.inverse } : { ok: false, code: res.code, error: res.error, currentVersion: res.currentVersion };
    },
  },
  {
    name: "commands.batch",
    description: "Run a batch of registry commands ATOMICALLY (all-or-nothing, revision-aware, undo inverse collected). MUTATING — requires a one-time human approval bound to these arguments.",
    scope: "projects:write",
    mutates: true,
    input: ProjectId.extend({
      entries: z.array(z.object({ commandId: z.string().min(1).max(64), params: z.record(z.string(), z.unknown()) })).min(1).max(50),
      expectedRevision: z.number().int().min(0),
      approvalId: z.string().min(1).max(64),
    }),
    handler: async (ctx, args) => {
      const { projectId, entries, expectedRevision, approvalId } = args as { projectId: string; entries: Array<{ commandId: string; params: Record<string, unknown> }>; expectedRevision: number; approvalId: string };
      const approval = await consumeApproval(ctx.auth.userId, "commands.batch", { projectId, entries, expectedRevision }, approvalId, `token:${ctx.auth.tokenId}`);
      if (!approval.ok) return { ok: false, code: "APPROVAL_GATE", error: `approval gate: ${approval.error}` };
      const res = await commandsBatch(projectId, ctx.auth.userId, entries, expectedRevision, mcpCaller(ctx.auth.tokenId), { source: "MCP_APPROVAL", reference: approvalId });
      return res.ok ? { ok: true, version: res.version, applied: res.applied, commandTypes: res.commandTypes } : { ok: false, code: res.code, error: res.error, currentVersion: res.currentVersion, failedIndex: res.failedIndex };
    },
  },
];
