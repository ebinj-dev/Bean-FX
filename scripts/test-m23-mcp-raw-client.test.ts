/**
 * M23 P3 — SECOND independent MCP client (zero shared code with the server
 * or the SDK client): envelope compliance, discovery, auth, authorization,
 * approval lifecycle, revocation, error propagation, CONNECTION RECOVERY.
 * Run: bun test scripts/test-m23-mcp-raw-client.test.ts
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { RawMcpClient, rawArgsHash } from "./mcp-raw-client";
import { scratchLegacyDb } from "./legacy-fixture";

const LIVE = "http://localhost:3117";
process.env.NODE_ENV = "production";
process.env.DATABASE_URL = scratchLegacyDb("m23-mcp-raw-client"); // M34 Track B: isolated fixture, never db/custom.db

let db: typeof import("../src/lib/db").db;
let user: { id: string };
let token = "";
let projectId = "";

beforeAll(async () => {
  if (!(await (await fetch(`${LIVE}/`)).ok)) throw new Error(`live server ${LIVE} unavailable`);
  db = (await import("../src/lib/db")).db;
  const { createIntegrationToken } = await import("../src/lib/integration-tokens");
  user = await db.user.upsert({
    where: { id: "m23-raw-client-user" },
    update: {},
    create: { id: "m23-raw-client-user", email: "m23raw@test.local", passwordHash: "x", emailVerified: true },
  });
  token = (await createIntegrationToken(user.id, "m23-raw", ["projects:read", "jobs:submit", "jobs:read", "jobs:cancel", "media:upload", "mcp:invoke"])).raw;
  const project = await db.project.create({ data: { userId: user.id, name: "M23 raw client" } });
  projectId = project.id;
  await db.timelineVersion.create({
    data: {
      projectId, versionNumber: 1,
      sequenceJson: JSON.stringify({
        id: projectId, name: "M23 raw client", fps: { num: 25, den: 1 }, width: 1280, height: 720, sampleRate: 48000,
        tracks: [{ id: "t1", kind: "VIDEO", name: "V1", visible: true, muted: false, solo: false, locked: false }],
        clips: [], transitions: [],
      }),
      createdById: user.id,
    },
  });
}, 20000);

describe("raw (independent) MCP client — full compatibility matrix (M23 P3)", () => {
  test("envelope compliance: jsonrpc 2.0 + id echo + serverInfo", async () => {
    const c = new RawMcpClient(LIVE, token);
    const info = await c.initialize();
    expect(info.name).toBe("beanfx-mcp");
    expect(info.version).toBeTruthy();
    await c.close?.();
  });

  test("tool discovery = exactly the shared registry (nine core + M43-B commands surface)", async () => {
    const c = new RawMcpClient(LIVE, token);
    await c.initialize();
    const tools = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["ai.models.list", "commands.batch", "commands.describe", "commands.list", "commands.preview", "commands.run", "commands.validate", "jobs.cancel", "jobs.status", "jobs.submit", "myai.execute", "myai.status", "project.canonical", "projects.list", "server.capabilities"]);
  });

  test("tool invocation + project authorization", async () => {
    const c = new RawMcpClient(LIVE, token);
    await c.initialize();
    const caps = (await c.callTool("server.capabilities", {})) as { capabilities: { api: string } };
    expect(caps.capabilities.api).toBe("v1");
    const other = await db.user.upsert({ where: { id: "m23-raw-foreign" }, update: {}, create: { id: "m23-raw-foreign", email: "m23rawf@test.local", passwordHash: "x" } });
    const foreign = await db.project.create({ data: { userId: other.id, name: "raw-foreign" } });
    await expect(c.callTool("project.canonical", { projectId: foreign.id })).rejects.toThrow(/project not found/);
    await db.project.delete({ where: { id: foreign.id } });
  });

  test("authentication + malformed JSON-RPC error propagation", async () => {
    const bad = new RawMcpClient(LIVE, "bfx_" + "0".repeat(64));
    await expect(bad.initialize()).rejects.toThrow(/401/);
    const res = await fetch(`${LIVE}/api/v1/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: "]]broken" });
    const body = (await res.json()) as { error?: { code: number } };
    expect(body.error?.code).toBe(-32700);
  });

  test("one-time approval: hash binding, expiry, replay — via raw client", async () => {
    const { argsHash } = await import("../src/lib/mcp/tools");
    const args = { projectId };
    // raw hash helper must be byte-identical to the server's
    expect(rawArgsHash("jobs.submit", args)).toBe(argsHash("jobs.submit", args));
    const row = await db.mcpApproval.create({ data: { userId: user.id, action: "jobs.submit", payloadHash: argsHash("jobs.submit", args), expiresAt: new Date(Date.now() + 600000) } });
    const c = new RawMcpClient(LIVE, token);
    await c.initialize();
    const out = (await c.callTool("jobs.submit", { ...args, approvalId: row.id })) as { jobId: string; status: string };
    expect(out.status).toBe("QUEUED");
    await expect(c.callTool("jobs.submit", { ...args, approvalId: row.id })).rejects.toThrow(/already consumed/); // replay
    const row2 = await db.mcpApproval.create({ data: { userId: user.id, action: "jobs.submit", payloadHash: argsHash("jobs.submit", { projectId }), expiresAt: new Date(Date.now() - 1000) } });
    await expect(c.callTool("jobs.submit", { projectId, approvalId: row2.id })).rejects.toThrow(/approval expired|approval not found/); // expiry
    await c.close?.();
    await db.job.delete({ where: { id: out.jobId } });
    await db.mcpApproval.delete({ where: { id: row.id } }).catch(() => {});
    await db.mcpApproval.delete({ where: { id: row2.id } }).catch(() => {});
  });

  test("token revocation kills the raw client immediately", async () => {
    const { createIntegrationToken, revokeIntegrationToken, verifyIntegrationToken } = await import("../src/lib/integration-tokens");
    const short = (await createIntegrationToken(user.id, "m23-raw-revoke", ["projects:read", "mcp:invoke"])).raw;
    const c = new RawMcpClient(LIVE, short);
    await c.initialize();
    await c.callTool("projects.list", {});
    const auth = await verifyIntegrationToken(`Bearer ${short}`);
    await revokeIntegrationToken(user.id, auth!.tokenId);
    await expect(c.callTool("projects.list", {})).rejects.toThrow(/401/);
    await c.close?.();
  });

  test("connection recovery: close + reopen works; server state consistent", async () => {
    const c1 = new RawMcpClient(LIVE, token);
    await c1.initialize();
    const before = (await c1.callTool("projects.list", {})) as { projects: unknown[] };
    await c1.close?.();
    const c2 = new RawMcpClient(LIVE, token); // brand-new connection (new handshake)
    await c2.initialize();
    const after = (await c2.callTool("projects.list", {})) as { projects: unknown[] };
    expect(JSON.stringify(before.projects.map((p) => (p as { id: string }).id).sort()))
      .toBe(JSON.stringify(after.projects.map((p) => (p as { id: string }).id).sort()));
    await c2.close?.();
  });
});
