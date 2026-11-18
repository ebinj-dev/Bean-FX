# M14 Reference Audit — repositories, principles adopted, licensing

Studied before implementation (2026-11-15). Verdict: **inspiration only** — zero code copied, zero sample artwork/media/fonts/weights imported. Every M14 component is an independently written BEAN FX-native implementation (TypeScript / Prisma / existing NIIKI-LAXII-RIISHE engines / PIL + FFmpeg pipeline). The four repositories are Python/agent-skill ecosystems; no dependency from them is imported into BEAN FX.

## 1. bangtutorial/bang-motion — MIT (© 2026 Bang Tutorial; license file on HEAD reviewed)
Agent skill for motion design. Principles adopted (re-implemented natively):
- **Style brief before code**: M14.1 generates three candidate directions + recommendation; the creator must APPROVE a direction before any asset generation or timeline mutation (mirrors its approval gate; our directions are configurable data, not its 10 hardcoded styles).
- **Palette provenance**: every color states where it comes from — adopted in the ArtDirection palette contract (`source` per swatch: direction/system/user-brand).
- **Continuous world / one persistent subject**: translated into M14.2 scene-plan continuity fields and M14.8 composition background/foreground layering; not its standalone HTML app.
- **Verification loop**: its snap-and-check loop → our deterministic `validateComposition` QA + render verification frames (M14.8) + preview/export parity tests.
- Rejected: its `index.html` single-file app, CSS/GSAP/Three.js animation stack (BEAN FX's NIIKI evaluator stays authoritative), its starters verbatim (used as *principles only*).

## 2. Alisa0808/vox-director — MIT (© 2026 Alisa Qian; license reviewed)
- **One structured source across all stages**: its single `beats.json` → our `ScenePlan` document is the single structured source shared by art direction, asset generation, composition and motion (no competing scene-planning engines).
- **Beats/钩子→节奏→镜头 patterns**: narration segmentation into scenes anchored to RIISHE timestamps (real timestamps preserved verbatim; never invented — our own honesty rules, stricter than its TTS-driven timing).
- **"Look is born in the image stage"**: style consistency rules from the approved direction flow into LAXII prompts (M14.6 style-profile system).
- **A-roll keeps the real face / never repaints the subject**: for video layers we composite source clips as-is (no regeneration of user media).
- Rejected: its Atlas-cloud pipeline, sample films (`assets/` — NOT for reuse), TTS/voice pipeline (RIISHE remains the transcription source; no new transcription), beat-count presets copied.

## 3. alchaincyf/huashu-art-motion — MIT for code/docs with named exceptions (reviewed)
- **Style recipe cards**: parameterized style definitions (palette, medium, texture, line treatment, lighting, composition rules, shape language, consistency rules) → our `StyleProfile` schema (M14.6), original fields, no recipes copied.
- **One frame first / measure then rebuild layer by layer**: scene plan → keyframe ("poster") first, then motion; layered composition assembly.
- **Numeric QA gates + anti-PowerPoint gate**: deterministic composition validation + render verification; motion-intensity floor (a composition with no measured motion is flagged in validation notes, not silently approved).
- Rejected: its Canvas/Playwright engine (BEAN FX renders via the existing pipeline + PIL/FFmpeg workers), its `strokes.js` (**Arphic Public License** — NOT imported), bundled fonts (SIL OFL — we keep our existing Noto font stack under its own OFL notice), **character artwork/frames (demo-use only, explicitly NOT MIT — not imported)**, Clawd clips (not covered).

## 4. cloveric/claude-drawing-skill — MIT (license reviewed)
- **Directed, not sampled**: deterministic, seeded composition (fixed inputs → same output) — our composition evaluator is deterministic by construction (no Date.now/random in render paths).
- **Layered stages**: layered compositing with non-destructive sources (M14.8 never flattens the project).
- **Per-style checklists of real failure modes**: translated into `validateComposition` checks (bounds, alpha sanity, mask dimensions, NaN transforms).
- Rejected: its 83 style example scripts (principles only), numpy/Pillow painting library (we use the already-present python toolchain under its own licenses: Pillow HPND/MIT-CMU, numpy BSD-3 — same libraries M12/M13 already used, no new license surface).

## Licensing gate summary
| Component | Source | License | Use |
|---|---|---|---|
| Motion workflow principles | bang-motion | MIT | inspiration, independently implemented |
| Beat/scene structure principles | vox-director | MIT | inspiration, independently implemented |
| Recipe-card concept | huashu-art-motion | MIT (code) | inspiration, independently implemented |
| strokes.js | huashu-art-motion | Arphic Public License | **NOT used** |
| Character art/frames (huashu) | huashu-art-motion | demo-only, NOT MIT | **NOT used** |
| Sample films/gallery images | vox/bang | not for reuse | **NOT used** |
| Painting library | claude-drawing-skill | MIT | principle only, not imported |
| Fonts | existing BEAN FX Noto stack | SIL OFL 1.1 (existing NOTICE.txt) | unchanged |

Attribution: this file documents the inspiration sources; BEAN FX contains no copied code from these repositories, so no upstream copyright notices are required in distribution — nevertheless the inspiration mapping is preserved here. No large generated media is committed; assets produced at runtime register through the existing media lifecycle.
