# M19 — Production Deployment Readiness

Status: **DOCUMENTED, NOT DEPLOYED** (no deployment was made — authorization required).

## Architecture

- Next.js 16 standalone server (`bun run build` → `.next/standalone`, started via `scripts/dev-server.sh` = `package.json` start).
- Postgres in production (`DATABASE_URL`); SQLite only for local dev.
- Durable job system (in-process worker; `BEANFX_MEDIA_WORKER_AUTOSTART`) for probes, proxies, AI jobs, renders, exports.
- Media root on persistent volume; exports under `media/exports`, renders under `media/timeline-renders` (windowed segments + concat for >240s sequences).

## Required infrastructure

| Component | Requirement |
|---|---|
| App server | Node/Bun host ≥4 GB RAM (windowed renders peak ≤~400 MB per FFmpeg window), 2 vCPU min |
| Database | PostgreSQL 14+, connection pooling, backups |
| Storage | Persistent volume for media root; sized from per-user quota × users |
| Temp storage | Same volume or fast local disk for render windows; cleanup on completion/cancel |
| FFmpeg/FFprobe | On PATH, versions supporting drawtext/colorbalance/xfade |
| Reverse proxy | TLS termination, HSTS, forwarded-for header (rate limiter reads `x-forwarded-for` first hop) |
| Domain/HTTPS | `PUBLIC_APP_URL` set; cookies are Secure in production |

## Database procedure

- Schema changes are **additive only** (M19: User.role/emailVerified/deletedAt + token + audit tables). Dev uses `prisma db push`; production uses `prisma migrate deploy` — generate the initial migration from the audited schema and baseline an existing DB (`prisma migrate baseline` docs).
- Backups: nightly `pg_dump` + restore test — **not yet created/tested in this environment: DOCUMENTED, NOT IMPLEMENTED (owner action).**
- Retention: deleted accounts soft-lock (`deletedAt`) then queued cleanup; media referenced by other users is preserved.

## Storage layout & cleanup

- Uploads: randomized identifiers under media root (no user-controlled paths).
- Render temp: window segments removed after concat success; failed jobs leave diagnostic logs only.
- Exports: owner-scoped, downloadable via `/api/exports/{id}/file` with ownership checks.

## Monitoring & health

- `GET /api/admin/health` (admin-only): DB reachable, queue depth, worker liveness.
- Public health surface kept minimal; internal metrics never public.
- Render/AI failure visibility: durable job records with safe messages (OOM renders now FAIL with explicit memory guidance).

## Operational runbooks (procedures)

1. **Restart app**: `bun run build && scripts/dev-server.sh` (or process manager restart); health-check `/api/admin/health`.
2. **Restart workers**: toggle `BEANFX_MEDIA_WORKER_AUTOSTART` / restart the server process — jobs requeue via heartbeat recovery (90 s stale-claim sweep).
3. **Recover failed jobs**: inspect `/api/admin/jobs` (status/message); fix cause; re-submit from the UI (job records are never falsified).
4. **Restore backups**: provision fresh Postgres → `pg_restore` → point `DATABASE_URL` → verify user login → verify media volume mount. *(Backup/restore is documented, not yet exercised — owner action.)*
5. **Rotate secrets**: rotate `DATABASE_URL` credentials + provider keys outside the app; sessions are DB-stored so no signing secret rotates user sessions.
6. **Storage exhaustion**: raise volume / lower `USER_STORAGE_QUOTA_BYTES`; failed uploads report quota errors; never delete user data in cleanup scripts.
7. **Provider outage**: AI endpoints fail safe with provider-error messages; local editing/render/export continue.
8. **Security incident**: revoke sessions for affected users (`DELETE /api/auth/sessions` per user or SQL), rotate credentials, review `AuditEvent`, follow the incident runbook in this doc set.

## Launch blockers (must clear before public deployment)

1. Owner-confirmed legal fields + professional legal review (see legal checklist).
2. SMTP + support addresses configured; `PUBLIC_APP_URL` set.
3. Postgres backups created AND restore tested.
4. `RATE_LIMIT_SCALE=1` verified; shared rate-limit store if multi-instance.
5. Admin role granted to the operator account; operator login tested.
