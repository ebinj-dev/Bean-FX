# M34 — BEAN FX Release-Candidate Operations Manual

**Audience:** the operator running BEAN FX on a server or workstation.
Every command below is a real repository command (verified in M34; see the qualification reports). Nothing here deploys, releases, or bills anything.

## 1. Installation (clean checkout)

```bash
git clone https://github.com/ebinj-dev/Bean-FX.git BeanFX && cd BeanFX
bun install --frozen-lockfile        # 620 packages (M34 evidence)
bunx prisma generate                 # explicit step — bun does not guarantee postinstall
```

Private-clone note: if the repository is private, use your established credential helper (`git -c credential.helper=… clone …`). The qualification harness accepts it via `BEANFX_GIT_CREDENTIAL_HELPER`.

## 2. Environment configuration

Copy `.env.example` to `.env` and set at minimum `DATABASE_URL` (e.g. `file:./db/custom.db`). Every variable is classified in `M34_ENVIRONMENT_MATRIX.md` — required vs optional, secret vs not, dev vs production. **Never put credentials in committed files or chat.**

## 3. Startup preflight

```bash
bun scripts/preflight.ts            # human-readable
bun scripts/preflight.ts --json     # machine-readable (CI/monitoring)
```

Reads as `READY / WARNING / CONFIGURATION REQUIRED / BLOCKED / UNSUPPORTED` per check. Verdicts: only BLOCKED items prevent startup; CONFIGURATION REQUIRED (providers, SMTP, segmentation) is an honest degraded mode — the product runs without them. Exit code is 1 only when BLOCKED items exist. Preflight never prints secret values.

## 4. Database initialization & migration

The repository ships schema via **`prisma db push`** (schema-sync; there is no migrations directory — `db:migrate`/`db:reset` npm scripts are inert):

```bash
bunx prisma db push --skip-generate          # create/update the schema (idempotent)
bunx prisma migrate diff --from-url "$DATABASE_URL" \
     --to-schema-datamodel prisma/schema.prisma   # review drift BEFORE pushing an existing DB
bun scripts/preflight.ts                     # db.file/db.connect/db.schema/db.wal all READY after push
```

- Fresh DB: push creates all 66 tables (verified; FK check clean).
- Existing DB: run the diff first, then push. Verified upgrade path: the 2026-11-11 backup (7 legacy tables) upgrades to the current schema on a copy with **all rows preserved** (`scripts/m34-migration-safety.ts`).
- Backup creation: `scripts/m31-backup-restore.ts` (existing tool); keep verified manifests (`MANIFEST.txt` + `SHA256.txt`) alongside backups — that discipline is what made the historical backup recoverable.
- Interrupted migration: if a push fails (e.g. the file is locked), release the lock and re-run — push is transactional per schema state and resumes cleanly (verified).

## 5. Application startup

```bash
bun run build                                # production bundle (Next standalone)
bun run start                                # scripts/dev-server.sh — serves on $PORT (default 3000)
```

`dev-server.sh` rebuilds automatically when `.next/BUILD_ID` is missing and copies static assets into the standalone output. Set `DATABASE_URL` and optionally `BEANFX_DATA_DIR`, `PUBLIC_APP_URL`, `PORT`. Run with `NODE_ENV=production` in production (silences Prisma query logs). Verify: `curl -s -o /dev/null -w '%{http_code}' http://localhost:$PORT/` → 200.

## 6. Render workers

The worker runs **in-process** with the server by default (`BEANFX_MEDIA_WORKER_AUTOSTART` unset/`1`) and executes the durable `Job` queue serially (M20 OOM guard: one render at a time). For multi-process deployments set `BEANFX_MEDIA_WORKER_AUTOSTART=0` on web instances and run a dedicated worker instance. Recovery is automatic: stale claims are requeued or failed honestly, orphaned ffmpeg processes are killed before re-run, and proxy/exist checks make retries safe. Do not run two workers against one SQLite file.

## 7. Project backup / restore

- Backup DB: `scripts/m31-backup-restore.ts` + keep the row-count manifest and sha256 (see §4).
- Backup media: archive `BEANFX_DATA_DIR/originals` (the only non-regenerable lane; proxies/exports are derivable, tmp is transient).

## 8. Project package portability

UI: editor → "Project portability: package, import, bulk relink". API: `POST /api/project-archives` (mode FULL/MEDIA), `GET /api/project-archives/<id>/download`, import through the portability panel. Packages are sha256-verified on write (assets and masks) and validated on import (checksums first; missing assets refuse the import). M33 acceptance covers the full package→import→validated-mask round trip.

## 9. Failed job handling & worker recovery

```bash
curl -s "http://localhost:$PORT/api/jobs/<jobId>"      # status + honest failure message
```

A FAILED job is terminal truth: read `message`, fix the cause (missing media, invalid input, provider outage), then re-dispatch the operation (renders are re-runnable; attempts are recorded). After a server crash mid-render: restart the server — the recovery sweep requeues/failed-fairs stale claims automatically; the runbook kill of orphaned encoders (`pkill -9 ffmpeg`) is safe because renders are globally serialized.

## 10. Storage maintenance

Lanes under `BEANFX_DATA_DIR`: `originals/` (never auto-delete — user footage), `proxies/` (regenerable), `exports/` (user-managed, quota-counted), `tmp/` (transient; safe to empty ONLY when no render is running). Check capacity: preflight `storage.disk`. Quota enforcement: 5 GB per user (`BEANFX_USER_QUOTA_BYTES`).

## 11. Provider configuration

See `M34_PROVIDER_ONBOARDING.md`. In short: install the provider CLI (`BEANFX_ZAI_BIN`), credentials in the environment (never in chat/files), verify with preflight (presence only), record verified pricing before any paid generation, and keep automatic segmentation CONFIGURATION REQUIRED until a provider is approved.

## 12. Security checks

```bash
python3 -I scripts/m20-osv-scan.py           # OSV dependency scan (0 findings as of M34)
bun scripts/preflight.ts --json              # config + secret presence (never values)
bun test scripts/test-m31-security.test.ts   # with a running server (M31_BASE=… M31_DB=…)
```

Legacy suites M19/M22/M23 run against isolated fixture DBs via `scripts/legacy-fixture.ts` — they can no longer touch the development database.

## 13. Shutdown

Stop the server process (`kill -TERM <pid>`); the worker finishes/times out the current tick, jobs stay durable (claimed jobs recover on next start). For a hard kill: jobs recover via the stale-claim sweep — that path is tested (M20 T4).

## 14. Disaster recovery

1. Restore the DB from the verified backup (copy + `prisma db push` to current schema — verified data-preserving).
2. Restore `originals/` from the media backup.
3. Start the server; claimed-but-interrupted jobs recover or fail honestly; re-dispatch as needed.
4. Verify with the health sequence below.

## 15. Known limitations (as qualified in M34)

- 4 GB sandbox OOM envelope for long-form renders (M20 T2/T3 need a larger host); renders fail HONESTLY, never corrupt.
- SQLite profile: one concurrent render, 2-connection pool; PostgreSQL is the owner decision for high-concurrency production (documented in `M34_DATABASE_QUALIFICATION.md` §6).
- Live paid generation and automatic segmentation remain gated (CONFIGURATION REQUIRED / owner approval).
- No CI workflows exist; qualification is local (owner option to add).

## 16. Health-check sequence (no provider secrets needed)

```bash
bun scripts/preflight.ts                     # overall: no BLOCKED → safe to start
curl -s -o /dev/null -w '%{http_code}' http://localhost:$PORT/     # 200
curl -s http://localhost:$PORT/api/health 2>/dev/null || true      # if present in deployment
bun scripts/preflight.ts --json | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['overall'], d['exit'])"
```

Application-healthy = preflight reports no BLOCKED items, `GET /` returns 200, and a test render submitted through the UI/API transitions QUEUED → IN_PROGRESS → COMPLETED with an ffprobe-validated export (the M34 storage-worker suite automates exactly this path).
