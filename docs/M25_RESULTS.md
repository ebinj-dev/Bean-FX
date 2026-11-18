# M25 RESULTS — Feature Completion & Product Polish

**Status: all feasible M25 work implemented, tested and pushed. Existing UI preserved — additions only. Payments NOT activated. No merge, no deploy, no M26.**

## 1. Audit findings (honesty first)

- Remote feature tip = M24 commit `f4802a4` verified; main baseline `c30c7125` recorded (unchanged through M25, verified after push).
- **CORRECTION of the M24 record**: M24 claimed it "implemented" `GET/DELETE /api/media/upload/[uploadId]`. That was an audit error — the route has existed since M3 (commit `4084fa9`, 123 lines, leak-safe 404s + per-part mismatch detection, superior to the local rewrite). The unpushed 88-line rewrite was discarded and the M3 original restored; `docs/M24_*` corrected. No product change was lost — the endpoint was always live.
- Sandbox recycle incident: the workspace `.git` rolled back to a pre-M21 snapshot and 522 exec bits were cleared; both were repaired locally (content re-verified byte-identical to the remote M24 tip). A schema push with `--force-reset` wiped the dev `custom.db` — **synthetic test data only** (no real users on this deployment); incident disclosed in `m25-evidence/00-m25-audit.md`.
- M24's 8 UI access points confirmed present in the remote commit; all re-verified live.

## 2. What was implemented

### P2 — Billing & subscription foundation (payments disabled by design)
- **Schema**: `SubscriptionPlan`, `Subscription`, `BillingEvent` (+ User relations) — prisma valid, pushed.
- **Entitlements engine** (`src/lib/billing/entitlements.ts`): honest catalog (Free = unlimited, matches current behavior; Creator/Studio profiles with limits), lazy plan seeding, lazy monthly period roll (renewal without charge — none is due), usage computed from the REAL tables (projects, ExportFile minutes, AIUsage calls, media bytes, active renders) — no second bookkeeping.
- **Enforcement (server-side)**: project create (`maxProjects`), timeline render (`maxConcurrentRenders` + `monthlyExportMinutes` from actual sequence duration), JAZMII/LAXII generation + MY AI chat (`monthlyAiCalls`) — all return honest `402 {code:"PLAN_LIMIT", limit, used, max}`. FREE users are untouched (nulls = unlimited).
- **API**: plans catalog (no prices), subscription+usage, self-serve switch (paid tiers → `403 PAYMENTS_DISABLED` + `PAYMENTS_DISABLED_BLOCK` audit event), cancel/resume state machine, billing history. **Admin**: manual plan assignment (the ONLY path to paid tiers until the owner authorizes payments) + subscription summary, fully audited.
- **UI (existing design language)**: Settings → "Plan & usage" (plan chip, status/renewal, usage grid, catalog with honest "Payments not enabled" for paid tiers, cancel/resume, billing history); admin assign block inside the existing admin card.

### P3 — Professional export experience (no invented capabilities)
- Export **range presets**: FULL / PREVIEW (first 10 s) / CUSTOM (start–end seconds → frames) — backed by the render route's real `startFrame/endFrame` contract.
- **Cancel** for queued/running renders (real `DELETE /api/jobs/[id]`), **Retry** re-running a failed job's OWN recorded range (GET now exposes it). FFprobe validation was already part of the durable pipeline (M20) and still passes.
- Resolution/codec selectors were NOT added — the pipeline renders at the sequence's settings; faking options would violate the honesty rule.

### P4 — Project & media management
- **Project deletion with safeguards**: `DELETE /api/projects/[id]?confirm=<exact name>` (412 on mismatch), ownership enforced, versions counted and cascade-deleted, **media library never touched**; UI danger zone in the project drawer (typed-name confirm, verified live).
- **Missing media**: honest MISSING MEDIA block in the clip inspector with a real relink (validated `ReplaceClip` command, reversible) to a library asset.

### P5 — AI workflow polish
- Generation jobs (JAZMII + LAXII): **CANCEL JOB** while active (real job cancel; poll loop reports CANCELLED honestly) and **RETRY** with the exact same params after failure. Provider failures remain explicit; no fabricated results.

### P6 — Reliability & accessibility
- Verified rather than reinvented: empty/loading/error states present across panels (screenshots), session-expiry → auth view switch works, autosave/version-reload handling unchanged, 375 px overflow checks pass, all new controls have aria-labels and title tooltips.

### P7 — Admin & operations
- New `GET /api/admin/audit` (requireAdmin + read-audited) and an audit-event feed (15 newest) in the admin settings card, alongside the M24 admin status and M25 plan assignment.

## 3. Testing
- tsc **0** · eslint **0 errors** · prisma valid · build **SUCCESS 23.6 s**
- **M25 suites: 20/20** (billing 13, P3/P4 7) — catalog, PAYMENTS_DISABLED, admin-only deny, manual assignment + audit, maxProjects 402 (26th project), monthlyAiCalls 402 (2000 rows), cancel/resume + events, period roll renewal, cancelled-period downgrade, deletion 412/200/404, render-range contract, audit deny.
- **Full M1–M24 regression: all green** (M21–M23: 13 suites; M1–M20: 18 suites; T1 durable render 45 s; A/V sync −0.052 s; worker probe pass).
- Browser walkthrough: register → project create → drawer DANGER ZONE (wrong name disabled → exact name enabled → deleted → selector cleared) → user menu → SETTINGS → Plan & usage live-rendered (Free auto-provisioned, billing history shows "subscription activated") → EXPORT drawer presets verified → 375 px no-overflow on studio + settings.

## 4. Classification (summary — full matrix in M25_FEATURE_COMPLETION_MATRIX.md)
- **VERIFIED** (browser/tests): billing foundation end-to-end, export range/cancel/retry, project deletion safeguards, missing-media relink, generation cancel/retry, admin audit/plan assignment, all M24 access points.
- **AUTOMATED**: all suites listed above.
- **CONFIGURATION REQUIRED / OWNER ACTION**: Premiere real-host validation, Windows bridge hardware, JAZMII sustained quota, payment provider activation (explicitly disabled until the owner authorizes).
- **NOT IMPLEMENTED (honest)**: real payment processing (by design), prices (none invented).

## 5. GitHub
- Commit URL/SHAs: see the final report (filled after push verification). Fast-forward only; main untouched.
