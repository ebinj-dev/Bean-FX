/**
 * M23 P3 — SECOND, independent MCP client implementation (no MCP SDK).
 * Hand-rolled JSON-RPC 2.0 over HTTP: proves BEAN FX MCP compliance against
 * an implementation that shares zero code with the server or the SDK client.
 * Also used to verify connection recovery and error propagation.
 */
import { createHash, randomUUID } from "node:crypto";

export interface RawTool { name: string; description?: string }

export class RawMcpClient {
  private nextId = 0;
  private initialized = false;
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly clientName = "m23-raw-client",
  ) {}

  private async rpc<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.nextId += 1;
    const id = this.nextId;
    const res = await fetch(`${this.baseUrl}/api/v1/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}`, "X-BeanFX-Api-Version": "v1" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }),
    });
    if (res.status !== 200) throw new Error(`http ${res.status}`);
    const body = (await res.json()) as { jsonrpc?: string; id?: number; result?: T; error?: { code: number; message: string } };
    if (body.jsonrpc !== "2.0" || body.id !== id) throw new Error("non-JSON-RPC-compliant response envelope");
    if (body.error) {
      const e = new Error(`${body.error.code}: ${body.error.message}`);
      (e as Error & { code?: number }).code = body.error.code;
      throw e;
    }
    return body.result as T;
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<number> {
    const res = await fetch(`${this.baseUrl}/api/v1/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}`, "X-BeanFX-Api-Version": "v1" },
      body: JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }),
    });
    return res.status; // notifications expect 202 Accepted
  }

  async initialize(): Promise<{ name: string; version: string }> {
    const result = await this.rpc<{ serverInfo?: { name: string; version: string } }>("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: this.clientName, version: "1.0.0" },
    });
    const status = await this.notify("notifications/initialized");
    if (status !== 202 && status !== 200) throw new Error(`notification status ${status}`);
    this.initialized = true;
    return result.serverInfo ?? { name: "unknown", version: "unknown" };
  }

  /** Stateless HTTP transport — nothing to close. */
  async close(): Promise<void> {}

  requireInitialized(): void {
    if (!this.initialized) throw new Error("client not initialized");
  }

  async listTools(): Promise<RawTool[]> {
    this.requireInitialized();
    const r = await this.rpc<{ tools?: RawTool[] }>("tools/list");
    return r.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    this.requireInitialized();
    const r = await this.rpc<{ content?: Array<{ type: string; text?: string }> }>("tools/call", { name, arguments: args });
    const text = r.content?.[0]?.text;
    return text ? JSON.parse(text) : r;
  }
}

/** Args hash — deep-sorted, byte-identical to the server's argsHash. */
function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, val]) => [k, sortDeep(val)]));
  }
  return v;
}

export function rawArgsHash(action: string, args: Record<string, unknown>): string {
  return createHash("sha256").update(`${action}:${JSON.stringify(sortDeep(args))}`).digest("hex");
}

export function rawNonce(): string {
  return randomUUID().replace(/-/g, "");
}
