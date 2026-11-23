/**
 * BEAN FX — M39 §4: admin storage visibility tests.
 *
 * Contract under test: storageVisibility() reports TRUTHFUL, non-double-
 * counted rollups of the managed classes, a bounded dry-run reclaimable
 * ESTIMATE that never mutates the filesystem, unknown (unreadable)
 * categories as unknown rather than zero, and the last AUDITED cleanup
 * execution with bytes ACTUALLY reclaimed — never conflating estimates with
 * real deletions.
 *
 * Run: bun test scripts/test-m39-storage-visibility.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, chmodSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Scratch DB + isolated media root BEFORE any module import resolves
// (media-storage resolves MEDIA_ROOT from the environment at import time).
const SCRATCH_DB = path.join(os.tmpdir(), `beanfx-m39-vis-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${SCRATCH_DB}`;
process.env.BEANFX_MEDIA_WORKER_AUTOSTART = "0";
process.env.NODE_ENV = "production";
const MEDIA_TMP = mkdtempSync(path.join(os.tmpdir(), "beanfx-m39-media-"));
process.env.BEANFX_DATA_DIR = MEDIA_TMP;
execSync("node_modules/.bin/prisma db push --skip-generate --accept-data-loss", { env: { ...process.env, DATABASE_URL: `file:${SCRATCH_DB}` }, stdio: ["ignore", "ignore", "inherit"] });

const { storageVisibility, analyzeLifecycle, executeLifecycle, MEDIA_GROUP_CATEGORIES } = await import("../src/lib/storage/lifecycle");
const { MEDIA_ROOT } = await import("../src/lib/media-storage");
const { db } = await import("@/lib/db");

let packageRelPath = "";

const U = "u_visuser";
const OLD = (f: string, bytes = 1024) => {
  const p = path.join(MEDIA_ROOT, f);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, Buffer.alloc(bytes, 7));
  const old = new Date(Date.now() - 48 * 3600_000);
  utimesSync(p, old, old);
  return p;
};

/** Recursive byte/file census of the media root for mutation checks. */
function census(): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (d: string) => {
    for (const e of existsSync(d) ? require("node:fs").readdirSync(d) : []) {
      const p = path.join(d, e);
      const st = require("node:fs").lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        files += 1;
        bytes += st.size;
      }
    }
  };
  walk(MEDIA_ROOT);
  return { files, bytes };
}

describe("M39 storage visibility", () => {
  beforeAll(async () => {
    await db.user.create({ data: { id: U, email: `vis-${U}@test.local`, name: "vis", passwordHash: "x" } }).catch(() => undefined);
    // Seed: a stale orphaned timeline render (eligible) + a stale package
    // zip that IS DB-referenced (protected) + originals/tmp.
    OLD("timeline-renders/u_" + U + "/stale-orphan.mp4", 4096);
    packageRelPath = `packages/u_${U}/stale-but-referenced.zip`;
    const pkgPath = OLD(packageRelPath, 2048);
    await db.publishPackage.create({ data: { userId: U, variantIdsJson: "[]", status: "READY", storagePath: pkgPath, sizeBytes: 2048 } });
    OLD("originals/u_" + U + "/source.mov", 8192);
    mkdirSync(path.join(MEDIA_ROOT, "tmp"), { recursive: true });
    writeFileSync(path.join(MEDIA_ROOT, "tmp", "scratch.txt"), Buffer.alloc(512));
  });

  afterAll(async () => {
    try {
      chmodSync(path.join(MEDIA_ROOT, "waveforms"), 0o755);
    } catch {
      /* V3 may not have run — nothing to restore */
    }
    await db.user.delete({ where: { id: U } }).catch(() => undefined);
    await db.$disconnect();
    rmSync(MEDIA_TMP, { recursive: true, force: true });
    rmSync(SCRATCH_DB, { force: true });
    rmSync(SCRATCH_DB + "-shm", { force: true });
    rmSync(SCRATCH_DB + "-wal", { force: true });
  });

  test("V1: groups partition the managed classes — no double counting, sums equal the total", async () => {
    const vis = await storageVisibility();
    const allCats = vis.groups.flatMap((g) => g.categories);
    // Every managed category appears in EXACTLY one group.
    expect(new Set(allCats).size).toBe(allCats.length);
    expect([...allCats].sort()).toEqual([...MEDIA_GROUP_CATEGORIES].sort());
    const groupSum = vis.groups.reduce((n, g) => n + g.bytes, 0);
    expect(groupSum).toBe(vis.totalManagedBytes);
    // Truthful seed accounting: originals 8192 + tmp 512 + eligible 4096 + referenced 2048.
    expect(vis.totalManagedBytes).toBe(4096 + 2048 + 8192 + 512);
    const originals = vis.groups.find((g) => g.key === "original-media");
    expect(originals?.bytes).toBe(8192);
  });

  test("V2: reclaimable is a dry-run ESTIMATE equal to analyzeLifecycle, and visibility mutates NOTHING", async () => {
    const before = census();
    const vis = await storageVisibility();
    const after = census();
    expect(after).toEqual(before); // byte-for-byte non-mutating
    const dry = await analyzeLifecycle();
    expect(vis.reclaimable.estimatedBytes).toBe(dry.reclaimableBytes);
    expect(vis.reclaimable.eligibleFiles).toBe(dry.eligibleFiles);
    // The stale orphan qualifies; the DB-referenced package does not.
    expect(vis.reclaimable.estimatedBytes).toBe(4096);
    expect(vis.reclaimable.protectedFiles).toBeGreaterThanOrEqual(1);
  });

  test("V3: un-enumerable category is reported unknown — never folded into zero", async () => {
    // A planted FILE in place of the waveforms directory makes readdir fail
    // with ENOTDIR deterministically (chmod 000 is a no-op under root).
    writeFileSync(path.join(MEDIA_ROOT, "waveforms"), Buffer.alloc(16));
    const vis = await storageVisibility();
    const wf = vis.inaccessible.find((i) => i.category === "waveforms");
    expect(wf).toBeTruthy();
    expect(wf!.reason).toBeTruthy();
    // The waveforms group still exists but carries NO fabricated bytes.
    expect(vis.groups.find((g) => g.key === "derived-cache")?.bytes).toBe(0);
  });

  test("V4: lastCleanup is null before any execute, then reports ACTUALLY reclaimed bytes from the audit trail", async () => {
    const visBefore = await storageVisibility();
    expect(visBefore.lastCleanup).toBeNull();
    // Real bounded execute through the M38 executor (audited inside the route
    // convention — audit the run here exactly as the admin route does).
    const dry = await analyzeLifecycle();
    const result = await executeLifecycle(dry, { maxFiles: 10, maxBytes: 64 * 1024 * 1024 });
    await db.auditEvent.create({ data: { action: "storage.lifecycle.execute", detail: JSON.stringify({ deleted: result.deletedFiles, failed: result.failedFiles, reclaimedBytes: result.reclaimedBytes }) } });
    const visAfter = await storageVisibility();
    expect(visAfter.lastCleanup).not.toBeNull();
    expect(visAfter.lastCleanup!.deletedFiles).toBe(1);
    expect(visAfter.lastCleanup!.reclaimedBytes).toBe(4096);
    // Estimate and actuals stay distinct: post-execute estimate drops to 0.
    expect(visAfter.reclaimable.estimatedBytes).toBe(0);
  });
});
