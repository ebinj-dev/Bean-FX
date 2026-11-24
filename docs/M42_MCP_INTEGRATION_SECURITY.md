# M42 — MCP Integration & Security (documentation)

## Architecture (existing, reused — no duplicate system)

- **Tool registry**: `src/lib/mcp/tools.ts` — the shared M21 tool surface (`server.capabilities`, `projects.list`, `project.canonical`, `jobs.*`, MY AI bridge tools `myai.status` / `myai.execute`, and the M42-D read-only `ai.models.list`).
- **Approvals**: every MUTATING tool requires a one-time, hash-bound `McpApproval` (`consumeApproval`) — there is no approval-free execution path, for hosts or for the chat.
- **Desktop Bridge / SDK**: loopback-only bridge with device pairing (M21/M22); the bridge exposes the same tool registry.
- **MY AI orchestration bridge** (`src/lib/my-ai/orchestration/mcp-bridge.ts`): agents coordinate RIISHE/GANGZII/NIIKI/JAZMII/LAXII ONLY through these tools — no private backdoors.

## AI Edit Chat ↔ MCP

The chat's MCP indicator documents the real state: connected tool surfaces are discovered through `server.capabilities` / the tool registry; tool INVOCATION from prompts goes through the MY AI orchestration bridge with per-user authorization and hash-bound approvals. The chat never executes MCP tools directly against project data outside this surface.

## Security controls (spec §7.4/§19 — all existing + preserved)

- Server allowlist + per-user authorization (M22 security suites enforce).
- Project-scoped access: every tool resolves the caller's OWN projects (`userId` scoping at the DB layer).
- Tool capability validation + argument schema validation (zod schemas per tool).
- Request timeouts + output-size limits (gateway + job layer).
- Audit logs (`audit()` on mutations), secret redaction (M23 hygiene suites).
- Explicit confirmation for risky operations: mutating tools require approvals; the chat additionally requires explicit user approval for plans (approve → apply) and for render submission.
- Untrusted data rule: media, filenames, transcripts, web results, model responses and MCP outputs are DATA, never instructions — the planner context marks them as such; prompt injection cannot grant tool access.
- The canonical editing command system is the ONLY way chat-approved plans touch the timeline; MCP tools cannot bypass it.
