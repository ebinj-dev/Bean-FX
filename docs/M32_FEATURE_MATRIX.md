# M32 FEATURE MATRIX — every requested feature, honest status

Legend per the milestone: VERIFIED · AUTOMATED · SIMULATED · CONFIGURATION REQUIRED · OWNER ACTION · INFRASTRUCTURE REQUIRED · NOT RUN · NOT IMPLEMENTED.

## Track A — JAZMII/LAXII real video-provider readiness

| Feature | Status | Files | Evidence |
|---|---|---|---|
| A1 typed capability registry (video+image, undocumented = honestly listed) | AUTOMATED | `src/lib/providers/readiness.ts` | `test-m32-providers.test.ts` (registry-truth assertions) |
| A1 reference-video conditioning / negative prompt / seed — absent, stated | AUTOMATED | same | `unsupported[]` asserted |
| A2 adapter contract (validate→submit→poll→cancel→result→validate→errors) | AUTOMATED (fixture adapter) | `src/lib/jazmii/{providers,jobs}.ts` (existing) | fixture lifecycle test |
| A3 readiness statuses (7-state model) + REAL probe (weak probe fixed) | AUTOMATED | readiness.ts, `src/lib/jazmii/jobs.ts` | unconfigured-env test → CONFIGURATION_REQUIRED both engines |
| A3 no secrets in UI/logs/tests | AUTOMATED | readiness.ts (safe detail only) | grep + suite |
| A4 cost UNKNOWN unless authoritative; approval+budget gates | AUTOMATED | readiness.ts, generation-router.ts | gates regression-tested; no live paid calls (OWNER ACTION) |
| A5 idempotency protection / duplicate-submission prevention | AUTOMATED | generation-router.ts, schema (`idempotencyKey`) | same-key test returns existing job; no new job row |
| A5 resumable submission (retry never creates a 2nd paid task) | AUTOMATED | `src/lib/jazmii/jobs.ts` (providerTaskId persisted pre-poll) | resume-path in handler + review |
| A5 bounded retries + exponential backoff + rate-limit handling | AUTOMATED | job-helpers.ts (permanent/transient split) | AUTH_FAILED fails immediately; RATE_LIMITED requeues with runAfter |
| A5 cancellation + reconciliation | AUTOMATED | job-runner.ts (existing) + syncGenerationAssets | cancel→asset FAILED test, no fabricated output |
| A5 timeout handling / expired-job recovery | AUTOMATED (timeout exit is honest FAILED; stale-claim recovery inherited) | job-runner.ts | inherited + classification tests |
| A6 output verification (sniff/ffprobe/sha256/quota) | AUTOMATED (inherited, fixture-exercised) | asset-lifecycle.ts | validation in registration path |
| Real-provider live execution | CONFIGURATION REQUIRED / OWNER ACTION | — | no credentials+spend authorization this milestone (by mandate) |

## Track B — multi-format campaign production

| Feature | Status | Files | Evidence |
|---|---|---|---|
| B1 master preservation (immutable unless re-approved) | AUTOMATED | variants.ts (byte-compare + quarantine) | immutability assertions |
| B1 variant records (source rev, approvals history link, format, resolution, fps, duration, framing, overrides, render id, export status) | AUTOMATED | schema `ProductionVariant`, variants.ts | suite |
| B2 focal-guided reframing + clamping + crop-loss | AUTOMATED | variants.ts `computeReframe` | math tests |
| B2 manual focal override per variant/scene | AUTOMATED | PATCH route + re-derive | focal strategy test |
| B2 honest center fallback (never labeled AI) | AUTOMATED | same | strategy="center" assertion |
| B3 generic safe-area validation + text overflow + caption warnings | AUTOMATED | variants.ts `validateSafeAreas` | tests (explicit not-a-platform-spec) |
| B4 timing preservation (identical frame positions) | AUTOMATED | deriveVariant | frame-position assertions |
| B5 native editable output (canonical commands only) | AUTOMATED | applyTimelineEdits path | target-dims + transform assertions |
| B6 individual + batch render on existing jobs; export aspect validation | AUTOMATED (render path) / NOT RUN (triple-format live render — needs completed master in live suite; see RESULTS §4) | variants route + syncVariantRenders | unit-verified logic |

## Track C — real mask-based subject isolation & compositing

| Feature | Status | Files | Evidence |
|---|---|---|---|
| C1 mask data model (versions, provenance, validation, temporal metadata, portable storage) | AUTOMATED | schema `MediaMask`, masks.ts | suite |
| C2 manual path (import→validate→scale→version chain) | AUTOMATED | masks.ts `importManualMask` | validation tests |
| C2 automatic segmentation | CONFIGURATION REQUIRED | AUTO_SEGMENTATION_STATUS | surfaced in API+UI; never faked |
| C3 invert / feather / refine / scale ops (real PIL) | AUTOMATED | masks.ts `processMask` | statistics/dims assertions |
| C3 invalid-mask detection (all-opaque/all-transparent/corrupt) | AUTOMATED | validateMaskFile | rejection tests |
| C4 frame compositing (pixel-verified) | AUTOMATED | masks.ts `compositeFrame` | pixel assertions (amber subject / blue bg) |
| C4 video compositing (FFmpeg alphamerge+overlay, ffprobe-verified) | AUTOMATED | masks.ts `compositeVideo` | mid-frame pixel test + provenance |
| C5 fallbacks (size/duration mismatch, corrupt, missing) preserving originals | AUTOMATED | masks.ts | DURATION_MISMATCH / MASK_SIZE_MISMATCH tests |
| Timeline integration via canonical commands (composites are ordinary MediaAssets) | AUTOMATED | registration path | provenance assertions |

## Track D — reliability & regression coverage (28 scenarios)

Scenarios 1–5 (product understanding/SSRF/screenshots/demo) and 6–8 (concepts/storyboard/approved-scene rejection): covered by `test-showcase-core` + `test-showcase-live` re-run on the M32 build → **10/10**. 9–15 (provider config failure/rate limit/timeout/cancellation/duplicates/invalid output/valid ingestion): `test-m32-providers`. 16 (mask creation & compositing): `test-m32-masks`. 17–19 (three-format derivation/timeline create/reopen): `test-m32-variants` (+ live timeline reopen in showcase suite). 20–23 (render/batch/cancel/retry): render job path unit-verified; retry/cancel via provider suite; triple-format live render NOT RUN (limitation). 24–25 (poster/share copy): showcase live suite. 26 (packaging/import): M29 journey untouched (no changes to that layer). 27 (collaboration handoff): M30 suites re-run. 28 (editor regression): editor suites in the 129-test run.

## Track E — UI integration

| Feature | Status | Files | Evidence |
|---|---|---|---|
| Provider readiness panel (status/capabilities/cost/unsupported) | VERIFIED | showcase-studio.tsx, `/api/providers/readiness` | browser walkthrough desktop+375px, no overflow |
| Campaign variants panel (derive/render/safe-area warnings/open-in-editor) | VERIFIED | same | screenshots |
| Masks panel (honest auto-seg banner, validated rows, invert/feather actions) | VERIFIED | same, `/api/masks` | screenshots |
| No fake progress / false success / silent retries / hidden config failures | VERIFIED (by design + tests) | — | code + suites |
| 375px no horizontal overflow | VERIFIED | — | `scrollWidth == innerWidth` checks + screenshots |

## Not implemented (honestly)

- Live triple-format variant render inside the HTTP live suite (logic unit-verified; wiring into that suite's completed-master flow is future work).
- Automatic segmentation (needs a verified provider/model + owner authorization).
- Platform-specific safe-area specs (no verified documentation supplied; generic margins used and labeled).
- Per-frame temporal mask sequences (single-frame masks + versioning now; multi-frame IoU consistency is a future extension).
