# M16 Audit — real limitations in the M15 editing engine, root causes, and architecture

Audited 2026-15-11 against `feature/ai-creative-studio` @ `8c54096`. Git state verified: remote feature tip = M15 commit `8c54096`, main `2c48276e` unchanged, auth OK; the environment auto-deletion of `src/app/api/media/upload/[uploadId]/route.ts` was restored from HEAD before any M16 work. All M15 functionality preserved.

## Root causes of the remaining editing limitations (traced in code)

1. **Playback clock accumulates drift.** `monitor.tsx` tick: `next = Math.round(playheadRef.current + elapsed * fps)` — each tick rounds from the *previous rounded* playhead, so error accumulates (±1 frame per tick at worst). Fix: anchor-based clock — `playhead = startPlayhead + (now − startTime) × fps`, rounded once per tick.
2. **No clip-boundary preloading.** A single `<video>` element follows the resolver; at every clip boundary the element swaps `src` and re-loads → a visible stall/black frame and A/V desync for one clip-length. Fix: double-buffered video pool with preloaded next clip.
3. **Seek interruption is unguarded.** `video.currentTime = desiredTime` fires even while a seek/decode is in flight; stale frames can render after a fast scrub. Fix: seek generation counter; obsolete seeks cancelled; render only from the latest generation.
4. **Audio preview drops contributors beyond 4** (fixed `<audio>` element pool, index-mapped). No pan, no track gain, no master control, no fade automation beyond the fade multiplier, element-based mixing is not sample-synced. Fix: Web Audio mixer — `AudioBufferSourceNode` scheduled on the AudioContext clock mapped from timeline seconds, clip GainNodes (volume + fade ramps), StereoPannerNodes, track/mute/solo/master gain chain; LRU decode cache; element-pool fallback.
5. **There is no timeline→video renderer.** Every existing export path (`process/burn-captions`, `EXPORT_VARIANT`, NIIKI jobs) renders from a SINGLE source asset. The multitrack sequence cannot be exported as its edit — the biggest M16 gap. Fix: durable `RENDER_TIMELINE` job building one ffmpeg graph: per-clip `trim`+speed+effects+fades segments, NIIKI graphic filters (`buildGraphicFilters` reused), caption `drawtext`, overlay chain in track order, `amix` audio with per-clip `volume`/`afade`; ffprobe validation.
6. **Effects pipeline is real but tiny** (`EffectType` = opacity/volume/flipH/flipV/grayscale/blur) and preview parity is implicit. Fix: extend the enum additively (brightness/contrast/saturation/exposure/temperature/tint/highlights/shadows/sharpen); ONE mapping module (`lib/editor/filters.ts`) generates BOTH the CSS filter string (preview) and the ffmpeg filter string (export) — single source of truth, unit-tested; parity verified in-browser by comparing a canvas frame drawn with `ctx.filter` against the ffmpeg-rendered frame.
7. **Timeline renders every clip of every track every frame** — fine for small projects, O(clips) per playhead tick at 30–60 fps. Fix: cull clip blocks to the visible frame window + memoized waveforms (peaks fetched once per asset, downsampled per width) + client-side poster capture (`<video preload=metadata>` → canvas → LRU data-URL cache) for real clip thumbnails.
8. **Canvas lacks multi-select/nudge/alignment**; anchor-point editing is NOT supported by the model's `Transform` (no anchor field) — honestly out of scope rather than faked.
9. **No Ctrl+S** and no unsaved-changes guard; autosave exists (600 ms debounce) but a reload mid-save can lose the last batch. Fix: Ctrl/Cmd+S flush, `beforeunload` guard when saveState ≠ saved.

## Baseline (before M16, measured in the sandbox)

- M15 E2E playback: play/pause/step work; multi-clip playback shows a load stall at each boundary (root cause #2); audio silent beyond 4 contributors (#4).
- Timeline: 60 fps scrubbing on small sequences; re-render of all clip blocks per playhead frame (#7).
- Playback frame rate / dropped frames: measured in Phase H (browser E2E with rAF drift instrumentation), reported honestly.

## Architecture decisions

- **Playback engine**: `lib/editor/playback.ts` — framework-free controller (clock, scheduler, seek generations); React only subscribes. Integer-frame state; rational FPS honored.
- **Audio**: `lib/editor/audio-mixer.ts` — Web Audio graph as the MASTER clock when active (video element synced to it); element-pool fallback when AudioContext/decode fails. GANGZII remains the only processing pipeline (no fake DSP).
- **Editing ops**: `lib/editor/edits.ts` compiles Insert/Overwrite/Roll/Lift/Extract to EXISTING reversible M1 commands (atomic batches) — no new engine semantics; invalid ops refuse honestly.
- **Effects/color**: additive `EffectType` extension + `lib/editor/filters.ts` dual mapping + inspector COLOR panel; unsupported things are not displayed.
- **Renderer**: `lib/publish/timeline-render.ts` + `RENDER_TIMELINE` job on the existing durable worker (M3/M9 contracts unchanged), output registered as a real `ExportFile`, validated with ffprobe.
- **No second composition model, no parallel engines, no Ollama, no arbitrary code execution.**
