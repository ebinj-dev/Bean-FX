# M34 — Provider & Segmentation Onboarding (operator guide)

**Audience:** the owner/operator configuring BEAN FX for real generation.
**Hard rule:** every paid operation behind BEAN FX's approval gates stays gated. M34 performs **no paid provider calls**. Nothing in this guide executes billing.

## 1. The provider model (what exists today)

BEAN FX talks to AI providers exclusively through the existing registries and engines — MY AI orchestration on top of **JAZMII** (video generation), **LAXII** (image generation), with RIISHE (inference), GANGZII (audio cleanup), NIKKI/NIIKI and the caption/ASR/semantic engines unchanged. The M32 honest-readiness layer (`src/lib/providers/readiness.ts`) reports per-provider status from documented contracts or real probes only:

- Statuses: `READY · CONFIGURATION_REQUIRED · UNSUPPORTED_CAPABILITY · TEMPORARILY_UNAVAILABLE · AUTHENTICATION_FAILED · PROVIDER_ERROR · COST_UNKNOWN`.
- **Pricing is COST UNKNOWN unless an authoritative source + date has been recorded.** Never assume a price.
- Probes return booleans and pre-redacted detail strings — no keys, no authorization headers, no token-bearing URLs ever flow through readiness output.

## 2. Configuration surface (exact names)

| Variable | Purpose | Secret? | Required for |
|---|---|---|---|
| `BEANFX_ZAI_BIN` | Provider CLI binary (default `z-ai`) on PATH | no | JAZMII/LAXII video+image generation |
| `ZAI_API_KEY` / `Z_AI_API_KEY` | Provider credentials (the CLI reads them; BEAN FX never stores them) | **YES — environment only** | live generation |
| `BEANFX_JAZMII_PROVIDER` / `BEANFX_LAXII_PROVIDER` | Engine provider selection inside the registries | no | engine routing |
| `BEANFX_MYAI_PROVIDER` / `BEANFX_MYAI_MODEL` | MY AI planner | no | orchestration |
| `BEANFX_SEMANTIC_*`, `BEANFX_VISUAL_*`, `BEANFX_ASR_*` | Semantic search / VLM / ASR endpoints | endpoint URLs are not secrets | those features only |
| `BEANFX_JAZMII_LICENSE_NOTE` / `BEANFX_LAXII_LICENSE_NOTE` / `*_RETENTION_NOTE` | License/retention notes recorded with generated assets | no | compliance metadata |
| `BEANFX_STUDIO_REAL_TTS` | Real TTS switch (off = honest placeholder) | no | studio voice-over |

Verification without exposure: `bun scripts/preflight.ts` reports **presence only** (`CONFIGURED` / `NOT CONFIGURED`) for credential variables and CLI reachability. The Showcase board's "AI providers (honest readiness)" panel shows the same statuses in the UI. No command in this repository prints a secret value; do not run the CLI itself to "verify" a key — its interactive output may echo account data.

## 3. Credential acquisition (owner steps — outside this repository)

1. Acquire the provider CLI and credentials through the provider's official distribution channel. BEAN FX never accepts keys in chat, in tickets, or in committed files (`.env` is untracked by design; `.env.example` documents every non-secret variable).
2. Install the CLI on PATH (or point `BEANFX_ZAI_BIN` at it). Verify reachability: preflight `provider.zai.cli` → READY.
3. Place credentials where the CLI expects them (environment/file per the provider's own docs). Verify: preflight `provider.zai.key` → CONFIGURED. This proves presence only — **not** account validity.

## 4. Non-billable readiness verification (what the app does for you)

| Check | What proves it | Billable? |
|---|---|---|
| CLI reachable | preflight READY | no |
| Credential present | preflight CONFIGURED (presence only) | no |
| Provider account verified | a real, logged probe by the provider adapter (M32 model) — still no media produced | no (probe-grade) |
| Capability verified (e.g., textToVideo 5/10s sizes) | the capability registry's documented contract + a probe response — never inferred from a model name | probe-dependent |
| Media generation works | one gated generation, explicitly approved | **YES** |

Never infer capability from a model name or an undocumented response field. A provider answering 200 for `/models` does not prove image or video generation.

## 5. Pricing verification (owner action)

Before enabling any live generation for cost-bearing work: record authoritative pricing (source URL + access date) into the readiness layer's `ProviderCostInfo` (state VERIFIED, currency, unit, source, sourceDate). Until then the UI keeps COST UNKNOWN and the release verdict keeps live paid generation gated. **M34 does not invent pricing and does not execute the paid call.**

## 6. Per-operation approval gates (already implemented — do not bypass)

- Showcase generation stages require explicit artifact approvals (Approve/Reject per artifact; M31/M32).
- Workflow templates mark approval gates with ``; steps only run from the whitelisted step library — no custom code, retry re-dispatches the same verified step.
- Paid generation additionally requires the owner's explicit go-ahead for the specific provider + expected cost (M33 closeout §gates; unchanged in M34).

## 7. Safe test mode

- Provider-less operation is a supported, honest state: with no credentials, generation stages report CONFIGURATION REQUIRED and the product runs (editor, timeline, renders, masks, packaging, collaboration all function — proven by the M33/M34 suites).
- `BEANFX_JAZMII_*_TIMEOUT_MS` bounds provider CLI latency; the durable Job queue records honest failure messages on provider errors (AUTH_FAILED fails immediately without paid re-fire; RATE_LIMITED backs off exponentially — M32 retry classification).
- Quota/rate-limit handling: the app rate-limits its own endpoints (fixed-window) and records provider rate-limit errors honestly; no automatic paid retries.

## 8. Failure recovery

| Symptom | Meaning | Operator action |
|---|---|---|
| `AUTHENTICATION_FAILED` | credentials rejected by provider | rotate credentials in the provider's console; never paste keys into BEAN FX UI/chat |
| `PROVIDER_ERROR` / `TEMPORARILY_UNAVAILABLE` | provider-side outage/limit | retry later; jobs stay FAILED honestly, re-dispatch manually |
| `COST_UNKNOWN` shown at approval time | pricing not verified | complete §5 before enabling paid work |
| `UNSUPPORTED_CAPABILITY` | the documented contract lacks it | do not work around with undocumented endpoints |

## 9. Automatic segmentation (unchanged gate)

Automatic segmentation stays **CONFIGURATION REQUIRED** until a verified model/provider is configured AND owner-approved. BEAN FX does not fake segmentation with blur, chroma key or rectangles (the UI states this in the Masks panel). The manual path — importing a mask via `/api/masks` (manual-import) with ffprobe/PIL validation — is the supported workflow and is regression-tested (M32 masks suite, M33 mask portability + acceptance). If a segmentation provider is later approved, it must pass the same honesty contract: capability from documented contract or real probe, COST UNKNOWN until verified, secrets never through the UI.
