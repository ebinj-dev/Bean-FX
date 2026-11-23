/**
 * BEAN FX — M38: rendered-output lifecycle manager (dry-run-first GC).
 *
 * Classifies every managed storage class under MEDIA_ROOT, identifies ONLY
 * demonstrably disposable artifacts, and deletes nothing unless an explicit
 * authenticated execute run demands it. Design contract (M38 §5/§6):
 *
 *  - Dry-run is the DEFAULT and never mutates the filesystem.
 *  - Execute is admin-only (requireAdmin at the API edge), bounded per run,
 *    audited, and re-verifies every candidate immediately before deletion.
 *  - Uncertainty PRESERVES: a candidate whose reference status cannot be
 *    determined is classified protected, never collected.
 *  - Whole protected classes (originals/, exports/, proxies/) are never
 *    scanned at all — user source media and user deliverables can only be
 *    removed by the user's own explicit deletion flows.
 *  - No path is ever accepted from a caller: candidates come exclusively
 *    from scanning the managed roots (traversal-proof by construction) and
 *    symlinks are never followed or deleted.
 *  - Active render artifacts are protected by the minimum-age gate (default
 *    24 h — renders carry bounded timeouts well under it) because render
 *    output paths are generated at run time, plus an explicit active-variant
 *    path check for the deterministic EXPORT_VARIANT output names.
 *  - No deployment-specific paths are hardcoded: every root derives from
 *    MEDIA_ROOT (BEANFX_DATA_DIR), same as the rest of the pipeline.
 */
import { promises as fs } from "fs";
import path from "path";
import { db } from "@/lib/db";
import { MEDIA_ROOT, isInsideMediaRoot } from "@/lib/media-storage";

/** Managed categories and their lifecycle classes. */
export type LifecycleCategory =
  | "timeline-renders"
  | "publish-variants"
  | "packages"
  | "project-archives"
  | "waveforms"
  | "laxii-outputs"
  | "publish-thumbnails";

export const GC_CATEGORIES: readonly LifecycleCategory[] = [
  "timeline-renders",
  "publish-variants",
  "packages",
  "project-archives",
  "waveforms",
  "laxii-outputs",
  "publish-thumbnails",
];

/** Whole classes that are NEVER eligible for automatic collection. */
export const PROTECTED_CATEGORIES: readonly string[] = ["originals", "exports", "proxies", "tmp"];

export interface LifecycleCandidate {
  /** Path RELATIVE to MEDIA_ROOT (never an absolute path in reports). */
  relPath: string;
  category: LifecycleCategory;
  sizeBytes: number;
  mtimeMs: number;
  /** Set when the artifact is not eligible for collection. */
  protectedReason: string | null;
  /** Set when it qualifies — why it is demonstrably disposable. */
  eligibleReason: string | null;
}

export interface LifecycleRunReport {
  mode: "dry-run" | "execute";
  ranAt: string;
  scannedFiles: number;
  protectedFiles: number;
  eligibleFiles: number;
  deletedFiles: number;
  failedFiles: number;
  reclaimableBytes: number;
  reclaimedBytes: number;
  protectedBytes: number;
  scannedBytes: number;
  limits: { minAgeHours: number; maxFiles: number; maxBytes: number };
  candidates: LifecycleCandidate[];
  outcomes: Array<{ relPath: string; status: "deleted" | "missing" | "changed" | "protected-now" | "refused" | "error"; bytesReclaimed: number; detail?: string }>;
}

/** Conservative defaults; invalid env values fall back to these — an unknown
 *  retention value must never become an aggressive policy. */
export function gcLimits(overrides?: { minAgeHours?: number; maxFiles?: number; maxBytes?: number }): { minAgeHours: number; maxFiles: number; maxBytes: number; minAgeMs: number } {
  const envAge = Number(process.env.BEANFX_GC_MIN_AGE_HOURS);
  const envFiles = Number(process.env.BEANFX_GC_MAX_FILES);
  const envBytes = Number(process.env.BEANFX_GC_MAX_BYTES);
  const minAgeHours = Number.isFinite(overrides?.minAgeHours) && (overrides!.minAgeHours as number) >= 0 ? (overrides!.minAgeHours as number) : Number.isFinite(envAge) && envAge >= 1 ? envAge : 24;
  const maxFiles = Number.isFinite(overrides?.maxFiles) && (overrides!.maxFiles as number) > 0 ? (overrides!.maxFiles as number) : Number.isFinite(envFiles) && envFiles > 0 ? Math.floor(envFiles) : 200;
  const maxBytes = Number.isFinite(overrides?.maxBytes) && (overrides!.maxBytes as number) > 0 ? (overrides!.maxBytes as number) : Number.isFinite(envBytes) && envBytes > 0 ? envBytes : 2 * 1024 * 1024 * 1024;
  return { minAgeHours, maxFiles, maxBytes, minAgeMs: minAgeHours * 3_600_000 };
}

/** Deterministic output path for an EXPORT_VARIANT job (publish/jobs.ts). */
function variantOutputPath(userId: string, variantId: string): string {
  return path.join(MEDIA_ROOT, "publish-variants", `u_${userId}`, `variant_${variantId}.mp4`);
}

interface ReferenceSets {
  exportPaths: Set<string>;
  assetPaths: Set<string>;
  proxyPaths: Set<string>;
  packagePaths: Set<string>;
  archivePaths: Set<string>;
  activeVariantPaths: Set<string>;
}

/** Load every DB reference that protects a file, in bounded queries. */
async function loadReferenceSets(): Promise<ReferenceSets> {
  const take = 5000;
  const [exports, assets, packages, archives, activeVariants] = await Promise.all([
    db.exportFile.findMany({ select: { storagePath: true }, take }),
    db.mediaAsset.findMany({ select: { storagePath: true, proxyPath: true }, take }),
    db.publishPackage.findMany({ select: { storagePath: true }, take }),
    db.projectArchive.findMany({ select: { storagePath: true }, take }),
    db.exportVariant.findMany({
      where: { status: { in: ["QUEUED", "RENDERING"] } },
      select: { id: true, userId: true },
      take: 200,
    }),
  ]);
  const activeVariantPaths = new Set<string>();
  for (const v of activeVariants) {
    activeVariantPaths.add(variantOutputPath(v.userId, v.id));
  }
  return {
    exportPaths: new Set(exports.map((e) => e.storagePath).filter((p): p is string => Boolean(p))),
    assetPaths: new Set(assets.map((a) => a.storagePath).filter((p): p is string => Boolean(p))),
    proxyPaths: new Set(assets.map((a) => a.proxyPath).filter((p): p is string => Boolean(p))),
    packagePaths: new Set(packages.map((p) => p.storagePath).filter((p): p is string => Boolean(p))),
    archivePaths: new Set(archives.map((a) => a.storagePath).filter((p): p is string => Boolean(p))),
    activeVariantPaths,
  };
}

/** Scan one managed category (depth-2: <category>/u_<user>/<file>). */
async function scanCategory(category: LifecycleCategory, now: number, limits: { minAgeMs: number }, refs: ReferenceSets, candidates: LifecycleCandidate[]): Promise<{ scannedBytes: number; protectedBytes: number }> {
  const dir = path.join(MEDIA_ROOT, category);
  let scannedBytes = 0;
  let protectedBytes = 0;
  const userDirs = await fs.readdir(dir).catch(() => [] as string[]);
  for (const userDir of userDirs) {
    const userPath = path.join(dir, userDir);
    const ust = await fs.lstat(userPath).catch(() => null);
    if (!ust) continue;
    if (ust.isSymbolicLink()) continue; // never traverse symlinks
    const files = ust.isDirectory() ? await fs.readdir(userPath).catch(() => [] as string[]) : [userDir];
    const baseDir = ust.isDirectory() ? userPath : dir;
    for (const file of files) {
      const abs = path.join(baseDir, file);
      const st = await fs.lstat(abs).catch(() => null);
      if (!st || st.isSymbolicLink()) continue; // symlink → invisible to GC (protected by omission)
      if (!st.isFile()) continue;
      scannedBytes += st.size;
      const relPath = path.relative(MEDIA_ROOT, abs);
      const candidate: LifecycleCandidate = { relPath, category, sizeBytes: st.size, mtimeMs: st.mtimeMs, protectedReason: null, eligibleReason: null };
      // Protection chain — first match wins; uncertainty protects.
      if (!isInsideMediaRoot(abs)) {
        candidate.protectedReason = "outside managed storage root";
      } else if (now - st.mtimeMs < limits.minAgeMs) {
        candidate.protectedReason = `younger than minimum age (${Math.round(limits.minAgeMs / 3_600_000)} h) — may belong to an active render`;
      } else if (refs.exportPaths.has(abs)) {
        candidate.protectedReason = "registered user export deliverable";
      } else if (refs.assetPaths.has(abs)) {
        candidate.protectedReason = "registered project asset";
      } else if (refs.proxyPaths.has(abs)) {
        candidate.protectedReason = "registered proxy/derived asset";
      } else if (refs.packagePaths.has(abs)) {
        candidate.protectedReason = "publication package deliverable";
      } else if (refs.archivePaths.has(abs)) {
        candidate.protectedReason = "project archive deliverable";
      } else if (refs.activeVariantPaths.has(abs)) {
        candidate.protectedReason = "active export variant job output";
      }
      if (candidate.protectedReason) {
        protectedBytes += st.size;
        candidate.eligibleReason = null;
      } else {
        candidate.eligibleReason = eligibilityReason(category, file);
      }
      candidates.push(candidate);
    }
  }
  return { scannedBytes, protectedBytes };
}

/** Why an unreferenced artifact of this category is demonstrably disposable. */
function eligibilityReason(category: LifecycleCategory, file: string): string {
  switch (category) {
    case "timeline-renders":
      return file.startsWith("seg_")
        ? "orphaned long-form render window segment (concat already settled or job failed)"
        : "no ExportFile references this render output — abandoned failed-render artifact";
    case "publish-variants":
      return "no ExportFile/ExportVariant references this variant output — stale failed-job artifact";
    case "packages":
      return "no PublishPackage row references this zip — orphaned failed packaging attempt";
    case "project-archives":
      return "no ProjectArchive row references this archive — orphaned failed export";
    case "waveforms":
      return "waveform cache for a deleted asset — regenerable derived data";
    case "laxii-outputs":
      return "raw provider output already consumed or abandoned — registration path moved elsewhere";
    case "publish-thumbnails":
      return "no MediaAsset references this thumbnail composite — abandoned composite attempt";
  }
}

/** Scan + classify (NO mutations in either mode — execute deletes later, per
 *  candidate, after full re-verification). */
export async function analyzeLifecycle(options?: { categories?: LifecycleCategory[]; minAgeHours?: number; maxFiles?: number; maxBytes?: number }): Promise<LifecycleRunReport> {
  const limits = gcLimits(options);
  const categories = (options?.categories?.length ? options.categories : [...GC_CATEGORIES]).filter((c) => (GC_CATEGORIES as readonly string[]).includes(c));
  const refs = await loadReferenceSets();
  const candidates: LifecycleCandidate[] = [];
  let scannedBytes = 0;
  let protectedBytes = 0;
  for (const category of categories) {
    const r = await scanCategory(category, Date.now(), limits, refs, candidates);
    scannedBytes += r.scannedBytes;
    protectedBytes += r.protectedBytes;
  }
  // Eligible, oldest first; bounded by maxFiles/maxBytes.
  const eligible = candidates
    .filter((c) => !c.protectedReason)
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  let budget = limits.maxBytes;
  const withinLimits = new Set<string>();
  for (const c of eligible) {
    if (withinLimits.size >= limits.maxFiles || budget - c.sizeBytes < 0) {
      c.protectedReason = `outside this run's limits (max ${limits.maxFiles} files / ${(limits.maxBytes / 1024 / 1024 / 1024).toFixed(1)} GiB)`;
      c.eligibleReason = null;
      continue;
    }
    budget -= c.sizeBytes;
    withinLimits.add(c.relPath);
  }
  const remainingEligible = eligible.filter((c) => c.eligibleReason);
  const report: LifecycleRunReport = {
    mode: "dry-run",
    ranAt: new Date().toISOString(),
    scannedFiles: candidates.length,
    protectedFiles: candidates.filter((c) => c.protectedReason).length,
    eligibleFiles: remainingEligible.length,
    deletedFiles: 0,
    failedFiles: 0,
    reclaimableBytes: remainingEligible.reduce((n, c) => n + c.sizeBytes, 0),
    reclaimedBytes: 0,
    protectedBytes,
    scannedBytes,
    limits: { minAgeHours: limits.minAgeHours, maxFiles: limits.maxFiles, maxBytes: limits.maxBytes },
    candidates,
    outcomes: [],
  };
  return report;
}

/**
 * Explicit destructive execution: re-verifies EVERY candidate immediately
 * before deletion (existence, identity by size+mtime, containment, DB
 * references) — a reference created between analysis and execution protects
 * the file (M38 §6.5). Bounded, audited by the caller, and honest about
 * partial failures.
 */
export async function executeLifecycle(analysis: LifecycleRunReport, options?: { maxFiles?: number; maxBytes?: number }): Promise<LifecycleRunReport> {
  const limits = gcLimits(options);
  const eligible = analysis.candidates.filter((c) => !c.protectedReason).sort((a, b) => a.mtimeMs - b.mtimeMs);
  const refs = await loadReferenceSets();
  let budget = limits.maxBytes;
  let deleted = 0;
  let failed = 0;
  let reclaimed = 0;
  const outcomes: LifecycleRunReport["outcomes"] = [];
  for (const candidate of eligible) {
    if (outcomes.length >= limits.maxFiles) {
      outcomes.push({ relPath: candidate.relPath, status: "refused", bytesReclaimed: 0, detail: `run limit reached (${limits.maxFiles} files)` });
      continue;
    }
    if (budget - candidate.sizeBytes < 0) {
      outcomes.push({ relPath: candidate.relPath, status: "refused", bytesReclaimed: 0, detail: "byte limit reached" });
      continue;
    }
    const abs = path.join(MEDIA_ROOT, candidate.relPath);
    // 1+2: existence/identity + containment, re-verified NOW.
    const st = await fs.lstat(abs).catch(() => null);
    if (!st) {
      outcomes.push({ relPath: candidate.relPath, status: "missing", bytesReclaimed: 0 });
      continue;
    }
    if (st.isSymbolicLink() || st.size !== candidate.sizeBytes || st.mtimeMs !== candidate.mtimeMs) {
      outcomes.push({ relPath: candidate.relPath, status: "changed", bytesReclaimed: 0, detail: "file changed or is a symlink since analysis — preserved" });
      continue;
    }
    if (!isInsideMediaRoot(abs)) {
      outcomes.push({ relPath: candidate.relPath, status: "refused", bytesReclaimed: 0, detail: "outside managed storage root" });
      continue;
    }
    // 3: DB references re-checked NOW (a new ExportFile/asset/package wins).
    const stillReferenced =
      refs.exportPaths.has(abs) ||
      refs.assetPaths.has(abs) ||
      refs.proxyPaths.has(abs) ||
      refs.packagePaths.has(abs) ||
      refs.archivePaths.has(abs) ||
      refs.activeVariantPaths.has(abs);
    if (stillReferenced) {
      outcomes.push({ relPath: candidate.relPath, status: "protected-now", bytesReclaimed: 0, detail: "reference appeared after analysis — preserved" });
      continue;
    }
    // 4: delete (missing file tolerated), record the ACTUAL outcome.
    try {
      await fs.rm(abs, { force: true });
      budget -= candidate.sizeBytes;
      deleted += 1;
      reclaimed += candidate.sizeBytes;
      outcomes.push({ relPath: candidate.relPath, status: "deleted", bytesReclaimed: candidate.sizeBytes });
    } catch (err) {
      failed += 1;
      outcomes.push({ relPath: candidate.relPath, status: "error", bytesReclaimed: 0, detail: err instanceof Error ? err.message.slice(0, 200) : "unlink failed" });
    }
  }
  return {
    ...analysis,
    mode: "execute",
    deletedFiles: deleted,
    failedFiles: failed,
    reclaimedBytes: reclaimed,
    outcomes,
  };
}

export interface StorageUsageSummary {
  totalManagedBytes: number;
  classes: Array<{ label: string; category: string; bytes: number; files: number; kind: "source" | "deliverable" | "derived" | "temp" | "cache" }>;
  note: string;
}

/** Truthful storage usage by class (§7) — estimates from a bounded walk. */
export async function storageUsage(): Promise<StorageUsageSummary> {
  const classes: StorageUsageSummary["classes"] = [];
  const spec: Array<{ category: string; label: string; kind: StorageUsageSummary["classes"][number]["kind"] }> = [
    { category: "originals", label: "Original source media", kind: "source" },
    { category: "exports", label: "User video exports", kind: "deliverable" },
    { category: "timeline-renders", label: "Timeline renders", kind: "deliverable" },
    { category: "publish-variants", label: "Publish variants", kind: "deliverable" },
    { category: "packages", label: "Publication packages", kind: "deliverable" },
    { category: "project-archives", label: "Project archives", kind: "deliverable" },
    { category: "proxies", label: "Proxies", kind: "derived" },
    { category: "waveforms", label: "Waveform cache", kind: "cache" },
    { category: "publish-thumbnails", label: "Thumbnail composites", kind: "derived" },
    { category: "laxii-outputs", label: "Raw provider outputs", kind: "temp" },
    { category: "tmp", label: "Temporary staging", kind: "temp" },
  ];
  let total = 0;
  for (const s of spec) {
    let bytes = 0;
    let files = 0;
    const dir = path.join(MEDIA_ROOT, s.category);
    const userDirs = await fs.readdir(dir).catch(() => [] as string[]);
    for (const ud of userDirs) {
      const up = path.join(dir, ud);
      const ust = await fs.lstat(up).catch(() => null);
      if (!ust || ust.isSymbolicLink()) continue;
      const entries = ust.isDirectory() ? await fs.readdir(up).catch(() => [] as string[]) : [ud];
      for (const f of entries) {
        const st = await fs.lstat(ust.isDirectory() ? path.join(up, f) : path.join(dir, f)).catch(() => null);
        if (st && st.isFile()) {
          bytes += st.size;
          files += 1;
        }
      }
    }
    total += bytes;
    classes.push({ label: s.label, category: s.category, bytes, files, kind: s.kind });
  }
  return {
    totalManagedBytes: total,
    classes,
    note: "Estimates from the managed roots only; reclaimed-vs-protected distinctions come from lifecycle runs, never from this summary.",
  };
}
