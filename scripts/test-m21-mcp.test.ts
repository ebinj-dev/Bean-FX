/**
 * M21 P4 tests — MCP shared registry: scope enforcement, approval gates
 * (hash-bound, one-time), JSON-RPC semantics, audit trail.
 * Run: bun test scripts/test-m21-mcp.test.ts
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRATCH_DB = path.join(os.tmpdir(), `beanfx-m21-mcp-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${SCRATCH_DB}`;
process.env.BEANFX_MEDIA_WORKER_AUTOSTART = "0";
process.env.NODE_ENV = "production";

execSync("bunx prisma db push --skip-generate --accept-data-loss", {
  env: { ...process.env, DATABASE_URL: `file:${SCRATCH_DB}` },
  stdio: ["ignore", "ignore", "inherit"],
});

let db: typeof import("../src/lib/db").db;
let tools: typeof import("../src/lib/mcp/tools");

const USER = "m21-mcp-user";
let authFull: import("../src/lib/integration-tokens").TokenAuth;
let authRead: import("../src/lib/integration-tokens").TokenAuth;
let projectId = "";

beforeAll(async () => {
  db = (await import("../src/lib/db")).db;
  tools = await import("../src/lib/mcp/tools");
  await db.user.create({ data: { id: USER, email: "m21mcp@test.local", passwordHash: "x", emailVerified: true } });
  await db.project.create({ data: { userId: USER, name: "mcp-project" } });
  const p = await db.project.findFirstOrThrow({ where: { userId: USER } });
  projectId = p.id;
  // seed a timeline version so project.canonical works
  await db.timelineVersion.create({
    data: {
      projectId,
      versionNumber: 1,
      sequenceJson: JSON.stringify({
        id: projectId, name: "mcp-project", fps: { num: 30, den: 1 }, width: 1280, height: 720,
        sampleRate: 48000, tracks: [{ id: "t1", kind: "VIDEO", name: "V1", visible: true, muted: false, solo: false, locked: false }],
        clips: [], transitions: [],
      }),
      createdById: USER,
    },
  });
  authFull = { tokenId: "tok-full", userId: USER, scopes: ["projects:read", "jobs:submit", "jobs:cancel", "jobs:read", "mcp:invoke"] };
  authRead = { tokenId: "tok-read", userId: USER, scopes: ["projects:read", "mcp:invoke"] };
});

describe("MCP shared registry (M21 §4.1-4.3)", () => {
  test("tools/list exposes the shared registry with mutation annotations", () => {
    const payload = tools.toolListPayload();
    const names = payload.tools.map((t) => t.name);
    // M22: the shared registry grew to 8 tools (MY AI added in P7 via
    // bootstrap registration) — assert the six base tools are present.
    expect(names.slice(0, 6).sort()).toEqual(["jobs.cancel", "jobs.status", "jobs.submit", "project.canonical", "projects.list", "server.capabilities"]);
    const submit = payload.tools.find((t) => t.name === "jobs.submit")!;
    expect(submit.annotations.mutates).toBe(true);
    expect(submit.annotations.scope).toBe("jobs:submit");
    expect(submit.description).toContain("one-time human approval");
  });

  test("read tools work with read-scoped auth", async () => {
    const caps = await tools.callTool({ auth: authRead }, "server.capabilities", {});
    expect((caps.capabilities as { api: string }).api).toBe("v1");
    const list = await tools.callTool({ auth: authRead }, "projects.list", {});
    expect((list.projects as Array<{ id: string }>).some((p) => p.id === projectId)).toBe(true);
    const can = await tools.callTool({ auth: authRead }, "project.canonical", { projectId });
    expect((can.project as { formatVersion: string }).formatVersion).toBe("beanfx-project-v1");
  });

  test("scope enforcement: read-scoped token cannot submit or cancel", async () => {
    await expect(tools.callTool({ auth: authRead }, "jobs.submit", { projectId, approvalId: "x" })).rejects.toThrow(/scope jobs:submit/);
    await expect(tools.callTool({ auth: authRead }, "jobs.cancel", { jobId: "j", approvalId: "x" })).rejects.toThrow(/scope jobs:cancel/);
  });

  test("mutation WITHOUT approval is rejected (agents alone can never mutate)", async () => {
    await expect(tools.callTool({ auth: authFull }, "jobs.submit", { projectId, approvalId: "nonexistent" })).rejects.toThrow(/approval gate: approval not found/);
  });

  test("approval is hash-bound: changed arguments fail the gate", async () => {
    const args = { projectId, startFrame: 0, endFrame: 240 };
    const approval = await db.mcpApproval.create({
      data: { userId: USER, action: "jobs.submit", payloadHash: tools.argsHash("jobs.submit", args), expiresAt: new Date(Date.now() + 600000) },
    });
    await expect(tools.callTool({ auth: authFull }, "jobs.submit", { ...args, endFrame: 999, approvalId: approval.id })).rejects.toThrow(/hash mismatch/);
  });

  test("approved submit runs once through the SAME durable pipeline; second use rejected", async () => {
    const args = { projectId, startFrame: 0, endFrame: 240 };
    const approval = await db.mcpApproval.create({
      data: { userId: USER, action: "jobs.submit", payloadHash: tools.argsHash("jobs.submit", args), expiresAt: new Date(Date.now() + 600000) },
    });
    const out = await tools.callTool({ auth: authFull }, "jobs.submit", { ...args, approvalId: approval.id });
    const jobId = (out as { jobId: string }).jobId;
    expect(jobId).toBeTruthy();
    const job = await db.job.findUnique({ where: { id: jobId } });
    expect(job?.userId).toBe(USER);
    expect(job?.status).toBe("QUEUED");
    // audit attribution carries the approval chain
    expect(job?.paramsJson).toContain(`approval:${approval.id}`);
    // one-time: reuse fails
    await expect(tools.callTool({ auth: authFull }, "jobs.submit", { ...args, approvalId: approval.id })).rejects.toThrow(/already consumed/);
    // foreign project rejected
    await db.user.create({ data: { id: "m21-foreign", email: "m21f@test.local", passwordHash: "x" } });
    const foreign = await db.project.create({ data: { userId: "m21-foreign", name: "not-yours" } });
    await expect(tools.callTool({ auth: authFull }, "project.canonical", { projectId: foreign.id })).rejects.toThrow(/project not found/);
  });

  test("unknown tool and bad args give structured errors + audit", async () => {
    await expect(tools.callTool({ auth: authFull }, "shell.exec", {})).rejects.toThrow(/unknown tool/);
    await expect(tools.callTool({ auth: authFull }, "project.canonical", {})).rejects.toThrow(/projectId/);
    const audits = await db.auditEvent.findMany({ where: { action: { startsWith: "mcp." } }, orderBy: { createdAt: "desc" } });
    const actions = audits.map((a) => a.action);
    expect(actions.some((a) => a === "mcp.shell.exec.unknown_tool")).toBe(true);
    expect(actions.some((a) => a === "mcp.jobs.submit.ok")).toBe(true);
    expect(actions.some((a) => a === "mcp.jobs.submit.scope_denied")).toBe(true);
  });

  test("cancelled job path is approval-gated too", async () => {
    const job = await db.job.create({ data: { userId: USER, type: "RENDER_TIMELINE", status: "QUEUED", paramsJson: "{}", maxAttempts: 3, timeoutSec: 600 } });
    await expect(tools.callTool({ auth: authFull }, "jobs.cancel", { jobId: job.id, approvalId: "nope" })).rejects.toThrow(/approval gate/);
    const args = { jobId: job.id };
    const approval = await db.mcpApproval.create({
      data: { userId: USER, action: "jobs.cancel", payloadHash: tools.argsHash("jobs.cancel", args), expiresAt: new Date(Date.now() + 600000) },
    });
    const out = await tools.callTool({ auth: authFull }, "jobs.cancel", { ...args, approvalId: approval.id });
    expect((out as { status: string }).status).toBe("CANCELLED");
  });
});
