/**
 * MCP transport — POST /api/automation/mcp (JSON-RPC 2.0, M8 §9A).
 * GET returns an honest capability hint (no auth bypass).
 */
import { NextRequest, NextResponse } from "next/server";
import { handleMcpRequest } from "@/lib/automation/mcp/server";

export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    server: "bean-fx-mcp",
    transport: "http-post-jsonrpc-2.0",
    auth: "Authorization: Bearer bfx_… automation token (create one in Settings → Automation)",
    protocol: "2025-06-18",
    methods: ["initialize", "notifications/initialized", "ping", "tools/list", "tools/call"],
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.json().catch(() => null);
  if (body === null) {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON body." } }, { status: 400 });
  }
  const response = await handleMcpRequest(body, req.headers.get("authorization"));
  return NextResponse.json(response);
}
