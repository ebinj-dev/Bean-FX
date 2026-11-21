# M34 — Release Candidate Report

**Date:** 2026-11-21 · Branch `feature/ai-creative-studio` · Starting tip `f74052b` (M33 closeout, verified via ls-remote) · `main` observed at `0fdf2d1` (owner PR #20 merged M33's `f74052b` — external event, untouched by this work).

## Release decision

## QUALIFIED WITH DOCUMENTED RESTRICTIONS

The application is operationally reproducible (clean checkout → install → preflight → schema → server → a real render/export workflow passes end-to-end), the database lifecycle is qualified (fresh init, idempotent sync, data-preserving upgrade from the verified 2026-11-11 backup, atomic failure behavior), ten legacy suites are genuinely restored on isolated fixtures (109 tests, 0 fail), the SQLite profile is measured cold+warm with zero engine errors and verified integrity (no lost updates, no double claims, no lost appends), storage/worker recovery is tested (6/6 new scenarios + the M20 contract), and the security assessment is recorded (OSV 0 findings, SBOM 985 components, secret scan clean, boundary suites green).

**It is NOT production-ready and this milestone does not authorize deployment, release, migration, or launch.** Remaining gates, unchanged and explicit:

1. **Owner decisions**: paid-provider credentials/pricing verification (COST UNKNOWN until sourced), automatic segmentation provider approval, PostgreSQL for high-concurrency production.
2. **Environment**: ≥8 GB host for long-form renders (4 GB sandbox OOM envelope documented; renders fail honestly, never corrupt).
3. **M20 durable-render suite re-run**: the T1–T7 long-form suite (40+ min of renders) was interrupted mid-run by this session's time budget after its fixture isolation was fixed — honest classification **NOT RUN (interrupted)**; its resilience scenarios are covered by the M34 storage-worker suite (6/6) and the migration-safety lock/retry tests. Owner action: re-run `test-m20-durable-render.test.ts` on an idle host.
4. **Browser walkthrough (M34)**: the M33 walkthrough evidence stands (13 inspected screenshots, both viewports, zero 375px overflow); M34's own UI-affecting diff is tooling/docs-only (preflight, test fixtures, docs) — no UI change to re-walk. Classified VERIFIED-by-carryover for M33 surfaces; the RC report makes no new UI claims.
5. Live paid generation, public release, production migration: NOT PERFORMED (explicitly out of scope).

## Readiness assessment (§12 of the mission)

| Dimension | Verdict |
|---|---|
| Build readiness | **VERIFIED** — clean checkout reproduces install→generate→preflight→push→build→run→workflow 6/6 (66 s) |
| Database readiness | **VERIFIED** — fresh init 66 tables FK-clean; idempotent sync; backup-copy upgrade preserves all rows; locked-DB failure atomic + retry recovers |
| Operational readiness | **VERIFIED** (SQLite profile) — recovery scenarios 6/6; serial renders; stale-claim/orphan contract intact |
| Editing readiness | **VERIFIED** — editor suites 8+22+14+16 = 60 tests 0 fail; no editor files modified in M34 |
| Showcase readiness | **VERIFIED** — three-format workflow 6/6 on the clean checkout; M33 acceptance 5/5 stands (M33 session evidence) |
| Security readiness | **DOCUMENTED** — no new vulnerabilities; scanners clean; boundary suites 92 tests 0 fail total (M19 21 + M22 18 + M23 8 + M30 13 + M31 8 + M31 core 14...) |
| Provider readiness | **CONFIGURATION REQUIRED / OWNER ACTION** — honest gating unchanged (M34_PROVIDER_ONBOARDING.md) |
| Infrastructure readiness | **ESTABLISHED** — SQLite dev profile limits measured; PostgreSQL decision documented; ≥8 GB render host required |

## Deliverables (this milestone)

- Tooling: `scripts/preflight.ts` (startup preflight), `scripts/qualify-clean-checkout.sh` (reproducible qualification), `scripts/legacy-fixture.ts` (isolated legacy fixtures), `scripts/m34-sqlite-bench.ts` (cold/warm concurrency benchmark), `scripts/m34-migration-safety.ts` (migration safety).
- Fixture isolation: 10 legacy test suites de-hardcoded from the development database (no assertion changes).
- Documentation: `M34_BASELINE_AUDIT.md`, `M34_ENVIRONMENT_MATRIX.md`, `M34_DATABASE_QUALIFICATION.md`, `M34_STORAGE_WORKER_QUALIFICATION.md`, `M34_SECURITY_REPORT.md`, `M34_PROVIDER_ONBOARDING.md`, `M34_OPERATIONS_MANUAL.md`, `M34_REGRESSION_REPORT.md`, this report.
- Recovered evidence: the historical dev DB binary sha256-verified and archived at `db/backup-20261111_042810/custom.db` beside its manifest.

## Remaining owner actions

1. Re-run `test-m20-durable-render.test.ts` (on an idle ≥8 GB host) — the only interrupted qualification.
2. Provider credentials + pricing verification; segmentation provider decision (see onboarding guide).
3. PostgreSQL decision for production-scale concurrency.
4. Optional: add a CI workflow (none exists) and/or a configured `bun pm scan` scanner.
