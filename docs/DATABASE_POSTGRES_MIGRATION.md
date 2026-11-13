# BEAN FX — Database Migration Strategy (SQLite → PostgreSQL)

**Status: migration-ready architecture, verified on this codebase (2026-11-12). No live
PostgreSQL switch has been executed in this sandbox — see §6 for the honest statement.**

## 1. Why the app is already provider-portable

Verified against the real source:

| Check | Result |
|---|---|
| Raw SQL in application code | Exactly **one** statement: `SELECT 1` in `src/app/api/health/route.ts` — portable |
| Schema annotations | No `@db.*` / SQLite-specific types in `prisma/schema.prisma` |
| `prisma validate` with `provider = "postgresql"` | **valid** (verified on a copy of the schema) |
| Schema tables/models | 12 models, all portable; `BigInt` fields map to PostgreSQL `bigint` |
| Migrations | Hand-written additive SQL applies to SQLite; PostgreSQL uses `prisma migrate` instead (§3) |

## 2. What must change for PostgreSQL (exact list)

1. `prisma/schema.prisma` datasource → `provider = "postgresql"` (validated copy in
   `/tmp/pg-validate` during the stabilization run; commit when the switch is executed).
2. `DATABASE_URL` → PostgreSQL connection string (single place; all consumers read it via Prisma).
3. Migration history: do NOT replay the SQLite migration files (p3/p6/p7 are SQLite DDL).
   The PostgreSQL database gets its baseline from `prisma migrate diff --from-empty`
   (or `prisma db push` once, then `migrate tag`), producing the identical logical schema.
4. `scripts/apply_missing_migrations.py` stays SQLite-only — it remains the tool for the
   SQLite deployment (and for testing additive chains on copies, which it now supports via
   `argv[1]`).

## 3. Migration procedure (zero data loss, ordered)

1. **Backup** (both sides): SQLite `sqlite3 db/custom.db ".backup backup.db"` +
   `SHA256SUMS`; take a PostgreSQL logical dump immediately before cutover.
2. **Provision PostgreSQL** (managed service or container), create the database and a
   least-privilege role. `sslmode=require`.
3. **Baseline schema**: with `DATABASE_URL` pointed at PostgreSQL and the postgres provider
   active, run `prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > baseline.sql`,
   review it, apply it, then `prisma migrate resolve --applied <baseline>`.
4. **Data transfer** (preserves M1–M3 data: users, sessions, projects, timeline versions,
   media assets, jobs, decisions, upload sessions):
   - preferred: a one-shot ETL script using Prisma clients on both databases
     (read all rows per table in the documented FK order: User → Session/Project/WordsToRemove →
     MediaAsset/ExportFile/Job/TimelineVersion → TimelineEdit/CutDecision/UploadSession),
     remapping nothing (all IDs are cuid strings, portable as-is);
   - alternative: `pgloader` with a SQLite source.
   Verify with row-count equality per table (the same invariant the SQLite migration
   script already enforces) plus checksum spot-checks on `TimelineVersion.sequenceJson`.
5. **Storage is unaffected**: media files live under `BEANFX_DATA_DIR` (configurable root,
   §4 of the stabilization), never inside the DB — the cutover moves rows only.
6. **Cutover**: stop writers (single deployment today), swap `DATABASE_URL`, run the app,
   hit `/api/health` (must report `database: ok`), run the standard test suite against the
   new backend.
7. **Rollback**: revert `DATABASE_URL` to the untouched SQLite file — the SQLite database
   is read-only during the migration window, so rollback is byte-identical. The PostgreSQL
   side can be dropped and re-run at zero data risk until the cutover moment.

## 4. Backup & restore procedures

- **SQLite (current production)**: nightly `sqlite3 .backup` into `db/backup-<date>/`
  (existing pattern) + SHA256 manifest; restore = stop app, copy back, restart.
- **PostgreSQL (target)**: managed PITR plus nightly `pg_dump --format=custom`;
  restore = create DB, `pg_restore`, point `DATABASE_URL`.
- Both procedures are documented here and MUST be rehearsed once on staging copies before
  the production cutover (the additive-chain rehearsal on a real-data copy —
  p3→p6→p7 against the 2026-11-11 backup — was executed and verified during stabilization:
  all rows preserved, `PRAGMA integrity_check` ok).

## 5. Concurrency notes (why this matters)

SQLite serializes writers; the timeline's optimistic-concurrency design relies on the
`@@unique([projectId, versionNumber])` constraint, whose P2002 rejection is mapped to a real
HTTP 409 (stabilization fix). PostgreSQL gives the same semantics with true concurrent
writers and no single-writer ceiling — the worker claim pattern
(conditional `UPDATE … WHERE status='QUEUED'`) ports unchanged and becomes the natural
`SKIP LOCKED` upgrade path for horizontally scaled workers.

## 6. Honest statement

This sandbox has no PostgreSQL server provisioned, so **no live switch or data-transfer
rehearsal against a real PostgreSQL instance was executed**. What IS verified here: the
schema validates under the PostgreSQL provider, application code contains no
SQLite-only SQL, the migration tooling supports rehearsal on copies, and the full additive
chain was proven against a real pre-migration database with zero data loss. The remaining
steps (§3) require a PostgreSQL endpoint and a maintenance window; they are mechanical once
available.
