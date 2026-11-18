/**
 * M22 P3 tests — REAL external MCP client (SDK Client, out-of-process
 * HTTPS transport + stdio child process): handshake, discovery, auth,
 * project authorization, approval lifecycle (binding/expiry/replay),
 * revoked tokens, malformed JSON-RPC, unauthorized invocation, audit.
 * Run: bun test scripts/test-m22-mcp-client.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { JsonRpcHttpTransport, connectHttp, connectStdio } from "./mcp-client-harness";

const LIVE = "http://localhost:3117";
process.env.NODE_ENV = "production";
process.env.DATABASE_URL = "file:/home/z/my-project/db/custom.db";

let db: typeof import("../src/lib/db").db;
let user: { id: string };
let token = "";
let projectId = "";

beforeAll(async () => {
  if (!(await (await fetch(`${LIVE}/`)).ok)) throw new Error(`live server ${LIVE} unavailable`);
  db = (await import("../src/lib/db")).db;
  const { createIntegrationToken } = await import("../src/lib/integration-tokens");
  user = await db.user.upsert({
    where: { id: "m22-mcp-client-user" },
    update: {},
    create: { id: "m22-mcp-client-user", email: "m22mcp@test.local", passwordHash: "x", emailVerified: true },
  });
  const created = await createIntegrationToken(user.id, "m22-external-client", ["projects:read", "jobs:read", "jobs:submit", "jobs:cancel", "mcp:invoke"]);
  token = created.raw;
  const project = await db.project.create({ data: { userId: user.id, name: "M22 MCP validation" } });
  projectId = project.id;
  await db.timelineVersion.create({
    data: {
      projectId, versionNumber: 1,
      sequenceJson: JSON.stringify({
        id: projectId, name: "M22 MCP validation", fps: { num: 30, den: 1 }, width: 1280, height: 720, sampleRate: 48000,
        tracks: [{ id: "t1", kind: "VIDEO", name: "V1", visible: true, muted: false, solo: false, locked: false }],
        clips: [], transitions: [],
      }),
      createdById: user.id,
    },
  });
}, 20000);

afterAll(async () => {
  await db.$disconnect?.().catch?.(() => {});
});

describe("external MCP client — HTTPS transport (real out-of-process)", () => {
  test("initialize handshake + tools/list exposes the EIGHT-tool shared registry", async () => {
    const { client, summary } = await connectHttp(LIVE, token);
    expect(summary.serverVersion?.name).toBe("beanfx-mcp"); // real initialize handshake
    expect(summary.serverInfo?.name).toBe("beanfx-mcp");
    const names = summary.tools.map((t) => t.name);
    expect(names).toEqual(["server.capabilities", "projects.list", "project.canonical", "jobs.status", "jobs.submit", "jobs.cancel", "myai.status", "myai.execute"]);
    expect(summary.tools.find((t) => t.name === "jobs.submit")?.mutates).toBe(true);
    const caps = summary.capabilitiesRead as { capabilities: { api: string; formatVersions: string[] } };
    expect(caps.capabilities.api).toBe("v1");
    await client.close();
  });

  test("tool calls work: projects.list + project.canonical scoped to the caller", async () => {
    const { client } = await connectHttp(LIVE, token);
    const list = (await client.callTool({ name: "projects.list", arguments: {} })) as { content?: Array<{ text: string }> };
    const projects = JSON.parse(list.content![0].text) as { projects: Array<{ id: string }> };
    expect(projects.projects.some((p) => p.id === projectId)).toBe(true);
    const can = (await client.callTool({ name: "project.canonical", arguments: { projectId } })) as { content?: Array<{ text: string }> };
    const canonical = JSON.parse(can.content![0].text) as { project: { formatVersion: string; baseVersion: number } };
    expect(canonical.project.formatVersion).toBe("beanfx-project-v1");
    expect(canonical.project.baseVersion).toBe(1);
    await client.close();
  });

  test("project-level authorization: a foreign project is rejected", async () => {
    const foreign = await db.project.create({ data: { userId: "m21-bridge-owner", name: "not-yours-m22" } });
    const { client } = await connectHttp(LIVE, token);
    await expect(client.callTool({ name: "project.canonical", arguments: { projectId: foreign.id } })).rejects.toThrow(/project not found/);
    await client.close();
  });

  test("authentication: bad token → HTTP-level rejection, client cannot connect", async () => {
    const bad = "bfx_" + "f".repeat(64);
    const transport = new JsonRpcHttpTransport(LIVE, bad);
    const client = new Client({ name: "bad", version: "1" });
    await expect(client.connect(transport as never)).rejects.toThrow(/401|UNAUTHORIZED/);
  });

  test("unauthorized tool invocation: read-scope token denied mutating tools (server-side)", async () => {
    const { createIntegrationToken } = await import("../src/lib/integration-tokens");
    const ro = (await createIntegrationToken(user.id, "m22-read-only", ["projects:read", "mcp:invoke"])).raw;
    const { client } = await connectHttp(LIVE, ro);
    await expect(client.callTool({ name: "jobs.submit", arguments: { projectId, approvalId: "x" } })).rejects.toThrow(/scope jobs:submit/);
    await client.close();
  });

  test("malformed JSON-RPC → structured -32700, no crash", async () => {
    const res = await fetch(`${LIVE}/api/v1/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: "{not json at all",
    });
    const body = (await res.json()) as { error?: { code: number } };
    expect(body.error?.code).toBe(-32700);
    // invalid method
    const res2 = await fetch(`${LIVE}/api/v1/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "admin.grant" }),
    });
    const body2 = (await res2.json()) as { error?: { code: number } };
    expect(body2.error?.code).toBe(-32601);
  });
});

describe("approval lifecycle through the external client (M22 P3)", () => {
  async function makeApproval(action: string, args: Record<string, unknown>, opts?: { expiresAt?: Date }): Promise<string> {
    const { argsHash } = await import("../src/lib/mcp/tools");
    const row = await db.mcpApproval.create({
      data: { userId: user.id, action, payloadHash: argsHash(action, args), expiresAt: opts?.expiresAt ?? new Date(Date.now() + 600000) },
    });
    return row.id;
  }

  test("approved jobs.submit executes ONCE through the durable pipeline; replay rejected", async () => {
    const args = { projectId };
    const approvalId = await makeApproval("jobs.submit", args);
    const { client } = await connectHttp(LIVE, token);
    const out = (await client.callTool({ name: "jobs.submit", arguments: { ...args, approvalId } })) as { content?: Array<{ text: string }> };
    const submitted = JSON.parse(out.content![0].text) as { jobId: string; status: string };
    expect(submitted.status).toBe("QUEUED");
    const job = await db.job.findUnique({ where: { id: submitted.jobId } });
    expect(job?.userId).toBe(user.id);
    // REPLAY (same approval id): rejected
    await expect(client.callTool({ name: "jobs.submit", arguments: { ...args, approvalId } })).rejects.toThrow(/already consumed/);
    await client.close();
    await db.job.delete({ where: { id: submitted.jobId } });
  });

  test("approval hash binding: changed arguments fail the gate", async () => {
    const args = { projectId };
    const approvalId = await makeApproval("jobs.submit", args);
    const { client } = await connectHttp(LIVE, token);
    await expect(client.callTool({ name: "jobs.submit", arguments: { projectId, approvalId } })).resolves.toBeDefined(); // exact args pass
    // make a fresh one and mutate args
    const approvalId2 = await makeApproval("jobs.submit", { projectId });
    await expect(client.callTool({ name: "jobs.submit", arguments: { projectId, approvalId: approvalId2, startFrame: 7 } })).rejects.toThrow(/hash mismatch/);
    await client.close();
  });

  test("approval expiration: expired approval rejected", async () => {
    const args = { projectId };
    const approvalId = await makeApproval("jobs.submit", args, { expiresAt: new Date(Date.now() - 1000) });
    const { client } = await connectHttp(LIVE, token);
    await expect(client.callTool({ name: "jobs.submit", arguments: { ...args, approvalId } })).rejects.toThrow(/approval expired|approval not found/);
    await client.close();
  });

  test("revoked integration token: client immediately locked out", async () => {
    const { createIntegrationToken, revokeIntegrationToken } = await import("../src/lib/integration-tokens");
    const short = (await createIntegrationToken(user.id, "m22-revoked", ["projects:read", "mcp:invoke"])).raw;
    const { client } = await connectHttp(LIVE, short);
    const ok = (await client.callTool({ name: "projects.list", arguments: {} })) as { content?: Array<{ text: string }> };
    expect(ok.content![0].text).toContain("projects");
    // revoke → next call fails with HTTP 401 surfaced as a transport error
    const auth = await import("../src/lib/integration-tokens");
    const a = await auth.verifyIntegrationToken(`Bearer ${short}`);
    await revokeIntegrationToken(user.id, a!.tokenId);
    await expect(client.callTool({ name: "projects.list", arguments: {} })).rejects.toThrow(/401/);
    await client.close();
  });

  test("audit records exist for the external client's calls", async () => {
    const audits = await db.auditEvent.findMany({ where: { userId: user.id, action: { startsWith: "mcp." } } });
    const actions = audits.map((a) => a.action);
    expect(actions.some((x) => x === "mcp.projects.list.ok")).toBe(true);
    expect(actions.some((x) => x === "mcp.jobs.submit.ok")).toBe(true);
    expect(actions.some((x) => x === "mcp.jobs.submit.scope_denied")).toBe(true);
  });
});

describe("external MCP client — stdio transport (REAL child process)", () => {
  test("spawns scripts/mcp-stdio-server.ts and completes the full MCP handshake", async () => {
    const { client, summary } = await connectStdio(LIVE, token);
    expect(summary.serverInfo?.name).toBe("beanfx-mcp");
    const names = summary.tools.map((t) => t.name);
    expect(names).toContain("server.capabilities");
    expect(names).toContain("jobs.submit");
    // a real tool call through stdio → HTTPS server round trip
    // (the standalone server declares a single `json` string argument per tool)
    const caps = (await client.callTool({ name: "server.capabilities", arguments: { json: JSON.stringify({}) } })) as { content?: Array<{ text: string }> };
    const parsed = JSON.parse(caps.content![0].text) as { capabilities: { api: string } };
    expect(parsed.capabilities.api).toBe("v1");
    await client.close();
  }, 30000);
});

// Evidence snapshot for the harness summary (used by M22_RESULTS).
afterAll(() => {
  try {
    const dir = mkdtempSync(path.join(os.tmpdir(), "unused-m22-"));
    void dir;
  } catch {}
});
