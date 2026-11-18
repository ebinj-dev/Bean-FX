# M7 — JAZMII (Video Creative) + LAXII (Image Creative)

Milestone goal: *"Two independent but interoperable creative engines inside BEAN FX — AI-assisted B-roll, video analysis and generation (JAZMII) and provider-backed image generation, backgrounds, illustrations, thumbnails (LAXII) — sharing the existing media infrastructure, integrated with the professional timeline and MY AI."* This document describes what SHIPPED, verified by the suites named in §11.

## 1. Architecture

```
JAZMII panel / LAXII panel / MY AI router
   │  validated payloads (zod)             │ proposals only — approval-gated
   ▼                                       ▼
/api/jazmii/{generate,analyze,proposal}   /api/laxii/generate   /api/ai/{route,outputs}
   │ durable jobs (JAZMII_GENERATE / JAZMII_ANALYZE / LAXII_GENERATE on the M3 worker)
   ▼
src/lib/jazmii/{providers,analysis,shots,jobs}   src/lib/laxii/{providers,processing,jobs}
   │ one provider contract per engine (§5) — adapters invoke the configured
   │ z-ai CLI server-side (credentials never leave the server)
   ▼
src/lib/ai/asset-lifecycle.ts  — THE shared asset pipeline (both engines):
sniff → validate (PIL/ffprobe) → quota → relocate into MEDIA_ROOT → sha256
→ MediaAsset row with full provenance (createdBy/provider/model/prompt/
params/license/attribution/referenceAssetId)
   ▼
Timeline integration via M1 commands only (AddClip/TrimClip/…, undo/redo/autosave native)
```

No duplicate job queues, no duplicate media libraries, no Ollama.

## 2. Provider contracts (§5)

**JAZMII — `zai-video`** (the configured z-ai video service, model **cogvideox-3**, verified live end-to-end):
- Operations: text-to-video, image-to-video (reference image, ownership-checked).
- Parameters: quality `speed|quality`; size `1920x1080|1280x720|1080x1920|720x1280`; fps `30|60`; duration `5|10 s`; optional AI audio.
- Invocation: `z-ai video …` → task id → `z-ai async-result --id` polling (real SUCCESS shape `video_result[0].url` — the adapter reads exactly that shape and tolerates alternatives).
- Authentication: environment-configured CLI (server-side); missing binary → `NOT_CONFIGURED` with an actionable message; 401/403 → `AUTH_FAILED`; 429 → `RATE_LIMITED`.
- Commercial use / retention / pricing: recorded as configurable metadata strings explicitly marked **"NOT independently verified"** — no invented licensing claims. `license: provider-terms`, attribution string recorded per asset.

**LAXII — `zai-image` / image-edit** (verified live, 41 s generation):
- Operations: text-to-image; image-to-image via `z-ai image-edit` (owned reference).
- Sizes (the provider's REAL list): `1024x1024, 768x1344, 864x1152, 1344x768, 1152x864, 1440x720, 720x1440`.
- **Explicit unsupported** (in the capability map, enforced in UI): transparent-background output (the provider returns JPEG bytes even for .png requests — caught in the live probe and asserted by tests), negative prompts, seeds.
- Same typed errors and honesty metadata as JAZMII.

Neither engine silently switches providers; selection is via `BEANFX_JAZMII_PROVIDER` / `BEANFX_LAXII_PROVIDER` with an honest error for unknown ids.

## 3. JAZMII capabilities actually implemented

- **Generation jobs** (§6A): durable `JAZMII_GENERATE` — provider task → bounded poll (10 s interval, heartbeat via setProgress, cancellation honored each poll, 15 min wall-clock timeout, ±2.5 s duration tolerance + aspect-class validation of the download) → download (500 MB cap) → sniff/ffprobe validation → registration with provenance → `complete` with the asset id. Queued/running/succeeded/failed/cancelled/timed-out states all handled; a job is never "complete" before the output is a registered asset.
- **B-roll workflow** (§6B): deterministic shot suggestions from REAL project context (captions/labels) — keyword→shot-type rules, subject extraction, per-shot prompt, duration in frames, provider hint, **confidence stays null** (no fake scores); suggestions are proposals only; approval generates via the normal job; insertion is an M1 `AddClip`.
- **Analysis** (§6C): `JAZMII_ANALYZE` — ffprobe metadata; scene boundaries via the ffmpeg scene-score filter (labeled `analysisMethod: "ffmpeg-heuristic"`, never "AI"); blackdetect; freezedetect (parser tolerates both output formats + EOF-open freezes); ≤8 evenly-spaced keyframes registered as IMAGE assets with parent provenance; per-scene 64-bit aHash (deterministic perceptual hashing — honestly named, not "AI understanding"). Verified against the REAL cogvideox-3 artifact (1920×1080 h264 5.19 s) and a labeled synthetic fixture with black+freeze segments.
- **Sourcing** (§6D): no external sourcing provider is configured — the feature is honestly absent (no scraping, no fakes). Import happens through the existing upload pipeline.

## 4. LAXII capabilities actually implemented

- **Generation** (§7A): text-to-image and image-to-image with size selection from the REAL list; 1–4 alternatives (sequential provider calls, each registered); outputs validated by CONTENT (sniff + PIL decode + size assertion) — the provider's declared format is never trusted.
- **Workflows** (§7B): backgrounds/illustrations/thumbnails via prompt presets in the router (thumbnail → 16:9-adapted child + explicit guidance to add text with NIIKI rather than burning it in); variations preserve the original and register `referenceAssetId` relationships.
- **Processing** (§7C): PIL-backed, non-destructive — aspect adaptation (cover-crop to 16:9 / 9:16 / 1:1 / 4:5 as a NEW child asset), 480 px thumbnails, transparency preservation verified (RGBA stays RGBA), dimension inspection.
- **Records** (§7D): prompt, params (size/count/aspect/sniffed format), provider/model, source references, output dims/format, status, provenance and attribution persisted on the MediaAsset rows.

## 5. Shared asset lifecycle (§8) — evidence

Every output becomes a normal MediaAsset: content-sniffed (`sniffMatchesClass`), engine-validated (PIL decode / ffprobe + duration tolerance), quota-checked (`hasQuotaFor` — same policy as uploads), **relocated into `MEDIA_ROOT/<engine>-outputs/u_<userId>/`** (provider /tmp files are never referenced), sha256-recorded, registered with provenance, and never orphaned (failed registrations delete the file — asserted by test). Derivatives (thumbnails/adaptations/keyframes) carry `referenceAssetId` parent links. Storage paths are always produced by `pathInsideMediaRoot` (no traversal).

## 6. Timeline integration (§9)

- JAZMII video inserts as a VIDEO-track clip via `AddClip` (source fps from the asset probe; label carries provenance) — trim/split/move/delete/undo/redo/reload all native (tests).
- LAXII stills insert as clips on VIDEO or GRAPHIC tracks (5 s default duration, editable via `TrimClip` — tests); IMAGE assets already render as stills in the program monitor (M3 stabilization); NIIKI animates position/scale/rotation/opacity on image clips via the standard keyframe model (compatibility asserted by tests).
- A/V sync: the generation duration tolerance keeps registered assets within the requested window; the analysis report carries exact fps/duration for insertion math.

## 7. MY AI (§10)

`src/lib/ai/registry.ts` — deterministic routing across **all five engines** (RIISHE, GANGZII, NIIKI, JAZMII, LAXII; the three M4–M6 engines keep their own typed proposals and remain reachable through the registry). Generation intents produce **approval-gated proposals** (`generationRequests` with availability + honest unavailability reasons) — the router NEVER executes; jobs start only via the engine routes after explicit approval. `POST /api/ai/route` (typed envelope, zod), `GET /api/ai/outputs?engine=…` (owner-scoped provenance history). No LLM dependency; M8 will orchestrate on these descriptors.

## 8. UI (§11)

`jazmii-panel.tsx` / `laxii-panel.tsx` in the editor sidebar (existing design system, no navigation redesign): prompt input; option controls generated from the REAL capability maps (JAZMII: quality/size/fps/duration/audio; LAXII: mode/7 sizes/1–4×/aspect/reference picker); shot suggestions with approve-and-generate per item; live job status (real worker progress — the provider supplies task state, never simulated percentages); failure details; generated-asset history with provenance and INSERT actions through M1 commands. Provider notes (no transparency/negative prompts; external processing happens only on GENERATE) are shown in the panel.

## 9. Security, privacy, cost (§12/§13)

- Credentials stay in the server-side CLI environment; nothing reaches the browser; no hardcoded keys.
- Every route: session auth + zod validation + ownership checks (reference assets must be owned by the caller — tested cross-user).
- Private media is NOT sent anywhere without an explicit user action (generation is the only external call; the panel states this).
- Rate limits: per-user concurrency (1 active job per engine type, route + worker enforced — tested 429 path), worker global cap 2.
- Failure handling: typed provider errors, bounded retries (30 s × 2^n backoff, permanent vs retryable classified), cancellation, timeouts (20/10/15 min per type), stale-claim recovery — all on the M3 worker (no new queue).
- Cost/storage: each image ≈ 170 KB–2 MB + a ≤480 px thumbnail; each video ≈ 2–15 MB; quota default 5 GB/user (`BEANFX_USER_QUOTA_BYTES`); generation is metered by the provider account (request ids recorded in `paramsJson`). **No capacity claims beyond what is measured** — this sandbox ran one real generation at a time.

## 10. Configuration (names only — no secrets)

`BEANFX_ZAI_BIN` (provider CLI path), `BEANFX_JAZMII_PROVIDER` / `BEANFX_LAXII_PROVIDER` (registry keys), `BEANFX_JAZMII_CLI_TIMEOUT_MS`, `BEANFX_LAXII_CLI_TIMEOUT_MS`, `BEANFX_JAZMII_GENERATE_TIMEOUT_MS`, `BEANFX_JAZMII_SCENE_THRESHOLD`, `BEANFX_JAZMII_LICENSE_NOTE`, `BEANFX_JAZMII_RETENTION_NOTE`, `BEANFX_LAXII_LICENSE_NOTE`, `BEANFX_LAXII_RETENTION_NOTE`, `BEANFX_USER_QUOTA_BYTES` (pre-existing). Provider credentials themselves live inside the configured CLI environment — never in the repo or these variables.

## 11. Tests and ACTUAL results (executed this session)

| Suite | Result |
|---|---|
| `test-jazmii.test.ts` — provider contract, NOT_CONFIGURED/AUTH/UNSUPPORTED, job lifecycle (fixture), sniff rejection + no-orphan, FAIL state, cross-user reference refusal, REAL cogvideox-3 artifact analysis, black/freeze detection on synthetic fixture, keyframe registration, shot suggestions (deterministic, null confidence), timeline insert + undo/redo/reload, A/V tolerance | **15/15** |
| `test-laxii.test.ts` — contract + honest unsupported, NOT_CONFIGURED/AUTH/UNSUPPORTED, content-not-claims validation, lifecycle + provenance + thumbnail/aspect children, variants, cross-user refusal, quota, transparency preservation, non-destructive adaptation, timeline still insert + TrimClip + NIIKI keyframe compat, **REAL provider end-to-end (run with `BEANFX_M7_REAL_PROVIDER=1`: 14/14 incl. real generation, pixel-asserted)** | **14/14** |
| `test-ai-registry.test.ts` — routing across engines, approval gating, job→asset lifecycle via the real worker, cross-user isolation, retry/backoff recovery, quotas, provenance distinguishability | **12/12** |
| M1–M6 regressions + full matrix via `scripts/run-all-tests.sh` | **14 suites, 0 failures** |

Fixture vs real: provider-adapter behavior is exercised through the labeled `scripts/fixtures/fake-zai.sh` FIXTURE (deterministic, clearly marked "NOT a real provider" in the file and test names); real AI-generation evidence: LAXII live generation through the full pipeline (1024×1024, pixel variance asserted) and the JAZMII live probe artifact (task→poll→download→ffprobe 1920×1080 5.19 s) analyzed by the suite.

## 12. Migrations

`prisma/schema.prisma` — additive columns on MediaAsset (NULL-backfilled): `createdBy, provider, model, prompt, paramsJson, license, attribution, referenceAssetId` + two indexes. Applied with `prisma db push` (SQLite dev, 17 ms); Postgres-compatible DDL (additive nullable columns). No data loss; no existing field changed.

## 13. Known limitations (honest)

- One provider family per engine (z-ai service) is configured; the registry supports more adapters but none are configured — UI/options reflect only what exists.
- JAZMII generation latency is minutes-scale (cogvideox-3); jobs poll at 10 s and bound at 15 min — long generations exceed the timeout honestly ("its result was NOT registered").
- No video sourcing (no permitted provider configured) — feature absent rather than faked.
- Scene detection is heuristic (ffmpeg), aHash similarity is deterministic hashing — neither is claimed as AI.
- JAZMII image-to-video passes the reference as a local file path through the CLI adapter; provider-side URL upload is not exercised in this environment.
- The REAL-provider suites require `BEANFX_M7_REAL_PROVIDER=1` and cost metered provider calls; CI runs fixture-only by default.
- `/tmp` stale `laxii-out-*` files from failed pre-registration attempts are cleaned by OS tmp hygiene, not BEAN FX (registered outputs always live in MEDIA_ROOT).

## 14. Future work (not M8)

Provider adapters over HTTP SDKs (finer progress), video-sourcing integration under a licensing contract, ffmpeg-based transient/transparent overlay renders for LAXII backgrounds inside NIIKI, per-provider accounting dashboards.
