# M36 — Database Operations (Phase C)

**Provider unchanged:** SQLite via Prisma (`provider = "sqlite"`, `DATABASE_URL`), M33's `connection_limit=2` writer-pool correction untouched. No PostgreSQL dependency added; no destructive command exists anywhere in the M36 tooling (`db push` without `--accept-data-loss` is the only schema operation used).

## 1. The one source change (minimal, targeted)

`src/lib/db.ts` line-51 WAL PRAGMA previously swallowed **all** failures silently (`catch(() => {})`). Phase C mandates that optional PRAGMA compatibility must be distinguished from real database failures. The change:

```ts
db.$queryRawUnsafe("PRAGMA journal_mode=WAL").catch((err) => {
  const url = process.env.DATABASE_URL ?? "";
  const msg = err instanceof Error ? err.message : String(err);
  if (!url.startsWith("file:") || /memory|readonly/i.test(msg)) return; // optional-compat cases stay quiet
  console.error(`[beanfx:db] WAL setup failed for ${url.split("?")[0]}: ${msg.slice(0,160)} — this usually means the
  database path is missing or not writable; run \`bunx prisma db push\` (never with --accept-data-loss)…`);
});
```

Evidence: failure-qualification **F10** — an unwritable database directory now produces the explicit `[beanfx:db] WAL setup failed … Error code 14: Unable to open the database file` line (previously hidden); **F11** — the in-memory compatibility case stays quiet. The fire-and-forget semantics are preserved (module load never blocks); readiness is still gated by preflight and `/api/health`, which independently verify `db.connect/db.schema/db.wal` and the live `SELECT 1`.

## 2. Operational controls (`scripts/m36-db-ops.ts`)

| Command | What it does | Verified |
|---|---|---|
| `verify --url file:…` | connectivity, `integrity_check`, journal mode, table count, **contention visibility** (scans recent FAILED jobs for `SQLITE_BUSY / socket timeout / P2024 / database is locked` signatures), file-permission audit (flags group/world-readable) | live: `integrity=ok · journal_mode=wal · tables=66 · contention=0 · perms=644 (WARNING)` |
| `wal --url …` | set/verify WAL idempotently | live |
| `integrity --url … [--quick]` | full or quick check | live: `quick_check=ok` |
| `stats --url …` | size, pages, freelist, WAL size, perms | live: 1.1 MB / 287 pages / freelist 0 / WAL 3.93 MB |

Missing file → explicit `DB_OPS_FAIL: database file missing … run bunx prisma db push (never with --accept-data-loss)` (exit 1). Corrupt file → `integrity` failure surfaced, not silent (F4).

## 3. The mandated controls, mapped

- **WAL configuration & verification** — set at client init; verified by `db-ops wal/verify` and preflight's `db.wal` check.
- **File permission checks** — `db-ops verify` flags group/world-readable DB files (user data); `m36-fs-layout.sh` restricts the data root to 0700.
- **Integrity checking** — `db-ops integrity` + post-restore verification (m36-backup).
- **Safe startup when DB missing/invalid** — SQLite auto-creates an empty file; the missing-schema case is surfaced by preflight (`db.schema`), `/api/health` (`SELECT 1` fails → 503), and the new `[beanfx:db]` message; install/rehearsal run `db push` explicitly and `db-ops verify` as the post-init gate.
- **Disk-full handling** — writes fail honestly (job FAILED with stderr tail); `/api/health` fails under 1 GB free; health-check flags ≥85% as DEGRADED. True ENOSPC on a dedicated volume: INFRASTRUCTURE REQUIRED (threshold detection tested; no mountable loop device in the sandbox).
- **Graceful shutdown/restart** — SIGTERM → standalone server exits; restart sweep re-queues stale jobs (M20-verified); rehearsal step 12 restarts against the same DB and re-proves job functionality.
- **Contention visibility** — `db-ops verify` contention line + health-check DEGRADED note when lock/timeout signatures appear in recent failures.
- **Safe maintenance** — snapshot-first rule: every schema-changing step in `m36-upgrade.sh` is preceded by a verified backup; maintenance read-only via `db-ops`; vacuum/optimize left to SQLite defaults (no destructive maintenance added).
