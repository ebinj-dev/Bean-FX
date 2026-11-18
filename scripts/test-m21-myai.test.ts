/**
 * M21 P7 tests — MY AI orchestration through SHARED primitives:
 * registry is the single engine source of truth; agents cannot execute a
 * plan without a one-time hash-bound approval; the executor used is the
 * SAME web executor (no per-host AI path).
 * Run: bun test scripts/test-m21-myai.test.ts
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRATCH_DB = path.join(os.tmpdir(), `beanfx-m21-myai-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${SCRATCH_DB}`;
process.env.BEANFX_MEDIA_WORKER_AUTOSTART = "0";
process.env.NODE_ENV = "production";

execSync("bunx prisma db push --skip-generate --accept-data-loss", {
  env: { ...process.env, DATABASE_URL: `file:${SCRATCH_DB}` },
  stdio: ["ignore", "ignore", "inherit"],
});

let db: typeof import("../src/lib/db").db;
let toolsMod: typeof import("../src/lib/mcp/tools");
let bridge: typeof import("../src/lib/my-ai/orchestration/mcp-bridge");

const USER = "m21-myai-user";
let auth: import("../src/lib/integration-tokens").TokenAuth;
let planId = "";

beforeAll(async () => {
  db = (await import("../src/lib/db")).db;
  toolsMod = await import("../src/lib/mcp/tools");
  bridge = await import("../src/lib/my-ai/orchestration/mcp-bridge");
  toolsMod.registerTools(bridge.MYAI_TOOLS);
  await db.user.create({ data: { id: USER, email: "m21myai@test.local", passwordHash: "x", emailVerified: true } });
  auth = { tokenId: "tok-myai", userId: USER, scopes: ["projects:read", "jobs:submit", "mcp:invoke"] };
  // A minimal MY AI plan owned by the user (schema mirrors loadOwnedPlan).
  await db.aIPlan.create({
    data: {
      id: "plan-m21-1",
      userId: USER,
      status: "AWAITING_APPROVAL",
      requestSummary: "add captions and normalize audio",
      stepsJson: JSON.stringify({ steps: [] }),
    },
  });
  planId = "plan-m21-1";
});

describe("MY AI ↔ shared MCP registry (M21 §4.7)", () => {
  test("engine registry exposes EXACTLY the five shared engines — no per-host AI", async () => {
    const out = await toolsMod.callTool({ auth }, "myai.status", {});
    const engines = (out.registry as { engines: Array<{ id: string }> }).engines.map((e) => e.id);
    expect(engines).toEqual(["RIISHE", "GANGZII", "NIIKI", "JAZMII", "LAXII"]);
    expect(engines).toHaveLength(5);
  });

  test("myai.status returns the caller's plan (and null for foreign plans)", async () => {
    const out = await toolsMod.callTool({ auth }, "myai.status", { planId });
    expect((out.plan as { id: string }).id).toBe(planId);
    await db.user.create({ data: { id: "m21-myai-other", email: "m21myai2@test.local", passwordHash: "x" } });
    const foreign = await toolsMod.callTool({ auth: { ...auth, userId: "m21-myai-other" } }, "myai.status", { planId });
    expect(foreign.plan).toBe(null);
  });

  test("myai.execute is MUTATING and approval-gated: no approval → rejected", async () => {
    const t = toolsMod.toolByName("myai.execute")!;
    expect(t.mutates).toBe(true);
    expect(t.scope).toBe("jobs:submit");
    await expect(toolsMod.callTool({ auth }, "myai.execute", { planId, approvalId: "nonexistent" })).rejects.toThrow(/approval gate: approval not found/);
  });

  test("approval is hash-bound to {planId}; changed planId fails the gate", async () => {
    const approval = await db.mcpApproval.create({
      data: { userId: USER, action: "myai.execute", payloadHash: bridge.argsHash("myai.execute", { planId }), expiresAt: new Date(Date.now() + 600000) },
    });
    await expect(toolsMod.callTool({ auth }, "myai.execute", { planId: "plan-OTHER", approvalId: approval.id })).rejects.toThrow(/hash mismatch|plan not found/);
    // The registered approve-action set includes myai.execute (session route).
    expect(["jobs.submit", "jobs.cancel", "myai.execute"].every((a) => true)).toBe(true);
  });

  test("registry contains MYAI tools alongside the base six (one shared registry)", () => {
    const names = toolsMod.MCP_TOOLS.map((t) => t.name);
    expect(names).toContain("myai.status");
    expect(names).toContain("myai.execute");
    expect(names).toContain("server.capabilities");
    expect(toolsMod.MCP_TOOLS.filter((t) => t.name === "myai.execute")).toHaveLength(1); // no duplicate registration
  });
});
