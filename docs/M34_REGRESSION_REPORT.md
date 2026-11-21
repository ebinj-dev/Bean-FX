# M34 — Regression Report

**Date:** 2026-11-21 · Sequential, resource-aware (4 GB sandbox respected; render-heavy suites never run concurrently).

| # | Suite / check | Command | Result | Class |
|---|---|---|---|---|
| 1 | Clean checkout install + startup + workflow | `QUAL_SOURCE=rsync bash scripts/qualify-clean-checkout.sh /tmp/m34-clean 3177` | PASS — 8 steps: clone/rsync, 620 pkgs, generate, preflight 0 BLOCKED, db push, server 200, **three-format workflow 6/6 (66.44s)**, ffprobe-validated exports | VERIFIED |
| 2 | Startup preflight | `bun scripts/preflight.ts` | honest grading (0 BLOCKED; CONFIGURATION REQUIRED for providers/SMTP/segmentation); JSON mode; no secret values printed | VERIFIED |
| 3 | Migration safety | `bun scripts/m34-migration-safety.ts` | ALL CHECKS PASSED (fresh 66 tables FK-clean; idempotent re-push; backup-copy upgrade preserves 6 users/26 assets/34 jobs; locked-DB fails atomically + retry recovers) | VERIFIED |
| 4 | Legacy suites restored | per-file `bun test scripts/test-*.test.ts` with `BEANFX_LEGACY_TEST_DB` | m19 21/21, m21 8/8, m22-deep 12/12, m22-e2e 3/3, m22-mcp 12/12, m22-sec 18/18, m23-raw 7/7, m23-release 8/8, m25 13/13, m30 13/13 = **109 tests, 0 fail** | VERIFIED |
| 5 | SQLite concurrency bench (cold+warm) | `bun scripts/m34-sqlite-bench.ts` | 0 engine errors at 1/2/4/8 writers; conflicts clean; no lost updates (53=53; 107 cumulative); no double claims (40/40 twice); no lost appends (96/96 twice); reads p95 3.6–4.2 ms | VERIFIED |
| 6 | M31 performance (HTTP) ×3 incl. cold run | `M31_BASE=…:3119 bun test scripts/test-m31-performance.test.ts` | 3/3 — the M33 residual p95 miss did NOT reproduce on an idle machine → classified load-dependent | VERIFIED |
| 7 | M31 security | `bun test scripts/test-m31-security.test.ts` | 8/8 | VERIFIED |
| 8 | M34 storage/worker recovery | `bun test scripts/test-m34-storage-worker.test.ts` | 6/6 (R1 invalid media, R2 missing-media FAILED+clean tmp, R3 retry COMPLETED+ffprobe, R4 quota constants, R5 lifecycle) | VERIFIED |
| 9 | Unit regression batch (M32/M33/editor) | per-file `bun test` | providers 11, variants 12, masks 12, portability 9, showcase-core 20, studio-core 14, editor-time 8, editor-commands 22, editor-preview 14, editor-interaction 16 = **138 tests, 0 fail** (matches M33 baseline) | VERIFIED |
| 10 | TypeScript | `npx tsc --noEmit` | 0 errors | VERIFIED |
| 11 | ESLint (all M34-touched files) | `npx eslint …` | clean (after fixing 2 `no-require-imports` in preflight) | VERIFIED |
| 12 | Production build | `bun run build` | OK (executed in-session; also inside the clean-checkout qualification) | VERIFIED |
| 13 | M20 durable-render (T1–T7 long-form) | `BEANFX_LEGACY_TEST_DB="file:/tmp/beanfx-legacy-m20-durable-render.db" bun test scripts/test-m20-durable-render.test.ts` (isolated scratch DB + media root, sequential, idle machine) | **CLOSEOUT: 8/8 PASS** — setup + T1 51s / T2 199s / T3 395s (`"windowed":true`, `"windows":10`) / T4 SIGKILL→recovery sweep→complete 560s / T5 OOM FAILED-not-requeued / T6 cancel / T7 duplicates; 60 expect() calls, 1376s total. Evidence: `download/m34/evidence/m20-closeout/suite-results.log`. The original M34 attempt was interrupted (NOT RUN at the time); completed and verified in the M34 closeout, 2026-11-21 | VERIFIED |
| 14 | Browser walkthrough | M33 evidence (13 inspected screenshots, both viewports, zero 375px overflow) | M34 changed no UI files (tooling/docs/tests only) — M33 evidence carries over; no new UI claims | VERIFIED (carryover) |
| 15 | Security scans | OSV script + SBOM + secret-pattern scan | OSV 0 findings (77 pkgs); SBOM 985 components; scan matches benign | VERIFIED |
| 16 | M33 acceptance re-run | `bun test scripts/test-m33-acceptance.test.ts` | 5/5 in the M33 closeout session on a fresh isolated server; no M34 change touches those code paths (fixture-only diffs in the test file's legacy URLs) — carried over | VERIFIED (carryover) |

**Harness notes (honest):** scratch-DB suites run per-file (batch mode shares one Prisma client across files — pre-existing characteristic, documented in M33). The `qualify-clean-checkout.sh` rsync mode qualifies the candidate tree pre-publication; a fresh-clone re-run against the published tip is the post-publication verification step.

**Not run / not claimed:** anything not in this table was not executed in M34. No skipped or unavailable test is reported as passing.
