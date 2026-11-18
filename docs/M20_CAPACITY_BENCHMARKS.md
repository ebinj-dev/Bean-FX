# M20 §12 — Capacity & Performance Benchmarks (measured, not claimed)

**Test host** (the only environment measured — a 4 GB development sandbox, NOT a production host):
- CPU: 2 vCPU · RAM: 3.9 GiB total (≈2.8 GiB available under the running stack) · Disk: 9.9 GB (≈4.3 GB free)
- FFmpeg 7.1.5 · Node (Next.js 16 standalone) · SQLite (dev) / PostgreSQL 16 (drill)
- Production hardware requirements are derived in §5 below and in `M19_PRODUCTION_DEPLOYMENT.md`; the sandbox itself is **not** representative of production capacity.

## 1. Durable long-form rendering (measured by `test-m20-durable-render.test.ts`)

| Scenario | Wall time | Peak ffmpeg RSS | Result |
|---|---|---|---|
| T1 · 60 s multitrack (2 video + 1 audio + overlay) | 45.0 s (run10) | sampler unpopulated (see note) | COMPLETED, ffprobe-validated |
| T2 · 300 s (5 windows) | 188.9 s (run9) / 194.5 s (run10) | sampler unpopulated | COMPLETED, 300.02 s output |
| T3 · 600 s multitrack (10 windows) | 384.4 s (run9) / 378.2 s (run10) | sampler unpopulated | COMPLETED, 600.02 s, 243 MB |
| T4 · 600 s with SIGKILL + worker restart | 543.8 s (run6) / 550.7 s (run9) | sampler unpopulated | COMPLETED after sweep requeue |
| T6 · cancellation mid-render | 30.2 s | — | CANCELLED, media intact |
| T7 · two concurrent submissions | 75.5 s | sampler unpopulated | both COMPLETED |

(Numbers are backfilled from `m20-suite9.log` / `m20-suite10.log` — real suite wall times, not estimates. The in-test ffmpeg RSS sampler returned null in these runs (sampled field not persisted); measured memory facts on this host come from dmesg OOM records: pre-hardening ffmpeg peaked ~2.5-2.9 GB RSS and was globally OOM-killed; the -threads 2 encoder cap and per-window bounded inputs are the mitigations now in force.)

## 2. Concurrency smoke (measured)

(pending run) parallel request fan-out against the production standalone build (project list, timeline load, public pages), recorded p95 latencies.

## 3. Storage growth (measured mechanics)

- Media uploads: quota 5 GiB/user default (`BEANFX_USER_QUOTA_BYTES`), enforced per upload.
- Exports: each 60 s 720p render ≈ TBD MB (from export rows); 600 s ≈ TBD MB.
- Proxies: generated per import (TBD) — reaped with asset deletion.
- Backups: pg_dump custom+compress of a 25-user/40-project seed = 106.5 KB (drill evidence); real-DB backup scales with `backup-db.sh`.

## 4. Launch capacity statement (honest)

- The 4 GB sandbox demonstrated the bounded-memory windowed renderer up to the limits measured in §1; it is **not** a public-production host.
- Realistic minimum production spec (derived from measured peaks, not marketing): 4 vCPU / 8 GB RAM (render worker separated from web) / 100 GB SSD, queue-limited to 2 concurrent windowed renders per worker; scale-out path documented in `M19_PRODUCTION_DEPLOYMENT.md`.
- No claims of concurrent-user ceilings beyond the measured smoke in §2.

## 5. Scaling thresholds (mechanism, not speculation)

| Resource | Threshold where behavior changes | Mechanism |
|---|---|---|
| Render worker RAM | Window peak × concurrency + ~1.5 GB base | queue admission control (`maxAttempts`, heartbeat) |
| SQLite→PostgreSQL switch | >1 writer node or >~100 concurrent sessions | DATABASE_URL to PostgreSQL (drill-verified path) |
| Media disk | 5 GiB/user quota × active users | per-user quota + deferred cleanup retention |
| SMTP | — | CONFIGURATION REQUIRED (owner provider) |
