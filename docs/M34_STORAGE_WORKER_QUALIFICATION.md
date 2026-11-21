# M34 — Media Storage & Render-Worker Qualification (Track D)

**Date:** 2026-11-21 · The durable Job contract (M20: claim + heartbeat + stale-claim sweep + orphan-ffmpeg kill) remains the single authoritative queue — M34 adds no second pipeline.

## 1. Media storage lifecycle (D1 — audited)

| Class | Location | Owner | Cleanup / retention |
|---|---|---|---|
| Original uploads | `DATA_DIR/originals/<user>/…` | per-user media asset | **never auto-deleted** (source footage protection); deleted only by explicit user asset deletion (M28 lifecycle) |
| Proxies | `DATA_DIR/proxies/` | derived from originals | regenerable; existing-proxy check makes recovery re-runs safe (M20 contract) |
| Generated assets | `originals/` (registered as MediaAssets with provider provenance) | per-user | same as originals |
| Masks | `originals/` (MediaMask rows point at stored PNG) | per-user | deleted with the asset; packaged into project archives since M33 |
| Render intermediates | `DATA_DIR/tmp/` (`seg_*`, `list_*`) | render worker | removed by the worker at render completion (M20 T1 asserts zero leftovers); orphaned by crashed renders only until the recovery sweep's orphan kill + retry |
| Export files | `DATA_DIR/exports/` | ExportFile row + per-user quota | user-managed; quota counts them |
| Project packages | `DATA_DIR/exports/` (`.beanfx` zips) | ProjectArchive rows | downloadable; sha256-verified manifests (assets AND masks) |
| Failed job artifacts | `DATA_DIR/tmp/` intermediates | worker | cleaned: verified by the M34 R2 scenario (zero `seg_*`/`list_*` after a missing-media failure); failed exports are never published (zero ExportFile rows — verified) |

Preflight guards the root: refuses an empty `BEANFX_DATA_DIR` or a filesystem root, verifies writability of all four lanes, and checks free disk (WARNING < 2 GB, BLOCKED < 500 MB).

## 2. Storage protection (D2 — verified)

- Upload limits: 250 MB single-shot / 2 GB chunked / 5 GB per-user quota — constants asserted by `test-m34-storage-worker.test.ts` R4.
- Path traversal: `isInsideMediaRoot` (symlink-aware) guards every storage path; archive extraction caps (800 entries, unpacked byte cap) with checksum verification (M29/M33, regression-tested).
- Atomic publish: archive + export publish via same-filesystem `rename`.
- Incomplete uploads: chunked-upload assembly rejects missing chunks; nothing partial becomes an asset (M3 suites).
- Safe temp paths: all intermediates under `DATA_DIR/tmp`, worker-owned.

## 3. Render-worker recovery (D3 — VERIFIED by test)

New coverage (`scripts/test-m34-storage-worker.test.ts`, real server :3129, scratch DB + dedicated data dir — **6/6 pass**, log `m34-sw-results.log`):

| Scenario | Result |
|---|---|
| R1 invalid media (text bytes named `.mp4`) | honest refusal / unusable asset — never a fake success |
| R2 missing source media at render time | job FAILED with a recorded honest message; **zero** partial exports published; tmp intermediates cleaned (no `seg_*`/`list_*` anywhere) |
| R3 retry after failure | COMPLETED; export ffprobe-validated (duration > 1.5 s); file present on disk |
| R4 quota/upload constants | 250 MB / 2 GB / 5 GB verified; originals preserved (content-addressed dedupe observed: byte-identical fixtures share one stored original) |
| R5 lifecycle layout | originals/proxies/exports/tmp present; nothing at the storage root itself |

Pre-existing M20 resilience coverage re-verified in this milestone (§4): server SIGKILL mid-render recovery (T4), OOM-killed job FAILED-not-requeued by the recovery sweep (T5), cancellation mid-render (T6), duplicate submission (T7). Database disconnection is not a scenario for the embedded profile (SQLite is local; the equivalent — a held exclusive lock — is covered by the migration-safety lock test, which also proved retry-after-release recovery).

## 4. Durable-render suite + resource qualification (D4)

`test-m20-durable-render.test.ts` re-run against a live :3117 server on the isolated fixture DB — see the regression report for the recorded result. The suite records per-render peak RSS (its T1–T3 long renders exercise the windowed pipeline).

**4 GB sandbox constraint (documented, not hidden):** this milestone again observed the OOM envelope — during the Track A clean-checkout qualification, a 720×1280 render was SIGKILLed by the kernel while a stray second server was still resident; the worker honestly recorded `encoder killed by the system (SIGKILL) — most likely out of memory` and FAILED the job (M20 T5 contract operating as designed). On an otherwise-idle machine the identical workflow passed (6/6, 66 s). **No hardware-scale performance claims are made from this sandbox**; a ≥8 GB host is the stated infrastructure requirement for the T2/T3 long-form renders and for production use.

## 5. Operational limits (measured)

- Concurrent render jobs: 1 (global serialization — the M20 OOM guard).
- Worker peak memory: recorded per render; long-form multi-window renders must fit the sandbox or fail honestly (never corrupt).
- Job recovery: stale-claim requeue/fail + orphan kill + safe re-run (proxy idempotence) — M20 contract, exercised.
- No silent corruption path observed in any scenario: every failure surfaced as an honest job status with a message, and every success produced an ffprobe-validated artifact.
