# M34 — Database Qualification (Track B + Track C)

**Date:** 2026-11-21 · Branch `feature/ai-creative-studio` (M33 closeout tip `f74052b` + M34 work).

## 1. Historical context preserved (never erased)

M33 measured and fixed the SQLite writer-contention defect (root cause: large default pool crossfiring on SQLite's single-writer lock; fix: `connection_limit=2` + WAL). Evidence: 4-writer race 26/27 across sessions, ladder 0 engine errors ≤21 ms, 49/49 version rows, one cold-run read-latency p95 boundary miss (500.35 ms vs `<500 ms` HTTP assertion). M34 re-measures everything below on that same configuration.

## 2. Migration model and safety (Track B4 — VERIFIED)

The repository ships schema via `prisma db push` (schema-sync); **no `prisma/migrations/` directory exists** — `db:migrate`/`db:reset` npm scripts are therefore inert and documented as such. `bun scripts/m34-migration-safety.ts` qualifies the push model end-to-end (log: `m34-mig-safety.log`):

| Check | Result |
|---|---|
| Fresh-database initialization | PASS — 66 tables created, `PRAGMA foreign_key_check` clean |
| Idempotent re-push | PASS — second push reports in sync, no destructive action |
| Existing-database upgrade | PASS — the validated 2026-11-11 historical backup (7 legacy tables; 6 users / 26 assets / 34 jobs) upgraded ON A COPY to the current 66-table schema with **all counts preserved** (pre=post exactly) and FK clean |
| Blocked/interrupted migration | PASS — push fails cleanly while another process holds an exclusive lock (SQLite DDL is transactional — no partial schema), and succeeds on retry after release; FK clean |
| No data-loss flags | `--accept-data-loss` is never used in the qualified paths (only `db:push` npm script retains it for interactive dev; production guidance: review the `migrate diff` first) |

### The historical development database

- The backup binary was recovered from the older snapshot (`/tmp/my-project/db/backup-20261111_042810/custom.db`), **sha256-verified against the backup's own manifest** (`fcb83627…` exact match), and archived into `db/backup-20261111_042810/custom.db` next to its `MANIFEST.txt` (integrity `PRAGMA integrity_check = ok`; row counts match the manifest exactly).
- The live dev database `db/custom.db` was lost in the sandbox recycle and remains EMPTY — no test depends on it anymore (see §3). The owner may restore it by copying the verified backup if the historical records are wanted.

## 3. Legacy suite restoration (Track B1–B3 — VERIFIED)

**Audit result:** the M19–M30 suites that hardcoded `db/custom.db` are fixture-dependent only — they self-seed deterministic records (fixed-ID upserts) and need a schema-migrated DB, not historical rows. M19/M20/M22/M23/M25/M30 classification:

| Suite | Type | Dependency class | Result after isolation |
|---|---|---|---|
| `test-m19-security` | HTTP (:3117) | Infrastructure (needs server) | **21/21 pass** |
| `test-m20-durable-render` | HTTP, spawns own server | Infrastructure + renders | see `M34_STORAGE_WORKER_QUALIFICATION.md` §4 |
| `test-m21-bridge` | hybrid | Fixture-dependent | **8/8 pass** |
| `test-m22-bridge-deep` | hybrid | Fixture-dependent | **12/12 pass** |
| `test-m22-e2e` | hybrid | Fixture-dependent | **3/3 pass** |
| `test-m22-mcp-client` | hybrid | Fixture-dependent | **12/12 pass** |
| `test-m22-security` | hybrid | Fixture-dependent | **18/18 pass** |
| `test-m23-mcp-raw-client` | hybrid | Fixture-dependent | **7/7 pass** |
| `test-m23-security-release` | hybrid | Fixture-dependent | **8/8 pass** |
| `test-m25-billing` | hybrid | Fixture-dependent | **13/13 pass** |
| `test-m30-collab` | hybrid | Fixture-dependent | **13/13 pass** |

Mechanism: `scripts/legacy-fixture.ts` (`scratchLegacyDb(suite)`) gives each suite a deterministic scratch DB under the OS temp dir, applies the CURRENT schema idempotently, and **refuses to ever touch `db/custom.db`**. Hybrid suites share one DB with their server via `BEANFX_LEGACY_TEST_DB`. Zero assertions changed — the diff only replaces the hardcoded URL with the helper call. Operational note: start the shared server AFTER one schema push (the first suite to load pushes it).

## 4. Concurrency & latency benchmark (Track C1 — VERIFIED)

`bun scripts/m34-sqlite-bench.ts` (full log: `m34-bench-final.log`), app-default config (`connection_limit=2`, `journal=wal`, `busy_timeout=5000`), fresh DB, idle machine:

**COLD (fresh database, first touch):**
| Workload | Result |
|---|---|
| Optimistic ladder 1/2/4/8 writers × 12 rounds | wins 12/12 at every level; conflicts stay CLEAN (12/24/36/84 → real P2002s); **0 engine errors**; latency p50 1.8→4.1 ms, p95 3.6→9.9 ms, p99 ≤19.9 ms |
| Integrity | version rows = 53 = expected 53 (one win per round + fixture) — **no lost updates, no double commits** |
| Durable-job claims (40 jobs, 8 claimers) | 40/40 claimed exactly once — **no double claims**; claim latency p95 2.4 ms |
| Collaboration comments (8 writers × 12) | 96/96 rows — **no lost appends**; p95 4.4 ms |
| Mixed reads (4 readers × 20) vs 2 writers | reads p50 1.6 ms, p95 4.2 ms, max 15.9 ms |

**WARM (same DB, caches/pools warmed):**
| Workload | Result |
|---|---|
| Ladder 1/2/4/8 × 12 | wins 12/12; 0 engine errors; p95 2.6–24.1 ms (one 34 ms scheduler hiccup at 2 writers), p99 ≤34 ms |
| Integrity | cumulative 107 rows = 53 + 48 ladder wins + 6 mixed-run wins — no lost updates |
| Job claims | 40/40 exactly once; p95 2.6 ms |
| Comments | 96/96 (phase-tagged) — no lost appends |
| Mixed reads | p50 1.4 ms, p95 3.6 ms |

Database size after the full run: db 1.1 MB, WAL 4.0 MB (WAL checkpoints normally; shm 32 KB).

## 5. Residual latency issue — investigation conclusion (Track C2)

The M33 residual (one HTTP-suite run where the read-latency p95 asserted `<500 ms` and measured 500.35 ms) did **not** reproduce: the M34 M31 performance suite passed **3/3 including the cold first run** on an idle machine (`m34-perf.log`). Combined with the DB-level mixed-read p95 of 3.6–4.2 ms (two orders of magnitude under the threshold), the evidence classifies the residual as **machine-load sensitivity of the HTTP percentile measurement** (it occurred both times when other workloads ran concurrently), not a database-config defect. No thresholds were changed; the test remains exactly as written. Owner recommendation unchanged: keep the suite as-is, run perf suites on an otherwise-idle machine for percentile honesty, and capture full logs on any recurrence.

## 6. Operational limits (Track C3 — measured only)

| Limit | Measured value (4 GB sandbox, SQLite + app default config) |
|---|---|
| Concurrent render jobs | 1 (global serialization by design — M20 OOM guard; recovery sweep requeues/fails honestly) |
| Concurrent optimistic writers | 8 tested — 0 engine errors, conflicts remain clean 409s; beyond 8 untested |
| Concurrent durable-job claimers | 8 tested — exactly-once semantics hold |
| Metadata write latency | p95 ≤ 24 ms at 8 writers (direct DB); HTTP adds transport overhead |
| Database connections | 2 (pool) — the documented M33 configuration; per-connection cost bounded |
| Media uploads | 250 MB/file single-shot, 2 GB chunked, 5 GB per-user quota (constants verified by test) |
| Worker memory | renders are serialized; peak RSS recorded per render by the M20 sampler (see storage/worker qualification) |
| Temporary storage | renders need transient space under `DATA_DIR/tmp`; preflight WARNING < 2 GB free, BLOCKED < 500 MB |
| Job recovery | stale-claim sweep + orphan-ffmpeg kill verified (M20 T4/T5 + M34 storage-worker suite) |

These numbers hold for the **SQLite development profile**. The M33 production guidance stands: for high-concurrency deployments the owner decides on PostgreSQL (the datasource URL is honored verbatim; `connection_limit` is not forced for non-file URLs). SQLite is not replaced in M34.

## 7. Verdict

- Fresh install/migration: VERIFIED.
- Supported upgrade path (schema-sync push, backup-copy upgrade): VERIFIED with data preservation.
- Legacy suites: RESTORED (109 tests, 0 fail across 10 suites) + migration-safety VERIFIED.
- Concurrency profile: VERIFIED (0 engine errors, no lost updates, no double claims, no lost appends, cold+warm).
- Residual p95: classified load-dependent (not reproduced on idle hardware; no threshold touched).
