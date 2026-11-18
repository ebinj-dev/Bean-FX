# M21 RESULTS — BEAN FX Core SDK & Integration Architecture

**Status: IMPLEMENTED AND VERIFIED (all seven phases, test-proven).** No merge to main, no deployment, no M22. The shared Core SDK is now the foundation for Studio, the Premiere panel, the Desktop Bridge and MCP — one registry, one approval model, no per-host AI systems, no Ollama.

## Phase results (all numbers are this session's measured values)

| Phase | Deliverable | Tests | Evidence |
|---|---|---|---|
| P1 | `@beanfx/core`: timebase (BigInt-exact), contracts, api-client, jobs | 19/19 | `download/m21-logs/test-m21-core.log` |
| P2 | Integration tokens + `/api/v1/*` + 426 version gate | 7/7 lib + live HTTP via bridge | `download/m21-logs/test-m21-tokens.log` |
| P3 | Canonical project format v1 + lossless converters | covered in P1 suite (round-trip + unknown-field preservation) | same |
| P4 | MCP: shared registry (8 tools), JSON-RPC HTTPS route, stdio transport, hash-bound one-time approvals, full audit | 8/8 | `download/m21-logs/test-m21-mcp.log` |
| P5 | Premiere UXP adapter + panel (honest capability probing) | 8/8 | `download/m21-logs/test-m21-premiere.log` |
| P6 | Desktop Bridge (loopback-only, proof-of-possession, fail-closed pairing) | 8/8 incl. live server | `download/m21-logs/test-m21-bridge.log` |
| P7 | MY AI orchestration through shared primitives | 5/5 | `download/m21-logs/test-m21-myai.log` |

## 1. Core SDK architecture and public interfaces

`src/lib/core/` — pure TypeScript, no UI, no DB access:
- **timebase.ts** — exact rational time: frames ↔ seconds (BigInt rationals), frames ↔ Premiere ticks (254016000/s, verified `1 frame @23.976 = 10594584 ticks`), audio sample bounds (floor start / ceil end — ranges never shrink); nearest-ties-away rounding, documented; property-tested over all 8 standard rates (23.976/24/25/29.97/30/50/59.94/60) to 10^6 frames.
- **types.ts** — project roles (`owner/editor/reviewer/viewer`), token scopes (`projects:read/write`, `jobs:submit/read/cancel`, `media:upload`, `mcp:invoke`) with scope→role NARROWING (a token can never widen its owner's power), capability descriptors, `beanfx-asset://` refs, job contracts mirroring the M20 durable pipeline exactly (QUEUED/PROCESSING/…), ±1-minor compatibility window.
- **project-schema.ts** — canonical `beanfx-project-v1` (Zod, passthrough): unknown fields PRESERVED through re-parse (forward compatibility), assets with provenance, reversible edit-op journal.
- **converters.ts** — Studio `Sequence` ↔ canonical, lossless beyond schema normalization; conversion failures never mutate inputs (tested).
- **host-adapter.ts** — THE host contract: import/export/applyOp/resolveMedia/restoreSnapshot; op inverse builder; `checkBaseVersion` CAS gate (stale baseVersion never applies — machine-readable conflict); MockHost for contract tests.
- **api-client.ts** — typed client (Bearer token, `X-BeanFX-Api-Version`), capability negotiation (426 on format mismatch), `waitForJob` with deadline.

## 2. API v1 implementation (P2)

- `IntegrationToken` (additive Prisma model): raw token `bfx_<64 hex>` (256-bit), ONLY sha256 stored, timing-safe verify, immediate revocation, TTL expiry, 60s-throttled `lastUsedAt`, **deleted-owner lockout carries over** (M19). Audit events on create/revoke (raw token never logged).
- Routes (all scope-enforced + version-gated): `GET /api/v1/capabilities` (open to any authenticated surface), `GET /api/v1/projects`, `GET /api/v1/projects/:id/canonical` (canonical export with baseVersion = latest timeline version), `POST /api/v1/jobs` (**SAME durable render pipeline** — hosts get no private lane; attribution `token:<id>`), `GET/DELETE /api/v1/jobs/:id` (guarded cancel: only QUEUED/PROCESSING). Session-auth management at `/api/account/tokens` (raw shown once). `426 UPGRADE_REQUIRED` for unsupported version headers.

## 3. Canonical project format (P3)

`beanfx-project-v1`: fps as exact rational; integer-frame times; asset refs canonical; tracks carry the FULL Studio kind union (VIDEO/AUDIO/CAPTION/GRAPHIC/OVERLAY — no track ever dropped); clips preserve transforms/captions/effects/keyframes/graphic styles; `editOps[]` journal; `baseVersion` for optimistic concurrency. Round-trip property tests over a full-feature fixture (fades, speed 2×, captions, keyframes, transitions, missing-media placeholders).

## 4. MCP tools and security (P4)

One registry (`src/lib/mcp/tools.ts`), two transports (POST `/api/v1/mcp` JSON-RPC 2.0 for external agents with `mcp:invoke` scope; stdio via real `@modelcontextprotocol/sdk` for internal use) — the stdio server PROXIES through the HTTPS route so enforcement lives in exactly one place. Tools: `server.capabilities`, `projects.list`, `project.canonical`, `jobs.status` (read) + `jobs.submit`, `jobs.cancel` (mutating) + `myai.status`, `myai.execute` (P7). Mutations require a **one-time, hash-bound, 15-min-TTL `McpApproval`** created by the human in the web session (`POST /api/mcp/approvals`): arguments-changed → rejected; reuse → rejected (race-safe consumedAt); foreign project → rejected. Every call audited (`mcp.<tool>.<verdict>`). No shell/exec tool exists; arbitrary code execution is impossible by construction.

## 5. Premiere UXP integration — verified host capabilities (P5)

`src/lib/premiere/uxp-adapter.ts` + panel skeleton (`src/integrations/premiere-panel/`: manifest v7, panel, html — Premiere Pro 24+). **Honesty contract, tested:** outside the UXP runtime the adapter detects absence and EVERY host call fails loudly (`hostUnavailable`) — nothing is simulated; capabilities list ONLY implemented features (`canonical.import/export`, `metadata media resolver`, `op journal`, `snapshots`) and ops (`INSERT_CLIP/DELETE_CLIP/MOVE_CLIP/SET_CLIP_PROPS`); direct timeline writes, GPU effects and local AI inference are NEVER claimed. Import enriches canonical projects with verified active-sequence metadata (dimensions/fps/sampleRate). Failed ops restore the pre-op snapshot (host state untouched, tested). Runtime verification against real Premiere requires OWNER ACTION (UXP dev host not available in this sandbox).

## 6. Desktop Bridge (P6)

`scripts/desktop-bridge.ts` — real Bun loopback service: binds **127.0.0.1 only, ephemeral port** (external bind refused by `assertLoopbackBind`); pairing probes the token against the live server **before storing** (fail-closed, tested with an unknown token); state file 0600; local callers authenticate by HMAC proof-of-possession (device token never crosses the wire after pairing; single-use 60s challenges); `/api/*` proxies to `/api/v1/*` with the SAME scope/quota/isolation as any other caller; LRU media cache reaper (budget-tested). Live tests ran against the production server on :3117 — this simultaneously verified the P2 v1 routes over real HTTP. Device token never appears in any endpoint response (tested). OS keychain integration is platform-specific OWNER ACTION (file perms are the sandbox-safe floor).

## 7. MY AI integration (P7)

`myai.status` exposes the engine registry — **exactly RIISHE, GANGZII, NIIKI, JAZMII, LAXII** (the single source of truth; no per-host AI) — plus the caller's plan status. `myai.execute` runs the SAME web executor (`executePlan`) under a one-time hash-bound approval; agents can never execute without the human gate; foreign plans invisible. Registration is de-duplicated (one shared registry for both transports).

## 8. Regression results (M1–M21, this session)

- M21 suites: 55 tests across 6 files, **0 fail** (`download/m21-logs/test-m21-*.log`).
- M1–M20: 18 suites (editor commands/time/regressions/interaction/preview, filler lexicon, AI registry, GANGZII DSP + analysis, export safety, ASR adapter + chunk cache, JAZMII, automation API + MCP, creative core, M19 security 21/21, M20 mail 4/4) — **all exit 0**.
- Durable T1 on the final build: **39.9s PASS** (`download/m21-logs/t1-current-build.log`); full T1–T7 8/8 evidence remains run 11 (render path unchanged).
- A/V sync: mean **-0.052s**, 5/5 markers (`download/m21-logs/sync-regression.log`).
- tsc 0 errors · eslint clean · prisma valid · OSV 0 vulns · webpack production build exit 0 (servers stopped during build; both restarted, worker probe PASS).
- Full M20 evidence set (journey 30/30, concurrency smoke, PG drill, secret scan) carries over — no M1–M20 behavior changed.

## 9. Known limitations (explicit, not hidden)

- **Premiere runtime**: adapter/panel are complete source but need real Premiere Pro 24+ UXP verification — OWNER ACTION. Never claims unverified capabilities.
- **OS keychain**: bridge stores the device token 0600; keychain hooks are platform work — OWNER ACTION.
- **npm publishing**: `@beanfx/core` is a workspace-internal package (hosts consume source/monorepo); publishing is an INFRASTRUCTURE/AUTHORING step, not done here.
- **MCP `tools/list` inputSchema**: descriptive (type: object) — full JSON-schema generation per tool is future polish; enforcement is zod-based server-side and fully active.
- **Capacity**: no user-capacity claims from sandbox numbers (M20 rule holds).
- **External config**: SMTP provider, staging host, legal review — unchanged from M20 §7 (CONFIGURATION / OWNER ACTION / LEGAL REVIEW REQUIRED).
