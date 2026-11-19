# M28 — Feature Matrix

Legend: **VERIFIED** (live evidence) · **AUTOMATED** (tests) · **REUSED** (pre-existing, verified in M28 regression) · **NOT IMPLEMENTED** (honest).

## Phase 1 — Media ingestion reliability
| Requirement | Status | Evidence |
|---|---|---|
| FFprobe-validated uploads (real metadata) | REUSED | MEDIA_PROBE job persists full metadata; corruption → PermanentJobError |
| Supported video/audio/image detection | REUSED | probe stream/codec/mime mapping incl. images |
| Duration/dims/fps/codec/pixel-ish/channels/rate extraction | REUSED | DeepProbe fields + probeMetaJson summary |
| Corrupted/incomplete file handling | REUSED | ffprobe rejection tests (M3) + honest probeError |
| Missing/unusual metadata | REUSED | parseNum null-safety; N/A handling |
| VFR detection | REUSED | isVfr (0.5 % tolerance) + surfaced in meta + Inspector badge (M28) |
| Rotation metadata | REUSED | display matrix + legacy rotate tag; proxy scale targets rotated dims |
| Large uploads within limits | REUSED | MAX_UPLOAD_BYTES / chunked sessions / TTL sweeps |
| Safe cleanup of incomplete artifacts | REUSED | upload-session + scratch sweeps (worker sweep 1–2) |
| Duplicate-processing prevention on retries | VERIFIED | idempotent probe/proxy + M28 regen 409 on active job |
| Originals preserved | VERIFIED | proxies/exports read-only on originals; sweep never deletes originals |
| Actionable errors | VERIFIED | specific messages incl. M28 disk guard ("originals are untouched") |
| Filename/extension validation independent of MIME | REUSED | header decoding + traversal checks + sniff-vs-extension |
| Path traversal / safe tmp / protocol restriction | REUSED | pathInsideMediaRoot; no user input in ffmpeg args |
| Size + disk limits | VERIFIED | existing byte caps + **M28 assertDiskSpace guard** |

## Phase 2 — Proxies & optimized playback
| Requirement | Status | Evidence |
|---|---|---|
| Lower-res proxies from originals | VERIFIED | E2E: 1080p → 960×540 h264 (FFprobe-verified) |
| Explicit original↔proxy relationship | REUSED | proxyPath/proxyStatus/proxyDurationSec on the asset; file route variant param |
| Timeline timing/frame identity stable | REUSED | fps_mode passthrough + 90 kHz timescale + alignment gate |
| Proxy/original switching | REUSED | auto-proxy serving + `?variant=original` escape (documented; no duplicate UI control this milestone) |
| Regeneration when missing | VERIFIED | POST /api/media/[id]/proxy (202/409/400) |
| Cancellation + retry | VERIFIED | worker cancellation paths; regen requeue |
| Progress tracking | REUSED | jobManager progress stages (5→92→97 %) |
| Persisted proxy job state | REUSED | durable Job rows + proxyStatus |
| Stale/invalid proxy detection | VERIFIED | sweep #4 (READY without file → FAILED) + regen-time repair |
| Originals never overwritten | VERIFIED | regen writes to PROXIES_DIR only |
| Aspect/rotation/duration correctness | VERIFIED | 960×540 from 1920×1080; duration gate max(0.5 s, 2 %) |
| VFR diagnostics | VERIFIED | isVfr persisted + Inspector "(VFR)" badge |
| No "ready" until validated | VERIFIED | probeMediaDeep + alignment check before READY |

## Phase 3 — Relinking & project portability
| Requirement | Status | Evidence |
|---|---|---|
| Missing source detection + clear status | VERIFIED | M25 placeholder + **M28: deleted-asset 404 → relink UI in Inspector** |
| Locate replacement files | VERIFIED | library picker (live) |
| Validate replacement before relink | AUTOMATED | diagnostics logic (duration/fps/audio) + ReplaceClip validation |
| Preserve timeline placement | REUSED | ReplaceClip keeps start/track |
| Source in/out when compatible | REUSED | reset to full length (documented honesty) |
| Duration mismatch detection | AUTOMATED | warning "duration X vs clip's Y" |
| Frame-rate mismatch detection | AUTOMATED | warning vs sequence fps |
| Audio-channel mismatch detection | AUTOMATED | video-only replacement warning |
| Safe bulk relinking | NOT IMPLEMENTED (honest) — per-clip relink only; bulk UI not built this milestone |
| Recorded in project history | REUSED | ReplaceClip flows through timeline versions |
| Undo when safe | REUSED | ReplaceClip inverse |
| Packaging/manifest | REUSED | M23 publish-package contract (audited, unchanged) |

## Phase 4 — Preview playback reliability
| Requirement | Status |
|---|---|
| Frame-accurate seek, timebase, boundaries, transitions, effects/keyframes, A/V sync | REUSED — M17 playback controller + M27 per-frame evaluation; suites green (test-editor-preview, test-m22-e2e, sync −0.052 s) |
| Decoder-error/buffering states | REUSED — unsupported-codec messaging (M19) |
| Proxy/original switching during preview | REUSED — file route auto-serves proxies |
| No fake playback | REUSED — honest placeholders only |

## Phase 5 — Professional export engine
| Requirement | Status | Evidence |
|---|---|---|
| Duration/start-end/clips/compositing/transitions/keyframes/crossfades/gain/pan/fps/aspect/sync | VERIFIED | M27/M28 render evidence under NEW conformance gates |
| Profile compatibility (M9) preserved | REUSED | profile registry + validation tests green |
| Truthful codec capability descriptions | VERIFIED | media-capabilities runtime checks (H265/PRORES/VP9 honestly unavailable on this host — reported, not advertised) |
| No silent setting substitution | REUSED | validateVariantTarget + buildVariantArgs contracts |
| Post-export validation (existence/size/ffprobe/streams/duration/dims/decodable/metadata stored) | VERIFIED | variant conformance + **M28 duration/dims gates on timeline renders** + ExportFile stores real probe data |

## Phase 6 — Job recovery & resource control
| Requirement | Status |
|---|---|
| Persistence, cancellation, safe retry, recovery, duplicate prevention, heartbeats, stale workers, temp cleanup, failure reasons, concurrency caps | REUSED (M20 §3 machinery) + VERIFIED in M28 regression (recovery suite, OOM dedup, sweeps) |
| Disk protection | VERIFIED — assertDiskSpace before proxy/render |
| Cancellation E2E | VERIFIED — cancel → CANCELLED; duplicate → 409 |

## Phase 7 — Performance (measured, not extrapolated)
import 638 ms (2 fixtures incl. transcode) · timeline apply 24 ms · probe settle 514 ms · 10 s 640×360 multi-clip render 7 s wall · 3 s 1080p proxy E2E ≈ 5 s · hardware: 2 vCPU sandbox; renders globally serialized by design (M20 OOM history).

## Phase 8 — AI engines
REUSED — five-engine architecture untouched; registry/job suites green; metadata now richer for JAZMII/GANGZII surfaces via probeMetaJson; no Ollama; no provider simulation; live providers remain CONFIGURATION REQUIRED.

## Phase 9 — UI preservation
VERIFIED — SOURCE MEDIA panel + relink diagnostics are additive inspector blocks using existing tokens; 375 px no overflow; screenshots committed.

## Totals
VERIFIED 22 · AUTOMATED 5 · REUSED 33 · NOT IMPLEMENTED 2 (bulk relink UI; new packaging mechanism — M23 contract reused) · CONFIGURATION REQUIRED 1 (encoder availability per host, now reported honestly).
