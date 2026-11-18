# P3 — Pre-Implementation Audit (Phase A)

**Date:** 2026-11-09 · **Mode:** read-only audit, no files changed · **Verdict: GO** — all conditions for a safe implementation are verifiable; one divergence from the P0 report is documented (§1.2) and one startup-script hazard is documented (§5).

---

## 1. Workspace and Git verification

### 1.1 Identity
- Git root: `/home/z/my-project` (workspace root = git root ✓)
- Branch: `main`
- HEAD: `ce01c3d6111dcce236eac94fb5d8bb6702d07878` — **not** `97e3058`
- Tag `p0-recovery` exists and dereferences (`^{commit}`) to `97e3058d55d8af69de3549ae51318979b5be79fd` — the P0 recovery point is intact and reachable.
- No git remote is configured. Working tree is **clean** (0 porcelain entries).

### 1.2 Divergences from the P0 report (verified, not assumed)
1. HEAD has moved **two commits beyond** the P0 pointer, both platform-authored snapshot commits made **during the P2 export task** (timestamps 2026-11-09 05:14 and 05:37 UTC):
   - `39694e5` — committed the P0 backup artifacts (`backups/db/20261109_051019/…`, `backups/media/20261109_051019/…` incl. `SHA256MANIFEST.txt`) into git history.
   - `ce01c3d` — committed `BEAN-FX-Source-Code.zip` and the full `BEAN-FX-Source-Export/` tree (the P2 deliverables).
   These explain the clean working tree: the P2 deliverables are now *tracked* files. Per the no-history-rewrite rule, nothing is reverted or rewritten; **observation for Phase H:** user media copies and a database copy sit in git history because of the platform's auto-commit — remediation would require history rewriting, which is forbidden; this is reported, not acted on.
2. The Windows commits **`9b30adb` and `d503d26` do not exist in this repository** (`git cat-file -t` → "Not a valid object name" for both). The Windows checkout and this workspace have therefore diverged; this workspace is the sole implementation target and no assumptions are carried over from the Windows repo.
3. `node_modules/` does **not exist** (platform cleanup). A clean `bun install --frozen-lockfile` is required before any build/typecheck/test work (disk headroom verified: 1.5 GB free; the same install measured ~1.05 GB in the P2 test).

### 1.3 Runtime state
- **No Next.js server is running** (nothing listens on :3000; only Caddy on :81). No restart will be needed — a fresh, justified start happens after implementation.
- `media-store/analysis-results/` holds **26 result JSON files** (440–584 KB each), matching the 26 `autocut-analysis` COMPLETED jobs.
- Existing P0 backup directories (`backups/db`, `backups/media`, `backups/restore-verify`) are present and will not be touched.

## 2. Database ground truth

- Live DB (from `.env`): `DATABASE_URL=file:/home/z/my-project/db/custom.db` (**absolute path** — resolves unambiguously; matches `db/custom.db`).
- File size 114,688 bytes; `PRAGMA integrity_check` → **ok**; `journal_mode=delete`; `user_version=0`.
- Tables and row counts (read-only snapshot):

| Table | Rows |
|---|---|
| User | 6 |
| Session | 15 |
| Project | 0 |
| WordsToRemove | 13 |
| MediaAsset | 28 |
| ExportFile | 16 |
| Job | 47 |

- `Job` breakdown by type/status: `autocut-analysis`/COMPLETED **26**; `AUTOCUT_APPLY`/COMPLETED 16; one each `AUDIO_PROCESS`, `BURN_CAPTIONS`, `WATERMARK` COMPLETED; `AUDIT_STALE` and `AUDIT_STALE2` FAILED (audit artifacts, preserved as-is).
- Prisma models (`prisma/schema.prisma`, 3,407 bytes): `User`, `Session`, `WordsToRemove`, `Project`, `MediaAsset`, `ExportFile`, `Job` — SQLite provider, `env("DATABASE_URL")`, `prisma-client-js` generator. **No migrations directory exists** (db-push workflow), so Phase B defines an explicit safe migration procedure instead of `db push`.

## 3. Candidate lifecycle (traced in source)

1. **Generation** — `POST /api/autocut/analyze` (`src/app/api/autocut/analyze/route.ts`) validates settings/words/SRT, creates `Job(type="autocut-analysis", paramsJson={mediaId})`, runs the 15-stage pipeline, and at completion writes the full payload **once**: `fs.writeFile(media-store/analysis-results/<jobId>.json)` (route.ts:449), then `jobManager.complete(...)`. **Result files are write-once / immutable** — nothing in the codebase ever updates them afterward; the result route serves the stored bytes verbatim.
2. **Display** — `auto-cut.tsx` `handleAnalysisCompleted` (line 419) maps `result.candidates[]` → `CutRange[]` with `review: c.review` (`"REMOVE" | "REVIEW" | "KEEP"`), `source` from `classificationSource`/`wordMatch`, evidence from `c.evidence` + `result.analysis`. `setCuts(proposals)`.
3. **User decisions today** — candidate cards render exactly two status buttons, `REMOVE` and `REVIEW` (`setCutReview(c.id, st)`, line 1715), plus delete. There are **no APPROVE/REJECT/KEEP buttons**; `KEEP` is only a filter state (`review !== "KEEP"` hides cuts from the list, lines 1088/1667/1691), and `PROPOSED`/`REJECTED` (declared in `CutReviewStatus`, types.ts:19) are never assigned anywhere — dead states. So today: clicking **REMOVE** on a REVIEW candidate = include it in the plan (= P3 "approve"); clicking **REVIEW** on a REMOVE candidate = demote it out of the plan (= P3 "reject"); **KEEP is unreachable from the UI** and must be added (Phase E).
4. **Approval→export** — `startApply` (line 1150) filters `cuts.filter(c => c.review === "REMOVE")`, sends `normalizeRanges(...)` (the canonical **union** of those intervals) to `POST /api/process/autocut`; the server re-validates (order, overlap, bounds) and renders with ffmpeg. On success the client flips REMOVE→APPROVED (line 1184; reverted back on job failure). The confirm dialog states the contract explicitly: "This applies every cut currently marked REMOVE. KEEP and REVIEW ranges are not applied."
5. **Derived views** — summary tile `approvedCount/approvedRemovedSec` (line 1085) and both timelines' skip logic (lines 249, 583, 723) use `review === "REMOVE"` (playback also includes post-apply `APPROVED`).

## 4. Persistence boundaries (current state — all ephemeral for decisions)

| Boundary | Mechanism | Persisted? |
|---|---|---|
| Analysis result payload | `media-store/analysis-results/<jobId>.json` (write-once) + `Job` row | ✓ (immutable) |
| Analysis progress | `Job.progress/stage/message` | ✓ |
| Approve/reject/keep per candidate | React state `cuts` (`CutRange.review`) only | ✗ — lost on refresh/navigation/restart |
| Words-to-remove preferences | `WordsToRemove` table | ✓ (out of P3 scope) |
| Media/exports/projects/sessions | `MediaAsset`/`ExportFile`/`Project`/`Session` tables + files | ✓ |
| In-process analysis result cache | module-level Map, TTL 30 min (analyze route) | ephemeral by design |
| Tool hand-off between routes | `sessionStorage` `beanfx.toolMedia.<tool>` | ephemeral by design |

**Conclusion:** there is currently **no persistence at all for candidate decisions**, and **no reopen path** — reopening the Auto Cut tool with a previously analyzed media starts blank (only the waveform is reloaded); the result JSON can only be fetched through the polling flow of a fresh run (`AnalysisJobProgress` → `GET /api/autocut/analyze/result/[jobId]`).

## 5. Startup-script hazard (verified by reading `.zscripts/dev.sh`)

`dev.sh` runs, on every start: `bun install` → **`bun run db:push`** (= `prisma db push --accept-data-loss`) → `bun run dev` + health check. After a schema addition this is a no-op **only if** the database schema already matches `schema.prisma`. The safe procedure (Phase B/C) is therefore ordered so the additive migration is applied to `db/custom.db` **before** any `dev.sh` start, making the script's push a verified no-op. The `--accept-data-loss` flag itself remains a standing footgun for future schema edits and is documented in the migration report.

## 6. Candidate identity in the immutable result JSON (verified across all 26 files)

- Top-level payload keys: `analysis, candidates, durationSec, fromCache, inference, inferenceNote, mediaId, notes, ok, originalName, peaks, plan, sampleRate, srt, stages, transcript`.
- Candidate keys: `id, start, end, duration, reason, review, confidence, classificationSource, evidence{pauseSec,rms,snr,transcriptWordsInRange,intraSentence,quietSpeechNearby,repeatedTake,floorReliable}, prevSentence, nextSentence` (+ `wordMatch` where applicable).
- **ID scheme and uniqueness:** prefixes `sil-` (3,153 occurrences), `word-` (494), `rep-` (27) across the 26 results; IDs are unique **within** each result file (verified programmatically; e.g. newest file: 56 candidates, all unique). They are deterministic per analysis run and immutable thereafter.
- `Job.paramsJson` for analysis jobs = `{"mediaId": "<id>"}` (parsed at runtime for the reopen listing; no SQL JSON query needed at this scale).

**Identity decision (Phase C):** the pair `(analysisJobId, candidateId)` is a stable, exact identity scoped to one immutable result. No timestamp matching; no interval matching needed — not even as a fallback. The result file remains the single source of truth for candidate data; the database stores only decisions (no candidate duplication, no redundant AnalysisResult/CutCandidate tables — the task explicitly warns against redundant models).

## 7. Design that follows from the audit (Phases C–F summary; details in the implementation report)

- **Schema (additive only):** two new models — `CutDecision` (`@@unique([userId, jobId, candidateId])`, FK → `User`, FK → `Job` with cascade, `decision` ∈ APPROVE/REJECT/KEEP) and `CutDecisionEvent` (append-only history so decisions are never silently overwritten). No existing column/table is altered.
- **API (existing conventions, no new auth):** `GET/POST /api/autocut/decisions` (restore / upsert with server-side validation: owned COMPLETED `autocut-analysis` job, candidate membership checked against the immutable result file, transactional upsert+history) and `GET /api/autocut/analyses?mediaId=` (owned completed analyses for a media → enables the reopen path).
- **Frontend (Auto Cut flow only):** decisions persist on the existing REMOVE/REVIEW buttons (REMOVE←user ⇒ APPROVE, REVIEW←user ⇒ REJECT), a new KEEP control (KEEP was unreachable — required by Phase E), per-candidate saving/saved/error states driven by **server confirmation**, and auto-restore of the newest completed analysis + its decisions when the tool opens with an analyzed media. Fresh analyses keep their own (empty) decision set — no inheritance.
- **Export (Phase F):** zero changes to union/ffmpeg logic. Restored APPROVE decisions map the candidate to `review: "REMOVE"` — the exact state the existing pipeline already treats as "in the plan" — so only approved intervals enter the union; REJECT/KEEP map out of it; REVIEW stays unapproved until explicitly approved; the plan-confirm dialog remains the final gate.

## 8. Safety-rule compliance plan (pre-verification)

| Rule | Plan |
|---|---|
| No deletion/reset of project, media, users, sessions, jobs, exports | additive-only schema; migration SQL reviewed before execution; row counts re-verified after |
| No RIISHE behavior change | zero edits to `autocut-analysis.ts`, `riishe-inference.ts`, `riishe-safety.ts`, `asr-providers.ts`, analyze route pipeline |
| No `db push --accept-data-loss`, no blind dev.sh | migration via `prisma migrate diff` script + `prisma db execute`; dev.sh hazard documented (§5) |
| Verified backup + rollback plan before migration | Phase B: online-backup API copy + SHA-256 + integrity + row counts + independent re-verification; rollback = restore backup file |
| No destructive tests on production data | isolated test DB + fixture media in a scratch dir; live DB never touched by tests |
| No commits/pushes/tags/history changes | none will be made |
| Server lifecycle | none running (§1.3); a fresh start after implementation is a start, not a restart |

**Blocker check:** none. All backup, database-identity, schema and recovery conditions are verifiable. Proceeding to Phase B.
