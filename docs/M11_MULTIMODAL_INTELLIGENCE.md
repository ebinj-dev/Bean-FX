# M11 — Multimodal Intelligence & Advanced Smart Editing

M11 extends M10's Creative Director into a genuinely multimodal editing-intelligence system: video, embedded audio, speech, captions, scenes and timeline structure are analyzed TOGETHER, multi-clip edit plans are planned/previewed/approved, and analysis results are versioned and invalidated honestly. **M12 was not started; M1–M10 functionality is untouched (full matrix green).**

## 1. Architecture — what M11 resolves from M10's limitations

| M10 limitation | M11 resolution |
|---|---|
| Video-embedded audio never analyzed | §3 embedded-audio pipeline: ffprobe stream detection → derived extraction → GANGZII inspection, fully dedup'd |
| Transcript required a separate manual RIISHE run | §4 integrated transcription (`TRANSCRIBE_PROJECT`) with versions + approval + SRT export |
| Pause removal only inside ONE clip | §6 multi-clip planner (single-clip, cross-clip junctions, overlap merging, caps, margins) |
| Visual evidence limited to timeline structure | §5 REAL local scene analysis (JAZMII deterministic ffmpeg: scene cuts / black / freeze) — nothing uploaded |
| No preview before applying complex plans | §8 in-memory plan simulation (before/after, Δ duration, moved clips, warnings) |
| No analysis versioning/invalidation | §10 `CreativeAnalysisArtifact` dependency fingerprints + stale reasons + reuse |
| Findings not reachable from the UI | §9 "open in timeline" seek, evidence filters, per-rec preview |

New modules (all reuse existing engines — no new execution paths): `src/lib/creative/{multimodal,embedded-audio,transcription,crossmodal,crossmodal-recommendations,pause-surgery,preview,multimodal-jobs}.ts`; API `src/app/api/creative/analyze/{unified,transcripts,transcripts/[id]}` + `plans/preview`; UI extensions in `creative-panel.tsx`; two worker job types `CREATIVE_MULTIMODAL` / `TRANSCRIBE_PROJECT` on the EXISTING M3 worker.

## 2. Unified multimodal analysis (§2)

`buildObservations()` produces schema-validated (`ObservationSchema`) records, each carrying: projectId, versionId (timeline staleness formula shared with MY AI), assetId, clipId, streamIndex, **sourceStartSec/sourceEndSec (the file's own clock)** and/or **timelineStartSec/timelineEndSec (the sequence clock)**, method (`ffprobe | gangzii-inspection | riishe-asr | caption-parse | timeline-structure | jazmii-scene-analysis`), evidenceType (audio/speech/caption/visual/pacing/sync/structure), confidence, status (`analyzed | detected-not-analyzed | failed | unsupported | missing`) and detail. Mapping helpers (`sourceToTimelineSec` / `timelineToSourceSec`) are frame-exact and speed-aware; a source↔timeline round-trip test pins them. Missing, unsupported or corrupt streams produce honest observations — never invented ones.

## 3. Embedded audio analysis (§3)

`ensureEmbeddedAudioEvidence(userId, projectId, {waitSec})`:
1. **Resolve** the primary source: dedicated AUDIO assets first, else VIDEO assets probed by ffprobe until one reports audio streams (`probeMediaStreams` reads ALL streams with indexes).
2. **Extract** stream 0 into a derived AUDIO asset (`ffmpeg -map 0:a:N -c:a pcm_s16le`) registered through the EXISTING asset lifecycle with provenance notes (`{derived, parentAssetId, streamIndex, fingerprint}`). The source video is NEVER modified.
3. **Analyze** via the EXISTING `GANGZII_ANALYZE` worker job (real silence spans, LUFS, LRA, imbalance, clipping, level classification).
4. **Dedup**: an equivalent COMPLETED inspection (same target asset + stream tag + fingerprint) is reused; the derived AUDIO asset itself becomes the primary source on re-runs, so repeat analyses extract nothing. Additional streams (up to 2) are extracted and analyzed per run.
5. **Associate**: `mapSilenceToTimeline()` maps file-clock silence through the clips that carry the asset (VIDEO-track clips for embedded audio, AUDIO-track clips for dedicated audio) into timeline spans with clip references.
No-audio videos, corrupt files and unreadable streams become honest notes/observations.

## 4. Integrated RIISHE transcription (§4)

`runProjectTranscription()` reuses the REAL RIISHE ASR path (`transcribeWithAsr` — same provider adapters as Auto Cut; it decodes any container itself). Each run stores a **`TranscriptVersion`** (versionNo per asset): detected language (`detectLanguage` — never assumed; mixed/unknown recorded honestly), chunk-level segments with REAL provider timestamps, `wordsAvailable: false` (the provider supplies chunk-level timing only — word-level timing is never claimed), provider warnings (failed chunks, empty transcript, unidentifiable script), and dependency fingerprints. **Stale detection**: `markStaleTranscripts()` recomputes the asset fingerprint (id+size+mtime); a changed fingerprint marks versions STALE with the reason, and approval refuses stale versions. **Approval flow**: PENDING_REVIEW → approve (optionally generating a NEW SRT subtitle asset via `serializeSrt`; pre-existing SRT assets and clip captions are NEVER touched — verified by test) or discard. Unsupported language/provider combinations surface as warnings, not fabrications (live-verified with a Tamil attempt).

## 5. Cross-modal creative understanding (§5)

`analyzeCrossModal(ctx, scene)` combines measured audio, transcript, captions and REAL local visual analysis into new finding categories: `speech-across-cut` (measured transcript segments × scene cuts), `narration-without-visuals` / `visuals-without-narration` (measured coverage gaps), `static-visuals` (**model-observed** — JAZMII's deterministic ffmpeg scene/freeze/black analysis of actual frames; explicitly "no AI claims", nothing uploaded), `caption-mismatch` (measured word overlap vs transcript, inferred verdict — captions may legitimately paraphrase), `av-sync` (measured |audio−video| duration drift beyond a 0.35 s tolerance), `audio-gap` (measured no-audio stretches under video) and abrupt-cut observations. Honesty: without real scene analysis the visual findings are `insufficient-evidence` with an explicit "the video was NOT visually understood from filename or metadata" statement (tested). The evidence-label enum gained **`model-observed`** (local deterministic frame analysis) alongside measured / inferred / ai-interpretation / insufficient-evidence.

## 6. Multi-clip pause surgery (§6)

`planPauseSurgery(seq, timelineSpans, options, trackId?)` — deterministic, frame-exact M1 command planning:
- **Configurable thresholds** (`validateSurgeryOptions`): minPauseSec (0.5–20), minRetainedGapSec (0.05–2 — silence RETAINED around every cut so speech/breaths are never clipped), maxRemovalsPerRun (1–12).
- Overlapping/near spans are **merged** before planning (overlap resolution).
- Cases: pause inside one clip → SplitClip ×2 + RippleDelete (M10 path); pause crossing a clip junction → TrimClip tail of A + TrimClip head of B + MoveClip chain that keeps B adjacent to A's new end and shifts downstream clips on the SAME track by the full removed delta.
- Refusals with explicit reasons: locked tracks (whole plan), transitions touching the junction (transition semantics preserved), inter-clip gaps when video tracks exist (would desync picture/captions), cuts leaving less than the retained gap, source-mapping producing empty clips, run cap.
- Warnings: caption-bearing clips (caption text rides the clip), downstream shift synchronization on other tracks.
- Removals are planned on the ORIGINAL clock in DESCENDING start order, so the concatenated command batch is valid when applied sequentially.
- **Dry-run** (`validateSurgeryPlan`) validates the entire chain in memory before anything persists. Execution goes through the M10 recommendation approval flow: explicit approve → `applyTimelineEdits` as ONE versioned batch (atomic: any failure writes nothing; undo/redo and version history intact; stale versions rejected). Measured silence is never removed automatically — the planner only PLANS.
- Test-proven end-to-end: cross-clip pause across two adjacent clips executed through M2; timeline shortened by exactly the planned removal; caption preserved riding its clip; clip B left adjacent to trimmed A.

## 7. Scene-aware smart editing (§7)

`buildCrossModalRecommendations()` routes cross-modal findings through the SAME typed payload contract as M10 (`timeline-commands | engine-action | informational`): unsupported narration → JAZMII b-roll generation (executable, metered provider); static holds → cutaway/trim/motion-text options; caption mismatch → transcript-based regeneration that preserves existing captions; silent visuals / audio gaps → narration/music guidance; A/V drift → source-level advice. The multimodal job additionally emits ONE executable **multi-clip pause-surgery recommendation** (validated dry-run, preview payload with removals + skips) when measured silence maps to the timeline.

## 8. Preview & edit simulation (§8)

`previewPlan(seq, commands, affectedClipIds, cuts)` applies the plan to an IN-MEMORY sequence and returns: before/after clip summaries + durations, exact durationDeltaSec, the proposed cuts, moved clips (with from→to seconds), and warnings (cross-track synchronization, caption-bearing moves, transitions on affected clips). The API exposes three modes: raw `commands`, a stored `recommendation` (with stale check against `timelineVersionAtProposal`), and `pause-surgery` (planner + preview from the latest measured spans). The UI's Preview block renders before→after, Δ, cuts, moved clips and warnings, labeled "structural simulation — not a rendered export; nothing was written" (no DB writes ever — tested).

## 9. Evidence-linked Creative Director (§9)

The panel now shows: what/where/how each finding was detected (evidence JSON, engine, method, confidence, evidence label), "open in timeline ↗" on findings and recommendations (wired to the editor playhead via `session.setPlayhead`), **filter chips** (all/audio/speech/captions/visuals/pacing/sync/technical), per-recommendation preview simulation, the integrated-transcripts block (versions, warnings, approve→SRT / discard), and the Multimodal scope option. All M10 tabs and functionality are preserved.

## 10. Analysis versioning & invalidation (§10)

`CreativeAnalysisArtifact` rows (kind: unified | scene | transcript-ready stages) persist dependency fingerprints: asset fingerprint (id+size+mtime), timeline contextVersion, thresholds hash, provider/model — hashed into `depsHash` for **deduplication** (identical dependencies ⇒ reuse the stored result instead of recomputing; test-proven). At each multimodal run, `invalidateStaleArtifacts()` compares fingerprints and marks changed artifacts STALE **with the specific reasons** ("timeline changed (v:1:2:0 → v:2:3:120)", "source media changed (size/mtime)", "thresholds changed", "provider/model changed") while unaffected artifacts are reused and only affected stages recompute. Transcript versions carry the same fingerprint discipline. Everything runs on the EXISTING durable queue (no second job system), with duplicate-job prevention, bounded waits, cancellation between phases, and idempotent recovery.

## 11. Reliability, privacy, performance (§11)

Ownership enforced on every endpoint, job and row; project-scoped analysis; source media NEVER modified (extraction writes derived files only); failed-extraction temp dirs cleaned (test-proven); derived assets registered through the existing lifecycle with provenance; `consentVisual` gates any EXTERNAL visual interpretation (media leaves the server only with explicit consent — local ffmpeg scene analysis uploads nothing and needs none); no provider credentials in browser code; configurable thresholds and analysis limits; honest provider-failure messages (e.g. unconfigured ASR fails the transcript step with a typed note while the rest of the review completes). No Ollama.

## 12. Database & API changes (additive only)

Models: **`CreativeAnalysisArtifact`** (kind, sourceAssetId, streamIndex, status, depsJson/depsHash, staleReason, resultJson, provider/model, consentVisual, jobId) and **`TranscriptVersion`** (per-asset versionNo, language, provider, text, segmentsJson, wordsAvailable, status PENDING_REVIEW/APPROVED/DISCARDED/STALE, deps, captionAssetId). New API: `POST/GET /api/creative/analyze/unified`, `POST/GET /api/creative/analyze/transcripts`, `PATCH /api/creative/analyze/transcripts/[id]`, `POST /api/creative/plans/preview`. All enforce auth, ownership, zod validation, version checks and auditable transitions. Job types `CREATIVE_MULTIMODAL` (30 min) and `TRANSCRIBE_PROJECT` (15 min) registered in the existing job-helpers/worker tables. One environment fix: `tsconfig.json` now excludes the untracked user folder `BEAN-FX-Source-Export/` (uploaded material must not enter project type-checking).

## 13. Privacy & provider requirements

- ASR: the configured RIISHE provider (ZAI); audio is decoded server-side and chunked exactly as the existing Auto Cut pipeline does — transcription is always an explicit user/job action.
- LLM: brief/scorecard/variants unchanged from M10 (provider seam; honest degradation).
- Visual: local ffmpeg analysis (no upload); external VLM interpretation remains consent-gated and is NOT exercised silently.
- Never uses Ollama. No credentials client-side.

## 14. Tests & real-provider evidence (executed 2026-11-14)

| Suite | Result |
|---|---|
| `scripts/test-multimodal-core.test.ts` (fixtures + REAL ffmpeg/GANGZII/JAZMII-local/M1/M2, stub ASR labeled) | **26/26** — real multi-stream/no-audio/corrupt detection; frame-exact round-trip mapping; REAL embedded-audio pipeline (derived asset registered, source untouched, GANGZII measured, timeline-mapped, dedup reuse with zero re-extraction); honest no-audio/corrupt notes; transcript versioning (stub ASR: PENDING_REVIEW, wordsAvailable=false, honest warnings), approve→NEW SRT with existing captions untouched, discard, ownership, stale-on-source-change; cross-modal labels (model-observed only from real local analysis; metadata-based visual claims impossible); **cross-clip pause surgery executed through M2** (exact removal incl. retained margins, caption preserved, adjacency restored, version history intact); overlap merge, caps, margins, locked-track and gap refusals; preview accuracy + no writes; full CREATIVE_MULTIMODAL through the REAL worker (embedded audio + scene analysis + artifacts + honest transcript degradation); artifact dedup + stale invalidation; worker recovery, cancel ownership, temp cleanup |
| `scripts/test-multimodal-live.test.ts` (REAL providers) | **5/5 live** — ZAI TTS generated real speech; REAL ASR transcribed it exactly ("Welcome to Bean Effects. This video shows how to brew filter coffee step by step."); Tamil attempt honestly language-detected (no fabricated Tamil); REAL GANGZII on embedded audio (LUFS −20.3, speech); REAL local scene analysis (cuts/static/black/drift=2.02 s); REAL CREATIVE_MULTIMODAL end-to-end (5 findings, scene+unified artifacts, transcript v2) |
| Full matrix `scripts/run-all-tests.sh` (M1–M10 + M11) | **24 suites, 0 failures** |
| Gates | Project TypeScript clean (the untracked user folder `BEAN-FX-Source-Export/` is excluded from the project build and remains uncommitted) · ESLint `--max-warnings=0` on all M11 code clean · `prisma validate` + `db push` applied · production build ✓ with all M10+M11 routes |
| Browser E2E (production `next start`) | Logged in → editor → Creative Director → **Multimodal review queued FROM THE UI (job cmwfz835)** → COMPLETED → filter chips (7) filter findings → evidence labels rendered → Recommendations tab → honest behavior verified via session API: scope=multimodal, `audio-quality:insufficient-evidence` (this project's master video genuinely has no embedded audio and no timeline clips — the honest answer, not a fabricated one), unified artifact persisted |

Fixture vs stub vs live: core = real engine/media code with labeled fixtures and injected ASR stubs; live = real TTS→ASR→GANGZII→scene pipeline, reported as such. No mock output is presented as provider verification; no capacity claims are made (no load testing was performed).

## 15. Known limitations (honest)

- Word-level transcript timing is never claimed (provider supplies chunk-level timestamps); speaker separation is not claimed at all.
- Tamil ASR quality depends entirely on the configured provider (live attempt detected the audio honestly; no fabricated Tamil text).
- The multimodal job analyzes ONE primary audio source and up to 2 extra streams per run; larger multi-stream sets need repeated runs (recorded honestly).
- Scene analysis is heuristic ffmpeg scene/black/freeze detection (JAZMII's own label: "No AI claims"); semantic visual understanding requires consent-gated external VLM and is not exercised automatically.
- Inter-clip audio gaps are refused for automated removal when video tracks exist (cross-track desync protection) — manual cuts required.
- The preview is structural (clip lists, durations, moves, warnings) — it is not a rendered frame preview; rendering remains the M6 pipeline's role.
- Transcript approval generates a new SRT asset; automatic re-alignment of existing inline clip captions is not performed (existing captions are never modified).

## 16. Operational vs planned

**Operational and tested**: unified multimodal reviews on the durable worker; embedded-audio analysis with dedup and source→timeline mapping; integrated transcription with versioning, staleness and caption-preserving approval; cross-modal scene-aware findings with honest evidence labels; multi-clip pause-surgery planning, dry-run, preview and approval-gated versioned execution; artifact versioning/invalidation with explanations; evidence filters and open-in-timeline navigation. **Planned, not claimed**: consent-gated external VLM scene understanding (plumbing only), automatic inline-caption realignment, multi-stream full coverage per run.
