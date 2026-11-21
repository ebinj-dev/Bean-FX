# M34 — Environment Matrix

Every environment variable the application reads, classified. **Validation without exposure:** `bun scripts/preflight.ts` reports presence/status only — it never prints a secret value. `.env` is untracked by design; `.env.example` documents the non-secret surface.

Legend: **R** = required to start · **O** = optional (safe default) · **T** = test-only (never in production) · **S** = secret (presence-only validation) · **dev** = development-only behavior.

## Application runtime

| Variable | R/O | Default | Notes |
|---|---|---|---|
| `NODE_ENV` | O | unset | `production` silences Prisma query logging (the server runs this way); dev enables `prisma:query` logs |
| `PORT` | O | `3000` | HTTP port (`scripts/dev-server.sh`) |
| `BIND_HOST` | O | `0.0.0.0` | listener address |
| `PUBLIC_APP_URL` | O | request host | share links/callbacks; preflight WARNING when unset |
| `RATE_LIMIT_SCALE` | O | `1` | scales every fixed-window limit (test fleets raise it; production leaves default) |
| `NEXT_PUBLIC_SUPPORT_EMAIL` | O | — | public support contact |
| `SUPPORT_EMAIL` | O | — | internal support mailbox |
| `NEXT_RUNTIME` | O | set by Next | framework-managed |

## Database

| Variable | R/O | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | **R** | — | `file:./db/custom.db` typical; the app appends `?connection_limit=2` for SQLite unless already configured (M33 fix, `src/lib/db.ts`) + WAL on first write. PostgreSQL accepted verbatim for production deployments |
| (implicit) pool config | O | `connection_limit=2` | documented M33 contention fix; do not raise for SQLite without a concurrency re-run (`scripts/m34-sqlite-bench.ts`) |

## Media storage

| Variable | R/O | Default | Notes |
|---|---|---|---|
| `BEANFX_DATA_DIR` | O | `/home/z/my-project/media-store` | storage root: `originals/ exports/ tmp/ proxies/`; empty value or filesystem root is REFUSED |
| `BEANFX_USER_QUOTA_BYTES` | O | `5368709120` (5 GB) | per-user quota across originals+proxies+exports |
| (constant) `MAX_UPLOAD_BYTES` | — | 250 MB/file, 2 GB chunked | `src/lib/media-storage.ts` |

## FFmpeg / FFprobe / Python

No variables — resolved from PATH at call time. Preflight checks `ffmpeg`, `ffprobe` (BLOCKED when missing) and `python3 -I` + Pillow (WARNING when missing; mask tooling needs it).

## Worker processes

| Variable | R/O | Default | Notes |
|---|---|---|---|
| `BEANFX_MEDIA_WORKER_AUTOSTART` | O | `1` (on) | `0` disables the in-process durable worker (multi-process deployments run an explicit worker instead) |

## AI provider configuration (all optional — product runs honestly without them)

| Variable | Secret? | Notes |
|---|---|---|
| `BEANFX_ZAI_BIN` | no | provider CLI binary (default `z-ai`) |
| `ZAI_API_KEY`, `Z_AI_API_KEY` | **S** | credentials; read by the CLI, never stored/logged by BEAN FX |
| `BEANFX_JAZMII_PROVIDER`, `BEANFX_LAXII_PROVIDER` | no | engine routing |
| `BEANFX_JAZMII_CLI_TIMEOUT_MS`, `BEANFX_JAZMII_GENERATE_TIMEOUT_MS`, `BEANFX_LAXII_CLI_TIMEOUT_MS` | no | provider latency bounds |
| `BEANFX_JAZMII_LICENSE_NOTE`, `BEANFX_JAZMII_RETENTION_NOTE`, `BEANFX_LAXII_LICENSE_NOTE`, `BEANFX_LAXII_RETENTION_NOTE` | no | recorded with generated assets |
| `BEANFX_JAZMII_SCENE_THRESHOLD` | no | scene analysis tuning |
| `BEANFX_MYAI_PROVIDER`, `BEANFX_MYAI_MODEL`, `BEANFX_MYAI_TIMEOUT_MS`, `BEANFX_MYAI_PLANNER_TIMEOUT_MS`, `BEANFX_MYAI_PLAN_TTL_MS`, `BEANFX_MYAI_RETRIES`, `BEANFX_MYAI_MAX_STEPS` | no | MY AI orchestration bounds |
| `BEANFX_STUDIO_PLANNER_TIMEOUT_MS`, `BEANFX_STUDIO_REAL_TTS` | no | studio planner / real-TTS switch |
| `BEANFX_SEMANTIC_ENDPOINT`, `BEANFX_SEMANTIC_PROVIDER`, `BEANFX_SEMANTIC_MODEL` | no | semantic search |
| `BEANFX_VISUAL_PROVIDER`, `BEANFX_VISUAL_MODEL` | no | VLM |
| `BEANFX_ASR_ENDPOINT`, `BEANFX_ASR_PROVIDER`, `BEANFX_ASR_MODEL` | no | ASR |
| `BEANFX_MCP_CALL_TIMEOUT_MS`, `BEANFX_MCP_RATE_PER_MIN` | no | MCP bridge bounds |
| `BEANFX_EXPORT_PROFILES_JSON` | no | export profile overrides |

## Authentication & collaboration

No required configuration: session cookie `beanfx_session` (None+Secure+Partitioned) + scrypt password hashing + integration tokens (hash+prefix, scoped) work out of the box. Mail-bound features need SMTP:

| Variable | Secret? | Notes |
|---|---|---|
| `SMTP_URL` / `SMTP_HOST`, `MAIL_FROM` | **S** (SMTP_URL may embed credentials) | email verification/reset; absent → honest degraded mode (preflight CONFIGURATION REQUIRED) |

## External integrations (bridge)

| Variable | R/O | Notes |
|---|---|---|
| `BEANFX_BRIDGE_HOST`, `BEANFX_BRIDGE_STATE_DIR`, `BEANFX_BRIDGE_CACHE_DIR`, `BEANFX_BRIDGE_CACHE_BUDGET` | O | M21/M22 bridge; defaults under the data dir |

## Test-only variables (never production)

`M29_BASE`, `M29_DB`, `M30_BASE`, `M30_DB`, `M31_BASE`, `M31_DB`, `M31_STORE`, `M33_BASE`, `M33_EVIDENCE_DIR`, `M33_*` suite vars, `BASE`, `BRIDGE_TEST_BASE`, `FAKE_ZAI_DIR`, `M11_DEBUG`, `BEANFX_M7_REAL_PROVIDER`, `BEANFX_M8_REAL_PROVIDER`, `BEANFX_TOKEN` (test integration token), `M34_PORT`, `BEANFX_LEGACY_TEST_DB`, `BEANFX_LEGACY_SKIP_PUSH`.

## Secrets handling summary (Track E2)

- `.env` untracked; `.env.example` carries placeholders only — **verified by scan**.
- Secret-pattern scan of tracked files: only benign matches (a redaction-function test with deliberately fake inputs; local test-fixture passwords in throwaway e2e scripts).
- Provider probes return pre-redacted details (`src/lib/providers/readiness.ts` contract; `redactSecrets` utility exercised by tests).
- Integration tokens are stored hash-only with a ≤12-char prefix; the raw token is returned once at creation (M22 suites verify).
