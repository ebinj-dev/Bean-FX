# M36 — Deployment Package (Phase B)

**Scope:** the smallest safe deployment package for the M35 single-server topology, built entirely on the actual architecture (Next.js standalone server via `node .next/standalone/server.js`, in-process durable job runner, SQLite WAL, `BEANFX_DATA_DIR` media root, ffmpeg children). No Docker (unvalidated — systemd templates + foreground simulation instead), no PostgreSQL, no second queue, no new runtime services.

## Package inventory

| File | Role | Validated how |
|---|---|---|
| `deploy/env.staging.example` | staging env template — REQUIRED/OPTIONAL/PROVIDER sections, placeholders only, `RATE_LIMIT_SCALE` forbidden | validation battery (M36_ENVIRONMENT_CONFIGURATION) |
| `scripts/m36-validate-env.ts` | fail-cold startup gate; presence-only secret reporting; refuses dev-default DB, fs-root media dir, group/world-readable env file (strict) | 5 test cases live |
| `scripts/m36-fs-layout.sh` | creates/verifies the persistent layout, refuses system paths, restricts backups dir to 0700, disk headroom check | live run |
| `scripts/m36-install.sh` | 9-step install: versions → resources → env → dirs → lockfile deps → prisma generate → **non-destructive** `db push` → build → db verify | component steps exercised in rehearsal |
| `scripts/m36-upgrade.sh` | 7-step upgrade: **verified backup FIRST** → fetch → ff-only checkout → deps → schema sync (non-destructive) → rebuild → restart+health; failures leave the previous build running | logic reviewed; real-host run = OWNER ACTION |
| `scripts/beanfxctl.sh` | start/stop/restart/status/health/logs; delegates to systemd when the unit exists, else validated **foreground simulation** with PID file and SIGTERM→SIGKILL shutdown | full lifecycle live (start→200→status→health→stop→exit 3) |
| `deploy/systemd/beanfx.service.template` | real-host unit: `EnvironmentFile` + **ExecStartPre env gate** (refuses boot on invalid env), SIGTERM graceful stop, Restart=on-failure with start-limit, journald logging, MemoryMax | template only — real-host validation OWNER ACTION |
| `deploy/caddy/Caddyfile.staging.template`, `deploy/nginx/nginx.staging.template` | TLS termination, HTTP→HTTPS redirect, 2 GB upload headroom, 600 s job timeouts, no trusted client-supplied `X-Forwarded-*`, HSTS/nosniff/Referrer-Policy | templates only — no domain/cert claimed |
| `scripts/m36-db-ops.ts` | Phase C operator tool (see M36_DATABASE_OPERATIONS) | 4 commands live |
| `scripts/m36-backup.ts` / restore | Phase D (see M36_BACKUP_RESTORE_OPERATIONS) | backup+verify+restore+refusal+retention live |
| `scripts/m36-health-check.sh` | Phase E four-state check, extended (see M36_HEALTH_AND_OBSERVABILITY) | live vs running app |
| `scripts/m36-failure-qualification.sh` | Phase F failure battery | 12/12 PASS |
| `scripts/m36-rehearsal.sh` | Phase G end-to-end rehearsal driver | 16-step run |

## Design decisions (and their evidence)

1. **Fail-cold over fail-safe defaults.** Missing `DATABASE_URL`/`BEANFX_DATA_DIR` or a path pointing at the development DB (`db/custom.db`) stops install/start with an actionable message. No insecure default secrets are ever substituted — the systemd `ExecStartPre` gate makes this bind at boot.
2. **Temp files can never pose as exports.** Render intermediates live under the media root's `tmp/` area with `seg_*`/`list_*` names, are cleaned post-render (M20-verified zero leftovers), and the health check flags `seg_*`/`list_*` files older than 1 h as DEGRADED. Exports are only `ExportFile`-registered artifacts.
3. **Persistent data never lives in the build tree.** DB and media live under the configurable data root (`/home/beanfx/data/...`); `.next/` is regenerable and wiped by rebuilds without touching user data. `m36-fs-layout.sh` refuses `/`, `/tmp`, `/usr`, `/etc`, `/var`, `/boot`, `/dev`, `/proc`, `/sys` as data roots.
4. **Backups can't target live data by accident.** `m36-backup.ts restore` refuses a target equal to the manifest's recorded live source paths AND to the current process `DATABASE_URL`/`BEANFX_DATA_DIR`; snapshots publish atomically from a `.tmp` staging dir that is cleaned on failure (F8b).
5. **No duplicate tooling.** `backup-db.sh`/`restore-db.sh` (M20) and `m35-backup-drill.ts` remain; `m36-backup.ts` adds the operations layer (manifest/retention/media/refusals) that evidence showed missing (M36_BASELINE_AND_DEPLOYMENT_AUDIT §2), reusing the same VACUUM-INTO semantics.
