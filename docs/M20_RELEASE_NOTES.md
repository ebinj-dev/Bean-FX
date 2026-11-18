# BEAN FX 0.3.0-m20-rc1 — Release Notes (Release Candidate)

**Candidate date**: 2026-11-16 · **Base**: M19 (feature/ai-creative-studio @ 2a7c18d) · **Status**: RELEASE CANDIDATE — staging/production rollout gated by the owner checklist (`M20_LEGAL_OWNER_CHECKLIST.md`) and the runbook (`M20_RELEASE_RUNBOOK.md`).

## Headline changes since M19

1. **Durable long-form rendering (M20 §3)** — bounded-memory windowed pipeline: 60 s frame-aligned windows, transition-aware boundaries, audio-continuity guards, stream-copy concatenation, durable progress, heartbeats, cancellation, stale-claim recovery, OOM-aware retry classification, temp cleanup, idempotent completion. Validated 60 s / 300 s / interrupted / restart / cancel / repeated-submission suites (evidence: `download/m20-render-logs/`, `M20_RESULTS.md`).
2. **Production backup & DR (M20 §6)** — real PostgreSQL drill: pg_dump custom+compress → 106.5 KB @ scale, isolated restore 0.07 s with 0 errors, integrity match (probe 7,662), retention sweep; SQLite live drill retained. Scripts: `scripts/backup-db.sh`, `scripts/backup-drill.py`, `scripts/m20-backup-drill.py`.
3. **Email surface (M20 §5)** — named templates for verification, password reset, password-changed notice, deletion confirmation; single-use expiring tokens; honest `delivered:false` without SMTP (never fabricated); no token/secret leakage into logs or client bundles (4/4 tests pass).
4. **Security final audit (M20 §7)** — dependency audit, production-bundle secret scan, two-account cross-user isolation, worker endpoint protection, rate limiting, CSRF/CORS/CSP verification (evidence in `M20_RESULTS.md`).
5. **Legal & launch readiness (M20 §8/§9)** — owner checklist with India DPDP research (MeitY primary source), REQUIRES LEGAL REVIEW banners on Terms/Privacy/Cookie pages, payments audit confirming zero payment infrastructure and no purchase UI.
6. **Release engineering (M20 §11/§13)** — `VERSION` 0.3.0-m20-rc1, deployment + rollback runbook, first-launch checklist mapping, `.env.example` with server-only/public separation.

## Known limitations (honest)

- Public registration and production deployment remain **disabled pending owner authorization** (§14/§15 constraints).
- SMTP delivery is **CONFIGURATION REQUIRED** until the owner supplies verified provider credentials; all flows otherwise honestly report `delivered:false`.
- 4 GB RAM hosts **cannot** run 600 s exports (documented OOM evidence); minimum production spec is 8 GB with the windowed renderer.
- All legal documents are drafts marked **REQUIRES LEGAL REVIEW**; owner fields are `[OWNER TO CONFIRM]`, never invented.

## Verification gate

M20 is complete only when every item in `M20_RESULTS.md` §acceptance carries its honest status. Do not deploy without explicit authorization (§15).
