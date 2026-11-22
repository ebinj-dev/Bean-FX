# M35 — Baseline Audit (Deployment Architecture & Controlled Release Preparation)

**Date:** 2026-11-22 · **Branch:** `feature/ai-creative-studio` · **M34 closeout baseline:** `c619f41c8a3cf708b01280b01289b45b757e5f46` — **VERIFIED present** (remote tip at audit time; `git cat-file -t` returns `commit` in an independent fresh clone).

## 1. Repository identity and state

| Check | Result | Classification |
|---|---|---|
| Remote URL | `https://github.com/ebinj-dev/Bean-FX.git` | VERIFIED |
| Feature-branch tip | `c619f41` (M34 closeout) at audit start | VERIFIED via `git ls-remote` |
| `main` SHA | `8a027ee` — "Merge pull request #22 from ebinj-dev/feature/ai-creative-studio" | VERIFIED. The owner merged the M34 closeout into `main` externally (PR #22). Not performed by this work; not modified by this milestone. `main` was NOT assumed to remain `4b23160`. |
| Working tree | clean on `main` (contains all M34 content through the merge); publication will be made on `feature/ai-creative-studio` | VERIFIED |
| User changes preserved | no resets, cleans, stashes or rewrites performed | VERIFIED |

## 2. Actual runtime architecture (inspected, not assumed)

| Area | Finding (file-level evidence) |
|---|---|
| Application framework | Next.js App Router application run on the Bun runtime as a **single server process** (`scripts/dev-server.sh`; ~30 API route groups under `src/app/api/`). There is **no Python/FastAPI backend** — Python files in `scripts/` (`build_report_c.py`, `m20-osv-scan.py`, `verify-lk-fallback.py`) are build/scan tooling, not a runtime tier. The deployment documents therefore do not draw a FastAPI tier. |
| ORM / database | Prisma 6.19.2, `datasource db { provider = "sqlite", url = env("DATABASE_URL") }` (`prisma/schema.prisma`). 66 tables (M34 qualification). WAL mode set at startup: `src/lib/db.ts:51` — `db.$queryRawUnsafe("PRAGMA journal_mode=WAL")` guarded by `.catch()`. **This is the only raw SQLite-specific SQL statement in `src/lib`** (grep-audited). |
| Media storage | Local filesystem root resolved by `src/lib/media-storage.ts`: `BEANFX_DATA_DIR` env override; default `/home/z/my-project/media-store`; refuses empty values and filesystem-root targets. Category subdirectories observed: uploads/probes, exports (`seq_*.mp4` final exports registered in `ExportFile`), masks (`media-store/masks/u_<userId>/…` per `src/lib/project-archive.ts`), showcase assets, project packages (M29 portability), posters. |
| Job/worker model | **In-process durable job runner** (`src/lib/job-runner.ts`): ffmpeg children tracked per job; hard timeout path (`killChildForTimeout`, SIGTERM then SIGKILL); honest OOM handling — killed encoder fails the job with an explanatory message ("encoder process was killed by the system (signal SIGKILL) — most likely out of memory…"), never silently retries; observed ffmpeg RSS ~2.5 GB on a 600 s render (code comment, M20 evidence). Recovery sweep on server (re)start re-queues stale `QUEUED`/`PROCESSING` jobs older than 120 s (`updatedAt` guard, deliberately not an unconditional module-load sweep). `src/lib/job-helpers.ts`: exponential-backoff requeue `min(30 s · 2^(attempts−1), 5 min)`, deterministic-failure class that can never succeed is failed outright. Max 3 attempts (M20 evidence: "attempt 1/3"). **There is no separate worker process and no second job queue.** |
| Rendering | FFmpeg CLI, `libx264` + `aac`, `preset veryfast`; long-form renders are windowed (time-windowed ffmpeg passes + concat list) and validated with ffprobe after completion (`ExportFile.paramsJson` records `"windowed":true`, `"windows":N` — M20-verified). Intermediates (`seg_*`, `list_*`) are cleaned after success. |
| Authentication | `src/lib/auth.ts`: scrypt password hashing with `timingSafeEqual` comparison; session cookie `beanfx_session` (`HttpOnly`, `Secure`, `SameSite=None` + **Partitioned/CHIPS** — documented in-code rationale for cross-site preview embeds; CSRF posture documented there). Sessions persisted in the `Session` table. |
| Authorization / collaboration | Per-user project ownership checks in API routes; M30 collaboration via `/api/invitations`, review flows (`/api/reviews`); M29 project packages via `/api/project-archives`; M31 productions/showcase; M32 masks and provider variants. |
| SSRF controls | `src/lib/production/showcase/product-understanding.ts`: `BLOCKED_HOSTS` regex (`localhost`, `*.local`, `*.internal`, `metadata.*`, `*.arpa`), DNS-resolution check that rejects hosts resolving to private/link-local ranges (IPv4 + IPv6 `::1`, `f[cd]`, `fe80`), plus secret-redaction regexes for URLs/emails/tokens/private paths before analysis. |
| Rate limiting | `src/lib/rate-limit.ts`, scale via `RATE_LIMIT_SCALE` env (test scaling only). |
| Provider integration | Provider modules under `src/lib/` (`asr-providers.ts`, `src/lib/providers/`) and `/api/providers`; external ZAI access through the `BEANFX_ZAI_BIN` CLI binary (no SDK keys embedded); paid generation gated by owner-approved budget fields (`src/lib/production/showcase/generation-router.ts`, `src/lib/production/engine.ts`) and explicit approval gates. Segmentation remains CONFIGURATION REQUIRED (M32). |
| Health | `/api/health` route exists and is used by qualification scripts; capability reporting in `src/lib/media-capabilities.ts`. |
| Backup tooling (pre-existing) | `scripts/backup-db.sh` + `restore-db.sh` (SQLite `.backup`-based isolated drill **plus a `postgres` runbook mode**), `backup-drill.py`, `m31-backup-restore.ts`, `p0_backup_media.sh`, archived legacy DB `db/backup-20261111_042810/` (sha256-verified, M34). Note: the `sqlite3` CLI is **not installed** in this dev sandbox (no dpkg root) — the M35 drill therefore reproduces the drill with `bun:sqlite` (`scripts/m35-backup-drill.ts`). |
| Deployment artifacts | No Dockerfile/compose, no CI workflow, no Kubernetes manifests — deployment so far = dev-server.sh + preflight.ts + qualify-clean-checkout.sh. This milestone prepares (not executes) staging. |
| Containerization suitability | Architecture is process-based (single Next.js server + ffmpeg children). Containers are plausible (stateless server, env-configured DB/media roots) but **unvalidated** — per scope, no Docker files are added this milestone (Track J documents the qualification a container image would need first). |

## 3. M34 verdict carried forward

`M34_CLOSEOUT.md`: **QUALIFIED WITH DOCUMENTED RESTRICTIONS** — M20 T1–T7 executed 8/8; clean-checkout + three-format workflow re-verified; restrictions: ≥8 GB render host, paid-provider approvals, segmentation configuration, PostgreSQL decision (this milestone's Track C), CI optional. All M34 evidence preserved unchanged.

## 4. Environment envelope used for M35 testing

~3–4 GB RAM sandbox (OOM-bounded), 6+ GB free disk, Linux x64, Bun 1.3.14, Prisma CLI 6.19.2, FFmpeg + ffprobe present, `sqlite3` CLI absent, no PostgreSQL server binary, no Docker daemon. Consequences: render-heavy suites run sequentially; PostgreSQL live migration testing is classified INFRASTRUCTURE REQUIRED (static schema validation performed instead); container image validation NOT RUN (no daemon).
