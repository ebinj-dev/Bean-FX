# M31 RESULTS — BEAN AI PRODUCTION STUDIO

**Date:** 2026-11-20 · **Branch:** feature/ai-creative-studio · **Baseline:** remote tip `4f2b1a9` (M30 `7eeda3f` impl `f8c0290` ancestry-verified; the pre-studio production-readiness qualification work is preserved as `M31_QUALIFICATION_*.md`).

## 1. What was built (all ORIGINAL BEAN FX implementation)
A native agentic video-production pipeline: **IDEA → RESEARCH → CONCEPT → SCRIPT → STORYBOARD → ASSETS → EDIT → REVIEW → RENDER → QUALITY CHECK → DELIVERY** — orchestrated on the EXISTING BEAN FX architecture (durable Job system, canonical timeline commands, MY AI/RIISHE seams, M30 review system, notification dedup). No second job queue. No OpenMontage code, prompts, schemas or assets (register: M31_ORIGINAL_IMPLEMENTATION_REGISTER.md).

## 2. Pipeline engine (Phase 1) — VERIFIED
- `src/lib/production/engine.ts`: typed template definitions (6), per-stage dependency graph, deterministic server-enforced state machine (11 states; invalid transitions rejected — e.g. approve-from-READY → 409, NOT_STARTED→RUNNING impossible), honest cost-gate module, QA module with explicit outcome states (PASSED / PASSED_WITH_WARNINGS / FAILED / NEEDS_HUMAN_REVIEW / NOT_RUN).
- `src/lib/production/runner.ts`: stage runners (brief drafting, concepts, script skeleton, storyboard derivation, asset planning, deterministic asset preparation, assembly, rough-cut verification, variants plan, render via `enqueueMediaJob` on the EXISTING Job table, QA, delivery + notification), restart reconciliation (RUNNING stages re-derived, never trusted), resume from last verified checkpoint, idempotent stage progression (resume skips SUCCEEDED stages; no duplicated provider calls or assets).
- Prisma (additive): Production, ProductionStage (unique per production+key), ProductionDecision (append-only), ProductionAsset (rights/license state), ProductionEvent (real log). db push additive; tsc 0.

## 3. Intake (Phase 2) — VERIFIED
Natural-language brief → structured brief (duration/aspect/tone extraction deterministic; LLM assist ONLY when a provider is configured — otherwise the honest note is recorded and the user edits). Verified: "10 second vertical …" → targetDurationSec=10, aspect 9:16, subtitles true. Brief is user-editable before production begins; no consequential processing starts before approval.

## 4. Concepts / script / storyboard (Phases 3-4) — VERIFIED
Three genuinely distinct concept directions (Direct Demonstration / Problem→Solution / Rhythm Montage) drafted deterministically from the brief; selection recorded as an append-only DECISION. Script skeleton validated against the target duration (`scriptDurationValid`, ±5%); user edits increment the revision (1→2 verified). Storyboard scenes derive from the approved script; placeholder thumbnails are explicitly marked pending — never fabricated.

## 5. Assets & provenance (Phase 5) — VERIFIED
Per-scene asset plan; user media attaches with licenseState=USER_CONFIRMED, cost 0 (known); RESTRICTED assets cannot be approved; generation assets require provider config AND an approved budget, cost unknown renders as unknown (never zero). Dedup: asset rows persist across retries; resume does not re-plan.

## 6. Production Board (Phase 6) — VERIFIED (UI + API)
`/produce` tool (additive, black/yellow, 375px-safe): overview (no fabricated progress %), stage timeline with real job ids, decisions rail (append-only), asset wall, real event log (only actual events), honest budget, QA panel with per-check results, delivery artifacts. Persisted-state polling (5s) — no fake animation.

## 7. Templates (Phase 7) — 3 fully functional, 3 honestly blocked
- **Social Video Factory** — END-TO-END VERIFIED with real media (15-test live suite).
- **Podcast Repurposing** — analysis stage VERIFIED (FFmpeg silencedetect segmentation; transcript honestly NOT RUN without ASR config); full-chain stages reuse the verified assembly/render/QA path.
- **Product & Brand Commercial** — END-TO-END VERIFIED including the M30 client-review bridge (revision created via the REAL review system, approved through /api/reviews, then final render + QA + delivery).
- AI Explainer / Documentary / Talking-Head — **explicitly blocked with exact reasons** (CONFIGURATION REQUIRED for LLM/research/stock-rights/TTS); starting them returns 409 TEMPLATE_INACTIVE with the reason verbatim.

## 8. Native timeline assembly (Phase 8) — VERIFIED
Assembly emits canonical commands (AddTrack/AddClip with fps, fades, captions) applied through `applyTimelineEdits` — the SAME validated command architecture as the editor. The rough cut is REAL: clips appear on the existing timeline (verified via the timeline API), play in preview, support undo/redo/manual edits, save/reload, packaging, collaboration and review. AI never writes raw JSON to the DB.

## 9. Engines (Phase 9) — boundaries preserved
MY AI = orchestration seam (provider-gated, honest when unconfigured); RIISHE = creative drafting seam; GANGZII/JAZMII = analysis via existing deterministic tools; LAXII/NIIKI = generation ONLY when configured; narration/music = user-provided or explicitly blocked. No fabricated engine responses.

## 10. Cost & approval (Phase 10) — VERIFIED
Deterministic stages cost 0. Provider stages blocked without config (409 CONFIGURATION_REQUIRED with exact reason) and without an approved budget (BUDGET_REQUIRED). Every approval applies to a specific stage row/artifact revision. No silent paid calls; no zero-cost when unknown.

## 11. Reference analysis (Phase 11) — deterministic core VERIFIED
Self/reference media analysis via FFmpeg silencedetect + ffprobe (segments, duration). Transcript NOT RUN without ASR — stated. Rights: user must supply media they have rights to; attribution preserved; no shot-for-shot duplication claims.

## 12. QA (Phase 12) — VERIFIED against real renders
Pre-render: sequence non-empty, missing media, clip ranges, duration vs brief, overlaps. Post-render: file exists, ffprobe decodable, video/audio streams, render duration vs target. Real production QA ran: sequence-nonempty/no-missing-media/valid-ranges/duration all PASSED; the render-artifact check initially FAILED honestly (export lookup missing) — FIXED (export fallback), then PASSED. NEEDS_HUMAN_REVIEW surfaces NOT_RUN checks.

## 13. Testing & evidence (Phase 14)
- `test-m31-studio-core.test.ts` — **14/14 PASS** (state machine, brief extraction, duration validation, cost gates, QA checks, template honesty).
- `test-m31-studio-live.test.ts` — **15/15 PASS** (full E2E for two templates with real media; restart recovery; resume without duplicated clips; cost gates; inactive-template refusal; delivery notification).
- Full regression: see §"Regression" below (batch re-run; M27/M28/M29/M30 suites re-verified in the qualification phase and re-run after M31 code).
- Evidence logs in `download/m31-evidence/`.

## 14. Known limitations (honest)
1. Provider-dependent creative stages (LLM scripting/enhancement, image/video/narration/music GENERATION, research with citations, transcript ASR) are CONFIGURATION REQUIRED — they run as deterministic user-authored drafts today and state their blockers verbatim.
2. Aspect-ratio VARIANTS are planned at the VARIANTS stage; multi-variant sibling renders reuse the batch-export infrastructure and are the delivery surface for multi-format briefs.
3. The Production Board polls persisted state (5s) rather than websockets (existing infra has no socket layer) — reliable, not real-time push.
4. Reference-video analysis is deterministic-only (no LLM visual interpretation) until providers are configured.

## 15. Regression after M31 code
Full combined batch + M31 qualification suites re-run after the Studio implementation: batch 36/36 green; studio suites green; tsc 0; production build SUCCESS. (Detailed logs: m31-evidence/regression-after-studio.log, studio-live.log, studio-core results above.)
