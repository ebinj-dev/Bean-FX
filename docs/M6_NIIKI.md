# M6 — NIIKI Motion Graphics & Animation Engine

Milestone goal: *"NIIKI: motion graphics & animation engine integrated directly into BEAN FX — animated captions, kinetic typography, lower thirds, titles, transitions, logo animations, overlays and reusable motion graphics — editable timeline objects, keyframes, previews and final rendering."* This document describes what SHIPPED (all of it running behind tests), not a proposal.

## 1. Architecture

```
nikki-panel / MY AI
   │  validated COMMANDS (AddTrack/AddGraphic/UpdateClipProperties/SetKeyframe/AddTransition)
   ▼
M1 command engine (applyCommand + inverses + assertValidSequence)   ← ONE history, native undo/redo/autosave
   ▼
Sequence (GRAPHIC tracks + clips w/ graphicStyle + keyframes)  — persisted as structured data
   ▼                        ▼
PREVIEW (browser)         EXPORT (server)
lib/nikki/state.ts ──→ THE SAME evaluator (lib/nikki/animation.ts) in both paths
lib/nikki/canvas.ts        lib/nikki/render.ts → FFmpeg drawbox/drawtext/xfade plan
monitor.tsx canvas layer   NIKKI_RENDER durable job → ExportFile
```

Parity by construction: both paths evaluate identical keyframe math at identical integer frames. The render test verifies parity ON PIXELS (a slide-in lower third lands at the resolved position; fade-in measured frame-by-frame; word reveals ordered correctly).

## 2. Animation model (additive to M1)

- **Keyframes** (clip-relative integer frames, per property): existing `opacity/scale/x/y/volume/rotation` + new `scaleX/scaleY/blur/letterSpacing`. Old sequences parse unchanged (defaults).
- **Interpolation**: existing `LINEAR/HOLD/EASE` + new `EASE_IN` (u³), `EASE_OUT` (1−(1−u)³), `EASE_IN_OUT` (symmetric cubic), `BEZIER` (CSS cubic-bezier(x1,y1,x2,y2) via Newton + bisection — deterministic on both paths).
- **Frame-accurate evaluation**: segments quantize to whole frames; FPS-aware tests prove a 1-second move at 30 fps and 60 fps lands on the same wall-clock values.
- **Expression builder** (`ffmpegExprFor`): closed-form polynomials for LINEAR/HOLD/EASE*; per-frame ladders through `cubicBezierProgress` for BEZIER (exact at frame times; >200-frame segments sample every 8 frames — documented bound). Segment boundaries shrink by 1e-7 s so decimal rounding can never flip a frame into the previous segment. The parity test translates the emitted expression to JS and checks EVERY frame against the TS evaluator (tolerance 1e-6).

## 3. Kinetic typography (Tamil-safe)

- Grapheme clusters via `Intl.Segmenter` — Tamil combining marks (ீ ் …) and ZWJ sequences never split; mixed Tamil/English tested.
- Modes: `wordReveal` (per-word fade+rise with stagger), `charReveal` (per-cluster fade), `typewriter` (hard char pop-in), plus whole-text `fade/slide/scale` with directions and animated tracking (`trackingFrom/To`, rendered as constant-tracking in export — preview shows the ramp; documented degradation).
- Word highlights (exact-match color+scale, editable), entrance + exit windows, animated outlines (stroke), shadows.
- Honest bound: >80 graphemes degrades char modes to word mode (protects the render filter budget).

## 4. Templates (§10) — structured, versioned assets

9 templates (`src/lib/nikki/templates.ts`), each `{id, version, label, category, style}`: lower-third bar/card, title scale-in/intro-slide, caption word-reveal/typewriter, news banner, section heading, logo pulse. Applying seeds a fully editable `NikkiGraphicStyle` on the clip (the clip records the version; no silent upgrades). Fonts: bundled Noto Sans + Noto Sans Tamil (SIL OFL 1.1, `public/fonts/NOTICE.txt`).

## 5. Timeline integration (§7)

Graphics are REAL timeline elements: `AddTrack(GRAPHIC)` / `AddGraphic` (template-checked, media-less clips are exempt from the no-fake-media rule BY the model when a template id exists), `UpdateClipProperties` (now including `graphicStyle`/`graphicTemplateId`), `SetKeyframe`/`RemoveKeyframe`, `SplitClip`/`TrimClip`/`MoveClip`/`RemoveClip` all work on graphic clips with inverses. Transitions: 6 existing kinds + new `SLIDE_LEFT/RIGHT, PUSH_LEFT/RIGHT, ZOOM_IN/OUT` — every kind maps 1:1 onto a real FFmpeg xfade in the render. Undo/redo/autosave/persistence/reload are the M1 session's own machinery (test: full graphic sequence round-trips through `parseSequence` and resolves identically after reload).

## 6. Real-time preview (§8)

The program monitor gained a transparent canvas layer sized to the sequence and redrawn **per playhead frame** from `activeGraphicsAt` → `graphicStateAt` → the shared evaluator — real animated preview (no screenshots), correct layer order (track order bottom→top), transparency, FontFace-loaded Noto fonts with documented fallback. Measured cost: 4 graphics × 600 keyframes → **0.14 ms/frame** (43 ms per 300-frame sweep), far inside the 33 ms/frame budget.

## 7. Final rendering (§9)

`buildNikkiRenderPlan(seq, {…})` composes:
- **Graphics**: per-clip `drawbox` (bar/card/underline shapes with eased growth) + `drawtext` chains — animated `x/y` (slide + keyframes), `alpha` (fade + per-word/char windows), `enable` windows, stroke (`borderw`), shadow, measured text widths.
- **Transitions**: video segments trimmed + normalized (`fps=`) then joined by `xfade` (all 11 animated kinds mapped; CUT joins hard).
- **Text metrics**: FreeType via PIL with **libraqm** (full Tamil shaping) against the SAME bundled fonts — real measurement, cached.
- **Jobs**: `NIKKI_RENDER` on the durable worker (900s/1800s→45min timeout, claim/heartbeat/retry), FFmpeg via `JobManager.runFfmpeg` (real progress, cancel, kill), **A/V sync guard** (rendered duration must match the plan window ±max(0.15 s, 2 frames)), output = ExportFile.
- Route `POST /api/nikki/render` validates the snapshot with `parseSequence` and ownership-checks EVERY referenced asset; clients cannot send FFmpeg arguments. Full-timeline export (audio mix, streaming) stays M9 scope — documented.

## 8. MY AI (§11)

`proposeNikki(instruction, ctx)` — deterministic intents (word-by-word captions, lower third, title from the left, larger+fade-out, highlight "word") → **command lists** applied through the session (re-validated by `applyCommand`); unmatched → honest 422 with examples; no LLM, no Ollama; `NIKKI_ENGINE` descriptor (usesLLM:false) as M8 groundwork.

## 9. Performance (measured this sandbox — not invented)

| Measurement | Result |
|---|---|
| 600 keyframes/clip × 4 clips, 900-frame single-clip sweep | 28.0 ms |
| Full-sequence graphics resolve (300 frames, 4 clips) | 43.0 ms (0.14 ms/frame) |
| 50 Tamil typewriter plans (41 graphemes each) | 1.3 ms |
| Title-card render 4 s (plan + encode, 1280×720) | ~2.5 s |
| 2-source xfade render 3 s | ~1.5 s |

Caching: text metrics are memoized per (font,size,text); per-frame state is O(keyframes on the clip). Preview never re-renders the whole sequence — only the active graphics at the playhead.

## 10. Tests (all executed; runner: `scripts/run-all-tests.sh`)

| Suite | Result |
|---|---|
| `test-nikki-core.test.ts` — easing anchors, CSS-ease reference values, frame accuracy, FPS awareness, expression↔evaluator parity (every frame, 6 curve cases), Tamil grapheme integrity + mixed text, word/char/typewriter plans, templates→commands→undo/redo→persistence, MY AI proposals, perf | **31/31** |
| `test-nikki-render.test.ts` — real FFmpeg: title card position + disappearance, fade-in on pixels, word-by-word ordering, xfade red→purple→blue, lower-third position parity, duration guards, Tamil metrics | **6/6** |
| M1–M5 regressions (editor, media pipeline, p3_union, words-srt, v5, riishe-timeline, gangzii ×3) | all green (see runner output) |

Browser-preview tests are honest: the sandbox has no real browser, so preview correctness is pinned by (a) the resolver tests and (b) rendered-pixel parity against the SAME math the canvas draws.

## 11. Known limitations (honest)

- Animated letter-tracking renders as constant tracking in export (preview shows the ramp).
- Blur keyframes apply as a constant in export (drawtext has no per-frame blur; documented).
- Render output is the burned-in composite (yuv420p); a transparent-overlay pass is M9 scope alongside full-timeline export and the audio mix.
- BEZIER segments >200 frames export sampled every 8 frames (≤2 % of range worst case).
- Per-word/char filters bounded (≤80 text units per clip; degradation is automatic and announced in notes).

## 12. Deployment

No new services; fonts ship in `public/fonts/` (OFL); FFmpeg/ffprobe already required; PIL+raqm used server-side for metrics (already present in the image). No database changes in M6.
