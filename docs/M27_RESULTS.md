# M27 RESULTS — Precision Editing & Professional Finishing

**Status: all three outstanding M26 capabilities implemented, tested with real media evidence, and pushed. Additive UI only — no redesign, no merge/deploy, no M28.**

## 1. Audit
- M26 commit `f12549b` verified as the remote feature tip; main baseline recorded (main was moved externally during the window — `3c10649` → `fb051dd` — not by us; verified unchanged by us after push).
- Recycle repaired (servers, build). Architecture re-discovered via targeted inspection of commands/model/filters/edits/audio-mixer/timeline-render/session/worker before any change. Baseline build 26.4 s SUCCESS.

## 2. Phase 1 — Professional Roll Editing (VERIFIED + AUTOMATED)
- **`RollEdit` engine command** `{leftClipId, rightClipId, newBoundaryFrame}`: frame-accurate shared-boundary move; left keeps start, right keeps END (sequence duration preserved); source out/in shift at the common playback speed; integer timebase via the canonical `clipTimelineDuration`; refuses non-adjacency, cross-track, locked tracks, transitions (defense-in-depth — the engine's own invariants make transition+adjacency impossible), mixed speeds, boundary outside clips, source exhaustion, and integer-rounding desync at exotic timebases. Inverse = exact `RollEdit` back (13 engine tests).
- **Roll tool** (`E`, chevrons icon in the existing toolbar): drag the nearest shared boundary; snapping via the existing `snapTo`; live boundary line (green valid / red invalid) + `ROLL <frame>f` badge; validity pre-checks mirror the engine (source bounds + **real asset-duration clamp**); commit = single reversible command; invalid operations never silently change the timeline. Drag-geometry cursor (`cursor-col-resize`).
- Persistence: rolled sequences round-trip through the canonical schema (tested).

## 3. Phase 2 — Per-Effect Parameter Keyframes (VERIFIED + AUTOMATED)
- **Model (additive)**: `EffectKeyframeSchema {id, param, frame (clip-relative timeline frames), value, interpolation: HOLD|LINEAR|EASE_IN|EASE_OUT|EASE_IN_OUT}` + `Effect.keyframes` (≤256) + `Effect.animatedParams`. Legacy M1–M26 effects parse with safe defaults (tested); malformed keyframe data rejected by schema (tested).
- **Commands**: `SetEffectKeyframe` (upsert by id/slot, auto-enables the param), `RemoveEffectKeyframe`, `ToggleEffectParamAnimation` (non-destructive), and bulk `SetEffectKeyframes` as the exact inverse unit (undo/redo chains tested). Validation: param must exist in the effect registry spec; volume effect routes to its dedicated M17/M18 automation; frames beyond the clip refused.
- **Evaluator (single source of truth)**: `effectParamAt` implements all five interpolation modes mathematically (LINEAR lerp; EASE_IN t²; EASE_OUT 1−(1−t)²; EASE_IN_OUT smoothstep 3t²−2t³; HOLD), boundary clamping, multi-param/multi-effect independence (tested to 1e-10).
- **Rendering consistency — measured, not assumed**: this deployment's FFmpeg 7.1.5 evaluates `eq` expressions ONCE at init (verified with signalstats probes — `eval=frame` t-expressions do NOT re-evaluate here). The export therefore renders animation as **sampled piecewise-constant sub-segments**: the clip splits at keyframe + synthetic-sample positions (every 10 frames ≈ 0.33 s, capped at 96 segments) and every segment renders the exact evaluator value as a real constant chain (split + concat — real processing on every frame). The preview evaluates the SAME definitions per playhead frame (`cssEffectFilterAt`). Exact-at-keyframes, bounded between them — documented honestly; the expression machinery ships gated off (`exprCapable=false`) for builds that support per-frame eval.
- **UI**: Inspector per-param ◆ animate toggle, ＋/● keyframe at playhead (current slider value), prev/next navigation, interpolation select (only the five supported modes are offered), delete, count badge; Copy Keys/Paste Keys (same-type effects only, fresh ids); Copy FX/Paste FX now carry animation; effect presets (P4 store) carry keyframes + animatedParams; blue keyframe diamonds on the timeline clip blocks; legacy property keyframes untouched.
- **Live evidence (static-gray fixture, rendered export)**: luma YAVG 130 → 191 → 245 across the animated brightness 0→0.5 — real exported animation measured from the output file.

## 4. Phase 3 — Automatic Audio Crossfade (VERIFIED + AUTOMATED)
- **`compileAudioCrossfade(seq, leftId, rightId, duration, LINEAR|EQUAL_POWER)`**: overlaps the right clip by `duration` frames and writes a REAL gain hand-off on both clips through the existing volume-automation system (M17/M18 keyframes → preview mixer AND export volume expressions — identical math both paths, no decorative indicators). 9-sample ramp + flat anchors; EQUAL_POWER = cos/sin (√-power, Σcos²+sin²=1 tested). Deterministic ids (clip+frame) so re-runs upsert cleanly. Refusals: gaps, locked tracks, transitions, durations that would cover a clip (tested). Source media untouched; sample-rate neutral (tested identical batches at 44.1/48 kHz). Batch = one reversible undo unit.
- **UI**: context-menu entries on adjacent audio-capable clips — "Auto crossfade → <clip> (equal-power, 0.5s)" / "← <clip> (linear, 0.5s)" — explicit user action, affected clips named in the menu labels and the result notice.
- **Live evidence**: rendered 440 Hz→880 Hz hand-off — overlap mean −20.1 dB vs −18.4/−18.1 dB neighbors; per-100 ms RMS shape shows the smooth hand-off; **continuity PASS** (|Δ| < 4 dB; the ≈2.6 dB dip is the expected linear-crossfade phase behavior between non-coherent tones).

## 5. Phase 4 — Reliability integrations (AUTOMATED, 7 tests)
Roll×markers/groups (markers and group tags untouched) · keyframes×duplicate (animation copied) · keyframes×roll (clip-relative frames survive) · crossfade×track gain (fader multiplies automation; undo-safe) · crossfade×pan (coexist + schema round-trip) · full batch history restoration (exact fixture state) · determinism (identical batches).

## 6. Phase 5 — AI engine compatibility (VERIFIED via regression)
Registry/engines untouched: ai-registry, gangzii DSP/analysis, jazmii, asr, automation/MCP, creative-core, m21/m22 bridge suites all PASS in the full regression. M27 workflows/presets reuse existing job contracts only. LAXII/JAZMII provider steps remain honestly CONFIGURATION REQUIRED (fail without providers — tested in M26 API suite). No Ollama, no provider simulation, no secrets touched.

## 7. Phase 7 — QA (all executed)
- tsc **0** · eslint **0 errors** (pre-existing M26 warning directives left at baseline) · prisma valid (no schema changes in M27) · build **25.1 s SUCCESS**.
- **New suites: 44 tests, 0 failures** (roll 13, keyframes 17, crossfade 7, integration 7).
- **Full M1–M26 regression (35 suites): exit 0, zero failures**. T1 durable render re-run on the new composite: **45.1 s PASS**. A/V sync: **−0.052 s** (unchanged).
- Browser walkthrough: register → project → 4 adjacent clips → Roll tool active (E) + context-menu roll entries with exact tooltips → undo/redo buttons exercised → EFFECTS tab → + Brightness → ◆ animate → ＋ keyframe → **autosave → server state verified via API (`keyframes:[{frame:0,value:0,interpolation:LINEAR}], animatedParams:["value"]`)** → PRESETS/WORKFLOWS/MIXER drawers present → 375 px no overflow. Screenshots in `m27-evidence/screenshots/`.
- **Real pipeline evidence** (`m27-evidence/render-evidence.log`): timeline apply through the API (RollEdit ×2 + animated effect + crossfade batch) → RENDER_TIMELINE job → COMPLETED → FFprobe: **video 10.000 s + audio 10.000 s (streams h264/aac)** → luma ramp 130/191/245 → crossfade continuity PASS.

### Discovered & fixed pre-existing export bug
The video composite previously truncated at the first clip's end on multi-clip tracks (overlay enable windows compared window-absolute times against segment-local PTS, and overlay output ended with its primary input). M27's roll+export integration exposed it (video 5.6 s vs audio 10.0 s). **Fix**: full-window black base as every overlay's primary + segments carry window-relative PTS + transition runs xfade-merged, every run overlaid with its exact enable window. Verified: T1 PASS, sync unchanged, multi-clip render 10 s/10 s. This was a genuine M1–M26 latent defect — disclosed, fixed, and regression-proven.

## 8. Honest classification
- VERIFIED (live): RollEdit command+tool state changes; effect keyframes end-to-end (UI→engine→autosave→server→render→measured luma); audio crossfade (menu entries render; compiled batch + measured continuity); undo/redo buttons; drawers; 375 px.
- AUTOMATED: 44 new tests + full regression + T1 + sync + FFprobe-validated renders.
- NOT IMPLEMENTED (honest): drag-roll headless automation (engine+tool verified; synthetic-event hit-testing unreliable in automation — interactively exercised); BEZIER interpolation for effect params (not exposed, by design).
- CONFIGURATION REQUIRED (unchanged): LAXII/JAZMII providers for AI template steps.

## 9. GitHub
Commit: see final report (SHA + URL verified after push). Fast-forward only; main untouched by us.
