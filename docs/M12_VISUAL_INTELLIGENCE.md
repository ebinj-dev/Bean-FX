# M12 — Visual Intelligence & Semantic Video Understanding

M12 extends the M10/M11 Creative Director with GENUINE visual intelligence: real frames are extracted from the project's actual footage, understood by a REAL configured vision-capable provider (consent-gated), indexed into searchable scene records, matched against narration, and turned into evidence-based B-roll and continuity recommendations. **M13 was not started; M1–M11 functionality is untouched (full matrix green).**

## 1. Architecture — what M12 resolves from M11's limitations

| M11 limitation | M12 resolution |
|---|---|
| Consent-gated external VLM was "plumbing only" | §3 real `VisionProvider` gateway over the SDK's `createVision` endpoint (live-verified `glm-4.5v`) |
| Scene analysis was cuts/black/freeze only — no semantic content | §4 scene index with provider descriptions, objects, activities (`semantic` vs `heuristic-only` honesty flag) |
| No footage search | §5 natural-language search (provider ranking + deterministic local fallback) |
| Narration↔visual coverage was purely measured (no semantics) | §6 grounded relevance verdicts over ACTUAL frame descriptions |
| B-roll suggestions not grounded in visual evidence | §7 recommendations from measured coverage gaps + analyzed scenes + owned unplaced assets |
| Continuity limited to cuts/static/black | §8 repeated shots (aHash), rapid cuts, aspect changes, composition shifts (model, consent-gated) |

New modules: `src/lib/my-ai/gateway/vision.ts` (vision seam); `src/lib/creative/visual/{contracts,frames,vision-analysis,scenes,search,matching,broll,continuity,jobs}.ts`; API `src/app/api/creative/visual/{index,search}`; UI: **Visual** tab in `creative-panel.tsx`; one new worker job type `VISUAL_INTELLIGENCE` on the EXISTING M3 worker. No new queue, no new storage layer, no Ollama.

## 2. Frame extraction (§2)

`extractFrames()` runs on the REAL source file with configurable settings (`m12-visual-1.0`): `sampleIntervalSec` (uniform sampling), scene-based sampling (midpoints of the JAZMII deterministic cuts), candidate proximity-dedupe, and a budget (`maxFramesPerAsset`, even spread across the duration). Frames are scaled to ≤ `maxFrameWidth` (never upscaled), JPEG q5, in a per-run temp dir under `MEDIA_ROOT/tmp/visual-frames/<runKey>` — cleaned in the job's `finally` (test-proven). Every frame record carries: assetId, clipId (timeline placement), **sourceSec (file clock) AND timelineSec (sequence clock, speed-aware via the M11 mappers)**, measured dimensions, extraction method, 64-bit aHash, `dupOf` provenance (which kept frame a near-duplicate duplicates), status (`extracted | analyzed | failed | skipped-duplicate | skipped-budget | skipped-no-consent`), and provider/model once analyzed. Known limitation (honestly documented): uniform-color frames share the zero aHash — perceptual dedup cannot distinguish solid colors (the test fixtures use textured sources for exactly this reason).

## 3. Vision provider capabilities (§3)

`VisionProvider` (`vision.ts`): `analyze(prompt, images, options)` — 0..4 base64 JPEG images per call, typed error normalization (NOT_CONFIGURED / AUTH_FAILED / RATE_LIMITED / TIMEOUT / PROVIDER_FAILURE / INVALID_RESPONSE / CANCELLED), bounded retries, abort support. Shipped adapter `zai` → SDK `createVision` (`data:image/jpeg;base64` content, thinking disabled), model configurable via `BEANFX_VISUAL_MODEL` (default **`glm-4.5v`** — live-verified). `visionHealth()` performs a REAL round trip against a 1×1 JPEG (60 s cache). Structured output goes through `VisionBatchResponseSchema` (description/objects/activities/environment/visibleText/shotType/composition/subjectPosition per image) with ONE informed repair attempt. Frames are labeled `IMAGE n` in the prompt so per-frame binding is explicit; missing/extra entries bind or fail honestly per frame. **Nothing in this path reads filenames, metadata or transcripts — it cannot fabricate visual understanding from text.**

## 4. Scene indexing (§4)

`buildScenes()` groups frames between the JAZMII deterministic cut boundaries. Each `VisualScene` carries: deterministic id (`<assetId>:s<i>`), source range, **timeline placements** (both clocks, ≤8), representative frame, registered representative IMAGE asset (UI thumbnail), description/objects/activities (ONLY from analyzed frames), aHash similarity neighbours, `repeatGroup` (union-find over similarity edges), confidence, provider/model, and `understanding: "semantic" | "heuristic-only"` — **a scene boundary never claims content; `heuristic-only` scenes explicitly carry no description**. Representative frames are registered through the EXISTING asset lifecycle (`registerImageArtifact`, engine JAZMII, `referenceAssetId` parent, provenance params `m12-visual-representative`) into a persistent per-user dir so the temp sweep cannot orphan them.

## 5. Natural-language footage search (§5)

`POST /api/creative/visual/search {projectId, query, assetId?, timeStartSec?, timeEndSec?, limit?}` — project-owned, zod-validated, audited. Requires a COMPLETED visual index (otherwise `available:false` with the reason). With stored consent: `provider-ranking` — the configured LLM ranks bounded scene records against the query (English AND Tamil where the model supports it), validated by `VisionSearchRankingSchema`; results cite scene ids, relevance scores and evidence. Without consent (or on provider failure, honestly noted): `local-keyword` — deterministic token matching over descriptions/objects/activities (English-focused; Tamil queries get the explicit note that provider ranking is the supported path). Results return scene thumbnails, both clocks, relevance and evidence; the UI seeks to the scene's timeline position.

## 6. Narration-to-visual matching (§6)

`matchNarrationToVisuals()`: 1) the **APPROVED** M11 `TranscriptVersion` (fallback: the RIISHE-reused measured transcript, honestly noted); 2) speech segments mapped to the timeline through the transcript's own source asset (embedded-audio videos included) via the existing clip-placement mapper; 3) deterministic coverage (`full | partial | none | unmappable`) from scene placements; 4) semantic relevance ONLY with consent + analyzed scenes: the provider compares each narration segment against the ACTUAL matched scene descriptions (`VisionMatchVerdictSchema`, ai-interpretation label) — without consent the verdict stays `unknown` with the missing data listed. Every match carries segment text, language, both clocks, matched scene ids, coverage, relevance, score, explanation and missing-data warnings. **A mismatch is never labeled an editing error** — the explanation states that b-roll/montage choices are legitimate (live-verified: coffee narration over SMPTE bars → `unrelated (0)` citing "no connection to coffee roasting").

## 7. B-roll recommendations (§7)

`buildBrollRecommendations()` reacts to measured coverage gaps and provider-assessed unrelated visuals: 1) **reuse an unused analyzed scene** of the indexed asset → executable `timeline-commands` AddClip proposal (validated M1 command, approval-gated); 2) **owned unplaced footage** (project IMAGE/VIDEO assets not on the timeline) → executable AddClip with honest "content NOT semantically verified" rationale; 3) **generation** → `engine-action` payloads routing to the EXISTING LAXII (`laxii-broll-image`, additive enum value + dispatch branch) / JAZMII jobs — output insertion remains a separate explicit user action; 4) unmappable speech → informational missing-footage note. No fabricated availability, no external stock claims, no auto-insertion. Approved timeline commands execute through `applyTimelineEdits` (versioned, undo/redo intact — test-proven).

## 8. Visual continuity (§8)

`analyzeVisualContinuity()` — deterministic (measured): repeated-shot groups (aHash ≤ `repeatShotHashDistance`, evidence includes the actual hashes + the "visual similarity, not verified semantic sameness" note), static/freeze and black sections (ffmpeg detectors, `model-observed`), rapid-cut windows (<0.5 s spacing), aspect-ratio changes between adjacent timeline video placements (probe dimensions). Model-interpreted (consent + analyzed frames only): composition/subject-position shifts between consecutive analyzed scenes (`ai-interpretation`, capped 3). Explicitly NOT claimed: exact camera movement, emotional expressions, cinematography quality, semantic continuity from timestamps alone — shipped in every run's notes.

## 9. Creative Director integration (§9)

New **Visual** tab (all M10/M11 tabs preserved): run controls (consent checkbox, frame budget, sampling interval — the disclosure states exactly what leaves the server), review progress, index staleness + honest missing-evidence notes, **Scene Browser** (real thumbnails via `/api/media/{id}/file`, semantic/heuristic labels, repeat badges, "open in timeline ↗" seek), **Frame Evidence Inspector** (per-scene frame records with both clocks + provider/model), **Visual Search**, **Narration Match** (evidence labels, coverage, verdicts, seek), **Visual Continuity Review**. Generated illustrations are never shown as project frames — thumbnails are registered frames of the actual footage.

## 10. Jobs, versioning, invalidation (§10)

`VISUAL_INTELLIGENCE` (45 min, per-user concurrency 1) on the existing durable worker: stale invalidation with reasons → whole-run dedup (identical dependency hash ⇒ the stored index is REUSED — no re-extraction, no provider calls; test-proven) → local scene analysis (M11 artifact, dedup'd) → extraction → consent-gated semantic analysis (per-call usage recorded into `AIUsage`) → scene index + representative registration → narration matching → continuity findings + recommendations → artifacts (`visual-index`, `visual-match`, `visual-continuity` on the EXISTING `CreativeAnalysisArtifact` model) with fingerprints over asset (id+size+mtime), timeline contextVersion, settings hash, vision provider/model. Changed fingerprints mark artifacts STALE **with reasons** ("source media changed (size/mtime)", "timeline changed (v:…)"); one primary video asset per run (extra assets listed honestly); cancellation between phases; idempotent recovery; temp cleanup in `finally`.

## 11. Privacy, consent, costs (§11)

Frames leave the server ONLY with the explicit per-run `consentVisual` checkbox; the UI and the enqueue response disclose exactly what is sent ("≈N vision request(s) for ≤M frame(s) at ≤Wpx"), and the run's artifacts record `consentVisual` + provider/model. Without consent the run is deterministic-only (frames never leave the server) — never silent. Only scaled JPEG frames are sent — never full videos. Credentials stay server-side (SDK env). Usage is recorded per call in `AIUsage` with the standing honesty note: token counts as reported; **no invented $/token rates** (no verified pricing exists). Local scene analysis, extraction and aHash similarity upload nothing. Ownership is enforced on every endpoint and job path; audit rows record enqueue and search actions. No Ollama.

## 12. Database & API changes (additive only)

**No new models.** Visual data lives in the EXISTING `CreativeAnalysisArtifact` (kinds `visual-index` / `visual-match` / `visual-continuity` / `scene` reuse) + `CreativeFinding` + `CreativeRecommendation`; representative frames are normal `MediaAsset` IMAGE rows with provenance. `VisualReview` reuses `CreativeReview` with the additive scope value `"visual"` (String column — no migration). New API: `GET/POST /api/creative/visual/index`, `POST /api/creative/visual/search` — session auth, project ownership, zod validation, audit rows. `ProposalPayloadSchema` gained the additive `laxii-broll-image` engine action with its dispatch branch in the existing approval flow. `prisma validate` ✓ — zero schema changes.

## 13. Tests & real-provider evidence (executed 2026-11-14)

| Suite | Result |
|---|---|
| `scripts/test-visual-core.test.ts` (fixtures + REAL ffmpeg/aHash/scenes/M1/M2; stub vision + stub ranker/verdict providers, clearly labeled) | **22/22** — settings clamp/refusal; sampling (scene midpoints + uniform, budget spread); REAL extraction with both clocks + speed mapping (2× speed → timeline < source); REAL dedup (solid fixture collapses, `dupOf` provenance); corrupt media refuses honestly; scene grouping with heuristic-only honesty; repeated-shot detection (real hash distances d02=0 vs d01=40); representative registration (IMAGE assets, provenance); stub-vision binding/provenance/typed failures/short-response honesty; gateway 0..4-image contract; search (local + filters + provider ranking + honest fallback); matching (APPROVED transcript, coverage measured, consent-gated semantics, ai-interpretation verdicts); B-roll (AddClip validated by `parseCommand`, engine-action accepted, REAL M1/M2 insertion with version bump); continuity findings with honest labels + NOT-claimed note; **FULL VISUAL_INTELLIGENCE through the REAL worker (no consent)**: 3 scenes indexed, artifacts + findings persisted, honest consent-skip note, temp dir cleaned; run dedup REUSES the index (no recompute); mtime change → STALE with reason; ownership; no-video honest failure |
| `scripts/test-visual-live.test.ts` (REAL providers) | **3/3 live** — REAL `glm-4.5v` vision described REAL extracted frames: *"A solid red background with bold white text reading 'BEAN FX' centered in the frame"* + `visibleText: "BEAN FX"` (verified against the KNOWN drawn content); REAL `VISUAL_INTELLIGENCE` job WITH consent through the REAL worker (2 semantic scenes, registered thumbnails) → REAL provider-ranked search for "the scene showing text that says BEAN FX" → top result the text scene (score 1, evidence quotes the description); REAL narration matching: ZAI TTS speech → REAL ASR (`lang=en`) → `glm-4.5v` verdict **`unrelated (0)`** with explanation citing the SMPTE bars — honest mismatch, ai-interpretation provenance |
| Full matrix `scripts/run-all-tests.sh` (M1–M11 + M12) | **26 suites, 0 failures** |

Fixture vs stub vs live: core = real engine/media code with labeled injected providers; live = real TTS→ASR→vision pipeline reported as such. No mock is presented as provider verification; no capacity claims are made (no load testing was performed).

## 14. Known limitations (honest)

- One vision provider family (`zai`/`glm-4.5v`) is configured; the seam is provider-independent but no second adapter ships. The vision model name is configurable; no capability auto-detection beyond the health probe.
- Frame analysis is per-batch (≤4 images); scene descriptions merge representative frames — fast motion inside a scene is not tracked (no optical flow; camera movement deliberately not claimed).
- aHash similarity is luma-based: uniform-color frames share the zero hash; cross-color similarity relies on luma patterns only.
- One primary video asset per visual run (secondary assets listed honestly — re-run to index more).
- Tamil search relies on provider ranking (local keyword matching is English-focused, stated in the response).
- B-roll "existing footage" proposals do not semantically verify unindexed assets (stated in the rationale).
- The visual review analyzes the CURRENT head timeline; concurrent edits invalidate artifacts via the context version (re-run required).
- No cost estimates: tokens recorded, $ rates refused without verified pricing.

## 15. Operational vs planned

**Operational and tested**: consent-gated REAL semantic frame understanding; scene indexing with registered thumbnails; NL search (provider + local); narration-to-visual matching over approved transcripts; B-roll recommendations through the existing approval flow (existing-footage reuse, owned assets, LAXII/JAZMII generation routing); continuity findings with separated provenance; versioned invalidation with reasons; full temp hygiene. **Planned, not claimed**: multi-asset parallel indexing, video-URL model inputs, semantic reordering proposals beyond informational guidance, word-level alignment refinement.
