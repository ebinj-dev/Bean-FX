/**
 * M21 P4 — internal MCP stdio transport (real @modelcontextprotocol/sdk).
 * Usage: BEANFX_BASE_URL=http://localhost:3117 BEANFX_TOKEN=bfx_… bun scripts/mcp-stdio-server.ts
 * Speaks JSON-RPC over stdio with the SAME shared tool registry semantics —
 * the external HTTPS transport and this internal one are one implementation.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BeanFxClient } from "../src/lib/core/api-client";
import "../src/lib/mcp/bootstrap";
import { MCP_TOOLS, type McpToolDef } from "../src/lib/mcp/tools";

const BASE = process.env.BEANFX_BASE_URL ?? "http://localhost:3117";
const TOKEN = process.env.BEANFX_TOKEN ?? "";
if (!TOKEN.startsWith("bfx_")) {
  console.error("BEANFX_TOKEN (bfx_…) required");
  process.exit(2);
}

const client = new BeanFxClient({ baseUrl: BASE, token: TOKEN });
const server = new McpServer({ name: "beanfx-mcp", version: "1.0.0" });

/** Register every shared tool on the MCP server. Mutating tools surface the
 *  approval requirement in their description; arguments pass through 1:1. */
for (const tool of MCP_TOOLS as McpToolDef[]) {
  server.tool(tool.name, tool.description, { json: z.string().describe("JSON-encoded arguments object") }, async ({ json }) => {
    let args: Record<string, unknown> = {};
    try { args = json ? (JSON.parse(json) as Record<string, unknown>) : {}; } catch { return { content: [{ type: "text", text: "bad JSON arguments" }], isError: true }; }
    try {
      // Route through the server's HTTPS transport so scope/approval/audit
      // enforcement stays in exactly one place (the server, not the host).
      const res = await fetch(`${BASE}/api/v1/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}`, "X-BeanFX-Api-Version": "v1" },
        body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: tool.name, arguments: args } }),
      });
      const body = (await res.json()) as { result?: { content?: Array<{ type: string; json?: unknown }> }; error?: { code: number; message: string } };
      if (body.error) return { content: [{ type: "text", text: `MCP error ${body.error.code}: ${body.error.message}` }], isError: true };
      // Server returns MCP-standard text content carrying JSON.
      const rawText = body.result?.content?.[0]?.text;
      const parsedOut = rawText ? JSON.parse(rawText) : body.result?.content?.[0]?.json;
      return { content: [{ type: "text", text: JSON.stringify(parsedOut) }] };
    } catch (e) {
      return { content: [{ type: "text", text: e instanceof Error ? e.message : "transport failure" }], isError: true };
    }
  });
}

await server.connect(new StdioServerTransport());
console.error(`beanfx-mcp stdio ready → ${BASE} (token ${TOKEN.slice(0, 12)}…)`);
