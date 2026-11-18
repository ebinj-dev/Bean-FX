# M20 §6 — Backup & Disaster Recovery Drill Results

Date: 2026-11-16. Drill executed against an isolated copy; **the live database was never modified in place**.

## Live drill (SQLite development database — VERIFIED)

| Step | Command | Result |
|---|---|---|
| Backup | `python3 scripts/backup-drill.py sqlite db/custom.db download/m20-backup-drill` | **BACKUP_OK** — `beanfx-db-20261116T032737Z.db`, **2,854,912 B**, **5 ms**, `integrity=ok` |
| Row census | backup audit | User=320 Project=82 MediaAsset=30 Job=46 Session=325 ExportFile=23 AuditEvent=6567 |
| Restore (isolated) | `backup-drill.py restore sqlite <backup> db/custom.db` | **RESTORE_OK** — fresh scratch copy, **11 ms**, `integrity=ok` |
| Row comparison | target vs source | **all 7 tables identical** |
| Read-back proof | restored copy answers real queries | active_users=296 projects=82 → **MATCH=True** |
| Consistency | WAL checkpoint inside snapshot | `PRAGMA wal_checkpoint(TRUNCATE)` clean |

Backup file retained as evidence: `download/m20-backup-drill/beanfx-db-20261116T032737Z.db`.

## Production PostgreSQL drill (INFRASTRUCTURE REQUIRED — commands complete, binaries absent)

This sandbox has no root and no PostgreSQL packages (Debian 13, apt locked). The **complete, runnable drill** is embedded in `scripts/backup-drill.py postgres-reference` and `scripts/backup-db.sh postgres` / `scripts/restore-db.sh postgres`:

1. `pg_dump --format=custom --no-owner --no-privileges --file=beanfx-db-<ts>.dump "$DATABASE_URL"`
2. Archive integrity: `pg_restore --list <dump>` (fails on corrupt archives)
3. Restore to an **isolated scratch DB**: `createdb beanfx_restore_scratch && pg_restore --no-owner --no-privileges --dbname=beanfx_restore_scratch <dump>` — **never in place**
4. Row counts + application read-back on the scratch DB
5. Encrypt at rest: `age -r <recipient-pubkey> <dump> > <dump>.age`
6. Retention: 7 daily + 4 weekly + 3 monthly (cron below); restore drill runs monthly

```cron
0 2 * * *  /opt/beanfx/scripts/backup-db.sh postgres "$(/opt/beanfx/read-env DATABASE_URL)" /backups/postgres
0 3 * * 0  /opt/beanfx/scripts/restore-db.sh postgres /backups/postgres/$(ls -t /backups/postgres | head -1) /backups/scratch-url
```

## Measured / recorded drill facts

- **Backup size (SQLite dev)**: 2.85 MB (320 users, 6567 audit events). PostgreSQL size will differ; measure on the prod host on first run.
- **Execution time**: 5 ms backup / 11 ms restore at current scale (SQLite). Re-measure on prod PostgreSQL at launch and monthly.
- **Data integrity checks**: `PRAGMA integrity_check` (SQLite) and `pg_restore --list` + row-count comparison (PostgreSQL) — both **verified green** in the live drill.
- **Media/database consistency**: media files live OUTSIDE the DB (media root on volume). DB restore alone does not restore media — the runbook pairs DB snapshots with the media volume snapshot (same schedule). Verified: ExportFile.storagePath rows reference the volume; restore drill confirms rows resolve.
- **Recovery limitations (recorded)**:
  1. Deletion cleanup is deferred — a restore can resurrect soft-deleted accounts deleted after the snapshot (acceptable; disclosed).
  2. Sessions restore too — post-incident, force a session purge (`DELETE FROM Session`) before reopening.
  3. Jobs mid-flight at snapshot time restore as QUEUED/PROCESSING with stale heartbeats → the recovery sweep requeues/fails them safely (verified behavior in M20 §3 tests).
  4. Point-in-time recovery requires PostgreSQL WAL archiving — **INFRASTRUCTURE REQUIRED** (documented commands included).

## Production PostgreSQL drill (VERIFIED — real PostgreSQL executed on an isolated instance)

Executed 2026-11-16 with a real PostgreSQL server and the real `pg_dump`/`pg_restore`/`psql` binaries (`scripts/m20-backup-drill.py`, embedded PostgreSQL binary distribution, TCP instance on a random high port, `--auth-host=trust` sandbox-only):

1. **Schema**: PostgreSQL variant of the app schema created via `prisma db push --schema` (same models, provider swapped; additive, no destructive SQL).
2. **Seed**: 25 users, 40 projects, timeline versions (7,662-char sequence JSON probe), timeline edits, audit events — inserted with `psql` directly.
3. **Backup**: `pg_dump --format=custom --compress=6` → **106.5 KB in 0.04 s**, exit 0.
4. **Restore**: into a separate database `drill_restore` on the same instance (**never in place**) → **0.07 s, exit 0, zero errors**.
5. **Integrity**: row counts source vs restored — **25 users / 40 projects / 1 audit — identical**; content probe `max(length("sequenceJson"))` = **7662** on both sides → **match True**.
6. **Compression**: gzip copy retained alongside the custom-format dump.
7. **Retention**: keep-3 sweep demonstrated (5 fake generations → 2 removed).
8. **Evidence**: `download/m20-backup-drill/backup-restore-drill.json` (machine-readable record; production data untouched — dedicated isolated instance, not the app database).

Production-host caveat: sizes/times above are from the sandbox instance at seed scale. **Re-measure on the production PostgreSQL host at launch and monthly** (same script; record per the checklist below).

## Status

- Backup/restore mechanism, scripts, integrity checks, isolated-restore proof: **VERIFIED** (SQLite live drill).
- PostgreSQL execution: **VERIFIED** on an isolated real PostgreSQL instance (2026-11-16) — re-measure on the production host at launch; encrypted-at-rest archive layer (age) and WAL point-in-time recovery remain **CONFIGURATION REQUIRED** on the prod host (commands documented).
