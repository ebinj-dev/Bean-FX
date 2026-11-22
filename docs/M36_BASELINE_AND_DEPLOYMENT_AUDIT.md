# M36 — Baseline & Deployment Audit (Phase A)

**Date:** 2026-11-22 · **Branch:** `feature/ai-creative-studio`

## 1. Git state (verified, not assumed)

| Check | Result |
|---|---|
| Feature-branch head | `2bb0219` — the M35 commit IS the current head; **no owner commits added after M35** (`git merge-base --is-ancestor 2bb0219 origin/feature/ai-creative-studio` → true) |
| `main` head | `8a027ee` (unchanged since M35 publication) |
| Working tree | clean; no owner work present to preserve beyond the remote state itself |
| Publication pattern | workspace files → fresh authenticated clone → review → fast-forward push (same as M35; no force operations) |

## 2. Actual runtime and entry points (code-verified)

| Aspect | Finding |
|---|---|
| Runtime | Next.js App Router, **`output: "standalone"`** production build. **Entry point: `node .next/standalone/server.js`** wrapped by `scripts/dev-server.sh` (also referenced by `package.json "start"`): builds if `.next/BUILD_ID` missing, copies `.next/static` and `public/` into the standalone tree, then `exec env DATABASE_URL=… PORT=… HOSTNAME=… node .next/standalone/server.js`. Defaults: `PORT=3000`, `BIND_HOST=0.0.0.0`, `DATABASE_URL=file:<cwd>/db/custom.db` (the default is a development convenience — staging overrides it). |
| Process model | **One Node process** owning the in-process durable job runner; ffmpeg/ffprobe spawned as children. No Python/FastAPI tier, no GPU path, no message queue, no container runtime — **none invented here**. |
| DB configuration | Prisma 6.19.2, `provider = "sqlite"`. `src/lib/db.ts`: M33 writer-contention correction — `sqliteUrlForRuntime()` forces `connection_limit=2` for `file:` URLs (unless explicitly configured) so writers queue at the pool instead of deadlocking at the file lock; WAL enables reader/writer concurrency. WAL PRAGMA (line 51) is fire-and-forget with a **silent catch** — Phase C improves exactly this: it must not conceal a real initialization failure while still tolerating the genuinely-optional in-memory/readonly cases. |
| Persistence locations | DB: whatever `DATABASE_URL` points at (dev default `db/custom.db`; M34 archived legacy DB under `db/`). Media: `BEANFX_DATA_DIR` (default `/home/z/my-project/media-store`), with runtime guards (absolute, dedicated subdir, not fs root). Render temporaries: `seg_*`/`list_*` inside the media root, auto-cleaned post-render (M20-verified). Build output: `.next/` (regenerable — never a user-data home). |
| Job lifecycle & recovery | `src/lib/job-runner.ts`: timeout kill (SIGTERM→SIGKILL), honest OOM fail (not requeued), cancellation with media intact; restart sweep re-queues stale `QUEUED`/`PROCESSING` jobs >120 s; `job-helpers.ts`: backoff `min(30 s·2^(n−1), 5 min)`, ≤3 attempts, deterministic-failure class fails immediately. Coordination = the `Job` table itself (no second queue exists or is added). |
| Health & readiness | `/api/health` (nodejs runtime, force-dynamic): DB `SELECT 1`, storage write-probe at `MEDIA_ROOT/tmp`, free-disk check (`statfs`, fails under 1 GB) → `{status: "ok"|"degraded", checks:{database,storage,disk}, uptimeSec}`, **503 with the failing component** — the app already distinguishes "up" from "up AND healthy". `scripts/preflight.ts`: read-only gate with statuses `READY / WARNING / CONFIGURATION REQUIRED / BLOCKED / UNSUPPORTED`, secret **presence-only** reporting, `--json` output. |
| Environment variables (observed) | `DATABASE_URL`, `BEANFX_DATA_DIR`, `PORT`, `BIND_HOST`, `PUBLIC_APP_URL`, `BEANFX_ZAI_BIN`, `RATE_LIMIT_SCALE` (test-only), `NODE_ENV`; provider credentials via env (presence-only surfaced by preflight). Validation today: preflight (read-only operator gate) — **no fail-cold startup validation** → Phase B adds `scripts/m36-validate-env.ts` for deployment mode. |
| Backup/restore today | `scripts/backup-db.sh` + `restore-db.sh` (M20 §6; sqlite3 CLI-based, isolated-target drill, `postgres` runbook mode), `scripts/m35-backup-drill.ts` (bun:sqlite equivalent, DRILL_PASS in M35), `p0_backup_media.sh` (media tree), `m31-backup-restore.ts`. Gaps M36 closes (Phase D): single-command consistent snapshot **including media + manifest + sha256 + retention + explicit exit codes**, restore that refuses live targets, OFF-HOST adapter contract. |
| Existing deployment artifacts & limitations | `deploy/env.staging.example` (M35, placeholders), `scripts/m35-health-check.sh` (four-state model, validated), `dev-server.sh` + `preflight.ts` + `qualify-clean-checkout.sh`. **Limitations found:** no service-manager unit (process dies with the shell session on a real host), no env validation at startup (misconfig surfaces as runtime 500s), no reverse-proxy template, no install/upgrade runbook script, `dev-server.sh` dev-default DB path can silently mask a staging misconfig, no backup manifest/retention, health-check lacks ffmpeg/tmp/backup-freshness checks. |

## 3. Honest-architecture statement

The deployment package in this milestone wraps **only** what exists: Node standalone server + in-process runner + SQLite + local media root + ffmpeg. No FastAPI, no GPU, no Docker (M35 reported containers unvalidated; Phase B uses systemd templates + a foreground control script instead), no PostgreSQL (SQLite retained; `DATABASE_URL` remains the only provider switch), no Ollama, no second queue.

## 4. What the local sandbox can and cannot qualify

| Can qualify locally | Cannot qualify locally (classification) |
|---|---|
| Env validation, fs layout, service lifecycle in **foreground simulation**, health checks, backup/restore drills, failure injection (bad env, bad DB path, missing ffmpeg, permissions, interrupted render), full 16-step rehearsal on isolated DB/media, all regression suites (sequential) | Real systemd behavior (**OWNER ACTION** — template provided; lifecycle simulated in foreground), real TLS/reverse proxy on a host (**OWNER ACTION** — templates provided), real disk-full on a dedicated volume (threshold detection tested instead; true ENOSPC behavior = INFRASTRUCTURE REQUIRED), any staging-host execution (Phase H gate) |
