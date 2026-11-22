# M35 — Release Preparation Report (Deployment Architecture & Controlled Release)

**Date:** 2026-11-22 · **Branch:** `feature/ai-creative-studio` · **Baseline:** `c619f41` (M34 closeout) · **This milestone's commit:** see publication record at the end.

## 1. Final recommendation

> ### SINGLE-SERVER INITIAL DEPLOYMENT · SQLite stays · verdict: **READY FOR STAGING IMPLEMENTATION (with documented restrictions)**

- **Topology:** one dedicated-vCPU host (≥8 GB RAM, 4+ vCPU, SSD ≥2× media headroom), TLS reverse proxy, off-host backups. This is the topology M34 actually qualified; Option 2 (split worker) is the pre-designed scaling step, Option 3 is explicitly not justified today (`M35_HOSTING_TOPOLOGY.md`).
- **Database:** SQLite WAL for the initial deployment — M34's measured concurrency evidence + M35's static audit (postgresql-provider schema validates; exactly one provider-conditional PRAGMA in `src/lib/db.ts:51`). PostgreSQL becomes required at the Option-2 split; migration + rollback designed, runtime test INFRASTRUCTURE REQUIRED (`M35_DATABASE_DECISION.md`).
- **Media storage:** current local media root unchanged (no media moved, no new dependency); object storage (R2/B2 sourced) designed as the Option-2-era path (`M35_MEDIA_STORAGE_ARCHITECTURE.md`).

## 2. What this milestone established (classification per item)

| Deliverable | Status |
|---|---|
| M35_BASELINE_AUDIT — actual architecture mapped from code (no FastAPI tier exists; honest omission) | ARCHITECTURE DESIGNED · VERIFIED facts |
| M35_DEPLOYMENT_ARCHITECTURE — component map, sync vs async, persistence/restart analysis | ARCHITECTURE DESIGNED |
| M35_HOSTING_TOPOLOGY — 3 topologies compared; Option 1 recommended | ARCHITECTURE DESIGNED |
| M35_DATABASE_DECISION — SQLite vs PostgreSQL, migration/rollback plan | DESIGNED · schema VERIFIED · runtime INFRASTRUCTURE REQUIRED |
| M35_MEDIA_STORAGE_ARCHITECTURE — 11 media categories audited, 3 approaches compared | DESIGNED (no code change, per scope) |
| M35_RENDER_INFRASTRUCTURE — measured ffmpeg workload + sizing table | MEASURED (M20/M34 evidence) + labeled ESTIMATEs |
| M35_DEPLOYMENT_SECURITY — boundary diagram, audit, secret-injection strategy | DESIGNED · code-level controls VERIFIED |
| M35_BACKUP_DISASTER_RECOVERY — full plan; **DRILL_PASS executed** on isolated data | PROCEDURE DESIGNED · restore mechanics VERIFIED · RPO/RTO = TARGETS |
| M35_OBSERVABILITY_OPERATIONS — four-state health model + runbook | DESIGNED · health-check script VERIFIED live |
| M35_COST_CAPACITY_MODEL — sourced pricing (R2, B2, Hetzner floors; 2026-11-22) + COST UNKNOWN register | SOURCED where possible |
| M35_STAGING_DEPLOYMENT_PLAN — 14-item checklist + env template + validated scripts | PREPARED · staging NOT RUN (not authorized) |
| Regression: M20 8/8, M34 storage-worker 6/6, TSC/ESLint/build/preflight, backup drill | VERIFIED (`M35_REGRESSION_REPORT.md`) |
| Staging environment / deployment / production testing | NOT RUN — OWNER ACTION |

## 3. Restrictions carried forward (all preserved, none weakened)

1. **Deployment infrastructure** — host procurement, TLS setup, backup scheduling: OWNER ACTION.
2. **Paid providers** — execution requires owner approval; pricing remains COST UNKNOWN; budget/approval gates untouched; no live paid call made in M35.
3. **Automatic segmentation** — CONFIGURATION REQUIRED until a verified provider is approved (manual masks available).
4. **PostgreSQL** — required only at the worker-split step; runtime migration test needs real infrastructure.
5. **Pre-existing lint debt** — 6 `no-require-imports` errors in `src/lib/core/credential-store.ts` (M22/M23-era, outside both M34 and M35 diffs): owner action.
6. No deployment, production migration, public release, or announcement is authorized by this milestone.

## 4. Publication record

| Field | Value |
|---|---|
| Commit | head of `feature/ai-creative-studio` after this commit (SHA recorded in the milestone completion reply; verify with `git ls-remote` and a fresh clone) |
| URL | https://github.com/ebinj-dev/Bean-FX/commit/(sha) |
| Branch | `feature/ai-creative-studio` |
| Remote verification | `git ls-remote` + independent fresh-clone inspection |
| `main` | untouched by this work (observed `8a027ee` before; re-checked after) |
| Changed files | 11 `docs/M35_*.md` + `scripts/m35-backup-drill.ts` + `scripts/m35-health-check.sh` + `deploy/env.staging.example` (placeholders only) |

## 5. Remaining owner actions (ordered)

1. Provision the staging host per Track B/E minimums and run `M35_STAGING_DEPLOYMENT_PLAN.md`'s 14-item checklist.
2. Schedule nightly backups (Track G) + quarterly restore drill; choose off-host target (B2 floor VERIFIED $1.40/mo at 200 GB).
3. Domain + TLS setup; decide staging registration policy (open vs invite).
4. Provider approvals (credentials + verified pricing) before any paid generation; segmentation provider decision.
5. Optional: fix credential-store lint debt; CI workflow; container image qualification (only via the Track J gate).
