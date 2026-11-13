# M8.1 — Social Video Studio (topic → editable video)

Milestone goal: *"A user can enter a topic, generate and edit a production plan, select or generate assets, create narration and captions, approve the scenes, assemble a real editable BEAN FX timeline, and export using the existing rendering pipeline."* Everything below reflects what SHIPPED, backed by the tests in §14.

## 1. MoneyPrinterTurbo — inspiration mapping (MIT; independent implementation)

MoneyPrinterTurbo (https://github.com/harry0703/MoneyPrinterTurbo.git) is **MIT licensed**; its public workflow was studied as an architectural reference only — **no source code, assets, or algorithms were copied or vendored**, so no copyright notices are required (MIT attribution would only apply to reused code; nothing was reused). The capability mapping:

| MPT public capability | BEAN FX M8.1 implementation (independent) |
|---|---|
| Topic → script → scene breakdown (LLM) | M8 LLM gateway + `ProductionPlanSchema` v1 + per-scene regeneration |
| Stock footage search (Pexels/Pixabay/Coverr) | **Not available** — no stock provider is configured in this deployment; the Studio states this honestly and offers JAZMII generation, LAXII images, or user uploads (§6 of the brief) |
| TTS voiceover (Edge/Azure/…) | **NEW** `zai-tts` adapter via the configured provider CLI — verified live (WAV 24 kHz, voice `tongtong`), registered as a real MediaAsset with provenance |
| Captions via ASR/timestamps | RIISHE's existing `transcribeWithAsr` on the narration audio — measured chunk windows; word timing stays the M4-documented speech-energy ESTIMATE (never claimed as provider word data) |
| Music + mixing | GANGZII (M5) presets/durable jobs — licensed/user music only; no bundled tracks are assumed licensable |
| FFmpeg assembly → 9:16/16:9/1:1 | M1 command engine + M2 versioned persistence → a genuine editable timeline; export via the existing NIIKI render pipeline |
| Batch topics | `STUDIO_TOPIC` durable jobs on the EXISTING M3 queue (no new queue/DB) |
| One-click publishing | **Not implemented** — no authorized platform integrations exist; never represented as available |

## 2. Product surface (§2)

Brief inputs: topic, keywords, target audience, language (**en | ta** — English and Tamil), objective, duration (15–300 s), platform, tone, narration voice/speed, visual style, captions toggle, optional custom script. Output profiles (validated export settings, mapped to real sequence settings within the M1 model bounds):

| Profile | Aspect | Sequence | Cap |
|---|---|---|---|
| YouTube Shorts | 9:16 | 1080×1920@30 | 60 s |
| Instagram Reels | 9:16 | 1080×1920@30 | 90 s |
| TikTok | 9:16 | 1080×1920@30 | 180 s |
| YouTube landscape | 16:9 | 1920×1080@30 | 300 s |
| Square social | 1:1 | 1080×1080@30 | 120 s |

Briefs are validated against the profile's cap before anything runs. No publication/upload step exists anywhere in the UI or API.

## 3. Production planner (§3)

`createStudioPlan` (M8 gateway, model glm-4-plus — live): emits topicSummary, hook, intro, scenes[] (number, durationSec, narration, visualDescription, footageNeed, brollNote, onScreenText, captionText, audioNote, transition), musicMood, closingCta, fullScript, sources[] — schema-validated (consecutive scene numbers, 2–60 s per scene, ≤400 s total). Deterministic normalization maps LLM representation deviations (key aliases, string durations); malformed output after one informed repair → labeled deterministic-fallback plan (never a guessed plan). **No fabricated research**: the planner prompt forbids invented citations; `sources` only carries explicit entries (tested to be empty). `regenerateScene` rewrites ONE scene via a targeted LLM call (verified live: other scenes byte-identical). Every plan is stored with `plannerMode` (`llm` vs `deterministic-fallback`).

## 4. Scene workspace (§4)

`StudioScene` rows are individually editable: PATCH scene fields (narration edits invalidate the narration audio), reorder (ids → new consecutive numbers), add/delete (numbers re-closed), regenerate (live), replace footage (assign any OWNED asset), preview (preview-frame tool), regenerate only missing assets (`autoAssignGeneratedAssets` best-effort by recency, disclosed as such). The scene plan lives in `StudioPlan`/`StudioScene` rows — the timeline is untouched until the user explicitly assembles.

## 5. Engine integrations (§5–§9)

- **RIISHE (§5):** narration scripts come from the planner; speech = the NEW TTS adapter (provider-backed, honest about voices); transcription/caption timing = existing RIISHE ASR (no duplication); original narration text + editable captionText retained; Tamil: planning/captions/typography Tamil-safe (`nikki-tamil`), TTS Tamil **not verified on the current provider** — refused honestly with an upload-your-voice path.
- **JAZMII (§6):** scene footage generation via durable M7 jobs (platform-correct size); scene-to-footage matching is manual/best-effort-assign (disclosed); **stock search honestly unavailable**; provenance + licence metadata recorded on assignment.
- **LAXII (§7):** scene illustrations/backgrounds via durable M7 jobs, aspect-matched to the profile; generated assets are non-destructive (new asset rows, provenance kept).
- **NIIKI (§8):** captions use NIIKI caption styles (Tamil-safe font), titles/on-screen text are scene fields ready for the NIIKI panel; transitions use the existing validated `TransitionKind` set.
- **GANGZII (§9):** narration cleanup/loudness/ducking run through the existing GANGZII presets/jobs on the narration assets; music is user-supplied or user-licensed only — nothing bundled is assumed licensable.

## 6. Assembly (§10) — a genuine editable project

`assembleStudioTimeline` (approval-gated: `{"confirm":"assemble"}`): builds AddClip/AddCaption/AddTransition commands through the M1 engine and applies them via `applyTimelineEdits` (versioned, undo/redo native, autosave/versions preserved). Integer-frame timing throughout (rational profile fps); locked tracks are RESPECTED (refuses loudly when no unlocked VIDEO/AUDIO track — tested); ownership checked per asset; originals never modified; scene clips labeled `scene N · <kind>` so every scene stays individually editable. Captions: RIISHE ASR chunk timing on the narration audio (measured), falling back to scene-level captions with disclosure. Transitions implement the M1 overlap semantics (clip A ends at transition end, clip B starts at its start — the assembler overlaps scenes accordingly). An IMAGE-still limitation is disclosed in the assembly notes: the M6 FFmpeg renderer treats stills as single-frame inputs (no loop) — use JAZMII footage/uploaded video for full export support.

**Pipeline fix shipped:** `buildNikkiRenderPlan` now emits `split=N` for inputs shared by N segments — multi-scene renders reusing one asset previously produced an invalid filter graph (found by the new export test; M6 behavior for distinct assets unchanged).

## 7. Batch production (§11)

`dispatchBatch` validates EVERY topic against the shared brief BEFORE creating anything (invalid topics reject the dispatch — tested), then creates one `STUDIO_TOPIC` job per topic on the existing durable queue. Per-topic status = the Job rows; failures independent; cancellation via the existing job cancel (+ batch-level cancel that cancels queued/running topic jobs); concurrency = the worker's per-type limit (1); quota enforcement = the brief validation + per-user job quotas; the handler creates the plan + scenes and completes with the plan id (verified live end-to-end through `tickWorkerOnce`).

## 8. UX (§12)

`studio-panel.tsx` mounted in the editor tools stack: CREATE (brief → plan, batch topics box, plan history), SCRIPT (scene narration editing, regenerate, reorder, add/delete), STORYBOARD (per-scene LAXII/JAZMII generation + own-media assignment + honest stock-unavailable note), VOICE (per-scene TTS with external-processing disclosure), ASSEMBLE (approval-gated with readiness summary + export handoff). BEAN FX visual language preserved; no separate app; publishing absent by design.

## 9. Security/privacy (§13)

Session-authenticated routes; ownership on every plan/scene/asset/job lookup; brief/platform validation at every boundary; no shell passthrough (the TTS adapter shells out ONLY to the configured `z-ai` CLI with fixed args — no user text beyond the `-i` argument, no arbitrary commands); external processing disclosed per action (TTS/generation responses carry `disclosure`); private media never sent anywhere by the Studio itself; no Ollama; assembly audited in `AutomationAudit`.

## 10. Testing evidence (executed this session)

| Suite | Result |
|---|---|
| `test-studio-core.test.ts` (fixture/engine, isolated DB): profile caps, plan schema + malformed-normalization + garbage rejection, no-fabricated-sources, labeled fallback, foreign-user refusals, Tamil metadata, footage honesty, Tamil-TTS honesty, **real assembly** (integer frames, labels, versions, audit, assemblyJson), **locked-track refusal**, **real render of the assembled timeline through the NIKKI render plan (built + executed, duration-verified)**, **real pipeline split fix**, batch dispatch validation | **16/16** |
| `test-studio-live.test.ts` (LIVE providers, clearly separated): **real LLM plan** (9 scenes, glm-4-plus, sources empty), **live scene regeneration** (only scene 2 changed), **real TTS** (5.06 s WAV, probe-READY, provenance), **assembly with `asr-segments` captions** (RIISHE transcribed the real TTS audio), **batch through the real worker** (job COMPLETED → plan created) | **5/5 live** |
| Full matrix `scripts/run-all-tests.sh` (M1–M8 regressions + studio-core) | **19 suites, 0 failures** |
| Gates | tsc clean · eslint --max-warnings=0 · prisma validate ✓ · production build ✓ (43 pages) |

Fixture vs live: the core suite uses REAL engine code with labeled fixtures; the live suite ran against the REAL configured LLM + TTS + ASR providers and is reported as such. No mocked response is presented as provider integration.

## 11. Migrations

Additive: `StudioPlan` (brief/plan JSON, status, plannerMode, assemblyJson, projectId indexed — relation one-to-many), `StudioScene` (per-scene fields + status + attribution + narrationAssetId), `StudioBatch`. `prisma validate` ✓, `prisma db push` applied; no existing model changed.

## 12. Known limitations (honest)

- Stock-footage search is not implemented (no configured provider) — generation/upload paths provided.
- TTS voices: English-capable `tongtong` verified; Tamil TTS unverified → refused with an honest message (upload path provided).
- Word-level caption timing remains M4's documented speech-energy estimate (provider returns no word timestamps).
- IMAGE stills are valid editable clips but the M6 renderer does not loop stills (disclosed in assembly notes); exports with still scenes need footage/video sources.
- Scene-to-generated-asset auto-assignment is best-effort by recency (disclosed; verify matches in the Storyboard).
- The export test renders a bounded window in CI (memory); full-length exports run through the same plan builder with the worker's 45-min budget.
- Publishing/upload integrations do not exist.
