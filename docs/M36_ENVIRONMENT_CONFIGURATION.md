# M36 — Environment Configuration (Phase B-A)

## Template

`deploy/env.staging.example` — placeholders only (`__SET_ON_HOST__`), three explicit sections:

| Class | Variables | Behavior when missing/wrong |
|---|---|---|
| **REQUIRED** | `DATABASE_URL` (file: SQLite URL, NOT the dev default `db/custom.db`; parent dir must exist and be writable), `BEANFX_DATA_DIR` (absolute dedicated dir, never `/` or relative) | `m36-validate-env.ts` → INVALID, exit 1, actionable message. Install, systemd `ExecStartPre`, and `beanfxctl start` all run this gate — **the app never boots silently into a misconfigured deployment.** No insecure default is ever substituted. |
| **OPTIONAL** | `PORT` (default 3000), `BIND_HOST` (default 127.0.0.1 in template — loopback behind the proxy), `PUBLIC_APP_URL` | absence = CONFIGURATION REQUIRED note (exit 2 under `--strict`), never a crash |
| **PROVIDER** | `BEANFX_ZAI_BIN` (CLI path; provider credentials stay on the host, never in the repo) | unconfigured provider = CONFIGURATION REQUIRED, **informational only — never degrades core health** (Phase E rule) |
| **FORBIDDEN** | `RATE_LIMIT_SCALE` | set to anything ≠ unset/1 outside tests → INVALID. Presence-only reporting for secret-like values (values never printed). |

## Validation semantics

```
bun scripts/m36-validate-env.ts --env /home/beanfx/.env.staging [--strict] [--json]
bun scripts/m36-validate-env.ts --process          # validate the current process env
```

Exit codes: **0** = valid (or non-strict with notes) · **1** = INVALID (blocking: missing required, dev-default DB, unreachable dir, forbidden env, placeholder credential) · **2** = valid core but CONFIGURATION REQUIRED gaps under `--strict` (optional/provider unconfigured).

## Test battery (executed, `download/m36/evidence/`)

| Case | Result |
|---|---|
| Template as-is (placeholders, dirs absent) | exit 1 — correctly blocking: `/home/beanfx` paths don't exist on this machine; hints name `m36-fs-layout.sh` |
| Real paths + chmod 600 + `--strict` (providers unconfigured) | exit 2 — VALID core, flagged optional gaps |
| Dev-default DB (`file:./db/custom.db`) | INVALID with explicit "refusing to silently share the dev database" |
| `RATE_LIMIT_SCALE="50"` | INVALID — test-only env in deployment |
| Env file mode 644 | strict → INVALID (chmod 600 required); non-strict → CONFIGURATION REQUIRED note |

## Integration points

- `m36-install.sh` step 3 (strict) — install stops before build on invalid env.
- `deploy/systemd/beanfx.service.template` `ExecStartPre` (strict) — a bad config prevents boot and systemd's start-limit stops loop attempts; `systemctl status` shows the validator's actionable output.
- `beanfxctl.sh start` (non-strict gate + explicit message) — simulation refuses to start on invalid env.
- `m36-rehearsal.sh` step 2 — the rehearsal env is validated before startup.

**Separation from development:** development keeps its implicit defaults (`db/custom.db`, workspace media store); the staging template has NO dev paths — pointing it at any dev path fails validation (tested). Development never reads the staging env file; staging never falls back to dev defaults.
