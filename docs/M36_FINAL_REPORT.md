# M36 — Final Report: Single-Server Staging Package & Deployment Rehearsal

**Date:** 2026-11-22 · **Branch:** `feature/ai-creative-studio` · **Baseline:** M35 `2bb0219` (verified ancestor; no owner commits after it at milestone start) · **M36 commit:** head of this branch after publication (SHA in the completion reply; verifiable via `git ls-remote` + fresh clone) · **`main` untouched:** `8a027ee` before and after (re-checked at publication).

## 1. Verdict

> ### **A. READY FOR STAGING HOST EXECUTION**

The deployment package is complete and locally rehearsed end-to-end (16/16), the regression battery passes, and nothing in the milestone claims more than it tested. A real staging host — provisioned and authorized by the owner — is the remaining gate. **Staging is NOT claimed qualified** (verdict B explicitly not claimed: no host exists/was authorized); production-readiness is NOT claimed.

## 2. What M36 delivered

| Phase | Deliverable | Status |
|---|---|---|
| A | `M36_BASELINE_AND_DEPLOYMENT_AUDIT.md` — actual runtime (standalone Node entry, in-process runner, SQLite WAL, media root), honest omissions (no FastAPI/GPU/Docker) | VERIFIED facts |
| B | Deployment package: env template + fail-cold validator (5 test cases), fs layout, install (9 gated steps, non-destructive), upgrade (backup-first, ff-only), `beanfxctl` lifecycle (live-validated), systemd template with ExecStartPre gate, Caddy+Nginx templates | IMPLEMENTED + locally validated; real-host systemd/TLS = OWNER ACTION |
| C | `db.ts` fail-honest WAL handling (the only src change, +16/−1) + `m36-db-ops.ts` (verify/wal/integrity/stats, contention visibility, permission audit) | VERIFIED (F10/F11 + live) |
| D | `m36-backup.ts` — snapshot+media+manifest+sha256+retention+exit codes; isolated-only restore with live-overwrite refusal; OFF-HOST: CONFIGURATION REQUIRED (no fake uploads); operator runbook | VERIFIED (backup/verify/restore/refusal/retention live) |
| E | `m36-health-check.sh` v2 — four-state model (canonical UNAVAILABLE; task's UNHEALTHY mapped), provider as separate subsystem, ffmpeg/tmp/backup-freshness/backlog added; ops runbook | VERIFIED live |
| F | Failure qualification — **12/12 PASS** + honest classifications (true-ENOSPC = INFRASTRUCTURE REQUIRED; interrupted-render cases = M20 VERIFIED) | VERIFIED within stated bounds |
| G | 16-step rehearsal **PASS** (three ffprobe-validated exports; restart; backup; isolated restore with 10 media hashes; restored boot) + sequential regression battery | VERIFIED |
| H | Staging gate resolved honestly: **no host provisioned/authorized** → `M36_STAGING_HOST_EXECUTION_CHECKLIST.md` (host profile, TLS, acceptance evidence list) | OWNER ACTION REQUIRED |
| I | Security review: secret scan 0, OSV 77 pkgs 0 issues, 13 mandated areas audited; **no penetration test claimed** | VERIFIED (review-level) |

## 3. Preserved behavior (regression summary — details in `M36_REGRESSION_REPORT.md`)

86 suite tests pass: M20 **8/8**, M34 **6/6** (×2 incl. restarted instance), M29 **8/8 + 4/4**, M32 **35/35**, M31 **14/14**, M33 **11/11** (battery's 2 failures analyzed: sandbox-memory OOM under accumulated load — the honest-failure contract worked, nothing falsely completed; clean 11/11 re-verified). TypeScript 0 errors, ESLint clean, build ✓, preflight 0 BLOCKED. AI engine readiness truthful; Showcase Studio, collaboration, native format, portability all re-proven. UI untouched (src diff = db.ts only).

## 4. Restrictions (all preserved, none weakened)

1. **Staging host execution** — OWNER ACTION (checklist provided).
2. **Paid providers** — unconfigured by default; budget/approval gates untouched; no pricing invented; no paid calls.
3. **Off-host backup** — CONFIGURATION REQUIRED until the owner selects an adapter (contract documented; nothing uploaded).
4. **True ENOSPC, systemd/TLS behavior, public traffic** — INFRASTRUCTURE REQUIRED / OWNER ACTION (threshold detection tested; honest about the rest).
5. Docker remains unvalidated and NOT a deployment requirement (systemd chosen per actual architecture).
6. No PostgreSQL migration performed (SQLite retained; no destructive command exists in the package).

## 5. Publication record (§14 sequence executed)

- Diff reviewed (24 files: 13 docs, 11 scripts/configs, 1 src change); secret scan clean; no runtime artifacts committed; commit on `feature/ai-creative-studio` via normal fast-forward push; remote verified via `git ls-remote`; independent fresh clone verified (M36 commit + all 13 deliverables present); `main` SHA identical before/after.
- Test totals: 86 suite tests + 16 rehearsal steps + 12 failure cases + 5 env cases; 0 failed / 0 skipped after re-verification; evidence under `download/m36/evidence/` and per-step logs in the rehearsal tree.

## 6. Remaining owner actions (ordered)

1. Provision the staging host per `M36_STAGING_HOST_EXECUTION_CHECKLIST.md` §0 (8–16 GB, 4 vCPU, SSD) and execute §1–§11; produce the §11 acceptance evidence.
2. Select/configure the off-host backup adapter (contract: `M36_BACKUP_RESTORE_OPERATIONS.md` §3); install the nightly timer + quarterly drill.
3. Domain + TLS + DNS (owner-managed; templates provided).
4. Decide staging registration policy and provider enablement (requires verified pricing + owner approval before any paid generation).
5. Optional hardening: restrict `/api/health` at the proxy; container-image qualification only via the Track-J-style gate if ever desired.
