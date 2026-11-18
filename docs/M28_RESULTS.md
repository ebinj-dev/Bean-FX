# M28 RESULTS — Professional Media Pipeline & Export Reliability

**Status: audit-driven hardening shipped with real FFmpeg evidence; one genuine concurrency race fixed; M27 truncation regression re-verified under new conformance gates. No redesign; additive UI only.**

## 1. Repository audit
- M27 tip `01286f5` verified on the remote branch; main baseline `fb051dd` (unchanged by this work).
- Recycle repaired (stale next-build lock cleared; servers restored). Working tree verified content-identical to the M27 tip (mode bits restored); the recycled-away `download/m27-evidence/` bundle was recovered from the remote tree.
- **Architecture findings (the pipeline was already far more complete than the brief assumed):**
  - `media-analysis.ts` (M3.2): deep ffprobe — dims, fps avg/nominal, **VFR detection** (0.5 % tolerance), **rotation** (display matrix + legacy tag), codecs, channels/rate, corruption → `PermanentJobError` with actionable messages; images handled.
  - `media-proxy.ts` (M3.3): rotation-aware 960-px proxies, VFR-safe timestamp passthrough, alignment verification (max(0.5 s, 2 %)), idempotent crash recovery, cancellation mirroring.
  - `media-worker.ts` (M3.4 + M20 §3): durable Job-table queue, atomic claims, heartbeats, stale-claim recovery, OOM dedup, orphan-ffmpeg kills, scratch sweeps (abandoned upload sessions, stale tmp, orphan proxies), global/per-user caps, globally serialized renders, watchdog.
  - Ingestion: filename traversal checks, extension rules, content-sniff vs extension, size limits (`MAX_UPLOAD_BYTES`/`MAX_CHUNKED_BYTES`), chunked upload sessions with TTL sweeps.
  - Export: M9 profile registry with validation; EXPORT_VARIANT validates target before encode AND runs post-encode ffprobe conformance with output cleanup; TIMELINE_RENDER probes output before registering the ExportFile.
  - Relinking (M25 P4): honest missing-media placeholder + ReplaceClip-based relink (reversible, recorded in timeline history).
  - Job control: DELETE /api/jobs/[id] cancellation exists.
- **Verified gaps (this milestone's work):** runtime encoder capability checks missing; proxy regeneration endpoint missing; stale READY proxy references unrepaired; no disk-space guard before transcodes; relink had no compatibility diagnostics; deleted-asset clips had no relink path in the inspector; render output duration/dimensions not conformance-gated.

## 2. Implementation
1. **Runtime codec capabilities** (`src/lib/media-capabilities.ts`): asks the deployed ffmpeg once per process (`-encoders`/`-muxers`/`-version`), maps every M9 export family to real encoder names (H264 libx264, H265 libx265, ProRes prores_ks, VP9 libvpx-vp9, AAC, PCM), `checkExportCodecAvailable()` returns honest availability + reasons. Tests inject capability snapshots.
2. **Proxy regeneration** (`POST /api/media/[id]/proxy`): ownership + kind checks, duplicate-job 409, stale-READY repair (file missing → honest FAILED + requeue). Worker sweep #4 repairs stale READY references in the other direction. Never touches originals.
3. **Disk-space guard** (`assertDiskSpace` in media-storage): statvfs-based floor (512 MiB) before proxy transcodes and timeline renders; actionable PermanentJobError; unknown capacity fails open (logged, not hidden).
4. **Proxy eligibility race FIXED** (real defect found by the E2E suite): the auto-queued proxy job could claim BEFORE probe metadata committed and misjudge 1080p sources as "not justified" (observed twice in the job history). `runProxyJob` now waits (≤10 s) for probe metadata before deciding, else defers to a retry.
5. **Render conformance gates**: post-encode ffprobe must match the requested window (duration within max(0.5 s, 2 %)) and the exact sequence dimensions, else the output is rejected — a successful ffmpeg exit alone is not evidence.
6. **Relink diagnostics**: media/list exposes fps/rotation/channels/videoCodec; the relink picker warns before relinking (duration mismatch vs the clip's timeline expectation, frame-rate vs sequence, video-only replacement). Placement preserved via ReplaceClip (reversible; recorded in project history).
7. **Inspector SOURCE MEDIA panel** (P9, additive): real probe metadata (resolution, fps + VFR badge, codecs, audio, duration, rotation, probe status) + proxy status + ↻ regenerate button; a 404 on the source asset now surfaces the MISSING-MEDIA relink path (closes the deleted-asset gap).

## 3. Evidence (all executed)
- **M28 suites: 11/11** — capabilities (3), disk guard (4), stale sweep (1), E2E: **real 1920×1080 fixture → probe → auto-proxy → FFprobe-verified 960×540 h264 proxy with aligned duration**, regen 202/409 + wrong-kind 400, media/list fields, render cancel → CANCELLED + duplicate cancel 409.
- **M27 truncation regression repeated under the new gates**: 10.000 s video = 10.000 s audio (multi-clip tracks), luma ramp 130/191/245 PASS (animated keyframes through the sampled segments), crossfade continuity PASS (−20.1 dB overlap). `m28-evidence/render-evidence.log`.
- **Timings measured** (this sandbox, 2 vCPU): import (2 fixtures incl. transcode) 638 ms; timeline apply 24 ms; probe settle 514 ms; 10 s 640×360 multi-clip render wall 7 s. Proxy E2E: upload→probe→proxy→READY ≈ 5 s for a 3 s 1080p source. Peak disk bounded by MIN_FREE_DISK_BYTES guard.
- **Regression: 41 suites (M1–M27 + M28) exit 0, zero failures**; tsc 0; eslint 0 errors (3 pre-existing M26 directive warnings at baseline); build 26.5 s SUCCESS.
- Browser walkthrough: project + clip → SOURCE MEDIA panel live (1920×, Probe READY, Proxy READY) → asset deleted → **MISSING MEDIA relink UI present with picker** → 375 px no overflow. Screenshots in `m28-evidence/screenshots/`.

## 4. Honest classification
- VERIFIED (live): proxy E2E chain, regen/stale/duplicate/cancel behaviors, disk guard errors, SOURCE MEDIA panel, missing-media relink UI, 375 px, render evidence incl. M27 regression repeat.
- AUTOMATED: capability mapping, conformance gates, sweep repairs, relink diagnostic logic (unit-level, types checked; the live warning list was not exercised because the test user had no second asset — noted honestly).
- REUSED (verified, unchanged): deep probe metadata, VFR/rotation handling, worker recovery machinery, export variant conformance, chunked upload security, job cancellation.
- NOT IMPLEMENTED (honest): no NEW packaging mechanism — project portability continues to use the existing M23 publish-package contract (audited, unchanged); proxy/original preview SWITCH control not added (the file route already auto-serves proxies with `?variant=original` escape — documented rather than duplicated in UI this milestone).
- OWNER ACTION: ProRes/VP9/H265 exports on hosts whose ffmpeg lacks those encoders — the capability check now reports CONFIGURATION-style reasons instead of failing mid-render.

## 5. Security notes
Ingestion security unchanged (filename traversal checks, sniff-vs-extension, size limits, safe tmp paths, local-only storage). New endpoint follows the same auth/ownership pattern; no user input reaches ffmpeg argument construction (proxy plans are built from persisted, probe-verified fields; render args from project state).

## 6. GitHub
- M28 commit: `3e4a14f` — https://github.com/ebinj-dev/Bean-FX/commit/3e4a14faf48f03d3724d1e55bb125bd475f7cd08
- Verified in a fresh authenticated clone: remote tip `3e4a14f`, M27 `01286f5` IS an ancestor, `m28-evidence/` (6 files) + all three docs present in the remote tree; main `fb051dd` unchanged by this work (before and after).
