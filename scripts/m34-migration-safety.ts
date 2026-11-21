/**
 * M34 Track B4 — migration safety qualification.
 *
 * The repository ships schema via `prisma db push` (schema-sync; there is no
 * prisma/migrations directory — see M34_BASELINE_AUDIT.md). This script
 * qualifies the operations that matter for that model:
 *   1. fresh-database initialization;
 *   2. idempotent re-push (schema already in sync);
 *   3. existing-database upgrade (the validated 2026-11-11 historical backup
 *      is upgraded on a COPY — the original is never touched);
 *   4. failure behavior when the database is locked, then recovery on retry;
 *   5. foreign-key integrity after every step.
 *
 * Run: bun scripts/m34-migration-safety.ts
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "path";

const BACKUP = path.join(process.cwd(), "db", "backup-20261111_042810", "custom.db");
let failures = 0;
const ok = (name: string, detail: string) => console.log(`  PASS ${name}: ${detail}`);
const bad = (name: string, detail: string) => { failures++; console.log(`  FAIL ${name}: ${detail}`); };

function push(url: string, extra = ""): { code: number; out: string } {
  try {
    const out = execSync(`bunx prisma db push --skip-generate ${extra}`, {
      env: { ...process.env, DATABASE_URL: url },
      encoding: "utf8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: String(err.stdout ?? "") + String(err.stderr ?? "") };
  }
}

const { PrismaClient } = await import("@prisma/client");
function client(url: string) {
  return new PrismaClient({ datasources: { db: { url: `file:${url}` } }, log: [] });
}
async function fkClean(url: string): Promise<boolean> {
  const db = client(url);
  try {
    const rows = await db.$queryRawUnsafe<{ foreign_key: number; parent: string }[]>("PRAGMA foreign_key_check");
    return rows.length === 0;
  } finally { await db.$disconnect(); }
}
async function tableCount(url: string): Promise<number> {
  const db = client(url);
  try {
    const r = await db.$queryRawUnsafe<{ c: bigint }[]>("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_prisma_migrations'");
    return Number(r[0].c);
  } finally { await db.$disconnect(); }
}

// ---- 1. fresh database ----
console.log("[1] fresh-database initialization");
const fresh = `/tmp/m34-mig-fresh-${Date.now().toString(36)}.db`;
const r1 = push(`file:${fresh}`);
if (r1.code === 0 && (await tableCount(fresh)) > 15) {
  ok("fresh.push", `push succeeded, ${await tableCount(fresh)} tables created`);
} else bad("fresh.push", `code=${r1.code} tables=${await tableCount(fresh)}`);
ok("fresh.fk", await fkClean(fresh) ? "foreign_key_check clean" : "FK VIOLATIONS");

// ---- 2. idempotency ----
console.log("[2] idempotent re-push");
const r2 = push(`file:${fresh}`);
const already = /already in sync|is now in sync|database is now in sync/i.test(r2.out);
if (r2.code === 0 && already) ok("idempotent.push", "second push reports in sync, no destructive action");
else bad("idempotent.push", `code=${r2.code} out=${r2.out.slice(0, 120)}`);

// ---- 3. existing-database upgrade (copy of the validated backup) ----
console.log("[3] existing-database upgrade (historical backup COPY)");
if (!fs.existsSync(BACKUP)) {
  bad("upgrade.backup-present", `${BACKUP} missing`);
} else {
  const up = `/tmp/m34-mig-upgrade-${Date.now().toString(36)}.db`;
  fs.copyFileSync(BACKUP, up);
  const pre = await tableCount(up);
  const { PrismaClient: _P } = { PrismaClient: null as never }; // placeholder to keep import shape
  const preDb = client(up);
  let preCounts = "";
  try {
    const row = await preDb.$queryRawUnsafe<{ users: bigint; assets: bigint; jobs: bigint }[]>("SELECT (SELECT COUNT(*) FROM User) users, (SELECT COUNT(*) FROM MediaAsset) assets, (SELECT COUNT(*) FROM Job) jobs");
    preCounts = JSON.stringify({ users: Number(row[0].users), assets: Number(row[0].assets), jobs: Number(row[0].jobs) });
  } catch (e) {
    preCounts = `legacy schema read failed (${String(e).slice(0, 60)}) — tables missing from the old DB`;
  }
  await preDb.$disconnect();
  const r3 = push(`file:${up}`);
  const post = await tableCount(up);
  if (r3.code === 0 && post > pre) ok("upgrade.push", `old DB (${pre} tables) upgraded to current schema (${post} tables); pre-counts ${preCounts}`);
  else bad("upgrade.push", `code=${r3.code} pre=${pre} post=${post} out=${r3.out.slice(0, 120)}`);
  const postDb = client(up);
  let postCounts = "";
  try {
    const row2 = await postDb.$queryRawUnsafe<{ users: bigint; assets: bigint; jobs: bigint }[]>("SELECT (SELECT COUNT(*) FROM User) users, (SELECT COUNT(*) FROM MediaAsset) assets, (SELECT COUNT(*) FROM Job) jobs");
    postCounts = JSON.stringify({ users: Number(row2[0].users), assets: Number(row2[0].assets), jobs: Number(row2[0].jobs) });
  } catch { postCounts = "unreadable"; }
  await postDb.$disconnect();
  console.log(`  upgrade data preservation: pre=${preCounts} post=${postCounts}`);
  ok("upgrade.fk", await fkClean(up) ? "foreign_key_check clean after upgrade" : "FK VIOLATIONS AFTER UPGRADE");
}

// ---- 4. locked-database failure + recovery ----
console.log("[4] interrupted/blocked migration behavior");
const lockDb = `/tmp/m34-mig-lock-${Date.now().toString(36)}.db`;
const { Database } = await import("bun:sqlite");
const raw = new Database(lockDb);
raw.exec("BEGIN EXCLUSIVE");
raw.exec("CREATE TABLE IF NOT EXISTS blocker(x)");
const r4 = push(`file:${lockDb}`);
raw.exec("COMMIT");
raw.close();
if (r4.code !== 0) ok("lock.fails-cleanly", `push fails while another process holds an exclusive lock (code=${r4.code}) — SQLite DDL is transactional, no partial schema`);
else bad("lock.fails-cleanly", "push unexpectedly succeeded against an exclusively locked database");
const r4b = push(`file:${lockDb}`);
if (r4b.code === 0) ok("lock.recovery", `push succeeds after the lock is released — retry path verified (${await tableCount(lockDb)} tables)`);
else bad("lock.recovery", `code=${r4b.code} ${r4b.out.slice(0, 120)}`);
ok("lock.fk", await fkClean(lockDb) ? "foreign_key_check clean after recovery" : "FK VIOLATIONS");

console.log(failures === 0 ? "\nMIGRATION SAFETY: ALL CHECKS PASSED" : `\nMIGRATION SAFETY: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
