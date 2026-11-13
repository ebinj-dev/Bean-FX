/**
 * MCP-compatible server for BEAN FX (M8 §9A/§9B) — INDEPENDENT implementation.
 *
 * JSON-RPC 2.0 over HTTP POST. Supported methods:
 *  - initialize        → protocol version + capabilities + server info
 *  - notifications/initialized (acknowledged, no-op)
 *  - ping              → liveness
 *  - tools/list        → profile-filtered tool catalog (MCP tool schema)
 *  - tools/call        → run one catalog tool (auth, allowlist, rate limit, audit)
 * resources/prompts are intentionally NOT advertised (not implemented).
 *
 * Safety: Bearer automation-token auth (hashed lookup), read-only default,
 * editing tools gated by profile, optional per-token allowlists, sliding-window
 * rate limit per token, per-call timeout, audit rows, and NO token/credential
 * material in any response.
 */
import { verifyToken, type VerifiedToken } from "@/lib/automation/tokens";
import { TOOL_CATALOG, authorizeTool, runTool, type ToolContext } from "@/lib/automation/catalog";
import { redactSecrets } from "@/lib/my-ai/gateway/provider";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function ok(id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function err(id: JsonRpcRequest["id"], code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, data } };
}

// Sliding-window rate limit (per token id). Single-process deployment scale —
// documented; swap for a shared store when scaling out.
const RATE_MAX_PER_MIN = Number(process.env.BEANFX_MCP_RATE_PER_MIN ?? 120);
const rateWindow = new Map<string, number[]>();

function rateLimited(tokenId: string): boolean {
  const now = Date.now();
  const window = (rateWindow.get(tokenId) ?? []).filter((t) => now - t < 60_000);
  if (window.length >= RATE_MAX_PER_MIN) {
    rateWindow.set(tokenId, window);
    return true;
  }
  window.push(now);
  rateWindow.set(tokenId, window);
  return false;
}

const CALL_TIMEOUT_MS = Number(process.env.BEANFX_MCP_CALL_TIMEOUT_MS ?? 120_000);

function toolContext(vt: VerifiedToken): ToolContext {
  return { userId: vt.userId, profile: vt.profile, allowlist: vt.allowlist, clientLabel: `token:${vt.id}` };
}

function mcpToolSchemas(ctx: ToolContext): unknown[] {
  return TOOL_CATALOG.filter((t) => authorizeTool(t, ctx).ok).map((t) => ({
    name: t.name,
    title: t.title,
    description: `${t.description} [profile: ${t.profile}]`,
    inputSchema: { type: "object", properties: {}, additionalProperties: true }, // zod schemas are enforced server-side per call
  }));
}

/** Handle one JSON-RPC request batch (single or array). */
export async function handleMcpRequest(raw: unknown, authHeader: string | null): Promise<JsonRpcResponse | JsonRpcResponse[]> {
  const reqs = Array.isArray(raw) ? (raw as JsonRpcRequest[]) : [raw as JsonRpcRequest];
  const responses: JsonRpcResponse[] = [];
  for (const req of reqs) {
    responses.push(await handleOne(req, authHeader));
  }
  return responses.length === 1 ? responses[0] : responses;
}

async function handleOne(req: JsonRpcRequest, authHeader: string | null): Promise<JsonRpcResponse> {
  const id = req.id ?? null;
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return err(id, -32600, "Invalid JSON-RPC 2.0 request.");
  }
  // initialize is allowed WITHOUT a token so clients can discover the server;
  // everything else requires auth.
  if (req.method === "initialize") {
    return ok(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "bean-fx-mcp", title: "BEAN FX Automation (MCP)", version: "8.0.0" },
      instructions: "Authenticate with a Bearer automation token (profile: read-only or editing). Call tools/list to discover available tools.",
    });
  }
  if (req.method === "notifications/initialized") {
    return ok(id, {});
  }
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    return err(id, -32001, "Authentication required: pass a BEAN FX automation token as `Authorization: Bearer bfx_…`.");
  }
  const vt = await verifyToken(authHeader.slice(7).trim());
  if (!vt) return err(id, -32002, "Invalid or revoked automation token.");
  if (rateLimited(vt.id)) return err(id, -32003, `Rate limit exceeded (${RATE_MAX_PER_MIN} calls/min per token).`);

  switch (req.method) {
    case "ping":
      return ok(id, { pong: true, server: "bean-fx-mcp", time: new Date().toISOString() });
    case "tools/list": {
      const ctx = toolContext(vt);
      return ok(id, { tools: mcpToolSchemas(ctx) });
    }
    case "tools/call": {
      const params = (req.params ?? {}) as { name?: unknown; arguments?: unknown };
      if (typeof params.name !== "string") return err(id, -32602, "tools/call requires params.name (string).");
      const ctx = toolContext(vt);
      try {
        const result = await Promise.race([
          runTool(params.name, (params.arguments ?? {}) as Record<string, unknown>, ctx),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`tool call exceeded ${CALL_TIMEOUT_MS} ms`)), CALL_TIMEOUT_MS)),
        ]);
        if (result.ok) {
          return ok(id, { content: [{ type: "text", text: JSON.stringify(result.result) }], structuredContent: result.result, isError: false });
        }
        return ok(id, {
          content: [{ type: "text", text: redactSecrets(`${result.code}: ${result.error}`) }],
          isError: true,
          error: { code: result.code, message: redactSecrets(result.error) },
        });
      } catch (e) {
        return err(id, -32004, redactSecrets(e instanceof Error ? e.message.slice(0, 300) : "tool call failed"));
      }
    }
    default:
      return err(id, -32601, `Unknown method "${req.method}". Supported: initialize, notifications/initialized, ping, tools/list, tools/call.`);
  }
}
