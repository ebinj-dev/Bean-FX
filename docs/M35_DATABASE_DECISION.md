# M35 Track C — Database Decision: SQLite vs PostgreSQL

**Verdict: SQLite (WAL) is SAFE for the recommended initial single-server deployment. PostgreSQL becomes necessary only at the Option-2 split (worker on a second host) or sustained multi-writer growth. No live migration is performed or authorized this milestone.**

## 1. Evidence base

- M34 SQLite qualification: 1/2/4/8-writer ladders, zero engine errors, clean 409-style conflict handling, no lost updates/duplicate claims/missing appends, read p95 3.6–4.2 ms; M31 performance suite 3/3 including cold run.
- M34 reproducibility: 66 tables, clean FK checks, idempotent sync, backup/restore drills green.
- M35 static portability audit (this milestone, VERIFIED):
  - `prisma validate` on a **postgresql-provider copy of the real schema** → **valid** (only the datasource provider line differs). Evidence: validation run 2026-11-22, `/tmp/schema-pg.prisma`.
  - Entire `src/lib` contains exactly **one** SQLite-specific statement: `PRAGMA journal_mode=WAL` (`src/lib/db.ts:51`) — already wrapped in `.catch(() => {})`, so on PostgreSQL it would error-and-continue harmlessly; the migration plan still makes it provider-conditional.
  - Exactly **one** raw SQL site total (`$queryRawUnsafe`) — the same PRAGMA. All other access is Prisma-generated SQL (provider-agnostic).
- Live PostgreSQL migration test: **INFRASTRUCTURE REQUIRED** (no PostgreSQL server binary or root package install in this 4 GB sandbox). Schema-level validation is the honest maximum here.

## 2. Comparison against BEAN FX's actual workload

| Dimension | SQLite (WAL) — current | PostgreSQL | Winner for initial deploy |
|---|---|---|---|
| Concurrent writes | Single-writer at a time; M34 ladder proved safe conflict handling and honest 409s. Job claims are brief transactions; renders are the long work and live outside the DB (files). | True multi-writer. | Tie for ≤ a few writers (SQLite adequate; measured) |
| Long-running render jobs | Renders do not hold DB transactions — windows write files, jobs update rows briefly. Measured fine (T3 600 s render). | Same. | Tie |
| Multiple application instances | Not supported (file-locked, same-host assumption). | Supported. | PG (but Option 1 has one instance) |
| Multiple render workers | Only via shared DB file — on-NFS SQLite is a known corruption risk → effectively no. | Supported (that IS the coordination point). | PG (only at Option-2 split) |
| Backup / restore | File-level snapshot (`VACUUM INTO` / `.backup`), drill-verified in M20/M31/M35. Simple. | `pg_dump` custom format — runbook mode already present in `backup-db.sh` (untested here — INFRASTRUCTURE REQUIRED). | SQLite (simplicity, proven drills) |
| Migration complexity | n/a | Schema swap validates clean; risks: the one PRAGMA, SQLite-type nuances (e.g., loose typing → `TEXT` dates comparisons), connection_limit budgets per process, `datasource url` env change. Migration path designed in §4; **not executed**. | SQLite (zero work) |
| Operational overhead | None (a file + WAL). No server process to run/patch/monitor. | A managed/self-hosted server to operate from day one. | SQLite |
| Storage durability | Single file + WAL on one host; durability = backup discipline (Track G). | Server-grade durability, replication options. | PG (eventually) |
| Future scale | Same-host bounded. | Multi-host, high concurrency. | PG (later) |
| Cost | €0. | Managed DB cost (COST UNKNOWN — vendor not chosen); self-host = ops time. | SQLite |

## 3. Answers to the mandated questions

1. **Can the current architecture safely run SQLite on a single server?** **YES** — this is precisely the M34/M20-qualified configuration (single writer serialization, renders outside DB transactions, WAL checkpointing, drill-verified backup/restore).
2. **When does PostgreSQL become necessary?** (a) Option-2 split — worker host + app host (DB can no longer be a local file shared across hosts); (b) sustained write concurrency beyond the M34-qualified envelope (many simultaneous job-claiming processes); (c) multi-instance API hosts.

## 4. PostgreSQL migration & rollback plan (DESIGNED ONLY — not executed; requires owner infrastructure)

1. **Prerequisite:** a PostgreSQL 15+ host reachable from the app; `DATABASE_URL="postgresql://…"`; **no destructive migration** — new DB initialized via `prisma db push` (or `migrate deploy` after baselining), never `migrate reset` against any real data.
2. **Provider-conditional PRAGMA:** guard `src/lib/db.ts:51` with a datasource check (e.g., only issue PRAGMA when the URL is not `postgresql:`). One-line change, must be tested against a real PG (INFRASTRUCTURE REQUIRED).
3. **Data migration (isolated rehearsal first):** export SQLite rows via Prisma reads → write through Prisma to PG (type-safe, no hand-written SQL), preserving IDs and `DateTime` values; rehearse on scratch copies only. Risks identified: SQLite's loose typing (verify any integer-boolean columns), `paramsJson` text payloads (JSON strings — portable), autoincrement semantics (use `cuid`-style existing IDs — schema uses string IDs, which removes the classic sequence problem — VERIFIED in schema inspection: IDs are `String @id`).
4. **Verification battery:** run the M20 T1–T7 suite + M34 storage-worker suite + M31 performance suite against a scratch PG database; compare row counts + integrity semantics; FFprobe-validate one export end-to-end.
5. **Rollback:** keep SQLite files and `DATABASE_URL` switchable; rollback = point `DATABASE_URL` back at the SQLite file (re-import any delta rows via the same export/import path). No destructive step exists in the plan.
6. **Compatibility gate:** until step 4 passes on real infrastructure, claim "PostgreSQL-ready at schema level (VERIFIED), runtime compatibility NOT RUN (INFRASTRUCTURE REQUIRED)". This is the honest classification.

## 5. Decision table

| Scenario | Database | Status |
|---|---|---|
| Single-server initial deployment (recommended) | SQLite WAL | **VERIFIED safe (M34 + M35 evidence)** |
| Controlled beta on one host | SQLite WAL | VERIFIED safe |
| Worker split (Option 2) | PostgreSQL | DESIGN READY · runtime migration test INFRASTRUCTURE REQUIRED |
| Growing production (Option 3) | PostgreSQL (+ pooling) | DESIGN READY · same gate |
