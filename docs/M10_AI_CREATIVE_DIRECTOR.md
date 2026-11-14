# M10 — AI Creative Director & Content Intelligence

Milestone goal: *"A genuine AI Creative Director that inspects a real project, produces evidence-based findings, generates typed recommendations, obtains user approval and applies valid changes through the existing editing engine."* Everything below reflects what SHIPPED, backed by the tests and browser verification in §12. M11 was not started; M1–M9 functionality is untouched (full matrix green).

## 1. Architecture

M10 adds **no new queue, renderer, editor or execution path**. The Creative Director is a layer that READS real project evidence, WRITES typed proposals, and EXECUTES only through the paths that already exist:

| Capability | Reused service |
|---|---|
| Project context | MY AI's `resolveProjectContext` (M8, bounded) + `getTimelineHead` (M2) — the staleness formula `v:<version>:<clipCount>:<maxEnd>` is shared with MY AI's executor (one definition of "current"). |
| Audio evidence | GANGZII `GangziiInspection` rows (M5): **measured** silence spans, silence fraction, integrated LUFS/LRA, channel imbalance, clipping, level classification. If no inspection exists, the review enqueues the EXISTING `GANGZII_ANALYZE` worker job and waits a bounded time (240 s default) — never fabricates. |
| Transcript evidence | RIISHE results REUSED ONLY from COMPLETED `autocut-analysis` jobs (`media-store/analysis-results/<jobId>.json` — speech spans, transcript, language). That pipeline runs in its own API route and is not duplicated. Missing → `insufficient-evidence`. |
| Captions | `parseSrt` (M2) over SUBTITLE assets + inline clip captions — measured cue counts, chars/sec, gaps. |
| Scenes / metadata | Studio plan scenes (M8.1) + M9 approved publishing metadata (CTA evidence). |
| Findings | Deterministic engine (`retention.ts`) — every finding labeled `measured | inferred | ai-interpretation | insufficient-evidence` with evidence JSON, severity, confidence. |
| Interpretation | MY AI gateway (`chatValidated` + provider seam) for the creative brief, subjective scorecard dimensions, assistant routing and text variants. |
| Execution | M1 `parseCommand` → `validateCommand` → dry-apply → M2 `applyTimelineEdits` (optimistic concurrency, new version, undo/redo/autosave intact) — the SAME path the editor and the M8 executor use. |
| Engine actions | Existing durable jobs only: GANGZII PROCESS, JAZMII GENERATE, LAXII GENERATE. RIISHE autocut is routed-to-ui honestly. |
| Jobs | EXISTING M3 worker: two new types `CREATIVE_REVIEW` (30 min budget) and `CREATIVE_VARIANTS` (10 min), per-user concurrency 1, claim/heartbeat/retry/timeout as everywhere else. |
| Assistant storage | Existing `Conversation`/`ConversationMessage` models (M8). |
| Audit | `AutomationAudit` rows for review enqueue, recommendation execution/dispatch, variant application. |

New modules: `src/lib/creative/{contracts,context,retention,brief,scorecard,recommendations,variants,assistant,jobs}.ts`; API `src/app/api/creative/**` (6 routes); UI `src/components/bean/editor/creative-panel.tsx` mounted in the editor (Assistant / Review / Retention / Scorecard / Recommendations / A/B / History tabs — BEAN FX design language, no separate editor).

## 2. Project context resolution (§3)

`buildMeasuredContext(userId, projectId, opts)` produces a bounded, honest snapshot: timeline structure (clips, audio/video split, gaps, overlaps, transitions, graphics, locked tracks), primary audio source (longest AUDIO-kind asset on an AUDIO track, else a project AUDIO asset — video-embedded audio is intentionally NOT auto-analyzed and reported as missing), GANGZII inspection, RIISHE transcript (reused only), captions, scenes, user-SUPPLIED audience (from the Studio brief — never assumed), M9 metadata, plus `missingEvidence[]` and `evidenceSources[]`. The creative brief (EN/TA) is an LLM INTERPRETATION over this measured context with hard rules: never invent footage/dialogue/facts; audience copied VERBATIM from `suppliedAudience` or null (enforced post-parse); `observed[]` and `interpreted[]` kept separate; missing elements listed. Live-verified: with no transcript and tone-only audio, the real model returned "Unknown (no transcript or visual content available)" instead of inventing a subject.

## 3. Retention methodology (§4)

`analyzeRetention(ctx)` — documented thresholds (`m10-retention-1.0`, in `RETENTION_THRESHOLDS`): long pause ≥1.5 s (moderate ≥2.5, major ≥4.0), opening dead air ≥3 s, speech onset ≥4 s, silence fraction >35%, caption speed guideline ~13 chars/s (explicitly a heuristic, not a platform rule), caption gaps >3 s (count >5), LUFS reference −14 (documented as a streaming REFERENCE, not a rule), channel imbalance >3 dB, repetition = word-set Jaccard ≥0.6 between nearby transcript segments, scene outliers >2.5× mean unit duration, visual reuse ≥40% by one asset.

Standing honesty rules, enforced in code and tests: measured silence is not automatically a bad edit (music/mixed classification suppresses trim suggestions and states the caveat); `unclear` level classification suppresses silence findings and records `insufficient-evidence`; a missing hook is NEVER declared from duration alone (only speech ONSET is measured); a missing CTA is recorded as an evidence gap, not a verdict; and `RETENTION_DISCLAIMER` ships with every analysis — no viewer-retention analytics exist in this deployment, so no drop-off graph or prediction is ever produced.

## 4. Evidence and confidence model

Every finding carries: findingNo, category (13 categories), startSec/endSec (clamped to duration), severity (info/minor/moderate/major), confidence (0..1 where quantifiable, else null), `evidenceLabel`, evidence JSON (the actual measured values + source references: engine, process/job ids, thresholds), explanation separating measurement from judgment, suggestion (nullable), engine. Labels: `measured` (GANGZII/RIISHE/SRT/timeline numbers), `inferred` (statistical pattern; intent unclear), `ai-interpretation` (LLM reading), `insufficient-evidence` (explicit gap + how to obtain it).

## 5. Recommendation contracts (§5) and approval workflow

`ProposalPayloadSchema`: `timeline-commands` (1–20 M1 commands, parseCommand-validated at proposal time AND execution), `engine-action` (GANGZII/JAZMII/LAXII via existing job types, params validated by each engine's own schema), `informational` (never executes). Every recommendation records `timelineVersionAtProposal`. Execution (`approveAndExecuteRecommendation`): idempotence checks → stale rejection (head version ≠ proposal version → STALE, never force-applied) → `validateCommand` + in-memory dry-apply per command (locked tracks and range errors surface BEFORE any write, recorded as FAILED) → `applyTimelineEdits` (new version; undo/redo/autosave untouched) → `EXECUTED` with the version recorded + audit row. Approval is per-recommendation and explicit (`preview` / `approve-execute` / `reject` actions); rejections and stale results are terminal states with recorded reasons. The generator (`buildRecommendations`) maps findings deterministically: measured pauses inside a single audio clip → SplitClip+SplitClip+RippleDelete (multi-clip/edge pauses honestly become informational); LUFS/imbalance/clipping → GANGZII presets (streaming-loudness / fix-channel-balance / repair-clip); caption speed → RIISHE/NIIKI guidance; visual reuse → JAZMII alternative generation; opening findings → LAXII thumbnail alternatives. MY AI never executes shell commands or builds raw FFmpeg.

## 6. A/B Studio (§6)

`CreativeVariant` rows preserve alternatives alongside the original: text kinds (hook/title/description/CTA/narration-section) generated via MY AI with the provider seam; thumbnail comparison REUSES the M9 Thumbnail Studio's LAXII candidates (registered as comparable variants — no duplicated generation); scene-sequence variants carry validated M1 command batches and can only be PROMOTED into the recommendation approval flow (direct apply is refused in code and tests). Applying: text variants write M9 APPROVED metadata fields (validated, audit-recorded, timeline untouched); thumbnails select the asset on the M9 draft; decisions + notes are recorded. Comparisons are labelled CREATIVE EVALUATION — `compareVariants` attaches "no audience experiment exists, so no performance prediction is offered" to every row.

## 7. Scorecard methodology (§7)

Documented model `m10-scorecard-1.0` — 8 dimensions, formula text stored IN each dimension's explanation:
- **Deterministic**: audio-quality (5 − loudness-Δ penalty (>2 dB −1, >4 dB −2) − clipping −2 − imbalance −1), caption-quality (avg chars/s bands 5/4/3/2/1, −1 if >5 long gaps; inline-only captions → neutral 3 with low-confidence disclosure), pacing-consistency (coefficient of variation of unit durations: 5 if ≤0.35 … 1 if >1.3; <3 units → null), technical-export-readiness (M9 variant conformance history: any ok validation → 5; only failures → 2; none → null).
- **AI-assessed** (MY AI): hook-clarity, story-coherence, visual-consistency, ending-cta-clarity — score null + missingData when evidence is absent; out-of-range scores are suppressed.
Missing data NEVER receives an invented score; the persisted `overallNote` always carries the disclaimer (creative evaluation, NOT a prediction of virality/revenue/retention). Deterministic-only runs (provider unavailable or deterministic scope) record the four subjective dimensions as unscored with the reason.

## 8. Creator Assistant (§8)

One turn: persist the user message on the project Conversation → typed intent classification (`AssistantDecisionSchema`, provider seam) → route: reuse a FRESH COMPLETED review (same contextVersion) when one exists; run a deterministic inline pass (persisted as a COMPLETED review with `provider: null` — labeled) for quick intents, creating findings + PENDING recommendations for approval; or enqueue a durable full `CREATIVE_REVIEW`. Replies are evidence-based; `general-question` answers are grounded only in the bounded summary; provider failure = typed 503 `unavailable` — never canned fake analysis. Assistant transcript persists on ConversationMessage with structured meta.

## 9. Database changes (additive only)

Five new models: **`CreativeReview`** (scope full/retention/scorecard/brief, language en/ta, status, progress, `contextVersion`+`headVersion` for staleness, briefJson, missingEvidenceJson, evidenceSourcesJson, provider/model, jobId), **`CreativeFinding`** (per-review, the full evidence contract), **`CreativeRecommendation`** (typed payload, target, preview, requiresApproval, status PROPOSED/APPROVED/REJECTED/EXECUTED/FAILED/STALE, `timelineVersionAtProposal`, executedVersion, result), **`CreativeVariant`** (kind/label/description/changedElements/payload/provenance/status/comparison/decision/appliedVersion), **`CreativeScorecard`** (1:1 with review, modelVersion, dimensionsJson, overallNote). `prisma validate` ✓, `prisma db push` applied; no existing model modified.

## 10. API routes

| Route | Purpose |
|---|---|
| `GET/POST /api/creative/reviews` | List (per project) / create + enqueue durable review |
| `GET/DELETE /api/creative/reviews/[id]` | Full payload (review + findings + recommendations + scorecard + live STALE flags) / cancel queued-running |
| `GET/PATCH /api/creative/recommendations/[id]` | Fetch / `preview` (dry-run) · `approve-execute` · `reject` |
| `GET/POST /api/creative/variants` | List + comparison view / generate (durable job) or register M9 thumbnail candidates |
| `GET/PATCH /api/creative/variants/[id]` | Fetch / `apply` (text→M9 metadata, thumbnail→M9 draft; scene-sequence → promoted to the approval flow) or `discard` |
| `POST /api/creative/assistant` | One project-aware turn (typed routing, honest errors) |

All routes: session auth, project/row ownership, zod-validated bodies, auditable transitions, no credential exposure.

## 11. Privacy and security

Private media never leaves the server (context is text/metadata only); prompts carry bounded digests; ownership is enforced on every row and in both job handlers; approvals are per-item and explicit; stale proposals are refused rather than force-applied; provider keys stay server-side; no Ollama anywhere.

## 12. Testing evidence (executed 2026-11-14)

| Suite | Result |
|---|---|
| `scripts/test-creative-core.test.ts` (fixtures + REAL M1/GANGZII integration, injected stubs labeled) | **28/28** — real timeline + REAL worker-run GANGZII inspection (measured silence spans); honest missing transcript/captions; ownership refusal; EN+TA briefs (stub); fabricated-audience stripping; supplied-audience preservation; REAL measured findings from GANGZII spans; synthetic severity/label assertions (dead air, pauses, LUFS delta, imbalance, music caveat, unclear→insufficient-evidence, caption speed, scene outliers, asset reuse, CTA evidence gap, repetition Jaccard); **executable pause removal through the REAL M1 engine (timeline shortened by exactly the pause; version history intact)**; preview ≠ write; stale rejection (nothing force-applied); locked-track refusal recorded FAILED; individual approval/rejection; ownership on recs; variant generate→persist→compare→apply-to-M9 (timeline untouched); scene-sequence promotion requirement; scorecard deterministic formulas + null-with-reasons; stub-scorecard; honest assistant provider failure; deterministic quick pass (findings+recs+conversation persisted, provider labeled null); **full CREATIVE_REVIEW through the REAL worker** (GANGZII evidence wait, honest per-piece degradation when the provider is absent, scorecard persisted); idempotent recovery + cancel + foreign cancel refusal; CREATIVE_VARIANTS worker job (permanent-failure honesty, zero fabricated variants) |
| `scripts/test-creative-live.test.ts` (REAL providers) | **5/5 live** — real GANGZII evidence (1 measured silence span, "mixed"); real EN brief (grounded: honestly "Unknown — no transcript or visual content available"); real TA brief (Tamil preserved); real scorecard (hook-clarity honestly null on missing data); real assistant turn (routed review-project, queued review) |
| Full matrix `scripts/run-all-tests.sh` (M1–M9 + M10) | **21 suites, 0 failures** |
| Gates | `tsc --noEmit` clean · `eslint src/lib/creative src/app/api/creative creative-panel.tsx --max-warnings=0` clean · `prisma validate` ✓ · `db push` applied · production build ✓ (all `/api/creative/*` routes present) · secret scan clean at push |
| Browser verification | Editor shows the AI Creative Director panel (7 tabs); a Full review was queued FROM THE UI and completed on the worker; the Retention tab rendered the real finding set — including the honest `insufficient-evidence` audio finding (video-embedded audio is not auto-analyzed) with the GANGZII suggestion |

Fixture vs live: the core suite uses real engine/timeline/FFprobe/GANGZII code with labeled fixtures and injected stub providers; the live suite ran the real LLM + real GANGZII path and is reported as such. No mocked output is presented as provider verification; no capacity claims are made.

## 13. Known limitations (honest)

- Transcript-dependent findings require a prior RIISHE Auto Cut analysis (that pipeline is not re-run from the Creative Director; the review says exactly what to run).
- Video-embedded audio is not auto-analyzed (GANGZII analyzes dedicated audio sources) — reported as missing evidence, not guessed.
- The assistant's general-question answers are grounded only in the bounded summary (no web/tools).
- A/B evaluation has no experiment engine — comparisons are creative evaluations by design.
- Pause-removal proposals only auto-build commands when the pause lies inside ONE audio clip (boundary-spanning pauses become informational).
- Text variant application writes M9 approved metadata (title/description/CTA); hook/narration variants currently land as references for manual timeline work unless expressed as scene-sequence commands.
- The scorecard's AI dimensions depend on provider availability; they degrade to unscored rather than guessing.

## 14. Operational vs planned

Operational and tested: full/retention/scorecard/brief reviews on the durable worker; measured audio findings; typed recommendations with approval-gated M1 execution (undo-safe, stale-safe, lock-safe); A/B text variants + thumbnail comparison; explainable scorecard; creator assistant with conversation persistence and honest failures. Planned-but-not-claimed: direct platform analytics ingestion (none exists), automatic multi-clip pause surgery, RIISHE re-analysis from the panel.
