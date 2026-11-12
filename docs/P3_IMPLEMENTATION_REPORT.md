# P3 — Implementation Report: Persistent RIISHE Editing Decisions

**Date:** 2026-11-09 · **Workspace:** `/home/z/my-project` (branch `main`, HEAD at start `ce01c3d`) · **Status: COMPLETE** — all 8 completion criteria met; evidence in `P3_TEST_REPORT.md` and `P3_DATABASE_MIGRATION_REPORT.md`.

---

## 1. What was built

Users' APPROVE / REJECT / KEEP decisions on RIISHE Auto Cut candidates are now persisted in SQLite, restored only for the **exact analysis result** they belong to, and are the only thing that can put an interval into the approved export union. Nothing about RIISHE detection, ASR, inference, safety classification, candidate generation, interval-union math or FFmpeg rendering was changed.

### 1.1 Exact changed-file inventory

**Modified (5 tracked files + 1 database):**

| File | Change |
|---|---|
| `prisma/schema.prisma` | +39 lines: two new models `CutDecision`, `CutDecisionEvent`; back-relations `User.cutDecisions`, `Job.cutDecisions`. No existing model/column touched. |
| `src/lib/types.ts` | +11 lines: `CutDecisionValue` ("APPROVE" \| "REJECT" \| "KEEP"), `SavedDecisionView`. |
| `src/lib/client-api.ts` | +23 lines: `api.analyses(mediaId)`, `api.decisions(jobId)`, `api.saveDecision(jobId, candidateId, decision)` + type import. |
| `src/components/bean/tools/auto-cut.tsx` | +~180 net lines: decision scope state, restore-on-open effect, persisted `changeCutReview` (server-confirmed UI), KEEP control + reveal toggle, SAVED/SAVING indicators, decision-error banner. All other tool behavior untouched. |
| `tsconfig.json` | exclude list += `BEAN-FX-Source-Export`, `download` (the P2 export copy inside the workspace would otherwise fail `next build`'s typecheck on its template/example files — housekeeping, no app effect). |
| `db/custom.db` | two additive tables + indexes (migration report §3); row counts unchanged. |

**New files (4 source + test/tooling):**

| File | Purpose |
|---|---|
| `src/app/api/autocut/decisions/route.ts` | `GET ?jobId=` (restore), `POST {jobId, candidateId, decision}` (upsert + history) |
| `src/app/api/autocut/analyses/route.ts` | `GET ?mediaId=` — owned completed analyses, newest first (the reopen path) |
| `scripts/p3_backup.py` | Phase B verified backup (run 2026-11-09 06:16:32 UTC) |
| `scripts/p3_migration.sql` | reviewed + applied additive DDL |
| `scripts/p3_union.test.ts` | bun unit tests (mapping + existing union logic) |
| `scripts/p3_e2e_test.sh` | isolated E2E suite (31 checks) |

**New documentation:** this file, `P3_DATABASE_MIGRATION_REPORT.md`, `P3_TEST_REPORT.md`, plus the earlier `P3_PRE_IMPLEMENTATION_AUDIT.md`.

## 2. Design decisions (as audited, Phase A → C)

1. **Identity = `(userId, jobId, candidateId)`.** `jobId` is the `autocut-analysis` Job id; `candidateId` is the stable id inside the immutable result file `media-store/analysis-results/<jobId>.json` (verified unique per file across all 26 existing results; prefixes `sil-`, `word-`, `rep-`). No timestamp matching; no interval matching — not even as fallback.
2. **No redundant models.** The result JSON stays the single source of truth for candidate data; only decisions are stored. The task's conceptual `AnalysisResult`/`CutCandidate` structures map to the existing immutable `Job` row + result file; only `CutDecision` (current state, `@@unique([userId, jobId, candidateId])`) and append-only `CutDecisionEvent` (history — decisions are never silently overwritten) exist.
3. **Server-side validation on every write:** zod input validation → session auth → job ownership + `type === "autocut-analysis"` → `status === "COMPLETED"` (409 otherwise) → result file present and parseable (410 otherwise) → candidate membership in that exact result (400 otherwise). Cross-user access returns 404 (same convention as the existing result route). Upsert + history event run in one `$transaction`; a failed write returns 5xx/4xx and writes nothing (proven by test T12/T12b).
4. **Decision→UI mapping (`decisionToReview`)** — the key to Phase F with zero export changes:
   `APPROVE → "REMOVE"` (exactly the state the existing export union consumes), `REJECT → "REVIEW"`, `KEEP → "KEEP"`. A restored decision lands in the *identical* UI state the live click produces, so plan, preview playback and export are the same before and after a refresh/restart.
5. **UI truth comes from the server.** The candidate state changes only after `POST /api/autocut/decisions` returns success; failures leave the candidate unchanged and show `Decision not saved: <reason> …` — a failed write can never look saved (required by Phase E.5/E.7; server side proven by T12).
6. **Fresh analyses are independent.** `handleAnalysisCompleted` resets the decision scope to the new jobId (empty decision set); restore requests are invalidated by a latest-wins token when a new analysis starts or completes (E.10, proven by T6/T6b + code path).

## 3. Frontend behavior (Phase E, only the Auto Cut flow touched)

- **Restore on open:** selecting a media now lists the user's completed analyses (`GET /api/autocut/analyses`), fetches the newest immutable result (existing endpoint) **and** its decisions (`GET /api/autocut/decisions`), renders the result through the existing `handleAnalysisCompleted`, then replays the decisions. A green note reports: `Restored analysis from <date> with N saved decision(s).`
- **Persisted actions:** the existing REMOVE / REVIEW buttons now persist APPROVE / REJECT (clicking REMOVE on a REVIEW candidate = approve; clicking REVIEW on a REMOVE candidate = reject); a new **KEEP** button persists KEEP (KEEP was previously unreachable in the UI). A "Show N kept candidates" toggle reveals kept ones. Manual (drag-created) ranges stay local, as before.
- **States per candidate:** spinner while saving (buttons disabled — no double submit), `SAVED · APPROVE/REJECT/KEEP` badge only after server confirmation (or immediately after a server-backed restore), error banner on failure.
- **Untouched on purpose:** RIISHE stage panel, waveform/dual-timeline, ORIGINAL/EDITED preview playback, apply dialog text and flow, words-to-remove, all other tools.

## 4. Export integration (Phase F) — verification, not modification

`startApply` still sends `normalizeRanges(cuts.filter(review === "REMOVE"))` to `POST /api/process/autocut`; the server still re-validates and renders with unchanged FFmpeg args. Only intervals whose *effective* state is REMOVE enter the union, and that state now arises from: (a) the server's original REMOVE classification (unchanged), (b) a user approval (live click or restored APPROVE), never from REJECT/KEEP, and never automatically for REVIEW candidates. Proven end-to-end by tests T13–T13e (export duration = original − union(approved)) and T14 + unit tests for overlap handling. The post-apply REMOVE→APPROVED flip (and its revert on job failure) is preserved exactly as before.

## 5. Phase H final validation (all executed 2026-11-09)

| Check | Result |
|---|---|
| Live DB integrity | `PRAGMA integrity_check` → **ok** |
| Existing rows intact | User 6, Session 15, WordsToRemove 13, Project 0, MediaAsset 28, ExportFile 16, Job 47 — identical to the Phase A snapshot; `CutDecision`/`CutDecisionEvent` start empty (0) |
| Media integrity | **All 228 files** listed in the P0 `SHA256MANIFEST.txt` re-hashed: 228 OK, 0 changed, 0 missing |
| RIISHE behavior unchanged | zero edits to `autocut-analysis.ts`, `riishe-inference.ts`, `riishe-safety.ts`, `asr-providers.ts`, analyze-route pipeline, ffmpeg invocations (git diff confirms) |
| Decisions survive refresh/restart | decisions are DB rows keyed by (user, jobId, candidateId); restore path re-reads them on every open — exercised by isolated E2E and by the live server serving the new code |
| Type safety | `bunx tsc --noEmit` → **0 errors** |
| Tests | unit 6/6 pass, E2E **31/31 pass** on an isolated DB/port/fixture |
| Secrets/media in Git | none added by this work (`git status` shows only source/doc/script changes; `db/custom.db` modified only by the additive DDL). Note: the P0 backup copies and the P2 zip were committed to history by the platform's earlier auto-commits — reported, not remediable without forbidden history rewrites |
| Git | **no commit, push, tag or history change made** |
| Live server | started fresh (none was running before P3 — a start, not a restart): health 200; new endpoints return proper 401 unauthenticated |

## 6. Known limitations (honest list)

1. **Candidate deletions and bounds edits are not persisted** — the task scopes persistence to APPROVE/REJECT/KEEP decisions. A deleted candidate or a bounds-adjusted interval reappears with its original values after a restore; its decision (if any) is restored.
2. **KEEP-ed candidates are hidden by default** (consistent with the pre-existing `review !== "KEEP"` list filter); the new toggle reveals them.
3. **The plan-confirm dialog remains the final approval gate** — unchanged by design; auto-REMOVE suggestions still apply as before once the user confirms the plan (that is the existing, preserved behavior; P3 adds persistence and explicit per-candidate decisions on top, it does not retroactively require approving every auto-REMOVE).
4. The restore path picks the **newest** completed analysis for the media; older analyses remain restorable at the API level (`decisions?jobId=`) but the UI exposes the latest one only.
5. `CutDecisionEvent` history is exposed in the database only (no UI/API for viewing history) — it exists so decisions are never silently overwritten.
6. Restart-resilience of *render* jobs (ffmpeg) is pre-existing behavior (orphan sweep) and was not changed.
