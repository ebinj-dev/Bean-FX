# M32 PROVIDER READINESS

**Date:** 2026-11-21 · **Environment:** BEAN FX deployment with the z-ai CLI present (`BEANFX_ZAI_BIN=z-ai`) · **No secret values appear anywhere in this report** (probe details are pre-redacted by the adapters).

## 1. Video provider — `zai-video` (JAZMII registry)

- **Readiness (this deployment):** READY — probe evidence: `Video provider CLI "z-ai" present (capabilities are registry data; cost UNKNOWN until verified)`.
- **Capabilities (registry data, verified against the adapter in M7 tests):**
  - Operations: textToVideo, imageToVideo (reference-IMAGE conditioning).
  - Qualities: speed, quality · Sizes: 1920x1080, 1280x720, 1080x1920, 720x1280 · FPS: 30, 60 · Durations: 5s, 10s.
  - Audio generation: supported (`withAudio`) — off for showcase routing by default.
  - Job states: QUEUED / PROCESSING / SUCCESS / FAIL / CANCELLED / UNKNOWN; provider-side progress: NOT returned by this provider (honest registry flag).
  - Provider-side cancellation: NOT supported — local cancellation stops the job and the result is never registered; the provider task runs to completion (documented in the capability report's unsupported list).
- **Explicitly unsupported (never invented):** reference-VIDEO conditioning; negative prompts; seed control.
- **Output:** mp4; platform registration cap 500 MB (platform cap, not a provider claim); content sniff + ffprobe duration/aspect tolerance + sha256 on every output.
- **Pricing:** COST UNKNOWN. The registry's `pricingNote` is a disclaimer ("metered by the provider account; BEAN FX records requests for accounting; per-image/video pricing NOT independently verified"), not verified pricing. No currency/unit/assumptions are claimed anywhere.

## 2. Image provider — `zai-image` (+ `zai-image-edit`) (LAXII registry)

- **Readiness (this deployment):** READY — probe evidence: `image provider CLI "z-ai" present (capability list verified in the M7 live probe; cost UNKNOWN)`.
- **Capabilities:** operations textToImage + imageToImage (reference-image); 7 documented sizes (1024x1024 … 720x1440); mode=edit requires an owned reference image.
- **Explicitly unsupported (registry honesty list, carried verbatim):** transparency (the provider returns JPEG bytes even for .png requests — caught in the M7 live probe); negative prompts.
- **Pricing:** COST UNKNOWN (same disclaimer basis).

## 3. Configuration state & what flips it

| Capability | State on this deployment | What would change it |
|---|---|---|
| Video/image generation SUBMISSION | READY (CLI present) | — |
| Real paid generation EXECUTION | CONFIGURATION REQUIRED / OWNER ACTION | Owner authorization for spend (approval + budget gates already enforce per-call consent); no live paid calls were made this milestone |
| Automatic segmentation | CONFIGURATION REQUIRED | A verified segmentation model/provider + owner approval; BEAN FX does not fake it |
| LLM-assisted product-understanding structuring | CONFIGURATION REQUIRED (gateway health-gated) | Configured MY AI provider credentials |

## 4. Pricing verification statement

No authoritative pricing source was available for this milestone. Per the mandate ("Show cost estimates only when supported by authoritative pricing data"), every cost display is COST UNKNOWN with no currency, unit, or assumption invented. If the owner supplies provider pricing documentation (with source + date), `ProviderCostInfo` accepts VERIFIED data and the UI will render it; until then the UNKNOWN state is the honest one.

## 5. Provider-side failure semantics (tested)

| Failure | Classification | Behavior |
|---|---|---|
| CLI missing / unknown registry id | NOT_CONFIGURED → CONFIGURATION_REQUIRED | immediate FAILED; UI shows install hint |
| Unsupported option | UNSUPPORTED → UNSUPPORTED_CAPABILITY | rejected at validation; never silently mapped |
| 401/403 | AUTH_FAILED → AUTHENTICATION_FAILED | immediate FAILED (no paid re-fire) |
| 429 | RATE_LIMITED → TEMPORARILY_UNAVAILABLE | bounded retry with exponential backoff |
| Timeout | TIMEOUT → TEMPORARILY_UNAVAILABLE | bounded retry; JAZMII retries RESUME the persisted provider task (no second paid task) |
| Provider failure | PROVIDER_FAILURE → TEMPORARILY_UNAVAILABLE | bounded retry |
| Garbage output | INVALID_RESPONSE | immediate FAILED; nothing registered |

## 6. Secret handling

Probes return booleans + pre-redacted detail strings; the readiness API/UI expose provider ids, statuses and capability DATA only. No API keys, authorization headers, signed URLs or token values appear in code, logs, tests, screenshots or this report.
