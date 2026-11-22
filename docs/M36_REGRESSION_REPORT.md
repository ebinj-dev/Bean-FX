# M36 — Regression Report

**Date:** 2026-11-22 · Branch `feature/ai-creative-studio` · Baseline: M35 `2bb0219` (verified ancestor) · **M36 `src/` diff = `src/lib/db.ts` only (+16/−1)**; everything else is new deployment tooling/templates/docs — UI, editor, formats, engines, job contract untouched.

## A. Static verification

| Check | Result | Classification |
|---|---|---|
| TypeScript (`npx tsc --noEmit`) | 0 errors | VERIFIED |
| ESLint (M36 files: `m36-backup.ts`, `m36-db-ops.ts`, `m36-validate-env.ts`) | 0 errors | VERIFIED |
| Production build (rehearsal, fresh checkout of the candidate tree) | ✓ built and served | VERIFIED |
| Preflight (candidate tree, isolated DB) | 0 BLOCKED (CONFIGURATION REQUIRED rows = unconfigured providers, as designed) | VERIFIED |
| Secret scan (24 changed files) | 0 matches | VERIFIED |
| OSV dependency scan | 77 packages — 0 CRITICAL / 0 HIGH / 0 MEDIUM / 0 LOW | VERIFIED |

## B. Isolated regression battery (sequential, one fresh scratch DB `file:/tmp/m36-reg/beanfx.db` + server :3117; evidence `download/m36/evidence/regression-battery.log`)

| Suite | Result | Classification |
|---|---|---|
| M20 durable-render T1–T7 (incl. SIGKILL recovery, OOM honesty, cancellation, duplicate submission) | **8 pass / 0 fail** | VERIFIED |
| M34 storage-worker | **6 pass / 0 fail** (also re-run standalone against the *restarted* rehearsal instance: 0 fail) | VERIFIED |
| M29 integrity | **8 pass / 0 fail** | VERIFIED |
| M29 portability | **4 pass / 0 fail** | VERIFIED |
| M32 providers + masks + variants | **35 pass / 0 fail** | VERIFIED |
| M31 studio-core | **14 pass / 0 fail** | VERIFIED |
| M33 acceptance + three-format | battery run: **9 pass / 2 fail** → re-verified: acceptance solo **5/5**, three-format solo **6/6**, combined pair **11/11** | VERIFIED (see analysis) |

### M33 battery failures — analysis (full transparency)

The two failures occurred only in the battery context, where every suite shared one scratch DB on the **3–4 GB sandbox**: the "review → render → QA → delivery" render ran 241 s (vs 43 s solo) and was **killed by the OS (SIGKILL) — out of memory**; the dependent three-format step aborted in 16 ms. The durable-job contract behaved exactly as qualified: the job FAILED with the honest OOM message, the archive job exhausted its retries with "original media is intact", and **nothing was ever falsely marked complete**. Every M33 test passes when the sandbox isn't memory-starved (three clean re-runs). This is the documented M34 restriction (≥8 GB render host; no parallel render suites) manifesting, not an M36 regression — and it is itself evidence for Phase F's "durable jobs are not incorrectly marked complete".

## C. M36-specific verification

| Check | Result |
|---|---|
| 16-step isolated deployment rehearsal | **PASS 16/16** (`M36_LOCAL_DEPLOYMENT_REHEARSAL.md`; three ffprobe-validated exports; backup+restore with 10 media files hash-verified; restart + restored boot) |
| Failure qualification battery | **12/12 PASS** (`M36_FAILURE_QUALIFICATION.md`) |
| Env-validation battery | 5/5 cases (`M36_ENVIRONMENT_CONFIGURATION.md`) |
| Service lifecycle simulation | start→status→health→stop→stopped, live (`M36_SERVICE_AND_REVERSE_PROXY.md`) |
| db-ops (verify/wal/integrity/stats + missing/corrupt/permissions) | live (`M36_DATABASE_OPERATIONS.md`) |

## D. UI & functionality preservation (§13)

| Item | Evidence |
|---|---|
| Editor opens / projects load / timeline & editing unchanged | M33 acceptance workflow (register→intake→editor projects→upload→timeline→render→delivery) 5/5 + combined 11/11; **zero UI diff** |
| Media remains available | rehearsal restart: `/api/health` 200 with persisted projects/media; M29 integrity 8/8 |
| FFmpeg export still works | three-format real exports ffprobe-verified (battery + rehearsal) |
| Showcase Studio available | M31 studio-core 14/14 |
| AI engine readiness truthful | M32 providers 35/35 (unconfigured = CONFIGURATION REQUIRED, never false READY) |
| M30 collaboration intact | collaboration code untouched (diff = db.ts only); M33 acceptance drives the review/collaboration flows — previously qualified in M34 (138-test legacy decoupling) |
| Mobile layout | no UI change → no regression possible |
| No new console/server errors attributable to M36 | the only src change is the fail-honest WAL catch (F10/F11 prove behavior); rehearsal server logs clean (`step5-server.log` harness PASS) |

**Totals:** 8+6+8+4+35+14+11 = **86 suite tests pass** (2 transient, explained) + 16 rehearsal steps + 12 failure cases + 5 env cases. Failed/skipped after re-verification: **0 failed, 0 silently skipped**; classified NOT RUN/OWNER ACTION: staging-host execution, systemd/TLS on a real host, true-ENOSPC (INFRASTRUCTURE REQUIRED) — all documented, none hidden.
