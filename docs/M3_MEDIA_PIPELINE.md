# M3 — Production-Grade Media Pipeline

**Status: IMPLEMENTED, TESTED AND PUSHED to `feature/ai-creative-studio`.**
This document describes the architecture, the reliability semantics, the
security model, and — explicitly — which capacity claims are *measured* and
which are *design targets only*.

## 1. What M3 adds

| Capability | Where | Notes |
|---|---|---|
| Resumable chunked uploads (up to 2 GB) | `src/app/api/media/route.ts`, `src/app/api/media/upload/[uploadId]/route.ts` | Server-tracked `UploadSession` rows; per-index part files; status endpoint lists missing/mismatched chunks; explicit cancellation |
| Content validation | `src/lib/media-storage.ts` (`sniffContainer`) | Magic-byte container sniffing (never the client's claims), extension cross-check, real MIME derivation, streamed sha256 |
| Duplicate detection | `finalizeUpload` | Same user + same sha256 → new asset row reuses the stored original (content-addressed); refcounted deletion |
| Per-user quotas | `computeUserUsage` / `hasQuotaFor` | Originals + proxies + exports counted; `BEANFX_USER_QUOTA_BYTES` (default 5 GB); checked against the declared size before bytes are accepted |
| Deep ffprobe analysis | `src/lib/media-analysis.ts` | Duration, size, resolution, DAR/SAR, r/avg frame rate (VFR detection), codecs, sample rate, channel layout, time base, start time, nb_frames, bit rate, rotation (display matrix + legacy tag), corruption/unsupported classification |
| Editing proxies | `src/lib/media-proxy.ts` | Long edge 960, H.264 veryfast CRF26 + AAC 128k, `-fps_mode passthrough` + 90 kHz track timescale for timestamp alignment, faststart, rotation-aware scaling, duration-alignment verification |
| Durable background worker | `src/lib/media-worker.ts`, `src/instrumentation.ts` | DB-backed queue, atomic claims, heartbeats, retry with backoff, cancellation, crash recovery, timeouts, per-user + global concurrency caps, idempotent handlers |
| Storage separation & hygiene | `media-store/{originals,proxies,exports,tmp}` | Worker sweeps: abandoned upload sessions (24 h TTL), stale scratch (6 h), orphan proxies. Originals are never deleted automatically |

No probing or transcoding runs inside HTTP handlers: upload requests do
bounded work only (sniff 32 bytes + hash + DB writes); everything heavy is a
queued job.

## 2. Job lifecycle (M3 types: `MEDIA_PROBE`, `MEDIA_PROXY`)

```
enqueue (QUEUED, maxAttempts=3, timeoutSec per type)
  → worker tick (2 s): recover stale claims (heartbeat > 90 s old)
                     → claim (atomic status flip QUEUED→PROCESSING, attempts++)
                     → per-user caps (probe ≤ 2, proxy ≤ 1) + global cap (2)
  → handler runs with heartbeat (progress writes + 15 s ticker)
  → success: COMPLETED (guarded write: only while PROCESSING)
  → transient error: attempts < max → QUEUED with runAfter = now + 30 s·2^(n−1) (≤ 5 min)
  → permanent error (PermanentJobError): FAILED immediately, no retry burned
  → worker crash: heartbeat goes stale → recovery re-queues or fails
  → timeout: child killed, FAILED "exceeded time limit" (probe 120 s, proxy 45 min)
  → cancel (DELETE /api/jobs/:id): queued → CANCELLED; running child → SIGTERM
```

Handlers are idempotent: probe re-reads the file; proxy short-circuits when a
READY proxy file already exists — a recovered job can safely re-run.

## 3. Security model

- Every asset, job, and upload-session row carries `userId`; every route
  verifies ownership before touching storage (`404` for cross-user probes to
  avoid id enumeration — verified by E2E).
- Media is served only through authenticated routes with Range support;
  `?variant=proxy` / `?variant=original` are explicit, and the default
  prefers the proxy only when it is READY.
- Originals are content-addressed and never overwritten; deleting a dedup
  copy never deletes shared bytes (verified by tests).
- No secrets, user media, databases, or generated exports are committed:
  `media-store/`, `db/`, `.env` are gitignored; the M3 diff was scanned.

## 4. Measured limits — single sandbox node, 2 vCPU, SQLite, local disk

These are **real measurements** from `scripts/e2e-media-pipeline.ts`
(2026-11-12, this workspace; small synthetic fixtures):

| Operation | Measured |
|---|---|
| Chunked upload 4.72 MB (with one interruption + resume) | 122 ms wire time (local loopback) |
| Deep ffprobe (5 s 720p MP4) | ≈ 2.2 s |
| Proxy transcode 1280×720 → 960×540, 5 s | ≈ 3.3 s (**≈ 1.5× realtime**) |
| Worker steady-state | global cap 2 concurrent jobs; 1 proxy per user |
| Full E2E (37 checks) | 16.2 s |

Interpreter: on this node, one proxy saturates roughly half a vCPU-pair;
60 s of 720p source needs ≈ 40 s of transcode. This is a **dev-grade single
node** — the numbers quantify the local pipeline, not a production fleet.

## 5. 100,000-concurrent-user design — TARGETS, NOT MEASURED FACTS

**No load test has been executed.** We do not claim 100k-CCU capacity. What
follows is the scaling design and its assumptions; every number in §4 is the
only measured evidence.

### What already scales by design
- **API vs processing separation**: uploads are bounded-cost requests; all
  media work is queued jobs. API capacity and worker capacity scale
  independently — move the worker loop to a fleet of worker processes
  (it needs only the DB and `media-store`; set `BEANFX_MEDIA_WORKER_AUTOSTART=0`
  on web nodes, run dedicated workers on transcode nodes).
- **Durable queue**: jobs survive restarts; claims are atomic. At fleet scale
  the SQLite queue is the first bottleneck (single-writer) — replace with
  Postgres (`SKIP LOCKED`) or Redis Streams; the claim/heartbeat/retry
  semantics port 1:1.
- **Storage isolation**: per-user accounting is centralized in
  `media-storage.ts`; swap the local FS for S3-style object storage with
  per-user prefixes and the quota/dedup logic carries over.

### Required at 100k CCU (design assumptions, unvalidated)
| Concern | Assumption / change |
|---|---|
| Object storage | S3 + presigned multipart uploads replace `media-store`; checksum/dedup keys unchanged |
| Queue | Postgres `SKIP LOCKED` or Redis Streams; ~100+ workers; jobs partitioned per user |
| Transcode fleet | At 1.5× realtime per 2 vCPU (measured locally), 10k uploads/day averaging 10 min ≈ 45–70 concurrent encodes → ~70–100 worker pods with autoscaling on queue depth |
| Admission control | Per-user concurrency caps already exist; add per-tenant quotas in the auth layer and 429s at the edge |
| Upload path | Presigned direct-to-object uploads remove the API server from the byte path (the current chunked protocol stays for the fallback route) |
| Database | Postgres with read replicas; `MediaAsset`/`Job` tables are the hot set; `sizeBytes Int` must become BigInt for >2 GB rows |
| CDN | Proxy/original delivery through signed URLs; the authed streaming route remains the fallback |

### Honest statement
The M3 code implements the semantics a 100k-CCU platform needs (durable
queue, admission control, quotas, isolation, crash recovery), but the only
executed measurements are the single-node numbers in §4. Before any capacity
claim: run a load test (k6/locust) against a Postgres + object-storage +
worker-fleet deployment and publish the p95/p99 numbers.

## 6. Verification summary (all executed 2026-11-12)

- `bun test scripts/*.test.ts` — **138/138 pass** (M3 suite: 24 tests —
  sniffing, checksums, probe matrix incl. VFR/rotation/corrupt/no-audio,
  proxy + alignment, retry/backoff/permanent, cancel, crash recovery,
  concurrency caps, quota, dedup refcount, sweeps)
- `scripts/e2e-media-pipeline.ts` — **37/37 checks** (chunked resume over
  real HTTP, async probe, proxy streaming with Range, dedup, 415 fake
  extension, 413 quota, session cancel, tenant isolation, concurrent users)
- `scripts/e2e-editor-timeline.ts` — **27/27 checks** (M2 regression on top
  of the async pipeline)
- `tsc --noEmit` clean · `prisma validate` clean · production build exit 0
