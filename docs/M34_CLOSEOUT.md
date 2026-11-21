# M34 CLOSEOUT — M20 Persistent Render & Release-Candidate Verification

**Date:** 2026-11-21 · Branch `feature/ai-creative-studio` · M34 baseline `4ae0b4f` (verified via ls-remote and present in history) · `main` observed at `4b23160` at closeout start (advanced again by the owner externally after PR #20 — not touched by this work).

## 1. Scope

Strictly the M34 closeout: (A) execute the previously interrupted M20 persistent-render suite T1–T7, (B) verify the M34 application startup + browser workflow, (C) reconcile the M34 evidence and release reports. No M35 scope, no new features, no UI redesign, no provider/paid changes.

## 2. Task A — M20 persistent-render suite T1–T7: **7/7 PASS (target met)**

Isolated execution environment: fresh scratch DB `/tmp/beanfx-legacy-m20-durable-render.db` (schema pushed before server start; `connection_limit=2` semantics via the app's own client), isolated media root `/tmp/m34closeout-m20-store`, server on :3117 (pid recorded), ports verified free, ~3 GB RAM / 6.2 GB disk free, no stray render/server processes. All tests sequential; nothing else ran concurrently. The prior interrupted run's raw logs were lost to the sandbox `/tmp` recycle — this is a genuinely fresh, complete execution.

| Test | Result | Runtime | Verified contract |
|---|---|---|---|
| setup (account, fixtures, projects) | PASS | 3.6 s | registration + ffmpeg testsrc fixtures + upload via `/api/media` |
| T1 60s durable render | PASS | 51.3 s | COMPLETED, ffprobe-validated, **zero `seg_*`/`list_*` leftovers** |
| T2 300s durable render (5 windows) | PASS | 199.5 s | COMPLETED, validated |
| T3 600s multitrack (10 windows + overlay) | PASS | 394.5 s | COMPLETED, validated, windowed registration `"windowed":true` + `"windows":10` in ExportFile.paramsJson |
| T4 interrupted render (server SIGKILL mid-render) | PASS | 560.1 s | kill → respawn → **recovery sweep requeued ("Recovered after a worker interruption (attempt 1/3)") → COMPLETED** |
| T5 OOM-killed job | PASS | 40.0 s | FAILED by the recovery sweep, **NOT requeued** |
| T6 cancellation mid-render | PASS | 30.2 s | CANCELLED, media intact |
| T7 repeated submission | PASS | 95.6 s | both renders complete |

Total: **8 pass / 0 fail / 60 expect() calls / 1376 s** — no assertions modified. Evidence: `download/m34/evidence/m20-closeout/suite-results.log` (+ `server.log`). Command: `BEANFX_LEGACY_TEST_DB="file:/tmp/beanfx-legacy-m20-durable-render.db" bun test scripts/test-m20-durable-render.test.ts` (class: VERIFIED).

Overlap note (per §A1): the M34 storage-worker suite (6/6, historical evidence) covers invalid-media refusal and missing-media failure + tmp cleanup; the unique M20 assertions validated here are long-form windowed renders (60/300/600 s), mid-render SIGKILL recovery, OOM fail-not-requeue classification, mid-render cancellation and duplicate-submission idempotence — all now VERIFIED.

## 3. Task B — Application startup & browser walkthrough

**B1 startup (VERIFIED):** the M34 clean-checkout qualification re-ran green end-to-end (`QUAL_SOURCE=rsync bash scripts/qualify-clean-checkout.sh /tmp/m34co-clean 3181`): install → `prisma generate` → preflight (OVERALL: CONFIGURATION REQUIRED, **0 BLOCKED** — providers/SMTP/segmentation honestly degraded) → `prisma db push` (db.file/db.connect/db.schema/db.wal all READY) → server HTTP 200 → in-process worker → **three-format workflow 6 pass / 0 fail** with ffprobe-validated exports → `QUALIFICATION RESULT: PASS`.

**B2 walkthrough (VERIFIED):** browser session against the qualified state (1440×900 and 375×812): marketing home → LOGIN → editor surface (workflow project loaded in the project switcher) → project dashboard (3 media files / 4 exports / three variant projects listed) → Showcase Studio (campaign intake, **"Approved budget $ (required before ANY paid generation)" gate visible** — the honest paid-gating model intact in the UI) → recent exports (real `seq_…mp4`). Zero console errors, zero page errors, 39 API requests tracked with no failures, **no horizontal overflow at 375 px on home or editor** (editor remains desktop-oriented by design; no mobile-optimization claim made).

**B3 screenshots:** the published M33→M34 diff was re-verified from the actual remote history: **9 docs + 16 scripts changed, ZERO UI files** (`src/app|src/components|public` untouched) — M33's 13 inspected screenshots therefore remain the inherited visual evidence, exactly as the M34 report stated. Four M34-specific screenshots were captured and inspected (they prove the fresh-startup operational state not present in M33 evidence): `m34-closeout-01-home-1440.png`, `03-dashboard-1440.png`, `04-showcase-1440.png`, `05-home-375.png` (+ `02-editor-1440`, `06-editor-375`).

## 4. Task C — Report reconciliation

- `M34_REGRESSION_REPORT.md` — row 13 (M20 NOT RUN) updated to VERIFIED 8/8 with this closeout's evidence; closeout rows appended.
- `M34_RELEASE_CANDIDATE_REPORT.md` — the "remaining owner action: re-run M20" is closed; restrictions list updated accordingly.
- All other M34 documents stand unchanged (their historical results are preserved; no regression was observed that would require re-running them).

## 5. Final regression (targeted, per closeout scope)

| Check | Result |
|---|---|
| M20 persistent-render T1–T7 (fresh isolated run) | **8/8 PASS** (this closeout) |
| Clean-checkout startup + three-format render/export workflow | **6/6 PASS** (this closeout) |
| Packaging/import & render/export | covered by the three-format workflow above (package→import→export round trip is part of the M33/M34 qualification path) — no dedicated re-run needed (no src changes since M34) |
| M34 storage-worker suite | 6/6 stands as recorded M34 evidence (no src changes since; re-run unnecessary) |
| TypeScript (`npx tsc --noEmit`) | 0 errors |
| ESLint (M34-touched files) | clean |
| ESLint (full `src/lib` sweep) | **6 pre-existing errors + 1 warning in `src/lib/core/credential-store.ts`** — `no-require-imports` debt introduced in the M22/M23 milestones (file last touched at M23 commit `906c773`; NOT in the M34 diff, which changed no src files). Classified PRE-EXISTING — deliberately not touched in this closeout because it is the credential-storage path; recorded as an owner action |
| Production build (`bun run build`) | OK |

## 6. Known restrictions (unchanged, explicit)

1. **Deployment infrastructure:** ≥8 GB host required for sustained long-form rendering (the 4 GB sandbox remains OOM-bounded; renders fail honestly, never corrupt). SQLite single-render serialization + 2-connection pool is the qualified dev profile; PostgreSQL is the owner decision for high-concurrency production.
2. **Paid providers:** no live paid generation executed or authorized; pricing remains COST UNKNOWN until authoritative sources are recorded; per-operation approval gates unchanged.
3. **Automatic segmentation:** CONFIGURATION REQUIRED until a verified model/provider is configured and approved; manual mask import remains the supported path.
4. **Legacy environment dependencies:** none remaining for the qualified suites — all suites run from isolated fixtures.
5. No CI workflows exist (owner option).

## 7. Final qualification verdict

## QUALIFIED WITH DOCUMENTED RESTRICTIONS

M34's sole outstanding qualification item (M20 T1–T7) is now VERIFIED 8/8; the startup and browser workflow re-verified PASS with zero errors and M33's inherited UI evidence is confirmed valid (zero-UI-diff). The verdict remains QUALIFIED WITH DOCUMENTED RESTRICTIONS — passing M20 does not make BEAN FX production-ready: the restrictions in §6 (infrastructure envelope, paid-provider owner approvals, segmentation configuration, PostgreSQL decision) are explicit and outstanding. No deployment, production migration, public release or announcement is authorized by this milestone.

## 8. Owner actions remaining

1. Infrastructure: host with ≥8 GB RAM for production-scale rendering; PostgreSQL decision for high-concurrency.
2. Providers: credential installation via official channels + pricing verification (M34_PROVIDER_ONBOARDING.md §5); segmentation provider approval.
3. Optional: CI workflow; configured `bun pm scan` scanner; formal license audit; fix the 6 pre-existing `no-require-imports` lint errors in `src/lib/core/credential-store.ts` (M22/M23-era debt, outside the M34 diff).
