# BEAN FX — Ecosystem Architecture (M21 preparation, design only)

**Status:** PROPOSED — not implemented. This document defines the target architecture for the next stage: Hybrid Web SaaS + Desktop Bridge + host extensions (Adobe Premiere Pro first), one shared BEAN FX Core SDK and API, internal and external MCP access, MY AI coordinating RIISHE, GANGZII, NIIKI, JAZMII and LAXII. No Ollama. It preserves the existing professional editing application and the M1–M20 architecture unchanged.

**Non-goals for M21 start:** no payment activation, no public customer registration, no deployment, no rewriting of the editor.

## 1. Canonical project format (`beanfx-project` v1)

- One canonical, versioned project document: `.beanfx/` directory or single `.beanfx.json` bundle.
- `formatVersion: 1`; every field additive-only. Unknown fields are preserved verbatim (forward compatibility).
- Contents: project metadata (id, name, fps as rational `num/den`, resolution, sample rate), media asset registry (id, kind, storage ref, checksum, proxy ref), track list, clips (source asset, timeline start, in/out points, transform, opacity, speed), audio automation (keyframes), effects/transitions (typed descriptors with version), captions tracks, AI provenance records (which subsystem produced what, approved by whom), and an edit-history digest (not the full op log — ops stay in the server DB).
- The server DB (`Project` + `TimelineVersion` rows) remains the source of truth for the web app; the canonical format is the **interchange** representation. Conversion is deterministic and lossless for M1–M20 sequence features; anything not representable is recorded in an `unknown` block with a warning flag.
- All times are stored as **rational frame numbers + source timebase**, never as floats (see §10).

## 2. BEAN FX Core SDK (`@beanfx/core`)

- One TypeScript package consumed by: the web app (already its own code), the Desktop Bridge, host extensions, and MCP tooling.
- Layers: `types` (project format, jobs, assets), `timebase` (frame/time conversion, §10), `project` (read/convert/validate/upgrade), `api-client` (typed client for the public API, session + CSRF handling), `jobs` (submit/poll/cancel/recover against the durable job surface), `media` (probe/validate helpers wrapping FFprobe contracts).
- No UI inside the SDK. No direct DB access — everything goes through the API (host extensions never talk to the database).
- Versioned releases: SDK `major.minor` tracks the project-format `major.minor`; patch releases are compatible.

## 3. Public and internal APIs

- **Public API** (existing Next.js routes, tightened): auth, projects, timeline, media, render/export, AI surfaces, account. Consumed by the web app, Desktop Bridge and host extensions. Same auth model (session cookie for web; scoped bearer tokens for bridge/extensions — see §6).
- **Internal service APIs**: media worker queue (already durable, M19/M20-hardened), mail transport, AI provider adapters (RIISHE/GANGZII/NIIKI/JAZMII/LAXII behind one interface), storage layer. These stay server-only; never exposed at the edge.
- API versioning: `/api/v1/*` prefix introduced additively; existing unversioned routes keep working during migration.
- Rate limiting, CSRF, and audit events apply uniformly (existing M19/M20 mechanisms, extended to token clients).

## 4. Host adapter interface (`@beanfx/host-adapter`)

Every host integration implements one interface:

```
interface BeanFxHostAdapter {
  host: { id: "premiere-pro" | string; version: string };
  capabilities: { importSequence: boolean; exportSequence: boolean; mediaAccess: "passthrough" | "copy" };
  importCanonical(project: BeanFxProject): Promise<ImportResult>;
  exportCanonical(scope: ExportScope): Promise<BeanFxProject>;
  mediaResolver: MediaResolver;   // maps canonical asset refs ↔ host media handles
  progressChannel: ProgressChannel; // reports long ops back to host UI
  authContext(): HostAuthContext;  // §6
}
```

- The adapter converts host-internal state ↔ canonical format using `@beanfx/core`. Conversions are unit-tested per host; a conversion failure never mutates host state (atomic import/export with rollback to the pre-op snapshot).
- Host quirks live ONLY in the adapter; core stays host-agnostic.

## 5. Premiere Pro UXP integration boundary

- Premiere extension (UXP panel) bundles `@beanfx/core` + the Premiere adapter; talks to the user's choice of **Desktop Bridge** (local) or the **web service** (cloud) for heavy jobs.
- In panel: project open/send-to-BEAN-FX (canonical export of the active sequence), render/export hand-off, caption and AI review surfaces (thin UI), approval flow for AI operations (nothing applies to the host timeline without explicit user approval — the M14 approval model).
- Heavy work (rendering, ASR, AI analysis) is queued server/bridge-side via the durable job API; the panel polls job state through the SDK client and reports progress into Premiere's UI thread.
- Media stays in Premiere's domain where possible (passthrough capability); the bridge uploads only assets a job actually needs (per-window asset bounding, the M20 pattern).

## 6. Desktop Bridge security model

- Local application (Electron/Tauri wrapper around a small Node service) exposing `http://127.0.0.1:<ephemeral port>` ONLY on loopback.
- Pairing: the bridge registers with the web service using a **device token** created by the user in account settings (scoped: `jobs:submit`, `jobs:read`, `media:upload`, `projects:read`, per device, revocable, 90-day rotation). No password ever reaches the bridge.
- Loopback requests require a per-session handshake: the bridge issues a one-time challenge to the local UI; browser/panel clients must present the pairing proof (protects against other local processes hitting the bridge).
- TLS for all cloud traffic; the bridge pins the service public key. Secrets (device token) stored in the OS keychain, never in plaintext config.
- Jobs submitted through the bridge run under the SAME server-side quota/isolation/rate-limit model as web jobs; the bridge is an untrusted client, not a peer.
- Telemetry: off by default; when enabled, no media content, no file paths, correlation IDs only.

## 7. MCP server architecture

- One MCP server process, two transports: **internal** (spawned by the Desktop Bridge / web backend,_stdio over a local channel) and **external** (HTTPS + token, for MY AI and approved third-party agents).
- Tools are thin wrappers over the SDK/API surface: project read/validate, job submit/poll/cancel, media probe, render status, caption/AI review state. Tools are READ-mostly; mutations require an approval reference (the approval event id from the M14 flow) in the call.
- Auth: internal transport inherits the logged-in user context; external transport uses per-agent tokens with scoped permissions and per-token rate limits. Every tool call is audited (`AuditEvent`).
- MY AI is an orchestrator client of MCP: it coordinates RIISHE (edit analysis/autocut), GANGZII, NIIKI, JAZMII and LAXII subsystems through the same job/approval primitives — no subsystem gets a private backdoor.
- No local model execution (no Ollama); all inference goes through the configured server-side providers.

## 8. Project permissions

- Roles: `owner`, `editor`, `reviewer`, `viewer` (web already has owner-only enforcement; M21 adds sharing roles additively).
- Host/bridge/agent access resolves to one of these roles via the device/agent token's scope set — tokens can never exceed the inviting user's role.
- Canonical-format exchange respects permissions: `exportCanonical(scope)` only includes assets/projects the caller can read; viewer scope strips transforms/edit history.
- Approval-gated mutations: AI operations touching timelines require an explicit approval event; the approval chain (who/when/what diff) is part of the canonical provenance block.

## 9. Timebase conversion

- Single conversion module in core (`timebase.ts`): every conversion is exact rational arithmetic (BigInt numerators/denominators) — never floating point.
- Rules: timeline positions are frames at the project fps (`num/den`); source media positions are seconds × media timebase. Conversions round to **nearest frame, ties away from zero**, with the rounding decision recorded in the conversion result for audit.
- Premiere-specific: adapter maps project timebase ↔ Premiere ticks (254016000 ticks/sec) exactly (both are integer ratios; no drift is possible if done in rationals).
- Audio sample clocks are converted through the same module (sample rate rational); A/V sync uses the measured-offset correction path from the M18/M20 beep-marker method as the calibration tool.

## 10. Media/asset exchange

- Canonical asset ref: `beanfx-asset://<assetId>` resolved by the host adapter or the bridge against (a) host media handles (Premiere), (b) local cache (bridge), (c) server storage (cloud-only sessions).
- Uploads use the existing media upload path with checksum verification (sha256) and quota enforcement; proxies are generated server-side as today.
- Long-form jobs keep the M20 bounding discipline: a job's ffmpeg inputs are limited to the assets its window plans reference; the bridge prefetches only those.
- Cleanup: canonical `unknown`/`external` asset refs never block deletion; orphaned cache entries in the bridge are reaped on a schedule with the same scratch-sweep pattern as the server.

## 11. Job execution

- All heavy work flows through the existing durable job system (QUEUED/PROCESSING/COMPLETED/FAILED/CANCELLED, heartbeat, stale-claim recovery, OOM no-retry, per-window bounding, cancellation, idempotent completion — M19/M20 semantics).
- New job types for M21 are additive: `HOST_IMPORT` (canonical→host), `HOST_EXPORT` (host→canonical), `BRIDGE_SYNC`. Worker capacity stays bounded (GLOBAL_MAX_ACTIVE, memory-conscious encodes).
- Progress and stage labels keep the honest-failure conventions (real stage, real error, no fabricated success). Recovery runbooks extend to bridge/panel surfaces.

## 12. Version compatibility

- Compatibility matrix shipped with each release: project-format version ↔ SDK version ↔ server API version ↔ host adapter versions.
- Format upgrades are one-way, additive, and executed through `project.upgrade()` with a pre-upgrade validation report; downgrades are refused rather than lossy.
- Server accepts requests from SDK versions within `±1 minor`; older clients get a machine-readable `UPGRADE_REQUIRED` (never a silent behavior change).
- The durable job schema evolves additively only (the M17–M20 rule); migrations stay reversible-by-expansion (new columns nullable, no renames).

## 13. Error and recovery behavior

- Every failure surface reports: correlation ID (already present), stage label, honest message, retryability, and the user-action hint — the same contract the editor uses today.
- Client (bridge/panel/agent) error mapping: transport errors are retried with jittered backoff (max 3); job-level failures are surfaced verbatim (the server message is authoritative — clients must not invent "success" or "timeout" semantics).
- Interrupted host operations: import/export are transactional in the host (snapshot → apply → commit; crash = rollback to snapshot). Bridge keeps a local op journal to make hand-offs idempotent.
- Recovery documentation per component (server runbooks exist; M21 adds bridge + panel runbooks) — including "worker recovery", "OOM diagnosis", "cancellation" sections mirroring the M20 suite.

## 14. M21 execution order (proposal, not started)

1. Core SDK extraction (types/timebase/project from existing editor code — no behavior change).
2. API v1 prefix + token auth for non-web clients.
3. Canonical format v1 + round-trip tests against the M1–M20 sequence model.
4. MCP server (internal transport) with read-mostly tools.
5. Premiere adapter + UXP panel skeleton against the bridge.
6. Desktop Bridge with the §6 security model.
7. MY AI orchestration on top of MCP approvals.
