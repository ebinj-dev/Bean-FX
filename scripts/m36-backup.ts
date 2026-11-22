/**
 * BEAN FX — M36 Phase D: backup / restore / retention operations.
 *
 * backup   Consistent SQLite snapshot (VACUUM INTO) + media tree copy, with a
 *          manifest recording timestamp, db identity (sha256, tables, row
 *          counts) and every media file's sha256. --verify re-checks hashes.
 * restore  Copies a snapshot into an ISOLATED target root — refuses anything
 *          that looks like the live database/media root — then verifies
 *          integrity + row counts + media checksums against the manifest.
 * prune    Retention: keeps the newest N snapshot dirs (default 14).
 *
 * OFF-HOST: a local snapshot is NOT an off-host backup. Until an adapter is
 * configured this tool prints: OFF-HOST BACKUP: CONFIGURATION REQUIRED.
 * The adapter contract is documented in docs/M36_BACKUP_RESTORE_OPERATIONS.md.
 * This tool never uploads anywhere.
 *
 * Exit codes: 0 ok · 1 backup failed · 2 verification failed · 3 restore failed · 4 prune failed
 *
 * Usage:
 *   m36-backup.ts backup  --db file:<path> --media <root> --out <dir> [--verify] [--keep N]
 *   m36-backup.ts restore --snapshot <dir> --target-root <dir>
 *   m36-backup.ts prune   --out <dir> [--keep N]
 */
import { Database } from "bun:sqlite";
import { createHash } from "crypto";
import {
  mkdirSync, existsSync, statSync, readdirSync, readFileSync,
  cpSync, rmSync, writeFileSync, copyFileSync, renameSync,
} from "fs";
import { join, relative } from "path";

const args = process.argv.slice(2);
const get = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const cmd = args[0];
const sha256 = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const rows = (db: Database, t: string) => (db.query(`SELECT COUNT(*) c FROM "${t}"`).get() as { c: number }).c;
const CORE = ["User", "Project", "MediaAsset", "Job", "Session", "ExportFile"];

function fail(code: number, msg: string): never {
  console.error(`${["BACKUP_FAIL", "VERIFY_FAIL", "RESTORE_FAIL", "PRUNE_FAIL"][code - 1]}: ${msg}`);
  process.exit(code);
}

/** Recursively collect files under root as {abs, rel}. Skips render tmp prefixes. */
function walk(root: string): { abs: string; rel: string }[] {
  const out: { abs: string; rel: string }[] = [];
  const rec = (d: string) => {
    for (const f of readdirSync(d)) {
      if (f.startsWith(".health-")) continue;
      const abs = join(d, f);
      if (statSync(abs).isDirectory()) rec(abs);
      else out.push({ abs, rel: relative(root, abs) });
    }
  };
  rec(root);
  return out;
}

const media = get("--media");
const outDir = get("--out");
const keep = Number(get("--keep") ?? 14);

if (cmd === "backup") {
  const url = get("--db") ?? process.env.DATABASE_URL ?? "";
  if (!url.startsWith("file:") || !media || !outDir) fail(1, "backup needs --db file:… --media <root> --out <dir>");
  const dbPath = url.slice(5).split("?")[0];
  if (!existsSync(dbPath)) fail(1, `database missing: ${dbPath}`);
  if (!existsSync(media)) fail(1, `media root missing: ${media}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const snap = join(outDir, `beanfx-backup-${stamp}`);
  const tmp = `${snap}.tmp`;
  try {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(join(tmp, "db"), { recursive: true });
    // 1. consistent DB snapshot
    const src = new Database(dbPath, { readonly: true });
    src.exec(`VACUUM INTO '${join(tmp, "db", "beanfx.db")}'`);
    src.close();
    // 2. media tree copy (never deletes anything; copies in place)
    cpSync(media, join(tmp, "media"), { recursive: true });
    // 3. manifest: db identity + row counts + media hashes
    const b = new Database(join(tmp, "db", "beanfx.db"), { readonly: true });
    const integrity = String((b.query("PRAGMA integrity_check").get() as Record<string, unknown>).integrity_check);
    const dbSha = sha256(join(tmp, "db", "beanfx.db"));
    const counts: Record<string, number> = {};
    for (const t of CORE) counts[t] = rows(b, t);
    b.close();
    const mediaFiles = walk(join(tmp, "media")).map((f) => ({ rel: f.rel, sha256: sha256(f.abs), bytes: statSync(f.abs).size }));
    const manifest = {
      tool: "m36-backup.ts", createdAt: new Date().toISOString(),
      db: { sourcePath: dbPath, sha256: dbSha, integrity, tables: counts, bytes: statSync(join(tmp, "db", "beanfx.db")).size },
      media: { sourceRoot: media, fileCount: mediaFiles.length, files: mediaFiles },
      offHost: "not-configured",
    };
    writeFileSync(join(tmp, "manifest.json"), JSON.stringify(manifest, null, 1));
    // atomic-ish publish
    rmSync(snap, { recursive: true, force: true });
    if (existsSync(snap)) fail(1, `snapshot dir ${snap} unexpectedly exists`);
    renameOrCopy(tmp, snap);
    console.log(`BACKUP_OK snapshot=${snap} dbSha=${dbSha.slice(0, 16)} mediaFiles=${mediaFiles.length} integrity=${integrity}`);
    console.log("OFF-HOST BACKUP: CONFIGURATION REQUIRED");
    // 4. optional verification + retention
    if (args.includes("--verify")) {
      const bad = mediaFiles.filter((f) => sha256(join(snap, "media", f.rel)) !== f.sha256);
      if (bad.length || sha256(join(snap, "db", "beanfx.db")) !== dbSha) fail(2, `post-backup hash mismatch on ${bad.length + 1} files`);
      console.log("BACKUP_VERIFY_OK all hashes re-checked");
    }
    prune(outDir, keep);
    process.exit(0);
  } catch (e) {
    // failure-safe cleanup of the partial temp dir only (never the live tree)
    rmSync(tmp, { recursive: true, force: true });
    fail(1, (e as Error).message);
  }
}

if (cmd === "restore") {
  const snap = get("--snapshot") ?? "";
  const targetRoot = get("--target-root") ?? "";
  if (!existsSync(join(snap, "manifest.json"))) fail(3, `not a snapshot dir: ${snap} (manifest.json missing)`);
  const man = JSON.parse(readFileSync(join(snap, "manifest.json"), "utf8"));
  // Explicit prevention of live overwrite:
  if (targetRoot === man.db.sourcePath || targetRoot === man.media.sourceRoot)
    fail(3, "target root equals a recorded live source path — refuse");
  if (process.env.DATABASE_URL?.startsWith("file:") &&
      join(process.env.DATABASE_URL.slice(5).split("?")[0]) === join(targetRoot, "beanfx-staging.db"))
    fail(3, "target db path equals the CURRENT DATABASE_URL live file — use an isolated target root");
  if (process.env.BEANFX_DATA_DIR && join(process.env.BEANFX_DATA_DIR) === join(targetRoot, "media-store"))
    fail(3, "target media root equals the CURRENT live BEANFX_DATA_DIR — use an isolated target root");
  const tmp = `${targetRoot}.tmp-restore`;
  try {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    copyFileSync(join(snap, "db", "beanfx.db"), join(tmp, "beanfx-staging.db"));
    cpSync(join(snap, "media"), join(tmp, "media-store"), { recursive: true });
    // verification: integrity + row counts + media checksums
    const r = new Database(join(tmp, "beanfx-staging.db"), { readonly: true });
    const integrity = String((r.query("PRAGMA integrity_check").get() as Record<string, unknown>).integrity_check);
    const counts: Record<string, string> = {};
    for (const t of CORE) {
      const live = man.db.tables[t] ?? 0, got = rows(r, t);
      counts[t] = `${live}->${got} ${live === got ? "OK" : "MISMATCH"}`;
    }
    r.close();
    const mism = man.media.files.filter((f: { rel: string; sha256: string }) => !existsSync(join(tmp, "media-store", f.rel)) || sha256(join(tmp, "media-store", f.rel)) !== f.sha256);
    rmSync(tmp, { recursive: true, force: true });
    if (integrity !== "ok" || mism.length || Object.values(counts).some((c) => c.includes("MISMATCH")))
      fail(2, `restore verification failed: integrity=${integrity} mediaMismatches=${mism.length} counts=${JSON.stringify(counts)}`);
    // publish verified restore into the isolated target
    mkdirSync(targetRoot, { recursive: true });
    copyFileSync(join(snap, "db", "beanfx.db"), join(targetRoot, "beanfx-staging.db"));
    cpSync(join(snap, "media"), join(targetRoot, "media-store"), { recursive: true });
    console.log(`RESTORE_OK target=${targetRoot} integrity=${integrity} counts=${JSON.stringify(counts)} mediaFiles=${man.media.files.length}`);
    console.log("next: point a scratch DATABASE_URL/BEANFX_DATA_DIR at this root and run m36-db-ops verify + app health");
    process.exit(0);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    fail(3, (e as Error).message);
  }
}

if (cmd === "prune") {
  try {
    prune(outDir ?? "", keep);
    process.exit(0);
  } catch (e) { fail(4, (e as Error).message); }
}

fail(1, `unknown command: ${cmd}. Use backup|restore|prune`);

// --- helpers ---
function prune(dir: string, keepN: number) {
  if (!dir || !existsSync(dir)) return;
  const snaps = readdirSync(dir).filter((d) => d.startsWith("beanfx-backup-")).sort().reverse();
  for (const old of snaps.slice(keepN)) {
    rmSync(join(dir, old), { recursive: true, force: true });
    console.log(`pruned ${old}`);
  }
}
function renameOrCopy(from: string, to: string) {
  try { renameSync(from, to); } catch { cpSync(from, to, { recursive: true }); rmSync(from, { recursive: true, force: true }); }
}
