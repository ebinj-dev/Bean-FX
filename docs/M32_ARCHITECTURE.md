# M32 ARCHITECTURE — provider readiness, multi-format campaigns, real masks

**Principle:** M32 EXTENDS the existing verified architecture. No second queue, no editor rewrite, no new dependencies, no parallel production system.

## 1. Provider adapter architecture (Track A)

```
UI/API ──> generation-router (approval/budget/idempotency) ──> jobManager.createJob (EXISTING durable queue)
                                                                   │
                                                    job handlers (EXISTING JAZMII/LAXII)
                                                                   │
                                    provider registries (EXISTING zai-video / zai-image adapters)
```

- `src/lib/providers/readiness.ts` (NEW) sits BESIDE the registries: builds typed capability reports FROM the registries' data (`buildVideoCapabilityReport`, `buildImageCapabilityReport`) and runs REAL probes (`videoProviderReadiness` — actual CLI presence; `imageProviderReadiness` — same). Nothing invents support: undocumented capabilities are listed verbatim in `unsupported[]`.
- **Probe fix:** `probeVideoProvider` previously resolved READY from registry presence alone; it now checks the actual provider CLI binary (cheap, no paid call) — the registry entry existing is not proof of operation.
- **Adapter contract (unchanged, now fixture-tested):** capability discovery → request validation (schema enums, ownership) → submission → status retrieval (poll) → cancellation (local job cancel; provider-side cancellation documented ABSENT) → result retrieval (download) → output validation (sniff + ffprobe + sha256 + quota in `registerGeneratedAsset`) → error normalization (ENOENT→NOT_CONFIGURED, killed→TIMEOUT, 401→AUTH_FAILED, 429→RATE_LIMITED).
- Provider-specific request/response formats stay behind the adapters; the rest of BEAN FX uses the internal job contract.

## 2. Capability model

`VideoCapabilityReport`: textToVideo / imageToVideo / referenceVideoConditioning (false — undocumented) / referenceImageConditioning / negativePrompt (false) / seedControl (false) / durationsSec / sizes / fps / qualities / withAudio / jobStates / providerProgress / cancellation ("none") / outputFormats / maxOutputBytes (platform cap, labeled) / unsupported[] / pricing.

`ProviderCostInfo`: `{state: UNKNOWN|VERIFIED, currency?, unit?, assumptions?, source?, sourceDate?}` — VERIFIED only with recorded authoritative source + date. Everything ships COST UNKNOWN today.

Readiness statuses: READY · CONFIGURATION_REQUIRED · UNSUPPORTED_CAPABILITY · TEMPORARILY_UNAVAILABLE · AUTHENTICATION_FAILED · PROVIDER_ERROR (+ COST_UNKNOWN as the cost attribute). `GET /api/providers/readiness` exposes them; the UI renders them verbatim.

## 3. Job lifecycle & reliability (Track A5)

- **Idempotency:** `ProductionAsset.idempotencyKey` — `routeGeneration` with a seen key returns the EXISTING job (no second submission, no second paid call).
- **Resumable submission:** the JAZMII handler persists `providerTaskId` on the Job row IMMEDIATELY after `createTask`; a retry attempt RESUMES polling that task. Retries are therefore safe for paid operations.
- **Permanent vs transient:** `NOT_CONFIGURED / UNSUPPORTED / AUTH_FAILED / INVALID_RESPONSE` → immediate FAILED (no pointless backoff, no paid re-fire). `RATE_LIMITED / TIMEOUT / PROVIDER_FAILURE` → bounded retries via the existing `requeueJob` exponential backoff (30s·2^n, cap 5min).
- **Cancellation:** `jobManager.cancel` → CANCELLED; the JAZMII poll loop honors it each poll; `syncGenerationAssets` reconciles asset rows honestly (FAILED with detail; mediaAssetId stays null — no fabricated output). Provider-side tasks are documented as not cancellable (capability registry states it).
- **Expiry:** stale-heartbeat recovery + `retryBackoff` (existing) re-queue PROCESSING jobs whose worker died.
- **Output integrity:** content sniff, ffprobe (duration tolerance + aspect class), sha256, quota — a provider HTTP 200 alone never marks success.

## 4. Multi-format campaign model (Track B)

```
Production (approved master, immutable)
   └── ProductionVariant (per format: 16:9 | 1:1 | 9:16)   [Prisma, @@unique(productionId, format)]
         ├── sourceStoryboardRev   (immutability anchor)
         ├── projectId             (NEW native project — editable in the editor)
         ├── framingJson           ({default: ReframeResult, manual: {sceneKey: {focalPct}}})
         ├── overridesJson         (explicit, validated)
         ├── safeAreaJson          (generic margins report + issues + note)
         └── renderJobId/exportId  (EXISTING RENDER_TIMELINE jobs; ffprobe aspect validation on completion)
```

- **Reframing** (`computeReframe`, pure): cover-scale = max(tw/mw, th/mh); focal window offset clamped to keep the frame filled; `strategy: "focal"|"center"` — center is honestly labeled when no focal evidence exists; cropLossPct computed; edge-clamped focal warnings demand manual framing. Manual overrides (`PATCH`) re-derive into a FRESH project via the same canonical path.
- **Derivation** (`deriveVariant`): requires master COMPLETED; refuses duplicates and the master's own aspect; builds AddTrack/AddClip/AddGraphic clones with reframed transforms and IDENTICAL frame positions (timing preservation by construction); audio cloned verbatim; applies through `applyTimelineEdits` on the NEW project only; then re-reads the master rows and QUARANTINES the variant if anything on the master changed (immutability check).
- **Safe areas** (`validateSafeAreas`): GENERIC 5% margins with the explicit note "not a platform specification"; text-width estimation flags overflow; 9:16 bottom-caption warning demands manual verification — platform specs are never invented.
- **Render/export:** batch render enqueues RENDER_TIMELINE per variant project; `syncVariantRenders` validates the export's real aspect against the format via ffprobe before marking COMPLETED.

## 5. Mask data model (Track C)

```
MediaMask [Prisma]: sourceAssetId · storagePath (PNG inside media-store) · width/height
  method ("manual-import"|"editor-refine"|"<provider>") · version · parentId (version chain)
  validationStatus (UNCHECKED|VALIDATED|FAILED) · validationJson (alpha statistics)
  coordSpace ("pixel:source-resolution") · fps/frameIndex (temporal) · notes
```

- Masks live under `MEDIA_ROOT/media-store/masks/u_<user>/` — the same storage layout packaging/import preserves, so they survive project portability workflows.
- **Creation paths:** manual import (API `action:"import"` — validates + scales to source geometry, mismatches prevented BY DESIGN) and `editor-refine` ops. Automatic segmentation = CONFIGURATION REQUIRED constant surfaced in UI/API; never faked.
- **Operations** (`processMask`): invert / feather (Gaussian) / refine (Min+Median edge) / scale (LANCZOS) — each writes a NEW versioned row (parentId chain), source masks never mutated; FAILED ancestors refuse further processing.
- **Validation** (`validateMaskFile`): PIL mode check, size floor, alpha statistics, all-opaque/all-transparent rejection — a mask that selects everything or nothing is not a usable isolation.

## 6. Compositing & rendering flow

- **Frame:** PIL `Image.composite(src, bg, alpha)` with hard size equality checks (`MASK_SIZE_MISMATCH` / `BACKGROUND_SIZE_MISMATCH`), output registered with provenance (`pil-composite`).
- **Video:** FFmpeg `[mask]scale→[0:v]alphamerge→[bg]scale→overlay` — real per-frame compositing on the EXISTING FFmpeg pipeline; duration mismatch (>0.5s) FAILS before encoding (originals preserved); frame-rate mismatch follows the source clock with a recorded note; output ffprobe-verified (duration + dims) before registration.
- **Timeline integration:** composited outputs are ordinary MediaAssets (provenance-complete) — attachable via the EXISTING canonical commands (AddClip); no direct JSON writes anywhere.

## 7. Security and approval boundaries

- SSRF guards (M31 website ingestion) untouched and still active; external content remains untrusted data.
- Provider probes/ready reports carry NO keys/headers/signed URLs — safe detail strings only; nothing new logs secrets.
- Paid calls: approval + approved-budget + idempotency + no-silent-retry — enforced in `routeGeneration`, regression-tested.
- Uploads (mask images) flow the ordinary MediaAsset validation path; packaging/import (M29) untouched.
- Access control: variants/masks routes are ownership-checked; collaboration permissions flow through `requireViewableProject`.
- No telemetry, no Ollama, no new paid services.
