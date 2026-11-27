# M47.4 — SECURITY EVIDENCE: test-to-property mapping

Suite: `scripts/test-m474-security.test.ts` — **16/16 pass** (machine-readable:
`download/m474-evidence/m474-security-results.json`). Every assertion is either the EXACT HTTP
contract (status + exact body) or a DIRECT DATABASE STATE check via Prisma. The M47.3 suite
(`test-m473-security.test.ts`) remains on the branch as the historical baseline; M47.4 supersedes it.

Evidence gaps closed from M47.3 (10/10 → 16/16, with materially stronger proofs):

| # | Security property | Test | Proof standard |
| - | ----------------- | ---- | -------------- |
| A1 | Same-project attach works | A1 > same-project attach succeeds | 200 + `productionAsset.mediaAssetId == mediaB`, status READY; media row's `projectId`/`userId` unchanged in DB |
| A1 | Cross-project attach rejected | A1 > cross-project attach rejected 409 | Exact 409 + "different project" message; asset row UNCHANGED in DB (mediaAssetId still null); mediaA.projectId still project A; media owner untouched |
| A1 | Cross-user asset attach rejected | A1 > another user's asset cannot be attached | 404 against a REAL attacker-owned upload; victim row unchanged; no ownership hints in the error body |
| A2 | Owner can download a REAL export | A2 > victim downloads their own real export | Export produced by the canonical renderer in the test itself (not fabricated); 200 + byte count == `exportFile.sizeBytes` from DB + attachment disposition |
| A2 | Non-owner denied with zero metadata | A2 > second authenticated account | Exact status 404 AND exact body `{"error":"Export not found."}` — asserted byte-identical; asserted to contain no filename/storage/owner substrings |
| A2 | Anonymous denied | A2 > anonymous access denied | Exact 401 + exact body `{"error":"Authentication required."}` |
| A2 | Export survives unauthorized attempts | A2 > export remains intact | DB sizeBytes unchanged + re-download byte-identical |
| A3 | Invalid selection: no mutation | A3 > invalid option id | Exact 400 + exact message; selection state unchanged; `productionDecision` count unchanged in DB |
| A3 | Valid selection recorded exactly once | A3 > valid selection | 200 + state set + exactly 1 `concept` decision row in DB |
| A3 | Duplicate selection precisely documented | A3 > (same test) | Probe-verified contract: repeat = 200 + one append-only audit row per request; SELECTION STATE stays singular; total history == number of requests (2) |
| A3 | Changed selection follows the intended rule | A3 > (same test) | 200 + state follows new option + history row 3 carries the new selectedId (latest = current) |
| A3 | Selection never bypasses approval | A3 > approval-gate block | SCRIPT start pre-approval → exact 409 `DEPENDENCY_NOT_MET`; duplicate CONCEPT approve after success → exact 409; SCRIPT opens only after explicit approve |
| A4 | Duplicate resume does not duplicate resources | A4 > repeated resume | 200 ×3 with IDENTICAL checkpoint arrays; production count unchanged in DB; active task count IDENTICAL before/after; RUNNING tasks ≤ 1 |
| A4 | Failed-stage retry restores a valid state | A4 > failed-stage retry | reject → FAILED (DB `productionStage.state`), retry → READY; INTAKE/BRIEF/CONCEPT/SCRIPT all still SUCCEEDED (approvals not bypassed); export count unchanged |
| A5 | Cross-user production access denied | A5 > production GET/PUT/stage/resume | 404 ×4 (no existence leak) |
| A5 | Cross-user asset routes denied | A5 > asset attach/decide | 404 ×2 |
| A5 | Cross-user exports invisible | A5 > export listing and file | Attacker's export list does not contain the victim's export id; direct file request 404 |
| A5 | Cross-user timeline/media denied | A5 > project timeline and media file | GET 404; POST with a VALID-shaped edit → 404 (ownership decides, not body shape); victim's timeline version intact; media file 404 |
| A5 | Conversation restoration is ownership-bound | A5 > conversation-to-production restoration | Attacker POST /api/productions with the victim's conversationId → exact 403 + exact message; victim can still use their own conversation (control case); conversation row untouched |

## Documented exclusions and environment limits

- The M46.1 missing-asset render invariant is covered by `scripts/test-m472-render-inputs.test.ts`
  (part of the CI `unit-regression` job) rather than duplicated here.
- DDoS-style flood tests and rate-limit boundary probing are intentionally excluded from the
  functional security suite (non-deterministic in CI); the rate limiter's own behavior is covered
  by the registration suite (429 path, M47.2).
- The security suite requires a running server (real HTTP) — it cannot execute in a bare
  `bun test` environment without one; CI boots the server in the `e2e-security-and-build` job.
- Admin/branch-protection actions are out of test scope (owner-side settings; see `docs/M474_CI.md`).

## Test-quality rules enforced (A6)

- No response-code ranges: every status assertion is exact (`toBe`/`toContain` with the documented value).
- No fabricated identifiers: exports/uploads/productions are created through the real flows in `beforeAll`.
- No infinite polling: the render wait has a hard 150 s deadline that THROWS (fails) on timeout.
- No swallowed assertions: `beforeAll` setup failures fail the suite loudly.
- DB state, not just HTTP: the decisive assertions read Prisma rows (`productionAsset`,
  `mediaAsset`, `productionDecision`, `productionStage`, `exportFile`, `productionTask`).

**Product defects found: none.** Two M47.3 test-design gaps were corrected (empty-edits payload
masked by shape validation ordering — the rewritten test proves ownership with a VALID payload;
duplicate-resume asserted a wrong task-count invariant — now asserts the real property: no growth).
One response-consumption bug in the M47.4 test helper itself was found and fixed (double body read).
