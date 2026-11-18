/**
 * JSON-RPC automation API — POST /api/automation/rpc (M8 §9C).
 * Same tool catalog and token auth as the MCP transport; a simpler envelope
 * for scripts: {"method": "bean_...", "params": {...}} with optional "id".
 */
import { NextRequest, NextResponse } from "next/server";
import { verifyToken } from "@/lib/automation/tokens";
import { runTool } from "@/lib/automation/catalog";
import { redactSecrets } from "@/lib/my-ai/gateway/provider";

export const runtime = "nodejs";

interface RpcRequest {
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get("authorization") ?? "";
  const body = (await req.json().catch(() => null)) as RpcRequest | RpcRequest[] | null;
  if (!body) return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON body." } }, { status: 400 });
  const list = Array.isArray(body) ? body : [body];
  const out: unknown[] = [];
  for (const item of list) {
    const id = item?.id ?? null;
    if (typeof item?.method !== "string") {
      out.push({ jsonrpc: "2.0", id, error: { code: -32600, message: "method (string) required." } });
      continue;
    }
    if (item.method === "rpc.discover") {
      if (!auth.toLowerCase().startsWith("bearer ")) {
        out.push({ jsonrpc: "2.0", id, error: { code: -32001, message: "Authentication required (Authorization: Bearer bfx_…)." } });
        continue;
      }
      const vt = await verifyToken(auth.slice(7).trim());
      if (!vt) {
        out.push({ jsonrpc: "2.0", id, error: { code: -32002, message: "Invalid or revoked token." } });
        continue;
      }
      const { TOOL_CATALOG, authorizeTool } = await import("@/lib/automation/catalog");
      const ctx = { userId: vt.userId, profile: vt.profile, allowlist: vt.allowlist, clientLabel: `rpc:${vt.id}` };
      out.push({
        jsonrpc: "2.0",
        id,
        result: {
          tools: TOOL_CATALOG.filter((t) => authorizeTool(t, ctx).ok).map((t) => ({ name: t.name, title: t.title, description: t.description, profile: t.profile })),
        },
      });
      continue;
    }
    if (!auth.toLowerCase().startsWith("bearer ")) {
      out.push({ jsonrpc: "2.0", id, error: { code: -32001, message: "Authentication required (Authorization: Bearer bfx_…)." } });
      continue;
    }
    const vt = await verifyToken(auth.slice(7).trim());
    if (!vt) {
      out.push({ jsonrpc: "2.0", id, error: { code: -32002, message: "Invalid or revoked token." } });
      continue;
    }
    const ctx = { userId: vt.userId, profile: vt.profile, allowlist: vt.allowlist, clientLabel: `rpc:${vt.id}` };
    const result = await runTool(item.method, item.params ?? {}, ctx);
    if (result.ok) out.push({ jsonrpc: "2.0", id, result: result.result });
    else out.push({ jsonrpc: "2.0", id, error: { code: -32000, message: redactSecrets(result.error), data: { code: result.code } } });
  }
  return NextResponse.json(Array.isArray(body) ? out : out[0]);
}
