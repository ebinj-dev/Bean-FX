# M34 BASELINE AUDIT — 2026-11-21

## Repository identity and state

| Item | Value |
|---|---|
| Remote feature tip | `f74052b` — the reported M33 closeout commit, **present and current** ✓ |
| Remote `main` | `0fdf2d1` — **advanced since M33 closeout**: `Merge pull request #20 from ebinj-dev/feature/ai-creative-studio` (owner merged M33's `f74052b` into `main`). External event, not this work's. This milestone does not modify `main`. |
| Reported M33 `main` SHA | `4cc10181` — superseded by the owner's PR #20 merge (verified, not assumed) |
| Local workspace | clean tree, snapshot chain; node_modules + `.next` build + `/tmp` evidence all present from the M33 session (no recycle) |

## Architecture facts established by inspection

1. **Runtime**: Next.js (standalone output) behind `scripts/dev-server.sh` (package.json `start`/`dev`); `bun run build` = `next build --webpack`. No Dockerfile, no container strategy — none invented.
2. **Database**: SQLite via Prisma (`prisma/schema.prisma`). **No `prisma/migrations/` directory exists** — schema changes ship via `prisma db push` (schema-sync). `db:migrate`/`db:reset` npm scripts reference migrate and would fail without a migrations dir — documented as a gap; Track B qualifies the `db push` path that the repository actually uses. `src/lib/db.ts` appends `connection_limit=2` (M33 fix) and enables WAL.
3. **CI**: **no `.github/workflows/`** — release qualification is local and manual; the RC report records this as an owner action, no CI invented in M34.
4. **Preflight**: **no preflight/health script exists** — Track A2 implements `scripts/preflight.ts` (READY / WARNING / CONFIGURATION REQUIRED / BLOCKED / UNSUPPORTED).
5. **Environment variables**: ~60 distinct `process.env.*` reads across `src/` + `scripts/` (full inventory with required/optional/secret classification in `M34_ENVIRONMENT_MATRIX.md`; test-only vars like `M29_BASE`, `FAKE_ZAI_DIR` are separated from runtime vars).
6. **Media storage** (`src/lib/media-storage.ts`): `BEANFX_DATA_DIR` root with `originals/ exports/ tmp/ proxies/`; 250 MB per-upload / 2 GB chunked limit; 5 GB per-user quota (`BEANFX_USER_QUOTA_BYTES`); symlink-aware path containment (`isInsideMediaRoot`).
7. **Render worker** (`src/lib/media-worker.ts`, M20 contract): durable `Job` rows, claim+heartbeat, stale-claim sweep, orphan-ffmpeg kill on recovery, serialized global renders (4 GB-sandbox OOM guard), `BEANFX_MEDIA_WORKER_AUTOSTART` gate. There is one job queue; M34 adds no second pipeline.
8. **Project archive** (`src/lib/project-archive.ts`, M29/M33): 800-entry and unpacked-byte caps, sha256 manifest verification (assets AND masks since M33), atomic rename publish.
9. **Auth** (`src/lib/auth.ts`): session cookie `beanfx_session` (None+Secure+Partitioned), scrypt password hashing, integration tokens (hash+prefix only, scoped). Consent/approval gates live in `src/lib/providers/` (M32 honest-readiness model).
10. **Legacy suites**: 10 test files hardcode `db/custom.db`; M22/M23 security are **hybrid** (direct DB + HTTP `:3117`) and **self-seed deterministic fixtures** (`db.user.upsert` with fixed IDs) — fixture-dependent, NOT historical-data-dependent.
11. **Historical dev DB**: `db/backup-20261111_042810/` in the workspace holds only `MANIFEST.txt` + `SHA256.txt`; **the actual `custom.db` binary survives at `/tmp/my-project/db/backup-20261111_042810/custom.db`** (older snapshot copy). Validated read-only: `PRAGMA integrity_check = ok`; row counts match the manifest exactly (User 6, Project 0, MediaAsset 26, ExportFile 15, Job 34, Session 15, WordsToRemove 13). It will be validated and documented — tests will NOT depend on it.
12. **Security scanning**: `scripts/m20-osv-scan.py` exists (invoked by M22's release checks) — reused for Track E dependency scanning.

## M33 history that M34 must not erase

- Acceptance 5/5 (`docs/m33-closeout-acceptance5.txt`), three-format 6/6, per-file unit suites 138/0-fail, M31 security 8/8.
- SQLite profile: WAL + `connection_limit=2`; ladder 0 engine errors ≤21 ms, 49/49 rows; race test 26/27 across sessions; residual = one cold-run read-latency p95 boundary miss (500.35 ms vs `<500 ms`) + one uncaptured pool timeout.
- Verdict QUALIFIED WITH DOCUMENTED RESTRICTIONS; live paid generation, automatic segmentation (CONFIGURATION REQUIRED), owner authorization, and the legacy dev-DB suites remain separately gated.

## Implementation plan derived from this audit

- Track A: `scripts/preflight.ts` + `M34_ENVIRONMENT_MATRIX.md` + clean-checkout qualification run.
- Track B: isolated fixture builder (scratch DB from schema) + point the 10 hardcoded suites at an env-overridable scratch path (no assertion changes) + qualify M19 on a real server + migration-safety checks (fresh push, re-push idempotency, FK integrity, interrupted-migration behavior) + backup validation record.
- Track C: cold/warm concurrency benchmark script extending the M33 ladder (p50/p95/p99/max, busy errors, lost-update checks) + investigate the p95 boundary miss + documented operational limits.
- Track D: storage lifecycle audit table + worker recovery scenario tests (already-supported M20 paths exercised: stale claim, orphan sweep, invalid media, cancel, duplicate submit, retry) + sequential resource qualification.
- Track E: code review + OSV scan + `bun pm` SBOM + targeted security regressions (existing suites + archive-path/SSRF cases).
- Track F: `M34_PROVIDER_ONBOARDING.md` + non-billable readiness checks only (no paid calls).
- Track G: the eight M34 documents using only real repository commands.
