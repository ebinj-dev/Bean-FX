# P3 — Test Report

**Date:** 2026-11-09 · **Verdict: all tests executed and passed** — unit **6/6**, end-to-end **31/31**, `tsc --noEmit` **0 errors**. Every claim below was actually run; raw outputs are saved in `download/P3_TEST_OUTPUT_UNIT.log` and `download/P3_TEST_OUTPUT_E2E.log`.

---

## 1. Test environment (isolated — live data untouched)

| Aspect | Isolated test setup |
|---|---|
| Database | `.p3-test/test.db` — fresh schema via `DATABASE_URL="file:$T/test.db" bunx prisma db push --skip-generate` (fresh file, additive; **the live `db/custom.db` was never the target of any test request**) |
| Server | `bunx next dev -p 3100` with the test `DATABASE_URL` (live :3000 not yet running; no conflict) |
| Fixture media | `ffmpeg -f lavfi -i sine=440:duration=3 -ar 44100 -ac 1 .p3-test/fixture.wav` — sha256 `6b345075…adbe7b7`, verified unchanged at the end |
| Fixture analyses | two `autocut-analysis` Job rows (user-owned) + immutable result JSONs with known candidates (`sil-1` REVIEW, `sil-2` REVIEW, `word-1` REMOVE for job1; `sil-1` only for job2) placed as `p3test*.json` in `media-store/analysis-results/` (the app's fixed results directory) and removed after tests |
| Users | two fresh accounts registered through the real API (`p3test-a@example.invalid`, `p3test-b@example.invalid`), sessions via real cookies |

## 2. Commands executed

```bash
bun test scripts/p3_union.test.ts                 # unit: mapping + union logic
bash scripts/p3_e2e_test.sh                       # 31-check E2E suite (isolated)
bunx tsc --noEmit                                 # whole-project typecheck
```

## 3. Unit test output (actual, `P3_TEST_OUTPUT_UNIT.log`)

```
(pass) decisionToReview … APPROVE lands in the export plan (REMOVE) …
(pass) decisionToReview … REJECT stays out of the plan (REVIEW)
(pass) decisionToReview … KEEP stays out of the plan (KEEP)
(pass) normalizeRanges … overlapping approved intervals merge into one union interval (#13)
(pass) normalizeRanges … multiple overlapping groups normalize independently
(pass) normalizeRanges … union removes exactly the union duration — kept material untouched
 6 pass, 0 fail, 11 expect() calls
```

## 4. E2E results (actual, `P3_TEST_OUTPUT_E2E.log`) mapped to the 14 required tests

| Required test | Executed check(s) | Result |
|---|---|---|
| 1. Save APPROVE | T1 `POST` sil-2 APPROVE → 200 | PASS |
| 2. Reload APPROVE | T2/T2b `GET` returns `"candidateId":"sil-2","decision":"APPROVE"` | PASS |
| 3. Save REJECT | T3 sil-1 REJECT → 200 | PASS |
| 4. Reload REJECT | T4 present in `GET` | PASS |
| 5. Save KEEP | T5 word-1 KEEP → 200 (retrieved in `GET`) | PASS |
| 6. Scoped to exact analysis | T6/T6b job2 (same media, different result) decisions `[]` | PASS |
| 7. New analysis inherits nothing | T6 + code path (new jobId ⇒ empty set; `handleAnalysisCompleted` resets scope) | PASS |
| 8. Duplicates consistent | T8 duplicate POST 200; T8b exactly **3** `CutDecision` rows after 4 writes (unique constraint + upsert; history events append) | PASS |
| 9. Invalid candidate/analysis IDs | T9 unknown jobId 404; T7 foreign candidate 400; T9b bad decision 400; T9c path-like candidateId 400 | PASS |
| 10. Cross-user rejected | T10/T10b/T10c user B gets 404 on GET/POST/analyses of user A's data | PASS |
| 11. Failed write ≠ success | T12 missing result file → **410**, T12b still exactly 3 rows; UI side: state changes only after server 2xx (code + T12 server proof) | PASS |
| 12. Only approved intervals reach export | T13 apply union [1.0,1.5) → T13b `estimatedFinalSec=2.5`, T13c job COMPLETED, T13d download 200, **T13e ffprobe duration = 2.500000 s** | PASS |
| 13. Overlapping approved intervals | Unit: overlapping groups merge (union); T14 raw overlapping cuts rejected server-side 400 (client `normalizeRanges` is the union) | PASS |
| 14. Fixture media SHA-256 unchanged | T15 before/after hashes identical (`6b345075…`) | PASS |
| (extra) Unauthenticated access | T16 GET without session → 401 | PASS |

Plus environment checks: server health 200, both registrations 200, analyses listing T11 with **newest-first** order verified programmatically.

## 5. TypeScript check

`bunx tsc --noEmit` → **0 errors** (whole project, strict mode). One incidental fix was required to make this meaningful: the P2 export copy `BEAN-FX-Source-Export/` (and `download/`) were added to `tsconfig.json` `exclude`, because their template example/probe files otherwise get type-checked by a root-level `tsc`/`next build` and fail on unrelated missing modules (`socket.io`, `bun:test`).

## 6. Cleanup verification (after tests)

- Test artifacts removed: `.p3-test/` (db, fixture, logs), both `p3test*.json` result files, and the **two** test export files (`cut_1794205973660_…wav`, `cut_1794205996600_…wav` — identified by mtime before deletion).
- Live `media-store` counts back to baseline: originals **27**, exports **16**, tmp **0**, waveforms **9**, uploads **1**, analysis-results **26**.
- **All 228 files** covered by the P0 media manifest re-hashed: **228 OK, 0 changed, 0 missing**.
- Live DB: integrity ok; counts unchanged (User 6, Session 15, WordsToRemove 13, Project 0, MediaAsset 28, ExportFile 16, Job 47, CutDecision 0, CutDecisionEvent 0).
- Port 3100 free; isolated server stopped by the suite itself.

## 7. Live-server smoke test (post-deployment)

The live server (port 3000) was started fresh (none had been running) and responds: `GET /` → 200; `GET/POST /api/autocut/decisions` and `GET /api/autocut/analyses` unauthenticated → `401 {"error":"Authentication required."}`. Real-user decision persistence is exercised by the UI on every approve/reject/keep action; it was intentionally **not** smoke-tested against live user data (no destructive or polluting operations on production data).

## 8. Not covered by automated tests (documented honestly)

- Browser-rendered UI behavior (badge/spinner/toggle visibility) is verified by code reading and typechecking, not a headless browser — the E2E suite covers the API contract that the UI consumes, including the exact decision→status mapping (`decisionToReview` unit tests).
- Multi-concurrent-writer behavior of SQLite under load was not stress-tested (out of scope; single-user-per-decision upserts are constraint-protected).
- The full RIISHE pipeline was not re-run end-to-end (rule: don't change or re-exercise detection thresholds; the pipeline is untouched and its output files are hash-verified unchanged).
