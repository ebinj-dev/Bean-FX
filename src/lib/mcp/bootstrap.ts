/**
 * M21 P4+P7 — one-time tool registration for BOTH MCP transports.
 * Import this module (side effect) before serving MCP requests so the
 * stdio server and the HTTPS route share the exact same registry.
 */
import { registerTools } from "./tools";
import { MYAI_TOOLS } from "@/lib/my-ai/orchestration/mcp-bridge";

let done = false;
export function ensureMcpTools(): void {
  if (!done) {
    registerTools(MYAI_TOOLS);
    done = true;
  }
}
ensureMcpTools();
