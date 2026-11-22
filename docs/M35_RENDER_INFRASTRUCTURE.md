# M35 Track E — Rendering Infrastructure

**Qualification baseline carried from M34:** ≥8 GB minimum render-host memory. Treated as the *tested* baseline, not a universal guarantee. All measurements below come from M20/M34 executions; estimates are labeled ESTIMATE.

## 1. Actual FFmpeg workload (code-verified)

- Codec path: **`libx264` (CPU) + `aac`**, `preset veryfast` — no GPU codec (`h264_nvenc`/`qsv`/`vaapi`) appears anywhere in the render code.
- Long-form renders are **windowed**: the timeline is rendered as N sequential time windows, each an ffmpeg pass writing `seg_*` files, then a concat (`list_*`) pass; validated by ffprobe; `ExportFile.paramsJson` records `"windowed":true` and `"windows":N` (M20 T3: 10 windows + overlay, verified).
- One render engine exists (the durable job contract). No second engine is added.

**GPU acceleration assessment:** with libx264-only filters/encoders in the pipeline, GPU encoding would require changing the encoder/filters (a new, unvalidated code path). GPU could accelerate encode but *not* the full pipeline (decode/filters remain CPU unless also ported), and would change output characteristics that all current evidence (ffprobe-validated exports) was built on. **Decision: CPU rendering stays; GPU is a future, separately-qualified option — no GPU requirement is imposed on hosting.** "Hybrid" is likewise not justified without a measured bottleneck that GPU work specifically removes.

## 2. Measured numbers (M20/M34 runs)

| Measurement | Value | Source |
|---|---|---|
| ffmpeg RSS on 600 s windowed render | ~2.5 GB (OOM-kill observation, code comment in `job-runner.ts`) | M20 evidence |
| Wall time T1 60 s render | 51 s | M20 closeout suite |
| Wall time T2 300 s / 5 windows | 199 s | M20 closeout suite |
| Wall time T3 600 s / 10 windows + overlay | 395 s | M20 closeout suite |
| Recovery after SIGKILL mid-render | completed on requeue (560 s total incl. recovery) | M20 T4 |
| Sandbox where those ran | ~3–4 GB RAM (OOM-bounded) | environment |
| Three-format production workflow | 6/6 in 66 s | M34 qualification |

Disk throughput: **ESTIMATE** — windowed renders write each `seg_*` then concat-copy: transient disk use ≈ 2× final export size; NVMe-class SSD assumed necessary for long-form (no throughput benchmark exists yet — recorded as a future measurement, INFRASTRUCTURE REQUIRED for a precise number).

## 3. Required analysis (mandated items)

| Item | Value |
|---|---|
| Minimum tested memory | 8 GB (M34; renders observed OOM-failing honestly below that envelope on 3–4 GB) |
| Recommended memory target | 16 GB for comfortable long-form + interactive use on the same host (ESTIMATE: 2.5 GB ffmpeg RSS + OS + server + headroom for one concurrent encode) |
| CPU | 4+ vCPU (libx264 `veryfast` is CPU-bound; 8 vCPU halves wall times for parallel-window workloads — ESTIMATE) |
| GPU | None required (see §1) |
| Disk throughput | SSD/NVMe; ≥ 2× export size free transient space per render |
| Concurrent render limits | SQLite serializes writers, but ffmpeg processes run in parallel — enforce **1 long-form render at a time** on an 8 GB host (policy note; the runner currently relies on backpressure via job queue) |
| Worker startup/shutdown | In-process: starts with the server (`dev-server.sh`/`next start`); shutdown = process stop; orphaned ffmpeg after crash is harmless (sweep re-runs job) |
| Worker health checks | `/api/health` + job-table freshness (Track H model) |
| Job timeout | Runner-enforced (`killChildForTimeout`: SIGTERM → SIGKILL) |
| Cancellation | User cancel → CANCELLED with media intact (M20 T6 VERIFIED) |
| Recovery after interruption | Restart sweep re-queues stale jobs >120 s; ≤3 attempts with backoff (M20 T4 VERIFIED) |
| OOM behavior | Honest failure with explanatory message, NOT requeued (M20 T5 VERIFIED) |
| Disk-full behavior | ffmpeg write failure → job FAILED with stderr tail in the message (runner design); disk-space preflight recommended before large renders (OWNER ACTION to enable disk monitoring — Track H) |

## 4. Resource sizing table

| Workload profile | Host | Concurrency | Expected behavior |
|---|---|---|---|
| Small (personal / single operator) | 8 GB / 4 vCPU / SSD | 1 long render | M34-qualified behavior; T1-class renders ≈ real-time×0.85 (51 s for 60 s) |
| Medium (controlled beta) | 16 GB / 8 vCPU / NVMe | 1–2 renders | 600 s timeline ≈ 6–7 min wall (measured 395 s on weaker host; faster CPU improves it — ESTIMATE) |
| Larger (growing) | 32 GB / 16 vCPU or Option-2 worker host | 2–4 renders | requires Option-2 topology (shared media) + PostgreSQL (Track C) — DESIGN READY |

## 5. Render infrastructure requirements checklist for staging

1. 8 GB RAM minimum (16 GB recommended) — VERIFIED baseline from M34.
2. SSD with free space ≥ 2× largest planned export.
3. FFmpeg + ffprobe on PATH (preflight checks — CONFIGURATION REQUIRED if missing).
4. Sequential long renders until a measured concurrency test says otherwise.
5. Disk/memory monitoring wired to Track H thresholds before public beta.
