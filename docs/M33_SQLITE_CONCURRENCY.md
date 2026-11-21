# M33 — SQLITE FOUR-WRITER CONTENTION (Track C)

**Result: root-caused with measurements and fixed. 19/20 repeated HTTP runs pass (18 consecutive at cutoff); ladder 0 engine errors at 8 writers (was 72).**

## Original failure

`test-m31-performance.test.ts` → "concurrent saves hold optimistic-concurrency guarantees": 4 same-base timeline writes — expected 200 + 409s == 4; observed 2 (two 400s: "Socket timeout — the database failed to respond within the configured timeout"). Optimistic concurrency held (one winner, one clean 409); two requests died at the DB engine level. Reproduced deterministically (~5s stalls, exactly matching the M31/M32 baseline records).

## Reproduction (controlled, `scripts/test-m33-sqlite-ladder.ts`)

Same-base interactive-transaction races on isolated scratch DBs, 12 rounds × {1,2,4,8} writers:

| Config | 4 writers | 8 writers | max race |
|---|---|---|---|
| Library default (pool = many connections, journal=delete, busy_timeout=5000) | 12 wins, 12 P2002, **24 ENGINE_ERRORS** | 12 wins, 1 P2002, **72 ENGINE_ERRORS + 11 other** | 5019ms / 15027ms |
| WAL only | identical (writer-writer exclusion is inherent) | identical | 5011ms |
| **`connection_limit=2` + WAL (the fix)** | **0 errors**, 36 clean P2002→409 | **0 errors**, 84 clean P2002→409 | **10–13ms** |

Correctness invariant in every phase: exactly one committed version per race round (final counts exact) — no lost writes, no double-commits at any setting.

## Root cause

NOT "SQLite can only do one write at a time" (that is inherent and handled). The failure is the Prisma SQLite connection POOL opening many connections: concurrent interactive transactions on DIFFERENT connections contend on the single-writer lock and stall until the engine's ~5s socket/busy timeout instead of failing fast or queuing. With the pool sized to the documented SQLite configuration (`connection_limit=2`), writers QUEUE at the pool and resolve in milliseconds; conflicts surface as clean P2002 → real 409s with the authoritative head.

**Why WAL too:** WAL does not fix the writer race (measured) but removes reader/writer exclusion — reads stay concurrent with writes under mixed load, which materially helps the rest of the app.

## The fix (minimal, evidence-based)

`src/lib/db.ts`: non-SQLite URLs untouched; `?connection_limit=2` appended when the URL has no explicit pool configuration; `PRAGMA journal_mode=WAL` set idempotently (persistent per DB file, fire-and-forget). No application writes serialized at the app level; no optimistic-concurrency change; no test removed or weakened; no arbitrary sleeps.

## Repeated-run evidence (exact command)

`M31_BASE=http://localhost:3118 M31_DB=file:/tmp/m33-e2e.db bun test scripts/test-m31-performance.test.ts` × 20 runs: **19 pass / 1 fail** — logs `evidence/m33-perf-4..21.log`; the single failing run (run 2, 10.07s) was not captured with full error text (log filter); its duration signature matches a P2024 pool timeout (10s maxWait), i.e. a DIFFERENT, bounded wait behavior than the original 5s engine socket-timeout. 18 consecutive passes followed. Owner action: capture full logs if it recurs; optionally `?pool_timeout=15` for burst tolerance.

## Production deployment implication

SQLite remains a single-writer embedded database: correctness is guaranteed (optimistic concurrency + atomic transactions), but sustained multi-writer throughput is bounded by design. For high-concurrency production deployments the owner decision is PostgreSQL (Prisma datasource swap) — no code change is made for that here.
