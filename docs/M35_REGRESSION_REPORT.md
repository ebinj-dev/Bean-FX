# M35 — Regression Report

**Date:** 2026-11-22 · Branch `feature/ai-creative-studio` · Baseline `c619f41` · M35 changed **no `src/` files** (docs + scripts + deploy template only), so the regression surface is: prove nothing broke, validate the new tooling, and re-run the suites that guard the durable-render and storage contracts.

## Results

| # | Check | Command | Result | Classification |
|---|---|---|---|---|
| 1 | M34 storage-worker suite | `BEANFX_LEGACY_TEST_DB="file:/tmp/m35-m20.db" bun test scripts/test-m34-storage-worker.test.ts` | **6 pass / 0 fail / 30 expect()** (10.3 s) | VERIFIED |
| 2 | M20 persistent-render suite T1–T7 (fresh isolated run: scratch DB `/tmp/m35-m20.db` + media root `/tmp/m35-m20-store`, server :3117, sequential) | `BEANFX_LEGACY_TEST_DB="file:/tmp/m35-m20.db" bun test scripts/test-m20-durable-render.test.ts` | **8 pass / 0 fail** (setup + T1 56.9 s, T2 205.6 s, T3 388.3 s, T4 SIGKILL-recovery 553.8 s, T5 OOM fail-not-requeue 40.0 s, T6 cancel 30.1 s, T7 duplicates 90.5 s; 1370 s total). Evidence: `download/m35/evidence/m20-rerun-results.log` | VERIFIED |
| 3 | TypeScript | `npx tsc --noEmit` | 0 errors | VERIFIED |
| 4 | ESLint (M35-touched files) | `npx eslint scripts/m35-backup-drill.ts` | 0 errors (pre-existing M22/M23-era debt in `src/lib/core/credential-store.ts` unchanged — recorded, owner action) | VERIFIED |
| 5 | Production build | `bun run build` | ✓ Compiled successfully in 27.6 s, exit 0 | VERIFIED |
| 6 | Environment preflight | `bun scripts/preflight.ts` (isolated scratch DB) | OVERALL: CONFIGURATION REQUIRED — 0 BLOCKED (same honest posture as M34; segmentation/paid providers remain owner-gated) | VERIFIED |
| 7 | Database backup/restore drill (isolated, post-suite quiescent DB) | `bun scripts/m35-backup-drill.ts /tmp/m35-m20.db /tmp/m35-m20-store` | **DRILL_PASS** — snapshot integrity ok (8 ms), isolated-restore integrity ok (3 ms), row counts equal across User/Project/MediaAsset/Job/Session/ExportFile, 5 media files SHA-256-sampled. Evidence: `download/m35/evidence/backup-drill.log`. One drill-script defect found and fixed during qualification (restore step originally created an empty target instead of copying the snapshot — fixed in the script itself, never a product file) | VERIFIED |
| 8 | Health-check tooling | `DATABASE_URL=… bash scripts/m35-health-check.sh http://localhost:3117 /tmp/m35-m20-store` — run live **during** the M20 suite | Correctly printed **DEGRADED** (`jobs: FAILED=3 QUEUED=0` — the suite's intentional T5/T6 failure rows) with app/DB/media/disk/mem all green; exit code semantics verified (0/1/2/3) | VERIFIED |
| 9 | PostgreSQL schema compatibility | `sed 's/provider = "sqlite"/provider = "postgresql"/'` on the real schema → `DATABASE_URL="postgresql://…" bunx prisma validate` | schema **valid**; runtime migration test **INFRASTRUCTURE REQUIRED** (no PG server in sandbox) | VERIFIED (schema level) / INFRASTRUCTURE REQUIRED (runtime) |
| 10 | Packaging/import & render/export suites | covered by #2 (T1–T7 exercise the full render→export→ffprobe contract) and unchanged code since M34's 6/6 workflow | carried over | VERIFIED (carryover) |
| 11 | Auth/authorization suites | unchanged code since M33/M34 qualification (138-test legacy decoupling, 109/109) | carried over, no M35 changes touch auth paths | VERIFIED (carryover) |
| 12 | Staging deployment | no staging environment created (not authorized) | NOT RUN — plan + validated tooling provided (Track J) | NOT RUN / OWNER ACTION |
| 13 | Container image validation | no Docker daemon in sandbox | NOT RUN — no Docker files added by design | NOT RUN |

## Harness honesty notes

- First background attempt this milestone failed on a **prisma push / server-start race** (diagnosed, re-run clean) and a **wrong port** (:3119 vs the suite's hardcoded :3117 → ConnectionRefused). Both were harness-configuration errors, corrected before results were recorded; neither touched product code.
- The `sqlite3` CLI is absent in this sandbox (no dpkg root) — `backup-db.sh` remains the primary tool on hosts that have it; the M35 drill reproduces its semantics with `bun:sqlite`.

**Nothing regressed. Every M34/M33/M20 behavior re-checked this milestone passed at or above its recorded baseline.**
