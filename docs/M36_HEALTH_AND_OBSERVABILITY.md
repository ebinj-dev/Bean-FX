# M36 — Health, Readiness & Operations (Phase E)

**Baseline preserved:** M35's four-state model. The repository's canonical enumeration is **HEALTHY · DEGRADED · CONFIGURATION REQUIRED · UNAVAILABLE** (M35 Track H + preflight's statuses). The task-named `UNHEALTHY` maps to the canonical **UNAVAILABLE**; no new state names were invented.

**Core rule preserved and enforced:** an unconfigured paid AI provider is reported as a **separate subsystem** (informational CONFIGURATION REQUIRED) and never changes the core verdict. No successful result is printed when a required dependency fails — hard failures (app down, `/api/health` 503 component, DB integrity not ok, media root unwritable) exit **UNAVAILABLE** immediately with the failing component named.

## 1. Check coverage (`scripts/m36-health-check.sh`, supersedes the M35 v1 with the audit-identified gaps closed)

| # | Check | Failure → state |
|---|---|---|
| 1 | App process / `GET /` | non-200 → **UNAVAILABLE** (exit 3) |
| 2 | `/api/health` incl. its 503 per-component report | 503 → UNAVAILABLE with the failing component; other non-200 → DEGRADED |
| 3 | DB reach + `integrity_check` + **permissions** + **contention signatures** (m36-db-ops) | integrity≠ok → UNAVAILABLE; world-readable DB / lock-timeout signatures → DEGRADED |
| 4 | Storage write access | fail → UNAVAILABLE |
| 5 | **FFmpeg + ffprobe availability** (new) | missing → DEGRADED (renders will fail honestly; core editor unaffected) |
| 6 | **Render-temp accumulation** `seg_*`/`list_*` >1 h (new) | any → DEGRADED (crashed-render signal) |
| 7 | **Backup freshness** (new; `BEANFX_BACKUP_DIR`) | none newer than 26 h → DEGRADED; unset → subsystem CONFIGURATION REQUIRED |
| 8 | Disk (≥85% DEGRADED) / available memory (<25% DEGRADED) | DEGRADED |
| 9 | Job backlog + FAILED/CANCELLED counts (durable-render visibility) | FAILED>0 → DEGRADED with counts |
| 10 | **Provider readiness** — separate subsystem, informational only | never affects the core verdict |

Live validation against a running app (M36 lifecycle test): `DEGRADED` with subsystems (`backup target not configured…`, `render-worker: in-process runner (jobs: QUEUED=0 PROCESSING=0 FAILED=4 CANCELLED=1)`, `provider CLI: unconfigured…`) and notes (`db file group/world readable`, job counts) — precisely the expected honest result against a scratch DB carrying M20's intentional failure rows. Exit-code semantics verified: 0/1/2/3.

## 2. Operations runbook (common failures → recovery)

| Symptom | Likely cause | Action |
|---|---|---|
| `UNAVAILABLE app=000` | server down | `beanfxctl status` → `beanfxctl logs` → `beanfxctl start` (env gate re-validates) → re-run health |
| `UNAVAILABLE /api/health failing component: database…` | DB path/permissions/integrity | `m36-db-ops.ts verify` → fix path/perms → if integrity≠ok **restore from latest backup** (never in-place repair) |
| `UNAVAILABLE media root not writable` | perms/disk | check mount + ownership (0700 data root), `df` for full volume |
| `DEGRADED ffmpeg/ffprobe not on PATH` | runtime package missing | install ffmpeg/ffprobe; renders fail honestly until then |
| `DEGRADED N render temp files older than 1h` | crashed render leftovers | verify job table (FAILED rows with OOM/stderr), delete the stale `seg_*`/`list_*` files, confirm next render cleans up |
| `DEGRADED disk N% ≥85` | media growth | clean old exports (owner-approved retention) AFTER confirming a verified backup; enlarge volume |
| `DEGRADED jobs: FAILED=n` | render failures | read job messages (OOM vs disk vs provider); apply M35 sizing guidance; long renders serialized on 8 GB hosts |
| `DEGRADED no backup newer than 26h` | backup timer broken | check `backup.log` for the explicit `BACKUP_FAILED` line; fix cron/systemd timer |
| `DEGRADED db file group/world readable` | permissions drift | `chmod 600 <db>`; investigate how it changed |
| `contention=… lock/timeout signatures` | writer pressure beyond M33 pool sizing | check concurrent-render count; M35 sizing table |
| subsystem: provider unconfigured | expected state | CONFIGURATION REQUIRED — decide/enable providers via owner process; core stays healthy |

**Escalation path:** any UNAVAILABLE not resolved by the table → restore procedure (M36_BACKUP_RESTORE_OPERATIONS §2) on an isolated target, then cutover. Never repair the live DB file in place.

## 3. What remains owner-side

Real-host health wiring (systemd timer for health checks + backup cadence), TLS/proxy health from outside, off-host backup adapter selection, and provider configuration decisions — all documented in M36_STAGING_HOST_EXECUTION_CHECKLIST.md.
