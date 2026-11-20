# M31 SECURITY AUDIT — collaboration & platform surface

**Method:** server-side code review + new independent-session tests (`scripts/test-m31-security.test.ts`, 7 tests) + the M30 suites re-run. No frontend trust.

## Authorization matrix re-validation — PASS
- Workspace roles enforced in `src/lib/collab.ts`; every protected operation re-resolves access; no-leak 404s for strangers (media/exports/reviews/render/imports).
- Revoked member: share revoke → immediate 404 on revision GET/comment POST/decision PUT (test 4).
- Worker authorization: render + archive jobs re-check the server-side matrix for shared projects (M30 fix re-validated).
- Cross-workspace isolation: membership required; strangers share nothing (no-leak).

## Token & session security — PASS
- 256-bit tokens; SHA-256 at rest for invitations, review links, guest sessions; raw tokens appear exactly once (creation response) and NEVER in listings/logs; unique-index lookups; expiry sweeps (invitations, links) enforced server-side; guest cookies bound to linkId+guest session hash; password-protected links verify SHA-256; notification payloads carry ids/titles only (asserted in test 6).

## Approval integrity — PASS
- Decisions bind to the exact revision (fingerprint persisted 64-hex; superseded/cancelled revisions reject votes 409); duplicate decisions 409; ALL/ANY policies deterministic; revoked reviewers cannot vote (access re-resolution); audit rows recorded for every transition.

## Findings & dispositions
| # | Finding | Severity | Disposition |
|---|---|---|---|
| S1 | Same-base concurrent timeline writes can surface 400 (SQLite write-lock contention) instead of 409 under tight races | Low | Safe failure: no lost writes, error actionable (retry). Data integrity verified. Documented in M31_RESULTS §11. Fix candidate for M32 (retry-to-409 mapping). |
| S2 | Guest identity is self-reported display name | By design | No guest accounts; scoped to one revision; rate-limited |
| S3 | In-process rate limiters reset on restart | Low | Documented; per-IP windows still bound abuse per process lifetime |
No authorization, injection, enumeration or replay vulnerabilities found in the audited surface.
