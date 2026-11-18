/**
 * M21 P7 — MY AI ↔ shared-architecture orchestration bridge.
 *
 * Requirement: "MY AI coordinating RIISHE/GANGZII/NIIKI/JAZMII/LAXII through
 * the same job/approval primitives (no private backdoors); no per-host AI
 * systems." This module exposes MY AI to agents THROUGH the M21 MCP tool
 * registry only:
 *   - myai.status  (read)   — plan status + engine registry view
 *   - myai.execute (mutate) — runs the EXISTING MY AI executor for a plan
 *     owned by the token's user; requires a one-time, hash-bound McpApproval
 *     exactly like every other mutating tool. Hosts get no private executor
 *     and no way around the web-session approval gate.
 * The engine registry stays the single source of truth (RIISHE, GANGZII,
 * NIIKI, JAZMII, LAXII) — agents discover it through server.capabilities /
 * myai.status instead of hard-coding engines.
 */
import { z } from "zod";
import { db } from "@/lib/db";
import { AI_ENGINE_REGISTRY } from "@/lib/ai/registry";
import { loadOwnedPlan } from "@/lib/my-ai/approvals";
import { executePlan } from "@/lib/my-ai/execution/executor";
import { consumeApproval, argsHash, type McpToolDef } from "@/lib/mcp/tools";

const EngineId = z.enum(["RIISHE", "GANGZII", "NIIKI", "JAZMII", "LAXII"]);

export const MYAI_TOOLS: McpToolDef[] = [
  {
    name: "myai.status",
    description: "MY AI coordination view: engine registry (RIISHE/GANGZII/NIIKI/JAZMII/LAXII — the ONLY engines, shared by every host) and the status of one of the caller's MY AI plans.",
    scope: "projects:read",
    mutates: false,
    input: z.object({ planId: z.string().max(64).optional() }),
    handler: async (ctx, args) => {
      const registry = {
        version: AI_ENGINE_REGISTRY.version,
        engines: AI_ENGINE_REGISTRY.engines.map((e) => ({ id: e.id, domain: e.domain })),
      };
      const planId = args.planId as string | undefined;
      if (!planId) return { registry, plan: null };
      const plan = await loadOwnedPlan(planId, ctx.auth.userId);
      if (!plan) return { registry, plan: null };
      return { registry, plan: { id: plan.id, status: plan.status, expiresAt: plan.expiresAt } };
    },
  },
  {
    name: "myai.execute",
    description: "Execute one of the caller's MY AI plans through the SAME web executor (durable jobs + approval gates). MUTATING: requires a one-time human approval (approvalId) hash-bound to {planId}; agents can never execute without it.",
    scope: "jobs:submit",
    mutates: true,
    input: z.object({ planId: z.string().min(1).max(64), approvalId: z.string().min(1).max(64) }),
    handler: async (ctx, args) => {
      const parsed = z.object({ planId: z.string().min(1).max(64), approvalId: z.string().min(1).max(64) }).parse(args);
      const plan = await loadOwnedPlan(parsed.planId, ctx.auth.userId);
      if (!plan) throw new Error("plan not found for this user");
      const gateArgs = { planId: parsed.planId };
      const approval = await consumeApproval(ctx.auth.userId, "myai.execute", gateArgs, parsed.approvalId, `token:${ctx.auth.tokenId}`);
      if (!approval.ok) throw new Error(`approval gate: ${approval.error}`);
      const report = await executePlan(parsed.planId, ctx.auth.userId);
      return { planId: parsed.planId, executedVia: "shared-m21-primitives", report };
    },
  },
];

export { EngineId, argsHash };
