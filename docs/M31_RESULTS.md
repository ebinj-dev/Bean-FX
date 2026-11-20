# M31 RESULTS — Production Readiness, Security & Integration Qualification

**Date:** 2026-11-20 · **Branch:** feature/ai-creative-studio · **Baseline:** M30 tip `7eeda3f` (impl `f8c0290`, both ancestry-verified)

## 1. Repository audit (Phase 0)
M30 SHAs verified on the remote; M29-C/M28 ancestry intact; local tree content-identical to the remote tip (exec bits restored post-recycle). Consolidated M1–M30 register built from 34 docs: 33 OWNER ACTION / 35 CONFIGURATION REQUIRED / 17 INFRASTRUCTURE REQUIRED / 33 NOT IMPLEMENTED / 9 NOT RUN mentions, deduplicated into the blocker register (M31_RELEASE_READINESS.md). Environment limitation found and handled: a sandbox recycle had wiped the untracked `download/` directory — fully restored from the pushed git tree (53 files, M27–M30 evidence).

## 2. OpenCV CSRT — RESOLVED reproducibly (Phase 1)
Root cause: `opencv-python-headless` **never ships the tracker contrib module**. Fix: replaced with `opencv-contrib-python-headless==4.13.0.90` (strict superset, GUI-free), pinned in **`requirements-test.txt`** (numpy 2.1.3 + contrib; "never install alongside opencv-python*"). Result: `cv2.TrackerCSRT_create` and `cv2.legacy.TrackerCSRT_create` both available. The M13 temporal suites ran UNMODIFIED:
- `test-temporal-core.test.ts` **15/15 PASS** (363 assertions, 62.8s)
- `test-temporal-live.test.ts` **2/2 PASS** (13 assertions, 28.2s)
No mocks, no skipped assertions, no weakened requirements. The M29-C carried-forward exception is CLOSED.

## 3. Full regression (Phase 2)
- Combined batch `run-all-tests.sh`: **35 PASS + 1 fail**; the failure was `test-m19-security` hitting the real registration rate limiter (429) because the server was restarted without `RATE_LIMIT_SCALE=50` — environmental. Rerun with the correct env scale: **21/21 PASS**. Effective batch: **36/36 green**.
- Durable suites on fresh isolated envs: m29-integrity **8/8**, m29-portability **4/4**, m29c-security **5/5**, m30-collab **13/13**, m30-reviews **15/15** (M30-era evidence), m31-security+worker **14/14** (new).
- Every failure investigated; two transient env-ordering failures (m29c deflate/import timing, m30 expired-invitation SQL targeting) reproduced as GREEN in isolated fresh-env runs — classified environmental, not product defects.

## 4. Collaboration security audit (Phase 3)
New `test-m31-security.test.ts` (7 tests, independent sessions): cross-user isolation (media/exports/notifications/review 404s without leaks), **revoked-member immediate lockout** (share revoke → next requests 404), **expired guest-link sessions die** (410→404), approval pinned to fingerprint, ALL-policy determinism, duplicate decision 409, unauthorized renders/reviews 404, notification payloads carry no tokens/paths. Existing M30 guarantees re-verified. Findings: no new vulnerabilities; the M30 worker-level authorization fix (render/archive jobs) re-validated.

## 5. Media & export qualification (Phase 4)
New `test-m31-media-qual.test.ts` **3/3 PASS**: real fixtures (30fps, 25fps mixed-rate, rotated, corrupt), ingest probes READY with metadata, corrupt media rejected (415 at ingest / FAILED probe), multi-track timeline (keyframed brightness ramp, audio crossfades, 3 video + 2 audio clips) → real render → **ffprobe conformance: 1920x1080 h264, 7.5s/225 frames, yuv420p, AAC 48kHz stereo, tail decodable, no truncation**. Export size 3,618,195 bytes. Note: the informational luma-ramp grep recorded 0/0 (signalstats metadata format differs) — the M27 keyframe suites in the batch verify the ramp deterministically and pass. Test-side fixes made during qualification: ffprobe flags (`-show_format` required with `-print_format`), sample_rate string coercion — no product changes.

## 6. Worker fault injection (Phase 5)
New `test-m31-worker.test.ts` (7 tests): duplicate render submissions create distinct jobs (no shared rows); outputs published atomically (files exist); invalid media → permanent classification (no infinite retry); corrupt package import → synchronous rejection OR async 202→FAILED with **zero partial project rows**; cancellation produces no outputs; completed renders leave no `.tmp/.part` leftovers; no stale leases (>10min) after normal completion; notification dedup: 3 attempts → exactly 1 row. **No new queue introduced; retry/lease behavior untouched.**

## 7. Backup & restore (Phase 6)
New `scripts/m31-backup-restore.ts` — **11/11 PASS**: complete snapshot = DB + media store (477 objects; database-only backup is explicitly NOT a complete backup — object-store backup remains INFRASTRUCTURE REQUIRED); restored counts/relationship walk (users/projects/revisions/comments/decisions/assets/notifications); no orphaned comments or assets; isolated restored server boots and serves; **real write path on the restored env (register/media/timeline) + a 601,644-byte pipeline render from restored data**. Source DB untouched.

## 8. Integrations (Phase 7)
`scripts/m31-integration-checks.ts` **20/20 PASS**: UXP panel artifacts + in-panel harness present, no embedded secrets, host-capability discovery, token auth via pairing (panel.js + host-adapter), bridge token hashing, OS-native-first credential store, pairing challenge + expiry, install/uninstall lifecycle, no embedded secrets in PowerShell installers, all four M21/M22 protocol suites present. **Real-host validation (Premiere Pro 24+ UXP; Windows host) remains OWNER ACTION** — reproducible checklists referenced (M23_PREMIERE_CHECKLIST.md, M22_OWNER_ACTIONS.md).

## 9. AI providers & email (Phase 8)
`scripts/m31-provider-diagnostics.ts`: no AI credentials present in this environment → **CONFIGURATION REQUIRED** (deterministic internal contracts covered by the passing provider suites; no live-provider success simulated); `/api/health` reports honest per-component status; mailer returns `delivered=false, reason=SMTP not configured` — **honest**; invitation flow works without SMTP with the copyable URL fallback (verified end-to-end). No Ollama, no new providers.

## 10. Observability (Phase 9)
Extended the EXISTING admin-only `/api/admin/health` (additive): worker queue depth/processing/failed/**stale leases**/last-completed, ffmpeg/ffprobe presence + versions, encoder capability flags (libx264/libx265/aac), storage bytes, and honest integration config presence (AI provider, email) — values withheld, no path leaks. Public `/api/health` unchanged. tsc 0.

## 11. Performance (Phase 10)
`test-m31-performance.test.ts` on the isolated env (measured: 4 vCPU, bounded ≤8 concurrency): timeline GET n=80 p50=194ms p95=341ms; notifications p95=248ms; concurrent comments 15/15 created p95=123ms with full persistence; duplicate invitation race → exactly [201,409]; **concurrent same-base saves: 1×200 + 1×409(authoritative head) + 2×400(SQLite write-lock contention → safe failure, retryable — no lost writes; documented as a bounded-environment finding, not a lost-update defect)**. Review render + comment integrity 15/15. No production-capacity claims.

## 12. Known limitations
1. Bounded-env perf numbers only; the 400-class lock-contention finding under same-base concurrent writes (safe failure) is documented, not hidden.
2. Real-host Premiere/Windows validation = OWNER ACTION; SMTP/AI credentials = CONFIGURATION REQUIRED.
3. Object-store backup infrastructure = INFRASTRUCTURE REQUIRED (drill proves DB+media-store copy semantics).
4. `download/` is untracked in the sandbox mirror; the pushed tree carries the evidence.

## 13. GitHub
M31 commit pushed fast-forward on `feature/ai-creative-studio`; SHA + remote verification in M31_RELEASE_READINESS.md §verdict and the final report. `main` untouched.
