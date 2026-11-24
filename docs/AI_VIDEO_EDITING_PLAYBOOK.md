# BEAN FX — AI Video Editing Playbook

**Milestone:** M42-C · **Version:** 2026.11.24 · **Maintainer:** BEAN FX / RIISHE program

This is the working knowledge base RIISHE (the AI Edit Chat's creative director) uses when planning and executing edits. It is structured, versioned and extensible: the machine-readable companion is [`scripts/ai-editing/style-recipes.json`](../../scripts/ai-editing/style-recipes.json) (loaded by the M42-G style engine), and each technique/recipe documented here is written so that its *executable* parts map one-to-one onto real BEAN FX editor capabilities.

**Two rules govern everything in this playbook:**

1. **A style is a coherent editing strategy, not a magic preset.** Recipes give ranges and reasoning; RIISHE adapts them to the actual footage, the user's intent and the project state.
2. **Never fabricate a capability.** If a recipe step needs something BEAN FX cannot execute today (e.g. true motion tracking, licensed music, diarization models), the engine must disclose the gap, offer a supported alternative, and continue — it must not silently skip the step or fake the effect.

---

## 1. How RIISHE consumes this playbook

| Stage (spec §15) | What the playbook supplies |
| --- | --- |
| Understand | Prompt-intent patterns (`AI_EDIT_PROMPT_GUIDE.md`) that map user language to style families |
| Analyze | Requirements per capability ("what the analysis must measure to support this style") |
| Creative direction | The style catalog: selection by content type, emotion, delivery target |
| Plan | Recipe fields → concrete plan values (pacing ranges, transition kinds, color effect ranges, caption styles) |
| Review | The recipe's quality checklist becomes the plan-review checklist shown to the user |
| Apply | Only fields that map to real commands survive into the canonical plan |
| Verify | `EDITING_QUALITY_CHECKLIST.md` gates the render |

Capability matrix: every recipe declares `needs` (capabilities not guaranteed locally). The style engine resolves each against the M42-D model/MCP capability registry and reports SUPPORTED / PARTIAL / DISCLOSED-GAP per style at plan time. The matrix lives in [`docs/ai-editing/STYLE_CAPABILITY_MATRIX.md`](ai-editing/STYLE_CAPABILITY_MATRIX.md) and is regenerated from `style-recipes.json` by tests so it cannot drift.

## 2. Editing grammar and techniques

Full glossary: [`ai-editing/EDITING_GRAMMAR_AND_TECHNIQUES.md`](ai-editing/EDITING_GRAMMAR_AND_TECHNIQUES.md). Executive summary of the four families RIISHE composes:

- **Cutting and continuity** — straight cut, continuity editing, match cut (graphic/action), cut on action, jump cut, smash cut, invisible cut, J-cut, L-cut, cross-cutting, parallel editing, montage (metric/rhythmic/tonal/intellectual), elliptical editing, long take, multi-camera editing, reaction cut, cutaway, insert shot, establishing shot.
- **Transitions** — hard cut, dissolve, fade in/out, fade through black/white, wipe, push, slide, zoom, whip pan, match transition, mask transition, light leak, film burn, motion-based transition, shape transition, audio-led transition.
- **Timing and rhythm** — slow/fast pacing, rhythmic cutting, beat synchronization, dialogue-driven editing, emotional pacing, action pacing, music-video pacing, build-up and release, suspense timing, comedic timing, silence and pauses.
- **Motion** — speed ramp, slow/fast motion, reverse playback, freeze frame, time remapping, motion tracking, stabilization, pan and scan, digital push-in, animated reframing, split screen, picture-in-picture.

**Executable mapping today:** cuts (AddClip ordering + RemoveClip/RippleDelete), transitions (CUT / CROSS_DISSOLVE / FADE_TO_BLACK / FADE_FROM_BLACK / ZOOM_IN as real xfade; ZOOM_OUT and the decorative families are honestly skipped), timing (timeline placement, `ChangePlaybackSpeed`, `TrimClip`, `SplitClip`), motion (`SetKeyframe` on opacity/scale/x/y/rotation/scaleX/scaleY/volume; digital push-in = scale keyframes; animated reframing = x keyframes). Motion tracking, stabilization (unless the host ffmpeg has vidstab), wipes/masks/light-leaks, freeze-frame-from-thin-air and reverse playback are **disclosed gaps** — the engine says so rather than pretending.

## 3. Style catalog

The catalog's home is the recipe registry (`scripts/ai-editing/style-recipes.json`); the human-readable cards with the full 22-field structure live in [`ai-editing/STYLE_CATALOG.md`](ai-editing/STYLE_CATALOG.md). Style families shipped in v1 (12 recipes):

- Cinematic: `cinematic-trailer`, `cinematic-storytelling`
- Social: `instagram-reel`, `vertical-reframe`
- Documentary: `documentary-interview`
- Events: `wedding-highlight`
- Gaming: `gaming-highlight`
- Commercial: `product-ad`
- Educational: `tutorial-explainer`
- Music: `music-video-montage`
- Sports: `sports-recap`
- Creator: `podcast-video`

Combination rules: recipes compose by *layer* — one **structure** recipe (trailer/storytelling/documentary…), one or more **delivery** recipes (vertical-reframe, instagram-reel), and optional **finish** layers (color treatment, caption style, audio strategy). Incompatible pairs (e.g. `wedding-highlight` + `gaming-highlight`) are rejected with the reason. Style gaps are disclosed per §1.

## 4. Visual appearance and finishing

Supported color treatments map to real effect params (brightness, contrast, saturation, exposure, temperature, tint, highlights, shadows, whites, blacks, sharpen, vignette, grayscale/blur as looks) — each applied with shot-sampled amounts, **never an arbitrary preset LUT**, and never a copyrighted third-party look. Guidance:

- **Natural color**: contrast ≤ 0.05, saturation ≤ 0.03 — correction, not grading.
- **Cinematic contrast**: contrast +0.08–0.15 with shadows −0.05–0.1; watch skin tones.
- **Warm/cool treatment**: temperature ±0.05–0.12; avoid pushing food/product whites.
- **High-key/low-key**: exposure ±0.1 with shadows/highlights compensation.
- **Night scenes**: exposure −0.05–0.1, blacks −0.05, temperature −0.03–0.08; keep faces legible.
- **Skin-tone preservation**: after any grade, sample a face region and keep hue drift < ±0.03 (analysis-assisted when JAZMII frame analysis is available; otherwise conservative ranges).
- **Black & white / monochrome**: grayscale 1.0 with contrast +0.05–0.15; consider vignette ≤ 0.15.
- **Vintage/retro/pastel**: saturation −0.1–0.25 + tint/temperature blends; disclosed as *stylized*, shot-matched.
- **Shot matching**: sample per-shot statistics first, then apply per-clip amounts so a scene reads consistently.

Highlight recovery / shadow detail / selective grading beyond the param set are partial (global params only) — disclosed.

## 5. Captions and titles

Supported now: caption clips with `CaptionStyle` (fontSize 8–400, color, background, position TOP/CENTER/BOTTOM), word-timing when an ASR source provided it, karaoke-style when word timestamps exist. Documented styles + positioning/safe-area/accessibility rules: [`ai-editing/CAPTIONS_AND_SUBTITLE_STYLES.md`](ai-editing/CAPTIONS_AND_SUBTITLE_STYLES.md). Lower thirds / animated titles / kinetic typography beyond caption clips are disclosed gaps (motion-graphics lane: NIIKI, not scheduled for M42).

## 6. Audio and sound design

Supported now: per-clip volume + `volume` keyframes (ducking = automated volume keyframes under dialogue), fadeIn/fadeOut frames, ChangeVolume, ChangePlaybackSpeed, silence trimming from `silencedetect` analysis. Delivery-specific loudness targets and the full sound-design strategy (music selection, SFX, foley, risers, ambience, stereo positioning, loudness normalization): [`ai-editing/SOUND_DESIGN_AND_MIXING.md`](ai-editing/SOUND_DESIGN_AND_MIXING.md). Noise reduction, music/source separation, and generated SFX require provider tools (GANGZII lane) — disclosed per project.

## 7. Workflows and quality

- [`ai-editing/EDITING_WORKFLOWS.md`](ai-editing/EDITING_WORKFLOWS.md) — the standard RIISHE job flows (montage, story edit, reframe, caption pass, revision loop) and their revision semantics.
- [`ai-editing/AI_EDIT_PROMPT_GUIDE.md`](ai-editing/AI_EDIT_PROMPT_GUIDE.md) — how user language maps to intents/styles/parameters, and how follow-up prompts ("make the intro shorter", "undo the last change") resolve against conversation state.
- [`ai-editing/EDITING_QUALITY_CHECKLIST.md`](ai-editing/EDITING_QUALITY_CHECKLIST.md) — the story/visual/audio/caption/export QA gate (spec §17) as a machine-checkable list.

## 8. Extension rules

Adding a recipe: (1) write the card in `STYLE_CATALOG.md` with all 22 fields; (2) add the JSON recipe to `scripts/ai-editing/style-recipes.json`; (3) run the style-engine tests (`bun test scripts/test-m42-style-engine.test.ts`) — they validate schema conformance, that every referenced effect/transition/keyframe param EXISTS in the editor model, and that the capability matrix regenerated from the JSON stays in sync with the docs. Recipes referencing non-existent capabilities fail CI by design.
