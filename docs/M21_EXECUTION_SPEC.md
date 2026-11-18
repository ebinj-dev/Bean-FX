# M21 Execution Specification — BEAN FX Core SDK & Integration Architecture

**Status:** DELIVERED (2026-11-18) — all 13 scope areas implemented and test-proven across phases P1–P7; see `M21_RESULTS.md` for measured results and limitations. The original plan below is preserved for traceability. This document turns `BEAN_FX_ECOSYSTEM_ARCHITECTURE.md` into an execution plan: scope items, concrete deliverables, and acceptance criteria per item. One shared Core SDK; no per-host AI systems; no Ollama. M20 (production readiness, `0.3.0-m20-rc1`) is closed and pushed; M21 builds on it without touching M1–M20 behavior.

## Execution order (proposed phases, each independently shippable)

| Phase | Deliverable | Depends on |
|---|---|---|
| P1 | `@beanfx/core` extracted (types, timebase, project) | — |
| P2 | API v1 prefix + device/agent token auth | P1 |
| P3 | Canonical project format v1 + round-trip tests | P1 |
| P4 | MCP server (internal transport, read-mostly tools) | P1–P3 |
| P5 | Host adapter interface + Premiere UXP panel skeleton | P1–P3 |
| P6 | Desktop Bridge (loopback service, pairing) | P2, P5 |
| P7 | MY AI orchestration over MCP approvals | P4 |

## 1. Canonical project and timeline contracts
- Deliverable: `.beanfx.json` v1 schema in core (`project/schema.ts`), converters `project/fromSequence` / `project/toSequence` over the existing M1–M20 `Sequence` model; `unknown`-field preservation; deterministic, lossless for every M1–M20 sequence feature.
- Acceptance: round-trip property tests over every fixture sequence in the M13–M19 suites (zero diff, including rational fps, transitions, keyframes, captions, AI provenance); a conversion failure never mutates input.

## 2. Versioned Core SDK
- Deliverable: `@beanfx/core` package with `types`, `timebase`, `project`, `api-client`, `jobs`, `media` layers; semver where minor tracks format minor; no UI, no DB access inside the SDK.
- Acceptance: the web app consumes core types without behavior change (tsc + full M1–M20 regression green); SDK builds standalone; published package exports documented.

## 3. Host adapter interface
- Deliverable: `@beanfx/host-adapter` interface (§4 of the architecture doc): capabilities, import/export canonical, media resolver, progress channel, auth context; atomic import/export with snapshot rollback.
- Acceptance: adapter contract tests (mock host) pass; a forced conversion failure leaves host state untouched.

## 4. Premiere Pro UXP integration boundary
- Deliverable: UXP panel skeleton bundling core + Premiere adapter; send-to-BEAN-FX (sequence → canonical export), render/export hand-off through the durable job API, caption/AI review surfaces, approval-gated apply (M14 model — nothing touches the host timeline without explicit approval).
- Acceptance: panel runs in Premiere UXP dev host; sequence export round-trips through canonical format; job progress renders in the panel; approval flow blocks unapproved mutations.

## 5. Desktop Bridge communication architecture
- Deliverable: local loopback service (ephemeral port, 127.0.0.1 only) + device-token pairing (scoped: jobs:submit/read, media:upload, projects:read; revocable; 90-day rotation; OS keychain storage); challenge handshake for local callers; TLS + pinned key for cloud; bridge as untrusted client under the same server-side quota/isolation.
- Acceptance: external interface bind fails closed; token revocation kills access within one request; secrets never in plaintext config; bridge job runs carry identical server-side limits as web jobs.

## 6. Internal and external MCP integration boundary
- Deliverable: one MCP server, two transports (stdio-internal inheriting user context; HTTPS-external with per-agent scoped tokens + rate limits); read-mostly tools; mutations require an approval event id; every call audited.
- Acceptance: tool-level permission tests; token scope enforcement; audit trail complete for external calls; MY AI coordinates RIISHE/GANGZII/NIIKI/JAZMII/LAXII through the same job/approval primitives (no private backdoors).

## 7. Project permissions and authentication
- Deliverable: additive roles `editor`/`reviewer`/`viewer` beside `owner`; token scope sets resolve to roles; canonical export respects read scope (viewer strips transforms/history).
- Acceptance: permission matrix tests per role × operation; token can never exceed the inviting user's role; M19 isolation suite stays green.

## 8. Rational FPS and timebase conversion
- Deliverable: `timebase.ts` — exact BigInt rational conversion (frames ↔ seconds ↔ Premiere ticks 254016000/s ↔ sample clocks); nearest-frame rounding, ties away from zero, decision recorded for audit.
- Acceptance: property tests (no drift over 10^6 conversions, exact tick mapping for 23.976/24/25/29.97/30/59.94/60); A/V sync calibration via the M18/M20 beep-marker method reproduces ≤1-frame offsets.

## 9. Asset and media references
- Deliverable: `beanfx-asset://<id>` canonical refs; resolver chain host-handle → bridge cache → server storage; checksummed uploads; per-window asset bounding kept for jobs; bridge cache reaper.
- Acceptance: reference resolution tests across all three resolvers; orphaned cache entries reaped; deletion never blocked by canonical `unknown` refs.

## 10. Reversible editing operations
- Deliverable: canonical edit ops mirror the M1–M20 command model (INSERT/OVERWRITE/ROLL/trim/split/mute/…), each with an inverse; host adapters apply ops as transactions with snapshots.
- Acceptance: inverse round-trip tests per op over fixture sequences; a rejected/crashed apply leaves the pre-op state intact.

## 11. Version conflicts and recovery
- Deliverable: optimistic concurrency on canonical exchange (baseVersion, same as the editor timeline API); conflict response carries the current head + a minimal patch suggestion; host op journal makes hand-offs idempotent.
- Acceptance: conflicting submissions resolve deterministically (one wins, one gets machine-readable conflict); crash mid-hand-off replays idempotently; M19/M20 durable-recovery semantics unchanged.

## 12. Capability discovery and host compatibility
- Deliverable: `GET /api/v1/capabilities` (server) + adapter `capabilities` (host): format versions, feature flags (render/captions/AI surfaces), limits; compatibility matrix shipped per release.
- Acceptance: capability negotiation tests for panel/bridge/agent; unsupported feature calls fail with a machine-readable `UNSUPPORTED` (never silent degradation); matrix CI-checked against actual feature flags.

## 13. API versioning and compatibility tests
- Deliverable: `/api/v1/*` additive prefix; SDK ±1-minor compatibility window; `UPGRADE_REQUIRED` for older clients; additive-only job/DB schema evolution (M17–M20 rule).
- Acceptance: contract tests pin v1 responses (golden files); breaking-change CI gate; M1–M20 routes keep working during migration; full regression + durable suite green on every phase merge.

## Explicit non-goals for M21 (unchanged from M20 close)
No merge to main, no deployment, no public registration activation, no payments enablement, no per-host AI systems, no Ollama. External configuration (SMTP provider, legal owner decisions, staging/production host) remains OWNER/CONFIGURATION/INFRASTRUCTURE REQUIRED exactly as classified in `M20_RESULTS.md` §7.
