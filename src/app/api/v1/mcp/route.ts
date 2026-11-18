/**
 * M21 P4 — POST /api/v1/mcp — external MCP transport (JSON-RPC 2.0).
 * Auth: integration token with scope mcp:invoke (§7). Methods:
 *   initialize  → protocol + capability handshake
 *   tools/list  → shared registry
 *   tools/call  → shared registry (approval gates enforced inside)
 * Ping-style requests get a structured error, never a silent hang.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiVersionGuard, verifyIntegrationToken, tokenHasScope } from "@/lib/integration-tokens";
import { callTool, McpError, toolListPayload } from "@/lib/mcp/tools";
import "@/lib/mcp/bootstrap";
import { SERVER_CAPABILITIES } from "@/lib/core/types";

export const runtime = "nodejs";

const RpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().min(1).max(80),
  params: z.record(z.string(), z.unknown()).optional(),
});

function rpcResult(id: string | number | undefined, result: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, result });
}
function rpcError(id: string | number | undefined, code: number, message: string) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

export async function POST(req: NextRequest) {
  const guard = apiVersionGuard(req.headers.get("x-beanfx-api-version"));
  if (!guard.ok) return NextResponse.json({ code: guard.code, error: guard.error }, { status: guard.status });
  const t = await verifyIntegrationToken(req.headers.get("authorization"));
  if (!t) return NextResponse.json({ code: "UNAUTHORIZED", error: "Valid integration token (scope mcp:invoke) required." }, { status: 401 });
  if (!tokenHasScope(t, "mcp:invoke")) {
    return NextResponse.json({ code: "FORBIDDEN", error: "Scope mcp:invoke required." }, { status: 403 });
  }
  const parsed = RpcRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return rpcError(undefined, -32700, "parse error");

  const { id, method, params } = parsed.data;
  try {
    switch (method) {
      case "initialize":
        return rpcResult(id, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "beanfx-mcp", version: SERVER_CAPABILITIES.api },
          beanfx: SERVER_CAPABILITIES,
        });
      case "tools/list":
        return rpcResult(id, toolListPayload());
      case "tools/call": {
        const p = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
        if (!p.name) return rpcError(id, -32602, "params.name required");
        const out = await callTool({ auth: t }, p.name, p.arguments ?? {});
        return rpcResult(id, { content: [{ type: "json", json: out }], isError: false });
      }
      default:
        return rpcError(id, -32601, `method not found: ${method}`);
    }
  } catch (e) {
    if (e instanceof McpError) return rpcError(id, e.code, e.message);
    return rpcError(id, -32000, e instanceof Error ? e.message : "internal error");
  }
}
