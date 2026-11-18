# M22 OWNER ACTIONS — required on YOUR machine for real-host completion

## A. Premiere Pro real-host validation (M22 P1) — OWNER ACTION REQUIRED
1. Install **Adobe UXP Developer Tool** (UDT) from Creative Cloud (Windows/macOS only).
2. In UDT: **Add Plugin** → select `src/integrations/premiere-panel/manifest.xml`.
3. **Load** the panel → Premiere Pro 24+ opens → `Window > Extensions > BEAN FX`.
4. Open any project with a sequence; in the panel dev console run:
   `window.beanfxHarness.runAll()`
5. The harness writes `beanfx-m22-harness-results.json` to the plugin data
   folder and prints the same JSON. Send that file back — it classifies each
   check VERIFIED/FAILED/SKIPPED against the REAL host.
6. Also exercise the panel buttons (Send sequence → BEAN FX) and confirm the
   `hostUnavailable` behavior is only ever shown when the runtime is absent.
Evidence expected: screenshots of the panel loaded in Premiere + the JSON.

## B. Windows Credential Manager live test (M22 P2) — OWNER ACTION REQUIRED
1. On Windows: `set BEANFX_BRIDGE_STATE_DIR=%TEMP%\beanfx-bridge` then
   `bun scripts/desktop-bridge.ts` — the startup JSON must show
   `"credentialProvider":"windows-credman"`.
2. Pair, then check Windows **Credential Manager** (Control Panel → Credential
   Manager → Windows Credentials) for the entry **"BEAN FX Bridge"**.
3. Run one proxy request and confirm operation. No plaintext fallback should
   appear anywhere; the state file must not contain `bfx_` tokens.
(On macOS/Linux the equivalent keychain providers use `security`/`secret-tool`
 and can be verified the same way.)

## C. Live JAZMII/LAXII provider generation (M22 P4) — CONFIGURATION REQUIRED
The provider path (z-ai CLI) is wired and the failure handling is verified
(real 406 from the service → typed ProviderError → no false success). To run
a REAL generation end-to-end the deployment needs provider access enabled for
the configured account (quota/region). Re-run:
`bun test scripts/test-m22-myai-orchestration.test.ts` from the server —
the last test classifies VERIFIED when a task is accepted.

## D. External MCP clients beyond the harness (M22 P3)
Any MCP-compatible client (Claude Desktop, Cursor, etc.) can connect:
- stdio: `BEANFX_BASE_URL=… BEANFX_TOKEN=bfx_… bun scripts/mcp-stdio-server.ts`
- HTTPS: POST JSON-RPC to `/api/v1/mcp` with `Authorization: Bearer bfx_…`
Approvals are created in the web UI (session) at `POST /api/mcp/approvals`.

## E. Not carried over from M20 (still open)
SMTP provider, staging host, legal review — unchanged from M20 §7.
