/**
 * BEAN FX — M38 storage lifecycle CLI (operations convenience; same module as
 * the admin API — src/lib/storage/lifecycle.ts).
 *
 * Dry-run is the DEFAULT and prints the report without touching anything:
 *   DATABASE_URL=... bun scripts/storage-lifecycle.ts
 *   DATABASE_URL=... bun scripts/storage-lifecycle.ts --execute
 *   ... --min-age 48 --max-files 100 --max-bytes 536870912 \
 *       --categories timeline-renders,packages
 *
 * Execute still requires the operator to pass --execute explicitly; the
 * printed report shows every candidate with its protection/eligibility
 * reason, per-run limits, and the actual deletion outcomes.
 */
import { analyzeLifecycle, executeLifecycle, storageUsage, GC_CATEGORIES, type LifecycleCategory } from "../src/lib/storage/lifecycle";

const args = process.argv.slice(2);
const execute = args.includes("--execute");
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const categoriesArg = flag("--categories");
const categories = categoriesArg
  ? (categoriesArg.split(",").map((c) => c.trim()).filter((c) => (GC_CATEGORIES as readonly string[]).includes(c)) as LifecycleCategory[])
  : undefined;
const minAgeHours = flag("--min-age") ? Number(flag("--min-age")) : undefined;
const maxFiles = flag("--max-files") ? Number(flag("--max-files")) : undefined;
const maxBytes = flag("--max-bytes") ? Number(flag("--max-bytes")) : undefined;

const usage = await storageUsage();
console.log("=== Storage usage by class (managed roots only) ===");
for (const c of usage.classes) {
  console.log(`${c.category.padEnd(18)} ${c.kind.padEnd(12)} ${(c.bytes / 1024 / 1024).toFixed(1).padStart(10)} MB  ${c.files} file(s)`);
}
console.log(`${"TOTAL".padEnd(31)} ${(usage.totalManagedBytes / 1024 / 1024).toFixed(1).padStart(10)} MB`);

const analysis = await analyzeLifecycle({ categories, minAgeHours, maxFiles, maxBytes });
console.log(`\n=== Lifecycle ${analysis.mode.toUpperCase()} — scanned ${analysis.scannedFiles}, protected ${analysis.protectedFiles}, eligible ${analysis.eligibleFiles} ===`);
console.log(`Limits: min age ${analysis.limits.minAgeHours} h · max ${analysis.limits.maxFiles} files · ${(analysis.limits.maxBytes / 1024 / 1024 / 1024).toFixed(1)} GiB per run`);
console.log(`Reclaimable (estimated): ${(analysis.reclaimableBytes / 1024 / 1024).toFixed(1)} MB · protected: ${(analysis.protectedBytes / 1024 / 1024).toFixed(1)} MB`);
for (const c of analysis.candidates.slice(0, 400)) {
  const tag = c.protectedReason ? `PROTECTED (${c.protectedReason})` : `ELIGIBLE (${c.eligibleReason})`;
  console.log(`  [${c.category}] ${c.relPath} — ${(c.sizeBytes / 1024).toFixed(0)} KB — ${tag}`);
}

if (execute) {
  if (analysis.mode !== "dry-run") throw new Error("unreachable");
  const result = await executeLifecycle(analysis, { maxFiles, maxBytes });
  console.log(`\n=== EXECUTE RESULTS — deleted ${result.deletedFiles}, failed ${result.failedFiles}, reclaimed ${(result.reclaimedBytes / 1024 / 1024).toFixed(1)} MB ===`);
  for (const o of result.outcomes) {
    console.log(`  ${o.status.toUpperCase().padEnd(14)} ${o.relPath}${o.detail ? ` — ${o.detail}` : ""}`);
  }
  console.log("\nAudit record written via the admin audit trail (storage.lifecycle.execute).");
} else {
  console.log("\nDry run only — nothing was deleted. Pass --execute to collect (admin/ops only).");
}
process.exit(0);
