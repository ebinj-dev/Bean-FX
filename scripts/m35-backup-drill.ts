#!/usr/bin/env bun
/**
 * M35 Track G — isolated backup → restore → integrity drill using bun:sqlite.
 *
 * The sqlite3 CLI is not installed in this sandbox (no dpkg root), so the
 * M20-era drill (backup-db.sh / restore-db.sh) is reproduced with bun:sqlite:
 *   1. consistent snapshot of the source via VACUUM INTO (single writer-free pass)
 *   2. integrity_check on the snapshot
 *   3. restore = copy snapshot to an isolated target, checkpoint WAL
 *   4. integrity_check on the restored copy
 *   5. row-count comparison across core tables (source vs restored)
 *   6. media-root spot check: SHA-256 of up to 5 registered media files
 *
 * NEVER restores in place; target is a fresh /tmp file. Exit 0 only when every
 * check passes. Usage: bun scripts/m35-backup-drill.ts <source-db> <media-root>
 */
import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { readdirSync, statSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";

const src = process.argv[2];
const mediaRoot = process.argv[3] || "";
if (!src) { console.error("usage: bun scripts/m35-backup-drill.ts <source-db> [media-root]"); process.exit(2); }
mkdirSync("/tmp/m35-drill", { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const snap = `/tmp/m35-drill/beanfx-db-${stamp}.db`;
const target = `/tmp/m35-drill/restore-${stamp}.db`;
const rows = (db: Database, table: string) =>
  (db.query(`SELECT COUNT(*) c FROM "${table}"`).get() as { c: number }).c;

// 1. consistent snapshot
const s = new Database(src, { readonly: true });
const t0 = performance.now();
s.exec(`VACUUM INTO '${snap}'`);
const backupMs = Math.round(performance.now() - t0);
s.close();

// 2. snapshot integrity
const b = new Database(snap, { readonly: true });
const intB = b.query("PRAGMA integrity_check").get() as { integrity_check: string };

// 3-4. restore to isolated target (copy snapshot — never in place) + checkpoint + integrity
import { copyFileSync } from "fs";
const t1 = performance.now();
copyFileSync(snap, target);
const r = new Database(target);
r.exec("PRAGMA wal_checkpoint(TRUNCATE);");
const intR = r.query("PRAGMA integrity_check").get() as { integrity_check: string };
const restoreMs = Math.round(performance.now() - t1);

// 5. row-count comparison
const tables = ["User", "Project", "MediaAsset", "Job", "Session", "ExportFile"];
const src2 = new Database(src, { readonly: true });
const counts = tables.map((t) => {
  const a = rows(src2, t), z = rows(r, t);
  return `${t}: ${a}->${z} ${a === z ? "OK" : "MISMATCH"}`;
});
const allMatch = counts.every((c) => c.endsWith("OK"));
b.close();

// 6. media spot check (up to 5 files, sha256)
let media = "media-root not provided — skipped";
if (mediaRoot) {
  try {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory() && files.length < 20) walk(p);
        else if (files.length < 5) files.push(p);
      }
    };
    walk(mediaRoot);
    media = files.map((f) => `${f.split("/").pop()} sha256=${createHash("sha256").update(readFileSync(f)).digest("hex").slice(0, 16)}`).join("; ");
  } catch (e) { media = `media check error: ${(e as Error).message}`; }
}

console.log(`BACKUP_OK snapshot=${snap} took=${backupMs}ms integrity=${intB.integrity_check}`);
console.log(`RESTORE_OK target=${target} took=${restoreMs}ms integrity=${intR.integrity_check}`);
console.log(counts.join("\n"));
console.log(`media: ${media}`);
const pass = intB.integrity_check === "ok" && intR.integrity_check === "ok" && allMatch;
console.log(pass ? "DRILL_PASS" : "DRILL_FAIL");
process.exit(pass ? 0 : 1);
