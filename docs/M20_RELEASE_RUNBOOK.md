# M20 §11 — Production Release Runbook (deployment, rollback, startup checks)

Companion to `M19_PRODUCTION_DEPLOYMENT.md` (architecture, reverse proxy, DNS) and `M20_BACKUP_DRILL.md` (backup/restore). This runbook is the single ordered procedure for a staging or production rollout.

## 0. Prerequisites (owner-supplied, each gates the next step)

- Server meeting the measured minimum (see M20_RESULTS §capacity): 4 vCPU / **8 GB RAM minimum for renders** (4 GB confirmed insufficient for 600 s exports — documented OOM evidence), 40+ GB persistent SSD, Ubuntu 22.04+.
- Domain DNS A/AAAA → server IP; TLS via the reverse proxy (Caddy auto-HTTPS or `certbot`).
- PostgreSQL 16+ reachable only from the app host; `DATABASE_URL` secret.
- SMTP or API mail provider credentials (`SMTP_URL`, verified sender domain).
- Secrets injected via the process manager environment (never committed): `AUTH_SECRET`, `DATABASE_URL`, `SMTP_URL`, `MAIL_FROM`, `SUPPORT_EMAIL`, `PUBLIC_APP_URL`, `RATE_LIMIT_SCALE=100`.

## 1. Build & verify the release candidate

```bash
bun ci --frozen-lockfile        # exact dependency tree (audit-clean per M20 §7)
bun run build                   # Next.js production build; startup checks print config audit
bun run start -- --port 3000    # smoke: /api/health → 200 {ok:true}
```

Startup checks fail closed on: missing `AUTH_SECRET` (<32 chars), missing `DATABASE_URL`, `PUBLIC_APP_URL` http on a non-local host, `NODE_ENV=production` with `NEXT_PUBLIC_*` mismatches.

## 2. Database migration (additive only)

```bash
bunx prisma migrate deploy      # applies committed migrations; never edits applied history
```

Rule: any migration containing `DROP TABLE` / `DROP COLUMN` / `ALTER COLUMN ... TYPE` on user data requires a dated backup + restore drill first (`scripts/backup-db.sh postgres`).

## 3. Workers

- Durable render/media workers run as separate processes: `BEANFX_MEDIA_WORKER_AUTOSTART=1` (or the standalone worker entrypoint) with `BEANFX_RENDER_WINDOW_SEC=60` (bounded-memory windowed rendering, M20 §3).
- systemd unit: `Restart=always`, `MemoryMax=3G` per worker (OOM is contained by the worker's retry sweep, not the kernel OOM-killer on the app host), `WatchdogSec=120` optional.

## 4. Health checks & monitoring

- `/api/health` (app) — LB target.
- DB: `pg_isready` every 30 s; disk: media root >80 % alerts; queue: jobs QUEUED >15 min alerts; heartbeats: stale PROCESSING sweep every 60 s (built-in).
- Logs: structured JSON to journald; ship to the owner's aggregator. Never log secrets (M20 §7 verified).

## 5. Rollback (guaranteed-safe procedure)

1. Stop the app + workers: `systemctl stop beanfx-app beanfx-worker`.
2. Point the release symlink at the previous build directory (`releases/<prev-sha>`); keep the **previous 3 builds** on disk.
3. Roll back DB only if the failed release added migrations: restore the pre-deploy snapshot from `/backups/postgres` into a scratch DB, verify counts (`scripts/backup-drill.py`), then swap. Additive migrations usually need no rollback — the previous binary tolerates extra columns/tables.
4. Start services; `/api/health` + one login + one small render smoke test.
5. Post-incident: record cause in the incident log; the stale-heartbeat recovery sweep requeues any render jobs interrupted mid-flight (verified behavior).

## 6. First-launch checklist mapping

| Runbook step | M20 acceptance item |
|---|---|
| §1 build | RC builds successfully (§14.13) |
| §2 migrations | additive-only rule (§15) |
| §3 workers | durable rendering solution (§3) |
| §4 monitoring | support/ops readiness (§10) |
| §5 rollback | rollback procedure (§13) |
| backup drill monthly | §6 |
