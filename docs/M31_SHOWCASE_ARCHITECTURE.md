# M31 SHOWCASE ARCHITECTURE — BEAN SHOWCASE STUDIO

**Date:** 2026-11-20 · **Branch:** `feature/ai-creative-studio` · **Product-design reference studied (inspiration only):** BrAG (github.com/latent-spaces/brag) — reviewed at the CONCEPT level (project-aware product understanding → natural-language creative direction → launch film → poster/share copy). **No BrAG source, agent skills, prompts, schemas, scripts, bundled audio/media or UI was copied, vendored, forked or imported. BrAG is not a runtime dependency. No Hyperframes/Remotion was introduced.** All code below is ORIGINAL BEAN FX implementation on existing verified contracts.

## 1. Position in the system

SHOWCASE STUDIO is a **capability of the existing M31 Production engine**, not a second system:

- One new pipeline template (`showcase-studio`, `productionType: "showcase"`) in the SAME `PIPELINE_TEMPLATES` registry, state machine, stage dependency graph, cost gate and append-only decision/event architecture as the verified PRODUCE templates (`src/lib/production/engine.ts`).
- New stage kind `product_understanding` executes on the same runner contract; all other stages reuse the verified executors (concept/script/storyboard/asset_planning/asset_generation/edit_planning/assembly/rough_cut/review/render/qa/delivery).
- The deliverable is a REAL editable BEAN FX sequence built with canonical commands (`AddTrack`/`AddClip`/`AddGraphic` through `applyTimelineEdits`) — the same architecture the editor, M30 review and export pipeline use. AI never writes raw JSON to the DB.

## 2. Stage chain (9-step UI flow mapping)

| UI step | Stages | Notes |
|---|---|---|
| SELECT PRODUCT | INTAKE | structured showcase inputs (see §3) |
| UNDERSTAND | PRODUCT_UNDERSTANDING | validated artifact, user-approved |
| CREATIVE CONCEPT | BRIEF → CONCEPT | campaign type + tone; 3 distinct directions |
| STORYBOARD | SCRIPT → STORYBOARD | beats from the approved concept; per-scene editing |
| GENERATE | ASSET_PLANNING → ASSET_GENERATION | user media + provider-gated generation |
| COMPOSE | EDIT_PLANNING → TIMELINE_ASSEMBLY → ROUGH_CUT | primitives + NIKKI graphics on canonical commands |
| REVIEW | REVIEW | M30 client-review bridge (fingerprint, revisions, approvals) |
| RENDER | FINAL_RENDER | existing durable Job system (`RENDER_TIMELINE`) |
| DELIVER | QUALITY_ASSURANCE → DELIVERY | QA measurements, poster, share copy |

## 3. Product Understanding Engine (`src/lib/production/showcase/product-understanding.ts`)

Inputs (all optional, ≥1 required; owned-media enforced per asset):
- product name / description / feature list (user-stated = explicit evidence)
- authorized public website URL
- screenshots (IMAGE MediaAssets)
- demo recordings (VIDEO MediaAssets)
- an existing BEAN FX project (real timeline evidence)

Security and honesty boundaries:
- **SSRF guard** (`assertPublicHttpUrl`): http(s) only, no credentials, blocklist of loopback/private/link-local/metadata hosts, DNS resolution re-checked against private ranges, manual-redirect re-validation (≤3 hops), 10s timeout, 768 KB cap, HTML/plain-text content-type only.
- **Retrieved web content is untrusted data** — parsed as text only (`extractFromHtml` strips scripts/styles/noscript/svg/comments); it can never execute or steer the agent.
- **Secret redaction before storage** (`redactSecrets`): emails, bearer/JWT tokens, API keys, private URLs, private paths → `[REDACTED:<kind>]`; only redaction KINDS are logged in `exclusions`, never values.
- **Deterministic brand palette** from real pixels (32×32 RGB quantization via FFmpeg rawvideo) and demo-video probes via the existing `ffprobe` seam.
- **Evidence-only LLM structuring** (optional): when the MY AI gateway is healthy (`llmHealth`), a validated pass (`chatValidated`) may structure purpose/audience/benefit/capabilities STRICTLY from recorded evidence; a post-lint (`claimsLint`) demotes any unbacked number or superlative into `unverifiedClaims`. No metrics/testimonials/customer counts are ever invented.
- Artifact (`ProductUnderstandingSchema`) stored in `Production.productJson` (additive column), user-approved before downstream stages; approval is an append-only `ProductionDecision`.

## 4. Creative direction (`showcase/concepts.ts`) & campaign types (`showcase/types.ts`)

- 8 campaign types with honest capability metadata; `cinematic-trailer` is explicitly marked as requiring a configured video provider (CONFIGURATION REQUIRED) — no unsupported type is presented as executable.
- 3 genuinely distinct deterministic directions (Hero Reveal / Problem→Proof / Rhythm Showcase), each with title, central idea, opening hook, product reveal, feature highlights (from the approved artifact), visual/motion/music/narration direction, closing CTA, complexity, required capabilities (real BEAN seams only), cost note. Selection + approval are append-only decisions before any consequential work.

## 5. Storyboard editing & demonstration planning (Phases 3–4)

- Additive scene fields: `textOverlay`, `productElement`, `transition`, `compositionPrimitive`, `demonstration` (source media, `illustrative` flag, mask notes). Legacy storyboards parse unchanged.
- Board API (`PUT /api/productions/[id]`) scene ops: `scene-edit`, `scene-reorder`, `scene-duplicate`, `scene-remove`, `scene-regenerate`, `scene-approval`, `product-approval` — all persisted + event-logged. **Approved scenes are never silently changed**: an edit without explicit `reApprove: true` returns 409; with it, the scene flips to PENDING and the change is logged.
- Demonstration planning: scene sources must be owned media; simulated interaction accents are recorded `illustrative: true` in production metadata (never presented as captured behavior); mask notes record private data that must be replaced/masked before public release.

## 6. Composition primitives (`showcase/compositions.ts`, Phase 6)

11 original primitives — hero-product-reveal, cinematic-title, feature-spotlight, ui-demonstration, floating-product-frame, split-screen-comparison, product-showcase, stat-reveal, end-card, logo-reveal, cta-scene — are pure functions emitting **editor-model data only**:
- clip property keyframes (`opacity/scale/x/y/rotation/blur`, editor interpolation enums, clip-relative frames on the canonical timeline clock — no second timebase);
- effect parameter keyframes (editor `EffectSchema` shapes);
- NIIKI graphic styles composed onto REAL registry templates (`title-scale-in`, `lower-third-card`, `news-banner`, `title-intro-slide`, `section-heading`) via `nikkiStyleFor` (full schema-valid clones).
A registry wrapper globally frame-sorts every emission (stable sort, editor invariant), and `validateEmission` enforces caps (512 property / 256 effect keyframes, clip duration minimums). `stat-reveal` **refuses** to render a number without recorded evidence. Assembly emits graphic-only scenes (titles/end cards) as REAL `AddGraphic` clips on a GRAPHIC track — never fabricated placeholders.

## 7. Generation routing (Phase 5, `showcase/generation-router.ts`)

The 10-step protocol, encoded: provider availability probe (real CLI probe / `probeVideoProvider`) → capability match against the provider contracts (`JazmiiGenerateParamsSchema` / `LaxiiGenerateParamsSchema` — unsupported options rejected, never silently mapped) → aspect/duration validation → **approval gate** (`approved: true` + `approvedBudgetCents` set; preview-only responses otherwise) → REAL job submission on the durable queue (`JAZMII_GENERATE` / `LAXII_GENERATE` via `jobManager.createJob`) → output validation in the existing job handlers (ffprobe duration/aspect tolerance, content sniff) → asset registration with full provenance (`registerGeneratedAsset`). Cost is recorded **UNKNOWN** (metered provider, pricing not independently verified — never 0, never invented). `syncGenerationAssets` maps completed jobs to their registered media assets via `Job.exportId` (idempotent; a produced asset refuses duplicate provider calls).

## 8. Audio (Phase 7)

- Music: user-supplied track (license `USER_CONFIRMED`), or explicit silence. No bundled third-party music exists in the showcase path.
- Narration: optional, per-scene, through the verified TTS seam (`z-ai tts`, voice `tongtong` — the 2026-11 live-probed voice) in `showcase/narration.ts`; WAVs become REAL audio MediaAssets with provenance; **Tamil is refused with an actionable note** (not verified on the provider — never faked). Narration text comes from the user-authored `narrationSegment`; the system never reads visible labels on its own. licenseState stays `UNKNOWN` (provider terms not independently verified) and is recorded verbatim.
- SFX: user-provided only; the mix is not padded with decorative cues.

## 9. Poster + share copy + delivery package (Phase 9)

- Poster (`showcase/poster.ts`): deterministic frame choice (mid-point of the end-card/CTA scene; fallback 80% of runtime — clear of transitions/fades), FFmpeg extraction, PIL decode + luminance band checks (black/clip rejection), title overlay via the M9 thumbnail compositor (fixed Python, layout as parsed JSON), dimensions matched to the film. Registered as a REAL MediaAsset (`SHOWCASE` engine, provenance recorded). Failed checks are recorded honestly — a poster that fails a check is not delivered as ready.
- Share copy (`showcase/share-copy.ts`): deterministic per-platform copy (YouTube/Instagram/TikTok/LinkedIn/X/WhatsApp) from the approved artifact + storyboard CTA only; per-platform limit verdicts are real (X = strict plain-character bound); over-limit copy is trimmed but flagged. `claimsLint` at understanding time keeps invented numbers out of the pipeline.
- Delivery JSON: artifacts (real ExportFile rows) + poster plan/checks + poster media id + share copy + delivered-at, appended with a deduped notification.

## 10. QA (Phase 10, `runProductionQa` extensions)

Beyond the pre-render sequence checks (non-empty, no missing media — NIKKI graphic clips excluded as legitimate template-rendered clips, valid ranges, duration vs brief, no overlaps), the rendered file is measured with real tools:
- `ffprobe` decodability, streams, duration;
- `blackdetect` (≥0.5s black segments — failing when >10% of runtime);
- `volumedetect` (mean/max dB; unmeasurable audio or >−0.5 dBFS peak fails for review);
- A/V duration sync; caption timing inside the rendered runtime.
QA outcomes remain the explicit `PASSED / PASSED_WITH_WARNINGS / FAILED / NEEDS_HUMAN_REVIEW / NOT_RUN` set — render exit success alone never marks a production ready.

## 11. UI (Phase 11)

`/showcase` route + `ShowcaseStudio` tool (`src/components/bean/showcase-studio.tsx`), added to the dashboard tool grid next to PRODUCE. Black/yellow design system preserved; step rail maps the 9 steps to real persisted stage states (no fabricated progress); the board renders the product artifact with evidence, concepts, editable scene cards, the asset wall with honest cost/unknown rendering, QA, poster checks, share copy and the real event log. State polls the persisted API every 5s.

## 12. Prisma changes (additive only)

`Production.productJson String?`; `ProductionAsset.jobId String?`, `ProductionAsset.error String?`; `GeneratedEngine` union extended with `"SHOWCASE"` (asset lifecycle). db push additive; existing rows/tables untouched.
