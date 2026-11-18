# M13 — Temporal Visual Intelligence & Motion Tracking

M13 extends M12's per-frame visual intelligence into TEMPORAL understanding: real subjects are tracked across consecutive decoded frames, motion and camera movement are measured with documented coordinate systems, temporal events are evidence-linked, and validated tracks drive approved NIIKI motion graphics through the existing editing engine. **M14 was not started; M1–M12 functionality is untouched (full matrix green).**

## 1. Architecture — what M13 resolves from M12's limitations

| M12 limitation | M13 resolution |
|---|---|
| Frame understanding was per-frame; no multi-frame correspondence | §3 REAL CSRT tracking across consecutive sampled frames (OpenCV) |
| No motion measurement | §4 per-track motion records (direction, pixel speed, accel trend, jumps, repeated patterns) with documented coordinate systems |
| No camera-motion intelligence | §5 global registration (masked ECC / phase correlation / window-cumulative multiscale zoom) separated from foreground motion |
| Scene records were static | §6 temporal events (entry/exit/loss/onset/stop/sudden-change/repeats/camera-move/continuity-candidates/speech-over-motion) |
| Search covered scenes only | §7 temporal search over tracks, events and camera records (deterministic predicates + consent-gated provider ranking) |
| NIIKI graphics were anchor-static | §8 tracking-assisted motion graphics: anchor-offset % keyframes from validated tracks, HOLD through gaps, applied via M1/M6 through the approval flow |

New modules: `src/lib/creative/visual/temporal/{contracts,sampling,tracking,motion,events,search,mograph,jobs}.ts`; API `src/app/api/creative/temporal/{index,search,mograph}`; UI: **Motion** tab in the Creative Director panel; one new worker job type `TEMPORAL_INTELLIGENCE` on the EXISTING M3 worker. M12 extraction/provider/scene infrastructure is REUSED (`timelinePlacementsFor` exported, scene cuts and M12 scene summaries consumed from existing artifacts). No new queue, no new storage layer, no Ollama.

## 2. Tracking approach and licenses (§3/§12)

**Selected approach (§3 mandates choosing one reliable approach): detector-assisted CSRT tracking with global-motion compensation** — a real multi-frame correspondence pipeline, not per-frame descriptions:

1. **Global registration per frame pair** (§5): phase correlation on downscaled blurred grayscale (translation), with a **foreground-mask authority rule** — when the difference mask leaves visible background (coverage ≤ 0.5), a masked ECC affine alignment of the BACKGROUND is the only authoritative global estimate (a bright moving subject on a plain background cannot fake camera motion); full-frame motion (> 0.5 coverage) is measured directly by phase correlation. Garbage registration is rejected (half-frame wrap-around, low response) — never allowed to corrupt detection.
2. **Zoom** (§5): window-CUMULATIVE multiscale template matching (first vs last frame center patch, 0.5–3.2×, texture-variance guarded) — the cumulative effect separates a real zoom from per-pair texture noise; a log-polar phase-correlation variant was implemented and honestly rejected (sub-pixel radius shift for 1.5 % zoom ≈ 0.6 px is below reliable resolution at these frame sizes — documented).
3. **Detection**: registered consecutive-frame difference (|warp(prev)−cur|) → morphology → contour boxes ≥ `minBoxAreaFrac` with near-whole-frame contours rejected. Detection REQUIRES initial motion (documented: a subject static from frame 0 is not auto-detected).
4. **Tracking**: one OpenCV CSRT correlation-filter tracker per subject, updated on every consecutive sampled frame. **Loss detection**: update failure, degenerate/exit boxes, AND an appearance-consistency check (normalized cross-correlation of the tracked region vs the initial template — a subject that STOPS keeps tracking; a subject that LEAPS or LEAVES collapses NCC and the track terminates `tracker-lost` — no drift-following, no fabricated continuity).
5. **Occlusion**: sustained IoU > 0.55 between two live tracks flags the smaller as `occluded` with interval records. **Duplicate detection**: two tracks of the same window whose CENTERS stay within ~1.3× subject size for ≥60 % of shared samples are merged (difference-detection ghosts) — `terminationReason: "merged"` + `mergedInto`; never presented as two subjects.
6. **Re-appearance**: a later track appearing near where a `tracker-lost` track ended (position Δ < 0.18 frame, size ratio > 0.6) is linked as `reappearsAs` + a `subject-continuity-candidate` event labeled **`inferred` (confidence ≤ 0.4)** — explicitly "a CONTINUITY CANDIDATE for review, not an established identity". No real-person identification, no sensitive-attribute inference, no persistent identity claims across scenes.

**Licenses**: OpenCV (base + contrib) — **Apache-2.0** (commercial use permitted); numpy — BSD-3-Clause. No model weights are downloaded or bundled; the tracking worker is a self-contained python script written at runtime from the TS module. Commercial-use and redistribution terms were reviewed before integration (§12). `opencv-contrib-python-headless` is the installed provider of the CSRT tracker (the base package ships no tracking module — probed at runtime).

## 3. Temporal frame sampling (§2)

`planWindows()` splits scene-aware ranges (M12/JAZMII deterministic cuts) into ≤ `windowSec` passes; `extractTemporalFrames()` resamples each window at `sampleFps` (1–15) with the ffmpeg `fps` filter — variable-frame-rate inputs are CFR-ized first (the standard handling) and exact per-frame timestamps come from `showinfo` pts_time of the resampled stream. Every frame record carries asset, timeline clip, SOURCE seconds, TIMELINE seconds (speed-aware shared mappers — tested at playbackSpeed 2), dimensions, sampling interval, window index. Budget: `maxFrames` (≤300) with an even per-window spread; frames live in the per-run temp dir and are always cleaned (test-proven). Corrupt/unreadable media fails honestly.

## 4. Motion measurement (§4)

Every `MotionMeasurement` documents: coordinate system (`pixel-top-left-origin (sampled frame space) + normalized [0,1] center`), frame interval, resolution, net center displacement (px), **pixel speed only** (the limitations field states plainly: "pixel displacement in sampled-frame space; not real-world speed (no calibrated scene geometry)"), direction (from net displacement, with an area-based `toward/away-from-camera` proxy), acceleration trend (half-window comparison), motion onset/stop (foreground displacement > 1.5 % of frame diagonal), sudden position jumps (>15 % diagonal AND >3× the running median — scene-cut-adjacent steps excluded), repeated patterns (autocorrelation ≥ 0.7 of the foreground motion series), and **foreground px/frame AFTER subtracting the registered global motion**.

## 5. Camera movement (§5)

Per-window classification: `static | pan | tilt | zoom | pan-tilt | handheld-like | mixed | uncertain` from (a) the median registered translation per frame, (b) the window-cumulative zoom rate, and (c) the variance of the translation series. Confidence is reported; **high-variance moderate motion is conservatively labeled `handheld-like` with the explicit note that this "describes the measured statistics — NOT a cinematography classification"**; every record's note states that direction/type claims are limited to the reported magnitudes and that foreground motion was subtracted. Abrupt changes near scene cuts are excluded (cuts ≠ camera movement). Panning/zooming time spans are recorded as supporting evidence.

## 6. Temporal events (§6)

`buildTemporalEvents()` combines tracks + motion + camera + M12 scene ids + M11 speech spans (mapped to the timeline) into typed `TemporalEvent`s with event type, both clocks, scene/track ids, frame refs, method, evidence label (measured / model-observed / inferred / ai-interpretation) and confidence: subject-entry/exit/lost, occlusion intervals, motion onset/stop, sudden position changes, repeated motion, camera-move, static-span, `subject-continuity-candidate` (inferred), and speech-over-motion / speech-over-static (deterministic overlap — "not semantic intent"). Heuristic motion is never presented as confirmed semantic intent.

## 7. Temporal search (§7)

`POST /api/creative/temporal/search` — project-scoped, requires a completed temporal index (otherwise honest `available:false`). Two methods: **`local-predicate`** (deterministic: direction words incl. "left to right", entry/exit, category words, motion/static, repeated patterns, camera classes, time/track/asset filters — English-focused, Tamil queries get the explicit note) and **`provider-ranking`** (consent-gated TEXT-only ranking of bounded temporal records, validated by `VisionTemporalRankingSchema`, EN/TA). Results carry kind (track/event/scene), both clocks, relevance, evidence and preview assets; the UI seeks to the exact timeline position. Live evidence: query "a bright object moving quickly across the frame" → the track with an explanation citing "38 samples, moving right at 32.99px/s" and honestly noting "no evidence of brightness".

## 8. Tracking-assisted motion graphics (§8)

`buildMographProposal()` converts a VALIDATED track (≥4 positioned samples — sparse tracks are refused honestly) into a NIIKI proposal: template from the versioned M6 registry (callout → lower-third fallback), tracked normalized centers → % of frame → **clip-relative `x`/`y` keyframes OFFSET FROM THE ANCHOR** (the exact semantics of the M6 evaluator both the preview canvas and the export compositor evaluate — parity by construction), decimated to ≤40 keyframes. **Gap handling**: within a tracking gap the graphic HOLDS its last measured position (HOLD keyframes + gap records + warnings); positions are NEVER extrapolated past the last observation; `tracker-lost` tracks warn explicitly. Previews draw the tracked path + current box on REAL sampled frames (PIL) registered as IMAGE assets. The payload is M1 `AddTrack` (GRAPHIC, only if none exists) + `AddGraphic` (the M6 panel's own command) with the full graphic style — validated by `parseCommand` and executed ONLY through the approval flow into `applyTimelineEdits` (versioned, undo/redo intact — test-proven), surfaced as executable CreativeRecommendations plus a `temporal-mograph` artifact for the UI.

## 9. Advanced recommendations (§9)

Temporal recommendations extend the M10 recommendation system with temporal evidence: motion-graphics placements (executable, approval-gated), long static intervals (informational), sudden subject position changes landing awkwardly in narration (informational), repeated-motion and B-roll-with-similar-movement notes — each with target timeline range, evidence references and risks; destructive changes are never automatic.

## 10. Temporal workspace (§10)

New **Motion** tab in the Creative Director (all M10–M12 tabs preserved): run controls (sampling rate, consent checkbox with the exact disclosure — "Local tracking (OpenCV CSRT) and camera registration upload NOTHING — consent only controls optional subject labeling"), review progress, staleness + honest missing-evidence, **Object Tracks** (category + provenance, sample counts, entry/exit on both clocks, direction/speed/accel, occlusions, termination, inferred re-appearance links, confidence) with **Track Inspector** (per-sample box coords + normalized centers + visibility + seek ↗), **Camera Movement** (per-window classification with medians + note), **Temporal Events**, **Temporal Search**, and **Motion Graphics Proposals** (keyframe counts, gap warnings, real-frame preview thumbnails, approval routed through the Recommendations tab). No separate editor; the program monitor is untouched.

## 11. Jobs and versioning (§11)

`TEMPORAL_INTELLIGENCE` (45 min, per-user concurrency 1) on the existing durable worker: stale invalidation with reasons → whole-run dedup (identical deps ⇒ stored temporal index REUSED — no re-sampling, no re-tracking; test-proven) → M12/M11 reuse (scene cuts artifact, M12 scene summaries) → sampling → local tracking → camera classification → motion → consent-gated provider labeling (≤4 crops, validated `VisionTrackLabelSchema`, usage recorded) → events → mograph proposals + recommendations → artifacts (`temporal-index`, `temporal-mograph` on the EXISTING `CreativeAnalysisArtifact`) with fingerprints (asset mtime, timeline contextVersion, settings hash, tracking model). Cancellation between phases, idempotent recovery, temp cleanup in `finally`.

## 12. Privacy (§12)

Local tracking, camera registration, motion analysis and search predicates upload NOTHING and require no consent. The ONLY external transmission is optional subject-category labeling of ≤4 small tracked crops to the configured vision provider, gated by the explicit per-run consent checkbox, disclosed in the enqueue response ("Local tracking uploads NOTHING; consented provider labeling sends ≤4 small subject crops to glm-4.5v (usage recorded, no $ estimate)") and recorded via `AIUsage` + audit rows. No invented cost rates. No Ollama.

## 13. Database & API (additive only)

**Zero schema changes** — temporal data lives in `CreativeAnalysisArtifact` (kinds `temporal-index` / `temporal-mograph`), `CreativeReview` scope `"temporal"` (String column), `CreativeRecommendation`/`CreativeFinding` (existing models). New API: `GET/POST /api/creative/temporal/index`, `POST /api/creative/temporal/search`, `POST /api/creative/temporal/mograph` — session auth, project ownership, zod validation, version checks, audit rows.

## 14. Tests & real-provider evidence (executed 2026-11-14)

| Suite | Result |
|---|---|
| `scripts/test-temporal-core.test.ts` (REAL OpenCV tracking over REAL ffmpeg fixtures with KNOWN motion) | **15/15** — window planning; consecutive sampling with exact pts spacing + both clocks; speed mapping (playbackSpeed 2); corrupt media refusal; **REAL multi-frame tracking with KNOWN ground truth** (35 px/s box → measured 35.02 px/s, direction right, monotonic x across consecutive samples, ghost duplicate MERGED); entry/exit with near-edge evidence + honest loss (NCC appearance consistency); two separated subjects (no false merge); static scene (no tracks, camera STATIC, static-span event, searchable); **REAL camera PAN measured globally and NOT misattributed to subjects** (foreground ≈ 0 after subtraction); **REAL camera ZOOM with window-cumulative scale evidence** (±direction recorded honestly); tracking gap → tracker-loss + re-entry + INFERRED continuity candidate (no identity claim); temporal search predicates/filters/honest misses/Tamil note; motion-graphics proposal (coordinate-converted keyframes, gap honesty, `parseCommand` validation, **REAL M1/M2 AddGraphic insertion with version bump and surviving keyframes on a GRAPHIC track**); **FULL TEMPORAL_INTELLIGENCE through the REAL worker** (artifacts, findings, executable recommendations, temp cleanup, REUSE on identical deps, mtime-change invalidation with reasons); ownership + no-video honest failure |
| `scripts/test-temporal-live.test.ts` (REAL providers) | **2/2 live** — REAL TEMPORAL_INTELLIGENCE job WITH consent through the REAL worker: real CSRT tracking (40 frames, 1 track, ground-truth motion verified) + **REAL glm-4.5v subject labeling of a REAL tracked crop** (`"object"`, categoryProvenance "provider"); REAL provider-ranked temporal search (top = the track, evidence citing "38 samples… moving right at 32.99px/s", honestly noting the query's "bright" was not verifiable) |
| Full matrix `scripts/run-all-tests.sh` | **28 suites, 0 failures** (M1–M13) |

Fixture vs stub vs live: core = real engine/media/OpenCV code with labeled injected providers where a provider is needed; live = real consent-gated provider calls reported as such. Independent frame descriptions are never presented as tracking; simulated boxes are never presented as tracking evidence — every track carries its real sample list with coordinates both clocks.

## 15. Known limitations (honest)

- Detection requires initial motion inside a sampled window (subjects static from frame 0 are not auto-detected) — stated in the index notes.
- CSRT identity through FULL occlusion is not guaranteed: occlusion intervals are flagged and the re-appearance link is `inferred`, never identity.
- Pixel speeds are not real-world speeds (no calibrated scene geometry) — stated on every measurement.
- Zoom estimation is a window-cumulative multiscale match with ±6 %/frame dynamic range and 0.5 % steps; zoompan direction semantics vary across ffmpeg builds — the direction is recorded as measured, not assumed (log-polar alternative honestly rejected and documented).
- One primary video asset per run; English-focused local predicates (Tamil via consent-gated provider ranking).
- Motion-graphics follow uses sampled keyframes (≤40) with LINEAR interpolation between MEASURED positions only — sparse intervals HOLD, never extrapolate; fast subjects are warned as approximate.
- No load testing performed — no production-capacity claims.
