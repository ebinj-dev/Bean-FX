/**
 * BEAN FX — M38: rendered-output lifecycle manager tests (dry-run-first GC).
 *
 * Contract under test: analyze() NEVER mutates the filesystem; execute()
 * deletes only candidates that are STILL unreferenced, unchanged, inside the
 * managed root, and within the run limits — with whole protected classes
 * (originals/exports/proxies) never scanned, symlinks invisible, active
 * renders/variants protected, and every new reference between analysis and
 * execution winning over the deletion.
 *
 * Run: bun test scripts/test-m38-gc.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, existsSync, readFileSync, symlinkSync, statSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Scratch DB + isolated media root BEFORE any module import resolves
// (media-storage resolves MEDIA_ROOT from the environment at import time).
const SCRATCH_DB = path.join(os.tmpdir(), `beanfx-m38-gc-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${SCRATCH_DB}`;
process.env.BEANFX_MEDIA_WORKER_AUTOSTART = "0";
process.env.NODE_ENV = "production";
const MEDIA_TMP = mkdtempSync(path.join(os.tmpdir(), "beanfx-m38-media-"));
process.env.BEANFX_DATA_DIR = MEDIA_TMP;
execSync("node_modules/.bin/prisma db push --skip-generate --accept-data-loss", { env: { ...process.env, DATABASE_URL: `file:${SCRATCH_DB}` }, stdio: ["ignore", "ignore", "inherit"] });

const { analyzeLifecycle, executeLifecycle, storageUsage, GC_CATEGORIES } = await import("../src/lib/storage/lifecycle");
const { MEDIA_ROOT } = await import("../src/lib/media-storage");
const { db } = await import("@/lib/db");

const U = "u_gcuser";
const OLD = (f: string) => {
  const p = path.join(MEDIA_ROOT, f);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, Buffer.alloc(1024, 7)); // 1 KB
  const old = new Date(Date.now() - 48 * 3600_000);
  utimesSync(p, old, old);
  return p;
};
const FRESH = (f: string, bytes = 2048) => {
  const p = path.join(MEDIA_ROOT, f);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, Buffer.alloc(bytes, 9));
  return p;
};

let exportProtectedPath = "";
let packageProtectedPath = "";
let archiveProtectedPath = "";
let assetAlivePath = "";
let activeVariantPath = "";

async function countFiles(): Promise<{ count: number; bytes: number }> {
  let count = 0;
  let bytes = 0;
  for (const c of GC_CATEGORIES) {
    const dir = path.join(MEDIA_ROOT, c);
    const userDirs = existsSync(dir) ? readdirSync(dir) : [];
    for (const ud of userDirs) {
      const up = path.join(dir, ud);
      const inner = existsSync(up) && statSync(up).isDirectory() ? readdirSync(up) : [];
      for (const f of inner) {
        const st = statSync(path.join(up, f));
        count += 1;
        bytes += st.size;
      }
    }
  }
  return { count, bytes };
}

beforeAll(async () => {
  // Eligible artifacts (old + unreferenced).
  OLD("timeline-renders/u_u1/seg_stale.mp4");
  OLD("timeline-renders/u_u1/seq_abandoned.mp4");
  OLD("publish-variants/u_u1/variant_orphan.mp4");
  OLD("packages/u_u1/package_orphan.zip");
  OLD("project-archives/u_u1/orphan.zip");
  OLD("waveforms/u_u1/wf_deleted.json");
  OLD("laxii-outputs/u_u1/raw_old.png");
  OLD("publish-thumbnails/u_u1/composite_orphan.jpg");
  // Protected by an ExportFile reference.
  exportProtectedPath = OLD("timeline-renders/u_u1/seq_protected.mp4");
  // Protected by freshness (may belong to an active render).
  FRESH("timeline-renders/u_u1/seq_fresh.mp4");
  // Protected by an active EXPORT_VARIANT job — the real deterministic output
  // path file is created in beforeAll under u_gcuser (see below).
  // Protected by PublishPackage / ProjectArchive / MediaAsset references.
  packageProtectedPath = OLD("packages/u_u1/package_protected.zip");
  archiveProtectedPath = OLD("project-archives/u_u1/kept.zip");
  assetAlivePath = OLD("laxii-outputs/u_u1/raw_registered.png");
  // Protected CLASS — never scanned: original source media + user exports.
  OLD("originals/u_u1/user_source.mp4");
  OLD("exports/u_u1/user_export.mp4");
  // Symlink escape attempt: points OUTSIDE the media root — must be invisible.
  try {
    symlinkSync("/etc/hostname", path.join(MEDIA_ROOT, "timeline-renders/u_u1/link_escape.mp4"));
  } catch { /* sandbox may forbid links; the assertion below adapts */ }

  const u = "gcuser";
  await db.user.create({ data: { id: u, email: `gc-${Date.now()}@test.local`, name: "GC", passwordHash: "x", role: "USER" } }).catch(() => undefined);
  await db.exportFile.create({ data: { userId: u, kind: "TIMELINE_RENDER", format: "mp4", filename: "protected.mp4", storagePath: exportProtectedPath, sizeBytes: 1024 } });
  await db.mediaAsset.create({ data: { userId: u, kind: "IMAGE", mimeType: "image/png", storagePath: assetAlivePath, sizeBytes: 1024, originalName: "raw.png" } });
  await db.exportVariant.create({ data: { userId: u, profileId: "youtube_landscape", profileVersion: "1", profileJson: "{}", status: "RENDERING", sourceExportId: null } });
  await db.publishPackage.create({ data: { userId: u, variantIdsJson: "[]", status: "READY", storagePath: packageProtectedPath, sizeBytes: 1024 } });
  await db.projectArchive.create({ data: { userId: u, direction: "EXPORT", status: "COMPLETED", storagePath: archiveProtectedPath, sizeBytes: 1024, formatVersion: "1", schemaVersion: "1" } });
  // The variant output path convention: publish-variants/u_<userId>/variant_<variantId>.mp4
  const v = await db.exportVariant.findFirst({ where: { userId: u, status: "RENDERING" } });
  if (v) {
    mkdirSync(path.join(MEDIA_ROOT, "publish-variants", `u_${u}`), { recursive: true });
    const p = path.join(MEDIA_ROOT, "publish-variants", `u_${u}`, `variant_${v.id}.mp4`);
    writeFileSync(p, Buffer.alloc(1024, 3));
    const old = new Date(Date.now() - 48 * 3600_000);
    utimesSync(p, old, old);
    activeVariantPath = p;
  }
});

afterAll(async () => {
  await db.$disconnect().catch(() => undefined);
  rmSync(MEDIA_TMP, { recursive: true, force: true });
  rmSync(SCRATCH_DB, { force: true });
});

describe("M38 GC — dry-run is non-mutating and classifications are correct", () => {
  test("whole protected classes are never scanned; symlinks are invisible", async () => {
    const report = await analyzeLifecycle();
    expect(report.candidates.every((c) => !c.relPath.startsWith("originals/"))).toBe(true);
    expect(report.candidates.every((c) => !c.relPath.startsWith("exports/"))).toBe(true);
    expect(report.candidates.every((c) => !c.relPath.startsWith("proxies/"))).toBe(true);
    expect(existsSync(path.join(MEDIA_ROOT, "originals/u_u1/user_source.mp4"))).toBe(true);
    expect(existsSync(path.join(MEDIA_ROOT, "exports/u_u1/user_export.mp4"))).toBe(true);
    // The symlink is not in the report and still on disk (never deleted).
    const linkPath = path.join(MEDIA_ROOT, "timeline-renders/u_u1/link_escape.mp4");
    if (existsSync(linkPath)) {
      expect(report.candidates.some((c) => c.relPath.includes("link_escape"))).toBe(false);
    }
    // Paths are relative only — no absolute filesystem paths leak.
    expect(report.candidates.every((c) => !path.isAbsolute(c.relPath))).toBe(true);
  });

  test("references, freshness and active jobs protect their artifacts", async () => {
    const report = await analyzeLifecycle();
    const prot = (needle: string) => report.candidates.find((c) => c.relPath.includes(needle));
    expect(prot("seq_protected")?.protectedReason).toContain("user export deliverable");
    expect(prot("seq_fresh")?.protectedReason).toContain("minimum age");
    expect(prot("package_protected")?.protectedReason).toContain("publication package");
    expect(prot("kept.zip")?.protectedReason).toContain("project archive");
    expect(prot("raw_registered")?.protectedReason).toContain("project asset");
    const u = (await db.user.findFirst({ where: { name: "GC" } }))!;
    const v = await db.exportVariant.findFirst({ where: { userId: u.id, status: "RENDERING" } });
    expect(prot(`variant_${v!.id}.mp4`)?.protectedReason).toContain("active export variant job output");
  });

  test("unreferenced stale artifacts are eligible with a concrete reason", async () => {
    const report = await analyzeLifecycle();
    for (const needle of ["seg_stale", "seq_abandoned", "variant_orphan", "package_orphan", "orphan.zip", "wf_deleted", "raw_old", "composite_orphan"]) {
      const c = report.candidates.find((x) => x.relPath.includes(needle));
      expect(c, needle).toBeDefined();
      expect(c!.protectedReason, needle).toBeNull();
      expect(c!.eligibleReason, needle).toBeTruthy();
    }
    expect(report.reclaimableBytes).toBeGreaterThanOrEqual(8 * 1024);
    expect(report.mode).toBe("dry-run");
    expect(report.deletedFiles).toBe(0);
  });

  test("dry run does NOT touch a single byte (count, sizes, mtimes unchanged)", async () => {
    const before = await countFiles();
    const probePath = path.join(MEDIA_ROOT, "timeline-renders/u_u1/seg_stale.mp4");
    const mtimeBefore = statSync(probePath).mtimeMs;
    const report = await analyzeLifecycle();
    const after = await countFiles();
    expect(after.count).toBe(before.count);
    expect(after.bytes).toBe(before.bytes);
    expect(statSync(probePath).mtimeMs).toBe(mtimeBefore);
    expect(report.outcomes).toHaveLength(0);
  });

  test("storage usage summary is truthful and class-scoped", async () => {
    const usage = await storageUsage();
    const originals = usage.classes.find((c) => c.category === "originals")!;
    expect(originals.files).toBe(1);
    expect(originals.kind).toBe("source");
    expect(usage.totalManagedBytes).toBeGreaterThan(0);
  });
});

describe("M38 GC — explicit execute re-verifies and reclaims", () => {
  test("execute deletes exactly the eligible set; protected artifacts survive", async () => {
    const analysis = await analyzeLifecycle();
    const eligibleRel = analysis.candidates.filter((c) => !c.protectedReason).map((c) => c.relPath);
    expect(eligibleRel.length).toBe(8);
    const result = await executeLifecycle(analysis);
    expect(result.mode).toBe("execute");
    expect(result.deletedFiles).toBe(8);
    expect(result.reclaimedBytes).toBe(8 * 1024);
    expect(result.outcomes.every((o) => o.status === "deleted")).toBe(true);
    for (const rel of eligibleRel) {
      if (existsSync(path.join(MEDIA_ROOT, rel))) console.error("SURVIVOR:", rel, result.outcomes.find((o) => o.relPath === rel));
      expect(existsSync(path.join(MEDIA_ROOT, rel))).toBe(false);
    }
    // Everything protected still exists.
    expect(existsSync(exportProtectedPath)).toBe(true);
    expect(existsSync(activeVariantPath)).toBe(true);
    expect(existsSync(packageProtectedPath)).toBe(true);
    expect(existsSync(archiveProtectedPath)).toBe(true);
    expect(existsSync(assetAlivePath)).toBe(true);
    expect(existsSync(path.join(MEDIA_ROOT, "timeline-renders/u_u1/seq_fresh.mp4"))).toBe(true);
    expect(existsSync(path.join(MEDIA_ROOT, "originals/u_u1/user_source.mp4"))).toBe(true);
    expect(existsSync(path.join(MEDIA_ROOT, "exports/u_u1/user_export.mp4"))).toBe(true);
  });

  test("a reference created between analysis and execution protects the file", async () => {
    const p = OLD("timeline-renders/u_u1/seq_rescued.mp4");
    const analysis = await analyzeLifecycle();
    expect(analysis.candidates.some((c) => c.relPath.endsWith("seq_rescued.mp4") && !c.protectedReason)).toBe(true);
    const u = (await db.user.findFirst({ where: { name: "GC" } }))!;
    await db.exportFile.create({ data: { userId: u.id, kind: "TIMELINE_RENDER", format: "mp4", filename: "rescued.mp4", storagePath: p, sizeBytes: 1024 } });
    const result = await executeLifecycle(analysis);
    const outcome = result.outcomes.find((o) => o.relPath.endsWith("seq_rescued.mp4"));
    expect(outcome?.status).toBe("protected-now");
    expect(existsSync(p)).toBe(true);
    // Re-analysis now classifies it protected.
    const recheck = await analyzeLifecycle();
    expect(recheck.candidates.find((c) => c.relPath.endsWith("seq_rescued.mp4"))?.protectedReason).toContain("user export deliverable");
  });

  test("a changed file between analysis and execution is preserved", async () => {
    const p = OLD("timeline-renders/u_u1/seq_mutating.mp4");
    const analysis = await analyzeLifecycle();
    writeFileSync(p, Buffer.alloc(4096, 1)); // size changed after scan
    const result = await executeLifecycle(analysis);
    expect(result.outcomes.find((o) => o.relPath.endsWith("seq_mutating.mp4"))?.status).toBe("changed");
    expect(existsSync(p)).toBe(true);
  });

  test("already-deleted candidates report missing, not an error", async () => {
    const p = OLD("timeline-renders/u_u1/seq_vanished.mp4");
    const analysis = await analyzeLifecycle();
    rmSync(p);
    const result = await executeLifecycle(analysis);
    expect(result.outcomes.find((o) => o.relPath.endsWith("seq_vanished.mp4"))?.status).toBe("missing");
    expect(result.failedFiles).toBe(0);
  });

  test("per-run limits are honored (files and bytes)", async () => {
    for (const f of ["l1", "l2", "l3", "l4"]) OLD(`timeline-renders/u_u1/limit_${f}.mp4`);
    const analysis = await analyzeLifecycle({ maxFiles: 2 });
    const eligible = analysis.candidates.filter((c) => !c.protectedReason);
    expect(eligible.length).toBe(2);
    const result = await executeLifecycle(analysis, { maxFiles: 2 });
    expect(result.deletedFiles).toBe(2);
    expect(result.outcomes.every((o) => o.status === "deleted")).toBe(true);
    // Over-limit candidates were excluded from the run and still exist —
    // a subsequent default-limits run collects them (safe resume).
    OLD("timeline-renders/u_u1/limit_b1.mp4");
    const analysis2 = await analyzeLifecycle({ maxBytes: 512 });
    expect(analysis2.candidates.filter((c) => !c.protectedReason).length).toBe(0); // byte budget below any file
    const cleanup = await executeLifecycle(await analyzeLifecycle());
    expect(cleanup.deletedFiles).toBe(3); // limit_l3, limit_l4, limit_b1
    expect(cleanup.outcomes.every((o) => o.status === "deleted")).toBe(true);
  });

  test("second execution finds nothing new to delete (idempotent, safe resume)", async () => {
    const analysis = await analyzeLifecycle();
    const result = await executeLifecycle(analysis);
    expect(result.deletedFiles).toBe(0); // everything already collected
    // Interrupted-cleanup resume: a leftover stale artifact is collected next run.
    OLD("timeline-renders/u_u1/resume_stale.mp4");
    const again = await executeLifecycle(await analyzeLifecycle());
    expect(again.deletedFiles).toBe(1);
    const third = await executeLifecycle(await analyzeLifecycle());
    expect(third.deletedFiles).toBe(0);
  });
});
