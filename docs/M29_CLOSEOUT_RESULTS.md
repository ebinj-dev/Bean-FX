# M29-C CLOSEOUT RESULTS — Integrity, Clean Environment & Regression

**Date:** 2026-11-19 · **Branch:** feature/ai-creative-studio · **Baseline:** M29 tip `c881e33`
**Closeout commit:** `85c3bfd` — https://github.com/ebinj-dev/Bean-FX/commit/85c3bfdf1c5b02b6dafd4ce6001b824712240c4b (independently clone-verified: M29+M28 ancestors present, both previously-lost download routes restored, 16 evidence files + 3 closeout docs in the remote tree; main `5db3140` unchanged before/after; diff vs M29 tip: 31 files, +780/−44)
**Scope:** closeout/validation only — no redesign, no package-format change, no M30.

## 1. Repository & remote audit (Phase 0)
- Remote feature tip `c881e33` (M29) confirmed; M29 implementation commit `21aa65e` and M28 tip `1058dd7` verified ancestors.
- **`main` was advanced by the owner** (`fb051dd` → `5db3140`) — untouched by this work; M29-C commits only on the feature branch.
- Working tree content-identical to the remote tip (exec bits restored after sandbox recycle).
- **Push-script defect discovered (Phase 0):** `push-m29.sh`'s `rsync --exclude download/` matches ANY `download/` directory at ANY depth — it silently dropped `src/app/api/project-archives/[id]/download/route.ts` (M29) AND deleted `src/app/api/publish/packages/[id]/download/route.ts` (M23) from the pushed tree. Fixed by anchoring the exclude (`/download/`) in the closeout push; both routes return to the remote tree with M29-C.

## 2. Isolated test environment (Phase 1)
- Provider inspected: **SQLite via Prisma** (`DATABASE_URL=file:`); storage root via `BEANFX_DATA_DIR` → `MEDIA_ROOT`; durable jobs in the `Job` table (single queue).
- New disposable environment: **`db/m29closeout.db`** + **`media-store-closeout/`** + port **3118**. Setup script: `scripts/m29closeout-env.sh` (creates db, applies current schema with plain `db push`, starts the built server, prints identity + fixture counts).
- **The normal development database (`db/custom.db`) was NEVER written**: reference snapshot before (8 users) and after (8 users) all closeout runs; cleanup ran only against the disposable db. Suites target the isolated server via `M29_BASE` env (default unchanged).

## 3. The six integrity failures — diagnosis & resolution (Phase 2)
| # | Test | Original failure | Root cause | Resolution | Class |
|---|---|---|---|---|---|
| 1 | corrupted-media test | flip at hard-coded `len-200` landed in a tolerant zip region; import COMPLETED | test artifact: METADATA package + arbitrary offset | rewritten: FULL package, flip a byte inside a REAL media payload located via ZIP central-directory metadata → importer rejects with exact checksum classification | test fix |
| 2 | METADATA import missing=0 | manifest said "media relinked later" but media was staged | **REAL product bug 1:** `buildManifest` ignored `mode` for ORIGINAL media (packages lied via their own `omitted` list) | METADATA mode now records references with `path:""` and ships NO media bytes | product fix |
| 3 | (same test) | importPackage staged media regardless of mode | **REAL product bug 2:** import loop ignored METADATA mode | media loop skips METADATA; refs intentionally stay dead | product fix |
| 4 | import of valid FULL package aborted | "1 restored clip reference(s) do not resolve" fired for METADATA imports | **REAL product bug 3:** final verify demanded resolution for refs that METADATA mode intentionally keeps dead | verify now enforces full resolution for FULL/NO_PROXIES only; METADATA refs surface via asset status/relink | product fix |
| 5 | bulk relink: no suggestions | `kind=null` for dead rows made every candidate INVALID | honest metadata was available but unused: the clip's TRACK kind | relink route infers expected kind from track configuration (VIDEO/AUDIO) | product fix |
| 6 | traversal / future-version / malformed tests cascading 409s | backwards assertion aborted before polling; a queued IMPORT row locked the next POST | test artifact + lock semantics | assertion removed (if/else handles 202/4xx); lock check expires rows whose job is gone/terminal | test fix |

**Security:** no validation weakened — STORED-only reader, format gate, checksum verification, entry caps and traversal rejection all remain enforced (see Phase 7).
**Final integrity suite: 8/8 PASS** (`scripts/test-m29-integrity.test.ts`).

## 4. Portability workflow revalidation (Phase 3) — 4/4 PASS
Fresh seeded library, isolated env: rich project (2 video tracks, image, brightness effect with parameter keyframes, marker, clip group) → FULL package → independent python-zipfile verification (per-asset SHA-256 + sizes, dedup of byte-identical fixtures, format gate, history present) → cross-user import (new project id, ownership correct, deterministic remap, **byte-identical media restoration**) → **restored project renders** (h264, duration gate). Evidence: `portability-chain.log`.
- Two test-side defects fixed while revalidating: settle-loop ordering (posted the archive BEFORE waiting for proxy readiness) and an M3 upload-dedup drift bug (**real product fix:** a deduplicated copy whose source probe was still in flight now enqueues its own probe instead of inheriting a stale PENDING forever).

## 5. Full M1–M28 regression (Phase 4)
- `scripts/run-all-tests.sh` (every suite in its own process, scratch DBs) — **36 suites: 34 PASS, 2 FAIL**.
- Failures: `test-temporal-core` (6 pass / 9 fail), `test-temporal-live` (0/2) — **all 11 failures environmental: this sandbox's OpenCV 4.13 build lacks `TrackerCSRT_create` (requires opencv-contrib-python)**; `import cv2` works, tracking candidate count = 0. Unrelated to M29 code paths; classified INFRASTRUCTURE REQUIRED, honestly NOT RUN-equivalent.
- **T1 durability render (isolated env):** render COMPLETED, wall **9 s**; worker state healthy; output 2,083,746 bytes, **ffprobe-validated** (h264 video 10.000 s + aac audio 10.000 s); luma ramp PASS; crossfade continuity PASS. Evidence: `t1-render-evidence.log`.
- **A/V synchronization:** video/audio start delta **+0.000 s** with equal 10.000 s durations — consistent with the M27/M28 baseline (≈ −0.052 s, tolerance ±0.15 s). PASS. Evidence: `av-sync.txt`.

## 6. Browser walkthrough (Phase 5) — REAL UI evidence
Driven with agent-browser against the isolated server; screenshots in `screenshots/`:
1. W1 login → editor (`01`) → portability drawer (`02`).
2. **Package journey:** Package → **live progress "COMPLETED — 100%" → Download .zip → real 1,017,641-byte file landed in the browser download dir** (`03`).
   - **Real UI defect found & fixed:** drawer progress was gated on a transient button flag and froze at "QUEUED 0%" — polling now keys off the archive state (`04` shows W2 registration mid-journey).
3. **Import journey:** W2 registered via UI (`04`) → drawer Import → package file uploaded through the real file input → **"COMPLETED — 100% · Imported as \"Walkthrough Project\""** (`05`) → new project identity visible in W2's selector; W1's original untouched (DB-verified).
4. **Bulk relink journey:** media deleted to create a genuine missing reference → drawer shows "BULK RELINK (1 MISSING)" with "walk-repl.mp4 [COMPATIBLE]" (`06`) → Apply → **"Relinked 1 asset reference(s) — one undoable history entry."** (`07`) → DB-verified: version history v5→v6 re-pointed ONLY `sourceAssetId`; in/out 0/90, position 0, duration 90 unchanged.
5. **Package failure journey:** payload-tampered zip imported via the UI → **"FAILED … Package is incomplete — 1 asset(s) failed validation: media/…mp4 (checksum mismatch (corrupted or modified)) Nothing was imported."** (`08`); W2 project count unchanged — no partial restoration.
- Minor cosmetic note: the drawer status line shows the stage text ("Queued") alongside the terminal FAILED state.

## 7. 375px responsive review (Phase 6)
Viewport 375×812: `document.scrollWidth === clientWidth === 375` — **no horizontal overflow** in the drawer or the editor base view (`09`, `10`, `11`); all four drawer sections stack cleanly; no clipped modal content; black/yellow identity intact; no changes to timeline/Inspector/navigation.

## 8. Security & data-safety validation (Phase 7) — supplements.log, 5/5 PASS
- Cross-user archive download/status → **404/401** (ownership enforced); anonymous → 401.
- **DEFLATE zip rejected** (STORED-only contract upheld).
- **900-entry zip rejected** (entry cap enforced).
- **Duplicate import of the same package → two DISTINCT new projects** (no overwrite; collision-safe names).
- Integrity suite additionally covers: traversal names, unsupported format version, malformed manifest, checksum mismatch, missing assets, non-zip signatures.

## 9. Final quality checks (Phase 8)
| Check | Result |
|---|---|
| TypeScript `tsc --noEmit` | **0 errors** |
| ESLint (all M29/M29-C touched files) | **clean** (0 errors) |
| Prisma validate | **valid** |
| Production build | **SUCCESS** (×6 across the closeout) |

## 10. Honest classification
- **VERIFIED:** integrity 8/8; portability 4/4; security supplements 5/5; T1 render + A/V sync; regression 34 suites; browser journeys (real screenshots + DB cross-checks); 375px overflow checks; dev-DB isolation.
- **AUTOMATED (no live run):** none required beyond the above.
- **NOT RUN:** none — every planned closeout check executed.
- **INFRASTRUCTURE REQUIRED:** OpenCV contrib build for M13 temporal suites (11 pre-existing environmental failures — absent in this sandbox, unrelated to M29 code).
- **NOT IMPLEMENTED:** folder-based relink matching (browser constraint, unchanged from M29).

## 11. Known remaining limitations
1. M13 temporal suites need an opencv-contrib-python sandbox to pass (11 failures classified INFRASTRUCTURE REQUIRED).
2. Package size cap 512 MB (memory-bounded honesty; unchanged).
3. METADATA imports intentionally arrive with missing references; the relink workflow is the restore path (now honest end-to-end).
4. Drawer cosmetic: terminal FAILED state still renders the last stage text alongside the status.
