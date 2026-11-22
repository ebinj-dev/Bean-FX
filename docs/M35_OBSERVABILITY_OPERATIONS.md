# M35 Track H — Observability & Operations

**Principle:** use what exists (`/api/health`, job tables, job-runner logs, preflight), structured logs with the existing secret redaction, no paid monitoring services (owner approval required first).

## 1. What to watch (mapping to actual code)

| Signal | Source | Healthy | Attention |
|---|---|---|---|
| Frontend availability | `GET /` via proxy | HTTP 200 | non-200 / TLS errors |
| API availability | `GET /api/health` | 200 JSON | 5xx / timeout |
| Database health | preflight `db.connect/db.schema/db.wal` checks (`scripts/preflight.ts`); `/api/health` | READY | errors on connect / integrity_check |
| Worker health | job-runner liveness = server process + recent job activity | jobs progressing | stale sweep firing repeatedly |
| Render queue depth | `Job` rows `QUEUED` by type | ≤ a few | sustained growth (backpressure) |
| Failed jobs / retry counts | `Job` rows `FAILED` + `attempts` | low, explained messages | OOM messages (RAM pressure) |
| Render duration | `Job` timestamps (`createdAt`→completion) | M20 baselines: 60 s render ≈ 51 s wall; 600 s ≈ 395 s | large drift = CPU/IO contention |
| Disk usage | host metrics (df on media root + DB volume) | < 75% | ≥ 85% → render failures follow (honest FAILED jobs) |
| Memory | host metrics + ffmpeg RSS observations (~2.5 GB on 600 s render) | < 75% | OOM-class FAILED jobs |
| CPU | host metrics | < 80% sustained | renders starving interactive latency |
| Media storage errors | job stderr (write failures), media probe rejections | none unexplained | any repeated write error |
| Provider readiness | preflight provider checks (CONFIGURATION REQUIRED classification) + `/api/health` capability payload | configured providers READY | unconfigured ≠ unhealthy (see §2) |
| Authentication errors | failed login/response codes in app logs | normal rate | spikes = credential stuffing → rate limiter engaged |

**Log discipline:** server logs already avoid credentials; provider-facing code applies secret-redaction regexes (`product-understanding.ts`). Rule for staging: logs go to the service unit / a local file with rotation; no log shipping service without owner approval.

## 2. Health-check model (four states — the provider rule)

| State | Meaning | Example |
|---|---|---|
| **HEALTHY** | Core editor + API + DB + worker all functional | login, timeline, render, export all working |
| **DEGRADED** | Core functional, secondary capability failing | disk ≥ 85% (renders may fail), repeated job retries |
| **CONFIGURATION REQUIRED** | Core functional; an optional capability has no credentials/config — **an unconfigured provider must NOT make the core editor unhealthy** | no ASR provider configured (captions degraded), segmentation unconfigured (M32), SMTP unset |
| **UNAVAILABLE** | Core broken | DB unreachable, server down, media root unwritable |

This matches the existing preflight/preflight-report vocabulary (M34: OVERALL = CONFIGURATION REQUIRED with 0 BLOCKED while providers were unconfigured) — the M35 model formalizes it for operations. `scripts/m35-health-check.sh` (added this milestone) implements: app 200 check, `/api/health` check, DB connect+integrity, media-root writability, disk/memory thresholds, job-failure scan → prints one of the four states.

## 3. Recovery runbook (operations)

1. **Server down:** restart service (`systemctl restart beanfx` or `bash scripts/dev-server.sh` on staging); the startup sweep re-queues stale jobs automatically (M20 T4 VERIFIED).
2. **Render failures with OOM message:** stop submitting long renders; check host memory; serialize renders (one long render at a time on 8 GB); consider Track E sizing table upgrade.
3. **Disk ≥ 85%:** clean old exports (owner-approved retention), verify backups exist first, then enlarge volume (media root and DB on same volume — atomic backup simplicity, Track A).
4. **DB integrity failure:** restore from latest backup per Track G §3 (never attempt in-place repair of the production file).
5. **Provider outage:** capability degrades (DEGRADED/CONFIGURATION REQUIRED), core editor unaffected by design.
