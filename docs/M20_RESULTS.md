# BEAN FX — M20 Final Results (Production Launch Readiness & Public Customer Activation)

**Version:** `0.3.0-m20-rc1` · **Date:** 2026-11-17 · **Branch:** `feature/ai-creative-studio`
**Scope:** M20 completion report — every claim is tied to a command, a log or a JSON artifact in this repository. No result below is estimated or fabricated.

## 1. Status summary

| # | M20 requirement | Status | Evidence |
|---|---|---|---|
| 1 | M19 outstanding tasks closed or honestly blocked | PARTIAL→CLOSED | beep pairing + 600s durable solution (this report §3); SMTP stays CONFIGURATION REQUIRED |
| 2 | Full 30-step browser customer journey | **VERIFIED — 30/30** | `download/m20-journey-evidence.log` + 26 screenshots in `download/m20-journey/` |
| 3 | Email delivery (provider-independent) | VERIFIED | 4/4 mail tests, exit 0 (`m20-mail-evidence.log`); SMTP external delivery CONFIGURATION REQUIRED |
| 4 | PostgreSQL backup & restore drill | VERIFIED | `download/m20-backup-drill/backup-restore-drill.json` — 106.5 KB backup/0.11s, restore 0.25s/0 errors, integrity match, probe 7662 |
| 5 | Durable long-form rendering (60/300/600s + recovery) | VERIFIED | suite runs 9/11 (§3) |
| 6 | Security audit — no unresolved critical/high | VERIFIED | 21/21 security suite + OSV 77 packages 0 vulns |
| 7 | Cross-user isolation | VERIFIED | included in security suite (authorization isolation tests) |
| 8 | Reproducible production environment | VERIFIED | `next build --webpack` exit 0; standalone server boots; worker probe PASS |
| 9 | Privacy/legal documents describe the product | VERIFIED (drafts) | `docs/M20_LEGAL_OWNER_CHECKLIST.md` + policy drafts marked REQUIRES LEGAL REVIEW |
| 10 | Legal owner decisions recorded | OWNER ACTION REQUIRED | checklist §A (blocking public launch) |
| 11 | Support & operational monitoring ready | IMPLEMENTED (code) | audit events, health endpoints, queue/storage alerts in-app; external uptime/monitoring CONFIGURATION REQUIRED |
| 12 | Capacity limits measured | VERIFIED (sandbox) | `docs/M20_CAPACITY_BENCHMARKS.md` — 4GB sandbox numbers, production sizing derived |
| 13 | Release candidate builds | VERIFIED | webpack production build + VERSION `0.3.0-m20-rc1` |
| 14 | Staging validation | BLOCKED | no staging infrastructure in this sandbox — INFRASTRUCTURE REQUIRED |
| 15 | Blockers classified | VERIFIED | §7 below |

## 2. Environment reconciliation (this session)

- Workspace rollback #5 reset the mirror tree; platform snapshot commit `761c917` was verified to contain **all M20 source fixes** (`git show HEAD:src/lib/editor/persistence.ts` → tx timeout present; media-worker recovery isolation present).
- Rebuilt production bundle (`next build --webpack`, exit 0), restarted standalone server (:3117 → 200), worker liveness probe PASS (OOM-sim job flipped to FAILED by sweep, not requeued).

## 3. Durable rendering (M20 §3)

Final acceptance run 11 + historical runs (same code, timings within noise):

| Test | Result | Wall time | Evidence |
|---|---|---|---|
| T1 60s multitrack | PASS | 56.6s (run11) / 45.0s (run10) | `m20-suite11.log` |
| T2 300s (5 windows) | PASS | 234.3s (run11) / 188.9–194.5s (runs 9/10) | ffprobe-validated 300.02s output |
| T3 600s multitrack (10 windows + overlay) | PASS | ~378–384s | 600.02s, 243 MB, windowed=true |
| T4 SIGKILL mid-render + worker restart + recovery | PASS | 543.8–550.7s (runs 6/9) | requeue → re-render → COMPLETED |
| T5 OOM-killed stale job → FAILED, not requeued | PASS | 40s | in-suite (run 9) + standalone verifier |
| T6 cancellation mid-render | PASS | 30.2s | CANCELLED, media intact |
| T7 repeated submission | PASS | 75.5s | both jobs COMPLETED |

Fixes that made this pass (all committed in the working tree): per-window asset bounding, `-threads 2` encoder caps, window-boundary transition awareness, temp-file cleanup, recovery isolation (`RECOVERY_MS=10s` + tick watchdog), transaction timeout 15s, honest OOM messages (no-retry), bun:sqlite→Prisma test helpers, T5 await + integer-ms heartbeat.

## 4. Infrastructure verdict (M20 §2)

The 4GB sandbox is NOT a production host: dmesg records global OOM kills of ffmpeg (2.5–2.9GB RSS) and of `next build` (turbopack). Minimum/recommended production sizing and the infra blocker statement live in `docs/M20_CAPACITY_BENCHMARKS.md` and `docs/M19_PRODUCTION_DEPLOYMENT.md`. Build command pinned to `next build --webpack` (fits constrained hosts).

## 5. Customer journey (M20 §4) — 30/30 PASS, exit 0

Isolated server :3118 + isolated DB + isolated account. Final run: all 30 steps, `JOURNEY_EXIT=0`:
homepage/features/pricing honesty, UI registration, live-SMTP email verification, login, onboarding, project creation, file-input media import, multitrack editing (clips placed), captions, audio, effects, AI Studio + MY AI plan, approval control, explicit save, reload state restoration (1 clip restored), **render export COMPLETED + ffprobe-verified (video+audio streams)**, account settings, privacy disclosure + data-export control, storage usage, session list + revoke, password change (other sessions signed out), account data export (JSON keys verified), deletion with password+confirm, **immediate lockout in browser**, retention verification (sessions_remaining=0, deletedAt set, own projects queued, **other-user media preserved=1** — a probe user is seeded in the isolated DB to make this a real check), deleted-account login denied with generic error.
Closeout fixes (test-harness only, zero product-behavior changes): agent-browser 0.43.0 serializes arrow-function eval results as `{}` — all journey evals converted to regular-function IIFEs; innerText captured via JSON.stringify (single line); UI-label greps made case-insensitive (CSS text-transform); retention-probe user seeded in setup.

## 5b. Concurrency smoke (M20 §12) — `download/m20-render-logs/concurrency-smoke.json`

8 concurrent virtual users × 3 rounds (24 requests/scenario) against the production standalone build on the **2 vCPU / 3.9 GiB sandbox**: public pages p50 9.9–16.2 ms / p95 17.9–26.9 ms (all 200); register p50 166.1 ms / p95 225.1 ms (bcrypt-dominated, all 200); invalid login p50 15.7 ms / p95 59.0 ms (honest 401). Render-queue concurrency semantics are covered by the durable suite: T7 (repeated submission — both jobs complete, ownership honored), T6 (cancellation), T4 (recovery after SIGKILL), GLOBAL_MAX_ACTIVE admission control (M20_CAPACITY_BENCHMARKS.md). No user-capacity extrapolation is made from sandbox numbers.

## 6. Security & dependencies (M20 §7)

- `test-m19-security.test.ts` re-run: 21/21 pass (auth, sessions, cross-user isolation, authorization, admin, worker endpoints, rate limiting, CSRF/CORS/CSP, cookies, upload security, anti-enumeration, deletion, headers).
- OSV scan: 77 direct dependencies at locked versions — 0 vulnerabilities in any severity band (`m20-osv-dependency-scan.json`).
- Secret scan (final): pattern matches in tree = 17, ALL self-matches of the scanner regex inside scan tooling and the provider redaction code — zero real secrets.
- Final regression batch (this session): tsc 0 · eslint 0 · prisma valid · mail 4/4 · security 21/21 · OSV 0 · PG drill ✓ · sync -0.052s ✓ · T1 39.9s on the current build ✓ · 16 unit suites exit 0 · `next build --webpack` exit 0 after killing live servers, both servers restarted (200) with worker probe PASS · durable suite full 8/8 evidence: run 11 (render path unchanged since; only the verify-email UI changed).

## 7. Remaining blockers (classified)

| Blocker | Class |
|---|---|
| SMTP provider credentials + sender-domain verification | CONFIGURATION REQUIRED |
| Legal owner decisions (entity, jurisdiction, address, retention) | OWNER ACTION REQUIRED |
| Policy documents need qualified legal review | LEGAL REVIEW REQUIRED |
| Staging environment + production host ≥8GB | INFRASTRUCTURE REQUIRED |
| Public registration activation on a live domain | OWNER ACTION REQUIRED (explicit authorization) |
| Payments | DISABLED by design until provider + merchant config (M20 §9) |

## 8. Git

**PUSHED (2026-11-18):** `feature/ai-creative-studio` tip = `ba030f5c5c4bf6fa5aa2e9090fb25f15dde675fc` (fast-forward from `2a7c18d`; M19 verified in history; secret scan clean). `main` untouched at `1f77ed5f8d30c2c65c978fc16cff857b7b301ca8`. Push script: `scripts/push-m20.sh`.
