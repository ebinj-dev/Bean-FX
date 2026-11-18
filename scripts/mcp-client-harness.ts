/**
 * M22 P3 — REAL external MCP client harness (no simulation).
 * Uses the official @modelcontextprotocol/sdk Client with two transports:
 *  - JsonRpcHttpTransport: genuine out-of-process HTTP JSON-RPC 2.0 client
 *    POSTing to /api/v1/mcp with a bfx_ integration token
 *  - StdioClientTransport: spawns scripts/mcp-stdio-server.ts as a REAL
 *    child process and speaks JSON-RPC over stdio
 * The client runs as its own process (bun scripts/mcp-client-harness.ts) —
 * it is NOT wired into the server and cannot bypass any control.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/** Minimal Transport impl: every send() is one HTTP JSON-RPC round trip. */
export class JsonRpcHttpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: unknown) => void;
  private seq = 0;
  constructor(private readonly baseUrl: string, private readonly token: string) {}

  async start(): Promise<void> {}
  async close(): Promise<void> {
    this.onclose?.();
  }

  async send(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    const isNotification = message.id === undefined;
    const res = await fetch(`${this.baseUrl}/api/v1/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
        "X-BeanFX-Api-Version": "v1",
      },
      body: JSON.stringify({ ...message, jsonrpc: "2.0" }),
    });
    const text = await res.text();
    if (isNotification) {
      // JSON-RPC notifications expect NO response payload (202 Accepted).
      if (res.status !== 202 && res.status !== 200) throw new Error(`http ${res.status}`);
      return {};
    }
    if (res.status !== 200) {
      throw new Error(`http ${res.status}: ${text.slice(0, 120)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`non-JSON response (${res.status}): ${text.slice(0, 120)}`);
    }
    this.onmessage?.(parsed);
    const body = parsed as { result?: Record<string, unknown>; error?: { code: number; message: string } };
    if (body.error) {
      const e = new Error(`MCP error ${body.error.code}: ${body.error.message}`);
      (e as Error & { code?: number }).code = body.error.code;
      throw e;
    }
    return body.result ?? {};
  }
}

export interface ClientSummary {
  serverVersion?: { name: string; version: string } | null;
  serverInfo?: { name: string; version: string };
  tools: Array<{ name: string; mutates?: boolean; scope?: string }>;
  capabilitiesRead: unknown;
}

/** Connect over HTTPS, initialize, list tools, read capabilities. */
export async function connectHttp(baseUrl: string, token: string): Promise<{ client: Client; summary: ClientSummary }> {
  const transport = new JsonRpcHttpTransport(baseUrl, token);
  const client = new Client({ name: "m22-external-client", version: "1.0.0" });
  await client.connect(transport as unknown as Transport);
  const init = (await client.getServerVersion()) as { protocolVersion?: string; name?: string; version?: string } | null;
  const tools = (await client.listTools()).tools as Array<{ name: string; description?: string }>;
  const caps = (await client.callTool({ name: "server.capabilities", arguments: {} })) as { content?: Array<{ type: string; text?: string }> };
  const capsJson = JSON.parse(caps.content?.[0]?.text ?? "{}") as unknown;
  // Mutating tools carry a [MUTATING …] marker in their description (SDK
  // strips non-standard annotation fields — the description survives).
  return {
    client,
    summary: {
      serverVersion: init ? { name: init.name ?? "unknown", version: init.version ?? "unknown" } : null,
      serverInfo: { name: init?.name ?? "unknown", version: init?.version ?? "unknown" },
      tools: tools.map((t) => ({ name: t.name, mutates: t.description?.includes("[MUTATING") ?? false })),
      capabilitiesRead: capsJson,
    },
  };
}

/** Connect over stdio (real child process of scripts/mcp-stdio-server.ts). */
export async function connectStdio(baseUrl: string, token: string): Promise<{ client: Client; summary: ClientSummary }> {
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["scripts/mcp-stdio-server.ts"],
    cwd: "/home/z/my-project",
    env: { ...process.env, BEANFX_BASE_URL: baseUrl, BEANFX_TOKEN: token } as Record<string, string>,
  });
  const client = new Client({ name: "m22-external-client-stdio", version: "1.0.0" });
  await client.connect(transport);
  const init = (await client.getServerVersion()) as { protocolVersion?: string; name?: string; version?: string } | null;
  const tools = (await client.listTools()).tools as Array<{ name: string }>;
  return {
    client,
    summary: {
      serverVersion: init ? { name: init.name ?? "unknown", version: init.version ?? "unknown" } : null,
      serverInfo: { name: init?.name ?? "unknown", version: init?.version ?? "unknown" },
      tools: tools.map((t) => ({ name: t.name })),
      capabilitiesRead: null,
    },
  };
}
