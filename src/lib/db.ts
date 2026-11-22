import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

/**
 * M33 Track C — SQLite writer-contention correction (evidence-based, minimal).
 *
 * Root cause (measured, scripts/test-m33-sqlite-ladder.ts): Prisma's SQLite
 * pool opens many connections; concurrent interactive transactions on
 * DIFFERENT connections contend on SQLite's single-writer lock and stall to
 * the engine's ~5s socket/busy timeout — surfacing as "Socket timeout" 400s
 * under 4+ concurrent writers (the M31 performance-suite failure). WAL alone
 * does NOT fix it (writer-writer exclusion is inherent); the correct,
 * Prisma-documented configuration for an embedded SQLite database is a small
 * pool so writers QUEUE at the pool instead of deadlocking at the file lock:
 *   default pool   : 4 writers → 24/48 engine errors, races ~5s
 *   connection_limit=2 + WAL: 0 errors, races ≤20ms, conflicts stay CLEAN
 *     P2002 → real 409s (optimistic concurrency semantics preserved and
 *     faster). WAL additionally keeps READS concurrent with the writer.
 *
 * This is NOT write serialization at the application level: the single-writer
 * property belongs to SQLite itself; the pool only removes the pathological
 * lock crossfire. Production deployment implication is documented in
 * M33_SQLITE_CONCURRENCY.md.
 */
function sqliteUrlForRuntime(): string {
  const raw = process.env.DATABASE_URL ?? "";
  if (!raw.startsWith("file:")) return raw; // non-SQLite deployments untouched
  const base = raw.split("?")[0];
  // Explicit configuration wins; otherwise the documented small pool.
  return raw.includes("connection_limit=") ? raw : `${base}?connection_limit=2`;
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasources: { db: { url: sqliteUrlForRuntime() } },
    // Query logging is dev-only noise; never enabled in production.
    log: process.env.NODE_ENV === 'production' ? [] : ['query'],
  })

// WAL is a persistent per-database-file property: enable it idempotently once
// per client so dev/test/scratch databases all get reader/writer concurrency.
// (The write-path correctness comes from the pool size above; WAL removes the
// reader exclusion that made stalls worse under mixed read/write load.)
// Fire-and-forget: journal_mode is persistent, so ordering vs first query is
// not correctness-critical, and module load must never block on it.
if (!globalForPrisma.prisma) {
  db.$queryRawUnsafe("PRAGMA journal_mode=WAL").catch((err) => {
    // M36 Phase C — honesty split: some PRAGMA failures are OPTIONAL
    // compatibility (in-memory/readonly test databases, non-SQLite URLs)
    // and stay quiet; a REAL initialization failure (missing directory,
    // permissions, corrupt file) must not be concealed — surface it loudly
    // while keeping module load non-blocking (preflight and /api/health
    // still gate readiness independently).
    const url = process.env.DATABASE_URL ?? "";
    const msg = err instanceof Error ? err.message : String(err);
    if (!url.startsWith("file:") || /memory|readonly/i.test(msg)) return;
    console.error(
      `[beanfx:db] WAL setup failed for ${url.split("?")[0]}: ${msg.slice(0, 160)} — ` +
      "this usually means the database path is missing or not writable; " +
      "run `bunx prisma db push` (never with --accept-data-loss) after fixing the path/permissions."
    );
  });
}

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
