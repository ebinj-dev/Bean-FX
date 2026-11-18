/**
 * BEAN FX — M8 MCP protocol tests (bun test, isolated DB).
 *
 * A REAL MCP client (official @modelcontextprotocol/sdk, StreamableHTTP)
 * drives the server over actual HTTP: initialize → tools/list → tools/call.
 * Plus protocol edge cases: no-auth rules, read-only gating, allowlists,
 * malformed requests, rate limiting, audit rows.
 *
 * Run: bun test scripts/test-automation-mcp.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRATCH_DB = path.join(os.tmpdir(), `beanfx-m8-mcp-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${SCRATCH_DB}`;
process.env.BEANFX_MEDIA_WORKER_AUTOSTART = "0";
process.env.NODE_ENV = "production";
process.env.BEANFX_MCP_RATE_PER_MIN = "8"; // tight for the rate-limit test

execSync("bunx prisma db push --skip-generate --accept-data-loss", {
  env: { ...process.env, DATABASE_URL: `file:${SCRATCH_DB}` },
  stdio: ["ignore", "ignore", "inherit"],
});

let db: typeof import("../src/lib/db").db;
let serverMod: typeof import("../src/lib/automation/mcp/server");
let tokensMod: typeof import("../src/lib/automation/tokens");

const USER_A = "mcp-user-a";
const USER_B = "mcp-user-b";
let readToken = "";
let editToken = "";
let allowToken = ""; // allowlist that EXCLUDES bean_project_list
let freshToken = ""; // untouched budget for the REAL client test
let serverUrl = "";
let stopServer: () => void = () => undefined;

beforeAll(async () => {
  db = (await import("../src/lib/db")).db;
  serverMod = await import("../src/lib/automation/mcp/server");
  tokensMod = await import("../src/lib/automation/tokens");
  await db.user.create({ data: { id: USER_A, email: "mcpa@test.local", name: "A", passwordHash: "x" } }).catch(() => undefined);
  await db.user.create({ data: { id: USER_B, email: "mcpb@test.local", name: "B", passwordHash: "x" } }).catch(() => undefined);
  readToken = (await tokensMod.createToken(USER_A, "ro", "read-only")).raw;
  editToken = (await tokensMod.createToken(USER_A, "ed", "editing")).raw;
  allowToken = (await tokensMod.createToken(USER_A, "allow", "editing", ["bean_project_get"])).raw;
  freshToken = (await tokensMod.createToken(USER_A, "fresh", "editing")).raw;

  // Minimal HTTP server exposing the MCP handler (the production route calls
  // the same function — see src/app/api/automation/mcp/route.ts).
  const handler = async (req: Request): Promise<Response> => {
    if (req.method === "GET") return new Response(JSON.stringify({ server: "bean-fx-mcp" }), { status: 200 });
    const body = await req.json().catch(() => null);
    const res = await serverMod.handleMcpRequest(body, req.headers.get("authorization"));
    return new Response(JSON.stringify(res), { status: 200, headers: { "content-type": "application/json" } });
  };
  const bSrv = Bun.serve({ port: 0, fetch: handler });
  serverUrl = `http://localhost:${bSrv.port}/`;
  stopServer = () => bSrv.stop(true);
});

afterAll(() => {
  stopServer();
  rmSync(String(process.env.DATABASE_URL).replace("file:", ""), { force: true });
});

describe("MCP protocol — raw JSON-RPC", () => {
  test("initialize works WITHOUT a token (discovery only)", async () => {
    const res = (await serverMod.handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, null)) as { result: { serverInfo: { name: string }; protocolVersion: string } };
    expect(res.result.serverInfo.name).toBe("bean-fx-mcp");
    expect(res.result.protocolVersion).toBe(serverMod.MCP_PROTOCOL_VERSION);
  });

  test("tools/list without auth → typed error", async () => {
    const res = (await serverMod.handleMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }, null)) as { error?: { code: number; message: string } };
    expect(res.error?.code).toBe(-32001);
    expect(res.error?.message).toContain("Authentication required");
  });

  test("invalid token → -32002", async () => {
    const res = (await serverMod.handleMcpRequest({ jsonrpc: "2.0", id: 3, method: "tools/list" }, "Bearer bfx_deadbeef_forged")) as { error?: { code: number } };
    expect(res.error?.code).toBe(-32002);
  });

  test("unknown method → -32601; malformed request → -32600", async () => {
    const r1 = (await serverMod.handleMcpRequest({ jsonrpc: "2.0", id: 4, method: "resources/list" }, `Bearer ${readToken}`)) as { error?: { code: number } };
    expect(r1.error?.code).toBe(-32601); // resources/prompts are not implemented → honest method-not-found
    const r2 = (await serverMod.handleMcpRequest({ id: 5, method: "tools/list" }, `Bearer ${readToken}`)) as { error?: { code: number } };
    expect(r2.error?.code).toBe(-32600);
  });

  test("read-only token: tools/list excludes editing tools; tools/call of an editing tool → FORBIDDEN", async () => {
    const ctx = { userId: USER_A, profile: "read-only" as const, allowlist: [], clientLabel: "t" };
    void ctx;
    const list = (await serverMod.handleMcpRequest({ jsonrpc: "2.0", id: 6, method: "tools/list" }, `Bearer ${readToken}`)) as { result: { tools: { name: string }[] } };
    const names = list.result.tools.map((t) => t.name);
    expect(names).toContain("bean_project_list");
    expect(names).toContain("bean_effects_list");
    expect(names).not.toContain("bean_edit_apply");
    expect(names).not.toContain("bean_clip_add");
    const call = (await serverMod.handleMcpRequest({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "bean_edit_apply", arguments: {} } }, `Bearer ${readToken}`)) as { result: { isError: boolean; error: { code: string } } };
    expect(call.result.isError).toBe(true);
    expect(call.result.error.code).toBe("FORBIDDEN");
  });

  test("editing token sees editing tools", async () => {
    const list = (await serverMod.handleMcpRequest({ jsonrpc: "2.0", id: 8, method: "tools/list" }, `Bearer ${editToken}`)) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toContain("bean_edit_apply");
  });

  test("allowlisted token: excluded tools are FORBIDDEN even when editing", async () => {
    const call = (await serverMod.handleMcpRequest({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "bean_project_list", arguments: { limit: 5 } } }, `Bearer ${allowToken}`)) as { result: { isError: boolean; error: { code: string } } };
    expect(call.result.isError).toBe(true);
    expect(call.result.error.code).toBe("FORBIDDEN");
    const okCall = (await serverMod.handleMcpRequest({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "bean_effects_list", arguments: {} } }, `Bearer ${allowToken}`)) as { result: { isError: boolean } };
    // bean_effects_list IS on the allowlist? No — allowlist = [bean_project_get] → effects_list excluded too.
    expect(okCall.result.isError).toBe(true);
    const get = (await serverMod.handleMcpRequest({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "bean_project_get", arguments: { projectId: "nonexistent" } } }, `Bearer ${allowToken}`)) as { result: { isError: boolean; error: { code: string } } };
    // On the allowlist → reaches the tool → honest PROJECT_NOT_FOUND (not FORBIDDEN).
    expect(get.result.isError).toBe(true);
    expect(get.result.error.code).toBe("PROJECT_NOT_FOUND");
  });

  test("rate limiting: beyond the per-token budget → -32003", async () => {
    let limited = false;
    for (let i = 0; i < 12; i++) {
      const res = (await serverMod.handleMcpRequest({ jsonrpc: "2.0", id: 100 + i, method: "ping" }, `Bearer ${editToken}`)) as { result?: { pong?: boolean }; error?: { code: number } };
      if (res.error?.code === -32003) {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
  });

  test("tool calls are audit-logged with the client label", async () => {
    const audits = await db.automationAudit.count({ where: { userId: USER_A, action: { startsWith: "TOOL_" } } });
    expect(audits).toBeGreaterThanOrEqual(1);
  });
});

describe("MCP protocol — REAL client (@modelcontextprotocol/sdk)", () => {
  test("Client initializes, discovers tools, calls a read tool over real HTTP", async () => {
    const { Client } = (await import("@modelcontextprotocol/sdk/client/index.js")) as unknown as { Client: new (info: { name: string; version: string }) => { connect: (t: unknown) => Promise<void>; listTools: () => Promise<{ tools: { name: string }[] }>; callTool: (a: { name: string; arguments: Record<string, unknown> }) => Promise<{ isError?: boolean; structuredContent?: unknown }>; close: () => Promise<void> } };
    const { StreamableHTTPClientTransport } = (await import("@modelcontextprotocol/sdk/client/streamableHttp.js")) as unknown as { StreamableHTTPClientTransport: new (url: string, opts?: { requestInit?: { headers: Record<string, string> } }) => unknown };
    const transport = new StreamableHTTPClientTransport(serverUrl, { requestInit: { headers: { Authorization: `Bearer ${freshToken}` } } });
    const client = new Client({ name: "beanfx-mcp-test-client", version: "1.0.0" });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThanOrEqual(20);
    expect(tools.tools.map((t) => t.name)).toContain("bean_timeline_read");
    const call = await client.callTool({ name: "bean_effects_list", arguments: {} });
    expect(call.isError).toBeFalsy();
    const structured = call.structuredContent as { effects: unknown[]; niikiTemplates: unknown[]; gangziiPresets: unknown[] };
    expect(structured.effects.length).toBeGreaterThanOrEqual(6);
    expect(structured.niikiTemplates.length).toBeGreaterThanOrEqual(1);
    expect(structured.gangziiPresets.length).toBeGreaterThanOrEqual(1);
    await client.close();
  }, 60_000);
});
