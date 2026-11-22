/**
 * BEAN FX — M36 Phase C: SQLite operational controls for the single-server
 * deployment. Read-mostly operator tool; the `verify` command is the gate the
 * install/upgrade/rehearsal scripts call. NEVER mutates user data.
 *
 * Commands:
 *   verify  --url file:…            connectivity + integrity + WAL + perms + contention signals
 *   wal     --url file:…            set/verify journal_mode=WAL (idempotent, reports current)
 *   integrity --url file:…          PRAGMA integrity_check (quick_check via --quick)
 *   stats   --url file:…            page counts, WAL size, journal mode, free pages
 *
 * Exit codes: 0 ok · 1 operational failure (integrity not ok / unreachable)
 */
import { Database } from "bun:sqlite";
import { statSync, existsSync } from "fs";

const args = process.argv.slice(2);
const cmd = args[0];
const urlIdx = args.indexOf("--url");
const url = urlIdx >= 0 ? args[urlIdx + 1] : (process.env.DATABASE_URL ?? "");
if (!cmd || !url) {
  console.error("usage: m36-db-ops.ts {verify|wal|integrity|stats} --url file:<path>[?connection_limit=2] [--quick]");
  process.exit(1);
}
const dbPath = url.slice("file:".length).split("?")[0];

function die(msg: string): never {
  console.error(`DB_OPS_FAIL: ${msg}`);
  process.exit(1);
}
if (!existsSync(dbPath)) {
  die(`database file missing: ${dbPath} — run \`bunx prisma db push\` after creating the directory (never with --accept-data-loss)`);
}
const st = statSync(dbPath);
const mode = (st.mode & 0o777).toString(8);

// Open read-only: verify/integrity/stats never need a writer.
let db: Database;
try {
  db = new Database(dbPath, { readonly: true });
} catch (e) {
  die(`cannot open ${dbPath} read-only: ${(e as Error).message}`);
}

const one = (sql: string) => db.query(sql).get() as Record<string, unknown>;

if (cmd === "wal") {
  const d = new Database(dbPath);
  const r = d.query("PRAGMA journal_mode=WAL").get() as Record<string, unknown>;
  d.close();
  console.log(`journal_mode=${r.journal_mode}`);
  process.exit(String(r.journal_mode) === "wal" ? 0 : 1);
}

if (cmd === "integrity") {
  const quick = args.includes("--quick");
  const r = db.query(`PRAGMA ${quick ? "quick_check" : "integrity_check"}`).get() as Record<string, unknown>;
  const res = String(Object.values(r)[0]);
  console.log(`${quick ? "quick" : "integrity"}_check=${res}`);
  db.close();
  process.exit(res === "ok" ? 0 : 1);
}

if (cmd === "stats") {
  const jm = (db.query("PRAGMA journal_mode").get() as Record<string, unknown>).journal_mode;
  const pages = one("PRAGMA page_count") as unknown as { page_count: number };
  const freelist = one("PRAGMA freelist_count") as unknown as { freelist_count: number };
  const sizeMB = (st.size / 1024 / 1024).toFixed(1);
  const walMB = existsSync(`${dbPath}-wal`) ? (statSync(`${dbPath}-wal`).size / 1024 / 1024).toFixed(2) : "0";
  console.log(`db=${dbPath} size=${sizeMB}MB mode=${jm} pages=${pages.page_count} freelist=${freelist.freelist_count} wal=${walMB}MB perms=${mode}`);
  db.close();
  process.exit(0);
}

// verify (default gate)
const checks: string[] = [];
const integrity = String((db.query("PRAGMA integrity_check").get() as Record<string, unknown>).integrity_check);
checks.push(`integrity=${integrity}`);
const jm = String((db.query("PRAGMA journal_mode").get() as Record<string, unknown>).journal_mode);
checks.push(`journal_mode=${jm}`);
const tables = (db.query("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get() as { c: number }).c;
checks.push(`tables=${tables}`);
// Contention visibility: failed jobs carrying SQLite busy/socket-timeout signatures.
let contention = "n/a";
try {
  const jobs = db.query("SELECT message FROM Job WHERE status='FAILED' ORDER BY createdAt DESC LIMIT 200").all() as { message: string }[];
  const busy = jobs.filter((j) => /SQLITE_BUSY|socket timeout|P2024|database is locked/i.test(j.message)).length;
  contention = busy === 0 ? "0 of recent FAILED jobs" : `${busy} recent FAILED jobs carry lock/timeout signatures`;
} catch { contention = "Job table unreadable"; }
checks.push(`contention=${contention}`);
db.close();
const permsOk = (st.mode & 0o077) === 0;
checks.push(`perms=${mode}${permsOk ? " (private)" : " (WARNING: group/world readable — user data)"}`);
console.log(`DB_VERIFY ${dbPath}\n  ${checks.join("\n  ")}`);
const fail = integrity !== "ok";
process.exit(fail ? 1 : 0);
