# M43 — Professional Editing Intelligence, Transitions, Audio Generation & Mood-Aware Color

**Status:** Source of truth for the M43 editing workflow, agent responsibilities, technical architecture, supported effects, licensing, model integration, quality requirements and implementation roadmap.
**Branch:** `feature/ai-creative-studio`. **History:** first authored while three verified units (`a53f2aa`, `980b958`, `490bb6d`) awaited publication; published with M43-B once the owner's authorized device-login publication opened the gate (both branches pushed and SHA-verified; PR #34 open for owner review).

---

## 1. Purpose and non-negotiable constraints

M43 upgrades BEAN FX's **own** application — its timeline, commands, media pipeline, preview and FFmpeg export — into a professional AI-assisted editing system with a coordinated specialist crew. It is not a plugin, a separate editor, or a research report.

Constraints that every unit must satisfy (all verified in the current codebase, not assumed):

1. **One executor.** Every mutation — human click or AI proposal — flows through the canonical command union in `src/lib/editor/commands.ts` (zod schemas, per-command `apply*` + inverse construction, `applyCommand(seq, cmd)`). No LLM ever writes timeline JSON, DB rows or shell commands directly.
2. **One renderer, one queue.** All renders go through the durable job system (`src/lib/job-helpers.ts`, `JOB_TYPE_RENDER_TIMELINE`, `src/lib/media-worker.ts`). No second renderer, no competing queue. New isolated render adapters (e.g., motion graphics) must enqueue under the existing contracts.
3. **Rational, frame-exact timing.** Sequence fps is a rational (`{num, den}`); all positions are integer frames; source→timeline mapping uses `clipTimelineDuration(sFrame, sourceIn, sourceFps, seqFps, speed)` from `src/lib/editor/model.ts` (the same math the executor validates with). No float seconds in persisted plans; seconds appear only inside analysis tools and are converted to frames immediately.
4. **Media confinement.** File access only through `MEDIA_ROOT` + `isInsideMediaRoot()` (`src/lib/media-storage`), argv-array spawns (no shell), timeouts, stderr caps — the pattern proven by `detectSilenceRanges` / `detectSceneChanges` in `src/lib/my-ai/tools/`.
5. **Honest capabilities.** Model readiness comes from the registry (`src/lib/ai/models.ts` — `ready`, `readyReason`, `displayName`); styles disclose gaps (`src/lib/ai/styles.ts` — `disclosedGaps`). Nothing is claimed "available" that has not been installed and inference-verified.
6. **Visual identity.** Black / yellow (`#d4a017`) / champagne-gold panel styling is preserved; the crew UI extends the existing AI Studio (`src/components/bean/editor/ai-edit-chat.tsx` and siblings) and never replaces the Program Monitor or timeline.

---

## 2. Upstream references, reuse decisions and license register

Researched from source this milestone (repo pages + license statements fetched directly). **No code is copied from any of them in M43-B; adoption is pattern-level unless a file-level import is explicitly listed in a later unit's commit.**

| Repository | Code license | Artifacts / weights | Decision for BEAN FX |
| --- | --- | --- | --- |
| [storytold/filmcraft](https://github.com/storytold/filmcraft) | Dual MIT **or** Apache-2.0 (`NOTICE` required; ArtCraft name/logos are excluded trademarks) | Bundled assets each catalogued in its `ATTRIBUTION.md`; fonts OFL-1.1; symphonia MPL-2.0 | **Adopt architecture pattern only** (Rust codebase — nothing importable): single authoritative registry with ~650+ typed commands; UI, CLI, JSON control channel and MCP all issue identical `engine.execute` calls; enabled-state gating; engine-level undo; integer-tick deterministic time. This is the blueprint for M43-B (§5). |
| [gl-transitions/gl-transitions](https://github.com/gl-transitions/gl-transitions) | Repo MIT; **per-file `License:` headers are authoritative** — exactly two transitions are BSD, everything else MIT (treat a missing header as MIT per its README) | `gl-transitions.json` catalog: name, glsl source, params (type/default/min/max), author, license, tags, textures | **Adopt catalog + per-transition license manifest** (§6). Shaders stay data, not code forks: each imported transition keeps its original file header in BEAN FX's own manifest. Rendering maps onto the existing FFmpeg pipeline (`xfade`-style), not a new WebGL path, with a CPU fallback. |
| [ace-step/ACE-Step](https://github.com/ace-step/ACE-Step) | Apache-2.0 (code) | Checkpoints distributed separately on Hugging Face (`ACE-Step/ACE-Step-v1-3.5B`) — **the repo page states no checkpoint license; the HF model card must be verified per revision before any commercial use** | **Optional, local-only music generation integration** behind an explicit verification gate (§7.1). Code Apache-2.0 is safe to integrate with attribution; the checkpoint is *not* cleared until its exact revision + license are recorded in the license register. Consumer-GPU viable (~8 GB VRAM optimized mode) but **not viable on this 2-vCPU CPU-only workspace** — readiness must be reported honestly by the registry. |
| [SonyResearch/Woosh](https://github.com/SonyResearch/Woosh) | MIT (most code) + Apache-2.0 (V2A parts adapted from MM-Audio/MotionFormer) | **Pretrained weights CC-BY-NC 4.0 — non-commercial** | **Do not bundle or enable the weights** in any commercial BEAN FX distribution. The SFX subsystem is built so legally cleared models can plug in later (§7.2); immediate support = cleared libraries (CC0/public domain, CC-BY with attribution tracking), procedural SFX, user-imported audio. |
| [Gadfly-Yang/Colourway](https://github.com/Gadfly-Yang/Colourway) | MIT | Demo media from Pexels/Coverr under their free licenses | **Adopt the parametric-grading philosophy into an original BEAN FX Auto Color tool** (§8): analysis → 26-style editable numeric parameters (not baked LUTs), reference-signature matching bounded to *direction* not absolute values, per-shot evaluation with cross-shot consistency, preview-before-apply. Original implementation against BEAN FX's own FFmpeg filters. |
| [haidrrrry/claude-remotion-skill](https://github.com/haidrrrry/claude-remotion-skill) | MIT (skill); **Remotion engine itself has separate company-license terms — the engine is NOT adopted** | `SKILL.md`, `motion-patterns.md` (17 components), `theme.ts` pattern, examples | **Adopt motion-design craft rules** (§9): springs/easing over linear interpolation, 2–3-property entrances, 3–6-frame staggered choreography, exits faster than entrances, five-layer stack, Ken Burns on stills, one centralized theme, **all timing derived from fps, no magic frame numbers**, and the mandatory render→inspect-frames→fix verification loop. |
| [givemotion/givemotion](https://github.com/givemotion/givemotion) | MIT (`THIRD_PARTY_NOTICES.md` for bundled OFL fonts; Chrome/ffmpeg under their own licenses) | 22 editable HTML blocks, skill pack, `check`/`snapshot`/`review`/`analyze` QC commands | **Adopt patterns**: deterministic code-to-motion with a virtual clock (frame-exact), editable parameterized presets instead of flattened overlays, alpha-channel overlay exports that drop onto the existing timeline (e.g., at detected scene-change markers), agent self-inspection as a QC step. Not bundled as a dependency in M43-B; re-evaluated per unit. |

**License register requirements (binding):** every M43 unit that imports a third-party file, shader, font, model checkpoint or dataset must add a row to `docs/THIRD_PARTY_LICENSES.md` (created in M43-B) with: component, exact source URL + revision, license name, license text location in this repo (`NOTICE`/headers), commercial-use verdict, and who verified it. **Rejected licenses (e.g., CC-BY-NC for commercial distribution) are recorded as rejections, never silently included.**

---

## 3. The professional editing workflow (BRIEF → EXPORT)

The canonical pipeline. Each phase lists: inputs, the decisions a professional editor makes, the BEAN FX mechanism that implements it, and failure cases that must be disclosed rather than papered over. Timestamps are always rational-fps frame integers in persisted state; analysis tools may emit seconds internally but every plan step converts via `secToSourceFrames()` (silence) or `Math.round(sec × sourceFps)` + `clipTimelineDuration()` (scenes) before any command is built.

### Phase 1 — BRIEF
- **Editorial decision:** what is the video for, who is the audience, what platform, what duration target, what emotional arc? The brief is captured as structured context (`audience`, `platform`, `targetSec`, `mood`, `mustKeep[]`) in the RIISHE conversation — not as free text the agents re-interpret per phase.
- **Mechanism:** `ai-edit-chat.tsx` conversation (per-project, persisted) → `createPlan()` context (`ProjectContext` + brief fields).
- **Failure case:** vague brief ("make it better") → RIISHE must ask a targeted follow-up instead of guessing; the chat already supports multi-turn conversation, and M43-E adds plan-revision context.

### Phase 2 — INGEST
- **Decision:** is the media technically usable?
- **Mechanism:** existing `JOB_TYPE_MEDIA_PROBE` / `MEDIA_PROXY` jobs (durable queue) produce duration/fps/audio-presence metadata; assets get `kind` (VIDEO/AUDIO/…), `storagePath` (inside `MEDIA_ROOT`), proxy media for previews.
- **Failure:** unreadable/corrupt files are surfaced as failed probe jobs with the real ffmpeg stderr, never silently skipped.

### Phase 3 — ANALYSE
- **Decision:** where are the cuts, the silences, the speech, the subjects?
- **Mechanism (existing, real):** `detectSceneChanges()` (ffmpeg `select='gt(scene,T)',showinfo` — M43-A Unit 1), `detectSilenceRanges()` (ffmpeg `silencedetect` — M42-I Unit 1), `TRANSCRIBE_PROJECT` (ASR sidecar path), `VISUAL_INTELLIGENCE` / `TEMPORAL_INTELLIGENCE` / `GANGZII_ANALYZE` / `JAZMII_ANALYZE` durable jobs. Independent analyses run in **parallel** (they are read-only); results are evidence objects (`ClipSceneAnalysis`, `ClipSilenceAnalysis`, transcript sidecars).
- **Rules:** analysis is evidence, never authority — every downstream plan cites the tool banner and parameters in its warnings (the established pattern: `evidence: ffmpeg … on asset … (N range(s), ≥Xs at YdB)`).
- **Failure:** analysis not possible (tool missing, timeout, file outside root) → the planner returns `null` and the plan *discloses* ("scene analysis unavailable — no markers planned"), as already implemented in the scene branch.

### Phase 4 — STORY (Story Architect)
- **Decision:** opening hook, development, climax, ending; what to drop; scene order.
- **Mechanism:** the Architect proposes a *structure document* (acts, beats, target seconds per beat, which assets carry which beat) as LLM output validated against `ProjectContext`; it may only **propose** commands (reorder via existing `ReorderClip`-family commands, trims, markers) through the planner — never execute.
- **Decision rules:** a beat longer than ~1.25× the brief's target duration per act is flagged "weak section"; repeated content detected via transcript n-gram repetition + scene-evidence gaps; the hook must land within the first 2 beats or the plan says so and proposes a cold-open trim.
- **Failure:** no transcript and no visual analysis → the Architect works from scene evidence only and **says so** in its summary (honest scope, per §4 rules).

### Phase 5 — SELECTS (Assistant Editor)
- **Decision:** which takes/ranges are usable; bin organization; markers.
- **Mechanism:** `AddMarker` (canonical, frame-exact — proven by M43-A Unit 1), ranges recorded as labeled markers; false starts / repeated takes marked for removal using transcript + silence evidence; the analysis cap (silence currently analyzes ≤3 clips per request — a known gap) is lifted in M43-E with honest disclosure of batch size.

### Phase 6 — ASSEMBLY (Lead Editor)
- **Decision:** shot order, trim points, cut timing, continuity.
- **Mechanism:** existing commands — `TrimClip` (head/tail via `headTailTrim`), `SplitClip` + `RippleDelete` (interior removal via `interiorSplitPlan`), exact executor math re-validated on apply. Serial execution: timeline mutations go through the planner's ordered `APPLY_COMMANDS` steps; independent *analysis* is parallel, *mutation* is serialized (§5).
- **Failure:** timebase-impossible trims (<1 timeline frame) are skipped and disclosed — the established fail-closed pattern from M42-I/M43-A.

### Phase 7 — AUDIO (Sound Designer, Music Supervisor, Dialogue Editor)
- Music selection/generation + ducking + fades + SFX (§7). Dialogue cleanup only where the actual ASR/tools support it (filler-word removal requires word-level timestamps — disclosed when the model lacks them).

### Phase 8 — GRAPHICS (Motion Graphics Designer)
- Titles, lower thirds, kinetic type via NIKKI/NIIKI + the motion-graphics engine (§9) — editable elements, frame-exact timing, rendered through `NIKKI_RENDER`/`COMPOSITION_RENDER`-style existing job types, never flattened when editability is possible.

### Phase 9 — COLOR (Colorist)
- Mood-aware correction per §8: technical correction first (exposure/WB/contrast), creative grade second, per-shot, skin-tone-protected, with before/after preview and full reversibility.

### Phase 10 — CAPTIONS (Caption Editor)
- Transcription ≠ translation (§10): detect spoken language → transcribe → translate **only on request** → style/position → export SRT. Word-level timing only when the selected ASR model provides it (disclosed otherwise).

### Phase 11 — B-ROLL (B-roll Researcher)
- Suggestions carry source + license + relevance (§11); insertion requires user approval; nothing downloads silently.

### Phase 12 — QC (Quality Control Specialist)
- Real checks, real tools: black frames (`ffmpeg blackdetect`), freeze (`freezedetect`), silence at head/tail (`silencedetect`), audio clipping (`astats`/`ebur128`), missing media (asset integrity against `MEDIA_ROOT`), caption gaps, export verification (`ffprobe` of the rendered file vs. expected rational fps/duration/codecs). Findings become either *proposal steps* (fixable: e.g., trim a black tail) or disclosed *warnings* (not fixable automatically).

### Phase 13 — APPROVAL
- The complete proposed timeline change set is presented as a plan (`PlanSummary` with `steps`, `warnings`, `expectedChanges`, `approvalSummary`) in the chat; the user approves/rejects/revision-requests. Execution reports real status per step (`result.steps[]` with `operation`/`status`/`detail`) — the existing M42-E contract, extended by M43-C with per-agent attribution.

### Phase 14 — EXPORT
- `JOB_TYPE_RENDER_TIMELINE` (or `EXPORT_VARIANT` for 16:9/9:16/1:1 deliverables) → ffprobe verification of the actual file → the plan records the verified output. The preview and the export must agree (same executor state → same render inputs).

---

## 4. The editing crew — roles mapped to real capabilities

RIISHE remains chief creative director/orchestrator. Specialists are **capability-backed roles**, each with: role definition, system instructions, supported tools (registry-checked), input/output schema, playbook references (§3 phases), and tests. Where a role's full professional scope exceeds what current models/tools can do, the role is still created but its `disclosedGaps` say exactly what it cannot do — **no decorative claims**.

| # | Role | Department | Real tools it gets (existing, verified names) | Honest availability note |
| --- | --- | --- | --- | --- |
| 1 | **RIISHE** — Creative Director | Creative | `createPlan()` orchestration, all evidence appendices, plan approval flow, model registry routing | Fully available (M42-E proven). |
| 2 | **Story Architect** | Creative | Transcript sidecars, scene evidence, brief context | Text-reasoning models only; no independent shot-scoring until VISUAL_INTELLIGENCE evidence exists — disclosed. |
| 3 | **Lead Editor** | Creative | `TrimClip`/`SplitClip`/`RippleDelete`/`AddTransition` proposals via planner | Fully available on evidence-driven trims; *taste-level* cut timing remains a suggestion with preview. |
| 4 | **Assistant Editor** | Creative | `AddMarker`, ranges/bins via markers, media organization | Fully available (markers proven). |
| 5 | **Mistake Detection Specialist** | Creative | `detectSilenceRanges`, `TRANSCRIBE_PROJECT` sidecars, repetition analysis | Silence/pause detection real; "false start"/"bad take" classification is transcript-quality-dependent — disclosed when word timestamps are missing. |
| 6 | **Visual Analyst** | Visual | `detectSceneChanges`, `VISUAL_INTELLIGENCE`, `JAZMII_ANALYZE` | Scene cuts real (M43-A). Shot-size/camera-move classification only where JAZMII's actual VLM capabilities support it — reported per registry readiness. |
| 7 | **Continuity Supervisor** | Visual | Scene + visual evidence, marker timelines | Advisory only; cannot verify eyelines automatically — disclosed. |
| 8 | **Colorist** | Visual | §8 Auto Color tool (analysis + parameter proposals) | Analysis + parameter proposals fully local (ffmpeg); "mood" is a labeled recommendation, never an intention claim. |
| 9 | **VFX / Compositing Artist** | Visual | JAZMII (image generation/compositing via `JAZMII_GENERATE`), existing mask pipeline (`test-m33-mask-portability` contracts) | Available where JAZMII is ready; chroma key only where supported filters exist — disclosed per look. |
| 10 | **Motion Graphics Designer** | Visual | NIKKI/NIIKI (`NIIKI_GRAPHIC`, `NIKKI_RENDER`, `COMPOSITION_RENDER`) + §9 engine | Template-driven compositions real; free-form "design me a logo" is a generation task, not an editing command — routed honestly. |
| 11 | **Dialogue Editor** | Audio | ASR sidecars, silence tools, `TrimClip` math | Pause/filler removal needs word-level ASR — gated on model capability, disclosed. |
| 12 | **Sound Designer** | Audio | §7.2 SFX subsystem, audio fades/levels | Cleared-library + procedural + user-imported; generative SFX disabled until a cleared model verifies (Woosh NC — rejected for commercial use). |
| 13 | **Music Supervisor** | Audio | §7.1 music pipeline, `LAXII_GENERATE` where applicable, user-supplied music | Selection/ducking/fades real; **generation** gated on the ACE-Step checkpoint verification (§7.1) — the supervisor says "generation unavailable: checkpoint license unverified" rather than pretending. |
| 14 | **Caption Editor** | Audio/Lang | `TRANSCRIBE_PROJECT`, caption styling, SRT export | Transcription real where ASR ready; translation quality depends on the model — language support list comes from the registry, never hardcoded. RTL + Tamil/Hindi/English supported at the styling/export layer. |
| 15 | **B-roll Researcher** | Delivery | Local media library search, user-imported assets, JAZMII image generation | Local + user assets + generated imagery only; **no silent stock downloads** (§11). |
| 16 | **Social / Reframing Editor** | Delivery | Existing variants system (`EXPORT_VARIANT`, 16:9/9:16/1:1 proven in `test-m33-three-format` contracts) | Reframing via existing variant pipeline; subject-aware reframing only where VISUAL_INTELLIGENCE provides subject boxes — disclosed. |
| 17 | **Finishing / Export Specialist** | Delivery | `RENDER_TIMELINE`, `EXPORT_VARIANT`, ffprobe verification | Fully available. |
| 18 | **QC Specialist** | Delivery | §3 Phase 12 checks | Fully available (ffmpeg detectors + ffprobe). |

Crew requests route through RIISHE: "assign the Colorist" → single specialist; "run the documentary crew" → the workflow profile (M43-E) with parallel analysis + serialized mutations. Every plan step records **provenance** (`proposedBy: agentId`) — extending the existing plan persistence, not replacing it.

---

## 5. M43-B — Command foundation (FilmCraft-pattern registry over the existing executor)

The existing executor already satisfies the hard core: typed zod command schemas, per-command `apply*` functions, **inverse construction inside every apply** (undo), re-validation on apply (fail-closed), and plan-level approval. M43-B wraps it in an **authoritative registry** — it does not replace it.

### Registry contract (new: `src/lib/editor/command-registry.ts`)

Every entry derives from the existing zod schema and adds:

```ts
interface CommandDescriptor {
  id: string;                    // e.g. "timeline.trimClip" — stable, unique
  schema: ZodSchema<Command>;    // the existing union member, reused verbatim
  description: string;
  requiredCapabilities: string[];// e.g. ["timeline.mutate"] — checked against caller scope
  scope: "project" | "media";    // what the command may touch
  risk: "read" | "low" | "timeline" | "destructive"; // mirrors plan step risk
  requiresApproval: boolean;     // destructive/high-impact always true
  available(seq: Sequence, ctx: CommandContext): { ok: boolean; reason?: string }; // enabled-state gating (FilmCraft pattern)
  preview(seq: Sequence, cmd: Command): PreviewResult;   // before/after without mutating
  apply: typeof applyCommand;    // the canonical executor — not a wrapper
}
```

### Service methods (new: `src/lib/my-ai/commands-service.ts`, exposed via an API route for UI + agents + MCP)

- **`commands.list(filter?)`** — descriptors minus schemas; powers the crew UI and MCP tool listing.
- **`commands.describe(id)`** — full descriptor incl. parameter JSON schema (for LLM tool-use and MCP).
- **`commands.validate(id, params, ctx)`** — zod parse + `available()` gate + media-root containment checks; returns structured errors.
- **`commands.preview(id, params, ctx)`** — pure `preview()`: changed fields, affected frames, inverse preview. No mutation.
- **`commands.run(id, params, ctx)`** — single command: revision check (`expectedRevision`), apply, return `{revision, inverse}`; provenance recorded (`proposedBy`).
- **`commands.batch(commands[], ctx)`** — **revision-aware transaction**: all-or-nothing at the plan level (each command validated against the *sequentially updated* sequence; first failure aborts with the index and reason), one checkpoint, one inverse stack entry, atomic provenance. Timeline mutations stay serialized: batches execute in order, and concurrent requests are rejected on revision mismatch (deterministic execution).

### Callers — all the same executor

1. **Manual UI** — existing editor dispatch gains the registry's `available()`/`preview()` gates without changing its feel.
2. **RIISHE / specialists** — the planner's `APPLY_COMMANDS` steps remain the proposal format; execution now goes through `commands.batch` (identical math, added revision + provenance).
3. **MCP** — new allowlisted tools `beanfx.commands.list/describe/validate/preview/run/batch`, permission-scoped like the existing m22/m23 MCP surfaces (`test-m22-security`/`test-m23-security-release` contracts preserved).
4. **CLI/automation** — the same service behind an internal API route.

### Tests (M43-B)

- Schema/validation: every command round-trips zod; invalid params rejected with structured errors.
- `available()` gating: destructive commands blocked without approval; disabled states reported by `list`.
- Revision conflicts: stale `expectedRevision` → rejection, no partial mutation.
- Batch atomicity: injected mid-batch failure rolls back cleanly (checkpoint + inverse), timeline unchanged.
- Undo/redo: `commands.run` inverse == the existing editor's undo path (same `inverse` construction — asserted by equality of apply results).
- Preview == apply: for a fixture set, `preview()` deltas match actual apply results.
- Permission boundaries: caller without `timeline.mutate` cannot `run`; MCP allowlist honored (m22-style security assertions).

---

## 6. Transition engine — gl-transitions adoption

**Existing basis (verified):** `TransitionKind` (`src/lib/editor/model.ts:176`) already enumerates `CUT, CROSS_DISSOLVE, FADE_TO_BLACK, FADE_FROM_BLACK, WIPE_LEFT, WIPE_RIGHT, SLIDE_LEFT, SLIDE_RIGHT, PUSH_LEFT, PUSH_RIGHT, ZOOM_IN, ZOOM_OUT`; `AddTransition` (`commands.ts:135`) carries `{transitionId, trackId, kind, startFrame, durationFrames, params: Record<string, number>}` — the numeric `params` record is exactly the contract a shader-parameter set needs.

### Plan

1. **Catalog manifest** (`src/lib/transitions/catalog.ts`, data-only): each entry = gl-transitions name, category (fade / wipe / slide / push / zoom / blur / light / glitch / mask / cinematic), default duration (frames, derived from seq fps), parameter schema (name, default, min, max), **source revision + per-file license header text** (MIT except the two BSD files — recorded individually, per mandate §4). The two BSD transitions are either excluded from commercial builds or flagged in the manifest; the register (§2) tracks the decision.
2. **Kind extension** (M43-D unit): extend `TransitionKind` with the new categories' kinds (e.g., `BLUR_DISSOLVE`, `GLITCH`, `LIGHT_LEAK`, `MASK_REVEAL`) — additive enum extension, no migration of existing kinds; `params` carries per-transition uniforms.
3. **Rendering** (existing pipeline only): the FFmpeg render path maps transition kinds onto `xfade`-family filters (fade/dissolve/wipe/slide/push/zoom map directly; blur/glitch/light via `xfade` + filter chains or pre-rendered segments under `JOB_TYPE_RENDER_TIMELINE`). **GPU/shader fallback:** if the host lacks the required filter support, the render job falls back to `CROSS_DISSOLVE`/`FADE_TO_BLACK` and the plan/manifest discloses the downgrade — never a silent wrong output.
4. **Preview:** transitions preview through the existing Program Monitor render path (proxy media), so preview and final agree by construction.
5. **Editorial rules (the AI decides *whether*):** a transition is proposed only when (a) scene evidence shows a shot change AND (b) the brief/profile calls for it (e.g., documentary → subtle dissolves ≤ 12 frames; shorts → punch-in/zoom only; horror → light/glitch sparingly). Default is **CUT**. The planner is explicitly forbidden from carpeting the timeline: a batch with transitions on >30% of boundaries fails QC review with a disclosure.

---

## 7. Audio generation and placement

### 7.1 Music (Music Supervisor) — ACE-Step, gated

- **Pipeline:** brief/mood/pacing/scene-duration/dialogue-presence → music spec (style tag set, duration = edit length, instrumental when dialogue dominates) → **either** user-selected file **or** local ACE-Step generation (optional integration: Apache-2.0 code; checkpoint only after `docs/THIRD_PARTY_LICENSES.md` records the exact HF revision + its stated license + commercial-use verdict — **TO VERIFY**; until then the supervisor reports generation unavailable, per §4).
- **Placement rules:** music length matched to edit (`TrimClip`-equivalent on the audio clip); **auto-duck** under dialogue (sidechain-style via ffmpeg `volume` automation derived from transcript/silence evidence — music drops ≥ 12 dB under detected speech ranges); smooth fades in/out (existing audio fade filters); **beat-synced cuts** only when a beat grid is available (beat analysis is a stretch goal — disclosed when absent); never covering important dialogue (QC phase checks music level under speech).
- **This workspace:** 2 vCPU, CPU-only — generation is *not viable here*; the registry reports the reason (`readyReason`), and the unit ships with the integration tested against a fixture audio file instead of real inference.

### 7.2 SFX (Sound Designer) — cleared sources only

- **Immediate:** CC0/public-domain library import, CC-BY with **attribution tracking** (asset metadata row: source, author, license, attribution string), procedural SFX (synthesized whooshes/risers/hits via ffmpeg `sine`/`anoisesrc` + envelopes — original, unlicensed-risk-free), user-imported audio.
- **Woosh weights (CC-BY-NC 4.0): REJECTED for commercial BEAN FX** — recorded as a license-register rejection; the SFX subsystem interface is model-agnostic so a cleared generator can slot in later without rework.
- **Placement rules:** SFX agent analyzes the actual scene (scene-cut evidence + transcript) and proposes effect + frame + duration + level + pan; a scene gets at most a few deliberate effects, never filler noise; every insertion is an approved `AddClip`-family command with preview.

---

## 8. Mood-aware automatic color (original BEAN FX Auto Color, Colourway-philosophy)

**Separation of concerns:** technical correction (per-shot, objective) → creative grade (brief/mood, subjective, editable) → consistency pass (shot matching).

1. **Analyze** representative frames per shot (existing probe infrastructure; `ffmpeg signalstats`/histograms — CPU-cheap): exposure percentiles, WB drift (R/B channel medians), saturation, highlight/shadow clipping, skin-tone pixel cluster (bounded hue/sat region) deviation.
2. **Propose parameters** — a fixed, editable numeric set (Colourway-inspired ~26 knobs, original mapping onto BEAN FX filters): tone control points → `curves`; WB/temperature → `colorbalance`/`colortemperature`; saturation → `eq=saturation`; split-toning → `colorbalance` shadows/midtones/highlights gains; halation/grain/vignette → optional overlay filters (kept separate from the grade, toggleable). Skin tones are a **protected constraint**: proposals that push skin out of the natural range are rejected before preview.
3. **Match shots:** related shots (same scene per scene-cut evidence) receive the *same* grade direction; `Auto Match Shots` derives the target from the reference shot's metrics (direction-matching, per Colourway's finding that absolute matching fails across content).
4. **Reference Image Match:** a user-provided still is turned into a signature → bounded search → proposed parameters (never a baked LUT).
5. **Mood looks** (Cinematic, Warm, Cool, Dark/Suspenseful, Bright, Natural documentary, Vintage, Luxury, Romantic, Corporate, Travel, Horror, user-defined): parameter *presets* (editable), applied as starting points on top of per-shot correction — never one aggressive LUT for every scene.
6. **Preview → approve → apply:** before/after preview frames (proxy path); approval applies parameters through the command system as clip effects (existing effect-parameter commands / `params` records); `Reset to Original` = the recorded inverse. Render via the existing pipeline.
7. **Honesty rule:** the tool labels its mood read as a *recommendation* ("content reads warm/intimate") — it never claims to know the creator's intention; everything stays editable.

---

## 9. Motion graphics and titles (M43-D)

- **Editable elements, not flattened overlays** where the timeline supports it: titles/lower-thirds/callouts as text+shape elements with parameter records (existing effect-command pattern), so users re-edit text/position/animation after placement.
- **Unified theme system** (`src/lib/motion/theme.ts`): palette (black/yellow/champagne-gold defaults preserved), typography scale (licensed fonts + fallback stacks for Tamil/Hindi/Arabic scripts), spacing, **animation curves/spring presets** — one theme, no inline values (Remotion-skill rule adopted).
- **Frame-exact timing:** every animation parameter is expressed in frames derived from the sequence's rational fps (adoption of the skill's "all timing derives from fps"); durations are integer frames; staggering uses 3–6-frame offsets; entrances animate 2–3 properties; exits are faster than entrances.
- **Template library** (presets with editable parameters): animated title, lower third/name strap, kinetic typography (word-by-word when word timings exist from ASR, otherwise whole-phrase — disclosed), logo reveal, counter/data animation, callout, intro/outro sequence, animated background/gradient, Ken Burns (still images), social-media graphic.
- **Rendering:** template compositions render through the existing durable jobs (`NIKKI_RENDER`/`COMPOSITION_RENDER` contracts) with alpha-capable intermediates, dropped onto the timeline via canonical commands (e.g., at scene-change marker frames from M43-A evidence). No new global queue; no Remotion engine bundled (license note, §2).

---

## 10. Multilingual captions

- **Detect spoken language → transcribe → translate only on request.** The Caption Editor uses `TRANSCRIBE_PROJECT` sidecars; translation is a separate, explicitly-requested step with the model's language list taken from the registry (`readyReason`/capability metadata), never hardcoded.
- **Word-level timing** only when the selected ASR model emits it; otherwise phrase-level with disclosed precision. Kinetic captions (§9) degrade gracefully to phrase-level.
- **Never silently substitute an unsupported language or fabricate dialogue** — missing transcript ranges become disclosed gaps with timecodes.
- **Styling/export:** caption styling (size/position/color from the theme system, user-editable — "make the captions smaller" is a parameter edit, not a re-generation), SRT (+ existing export formats) export, RTL and complex-script shaping supported at the render/styling layer; Tamil, English, Hindi supported where ASR/translation models verify.

---

## 11. B-roll and image intelligence

- Sources allowed: **user-selected assets**, local media library search (inside `MEDIA_ROOT`), BEAN image generation (JAZMII) where ready, and imported files the user supplies with license metadata.
- **Every suggestion carries: source, license, relevance reason.** No silent downloads; nothing unlicensed enters the project. Insertion is approval-gated (`AddClip` + preview).
- Placement uses real evidence: scene-change markers (M43-A), silence gaps, transcript topics — B-roll lands at editorially motivated frames, with the reasoning shown in the plan.

---

## 12. Security, performance and licensing (binding)

- Project scoping: every agent call carries `projectId` + user session; media paths resolve inside `MEDIA_ROOT` via `isInsideMediaRoot` — always argv-array spawns, no shell, timeouts.
- No arbitrary shell execution from model output; no unrestricted filesystem access; no unapproved external uploads; MCP tools allowlisted + permission-scoped (m22/m23 contracts preserved and extended with the commands.* tools, §5).
- Model outputs, transcripts, captions and tool responses are **untrusted input**: plans are schema-validated, commands re-validated by the executor, and foreign text is escaped at render/styling boundaries.
- Destructive/high-impact changes require explicit approval; previews are understandable before/after; undoable by construction (inverse commands).
- Provenance: every step records which agent proposed and which executor applied it (plan persistence + `commands.run/batch` audit rows).
- **Performance:** lightweight analysis first (ffmpeg detectors are CPU-cheap and already proven here), batching + caching for frame sampling, optional GPU acceleration reported by the registry; **no Ollama, no unapproved paid APIs, no fake availability.**

---

## 13. Verification and live demonstration protocol

Every M43 unit ships with tests; the milestone demo (M43-F) runs this exact sequence on a real project and records evidence:

1. Import a real test video (`MEDIA_PROBE` + proxy).
2. Detect and remove a real mistake (silence/transcript evidence → `SplitClip`+`RippleDelete` plan → approve → verify frames moved).
3. Apply an editorially justified transition (scene evidence → `AddTransition` → preview → render segment → verify).
4. Add music (user file or generated-if-cleared) with ducking under detected dialogue.
5. Add at least one SFX (procedural/library) at a scene-cut frame.
6. Apply a mood-based grade → before/after previews → approve.
7. Add animated motion graphics (title/lower third from the template library).
8. Generate captions in the requested language → style → export SRT.
9. Insert one approved B-roll asset with license metadata.
10. Preview everything in the Program Monitor (real app, real proxy renders).
11. Render through `RENDER_TIMELINE` → **ffprobe** the output (codec/fps/duration match the sequence's rational fps).
12. Assert preview/export agreement (same executor state produced both).

**Test suites** (existing + new): `test-riishe-silence`, `test-riishe-scenes`, `test-m42-ai-edit-chat`, `test-m42-models`, m21/m22/m23 MCP+bridge harness, M43-B registry suite, M43-C crew-routing suite, M43-D motion-timing/frame-rate suite, batch/rollback/undo suites — all wired into `scripts/m41-verify-fixes.sh`. M33 render suites remain **ENVIRONMENT/HARDWARE BLOCKED** on this 2-vCPU host (documented evidence retained); they must pass on capable hardware before any "production-ready render" claim.

---

## 14. Implementation roadmap and publication gate

**Publication cycle (binding, per mandate):** IMPLEMENT → TEST → COMMIT → IMMEDIATE PUSH → FETCH REMOTE → VERIFY SHA → NEXT UNIT. The authorized push runs from the owner's `ebinj-dev` clone; this workspace's intentional guard (`remote.origin.pushurl = no-push-from-workspace-repo`) is never bypassed, and if it blocks, work stops before accumulating local-only commits.

**Gate status — RESOLVED (2026-11-25, verified):**

- The repository owner authorized a one-time GitHub device login; the workspace authenticated as `ebinj-dev` and both branches were published by fast-forward (non-force) and SHA-verified on a fresh fetch: `origin/feature/ai-creative-studio` = `490bb6d03f…`, `origin/feature/asr-semantic-sidecars` = `251bd8afd…`, `main` unchanged at `251bd8afd…`. The saved push guard (`remote.origin.pushurl = no-push-from-workspace-repo`) was never modified.
- Recovery PR: https://github.com/ebinj-dev/Bean-FX/pull/34 (open, owner review).
- M43-B (command registry) is implemented and tested on top of that base — see `docs/EDITOR_COMMAND_CONTRACT.md` for the as-implemented contract.

**Unit order** (each gated on the previous one's verified push):

| Unit | Scope | Primary code touchpoints |
| --- | --- | --- |
| M43-B | Command registry + commands.list/describe/validate/preview/run/batch (§5) | `src/lib/editor/command-registry.ts` (new), `src/lib/my-ai/commands-service.ts` (new), API route, MCP tools, tests |
| M43-C | Crew roles + RIISHE orchestration + provenance (§4) | `src/lib/my-ai/crew/` (new), planner attribution, chat roster UI (extends `ai-edit-chat.tsx`) |
| M43-D | Transition kinds + catalog manifest; motion-graphics theme + template presets (§6, §9) | `src/lib/transitions/`, `src/lib/motion/`, `TransitionKind` additive extension, NIKKI render path, tests |
| M43-E | Production workflows + conversational revisions + batch-silence cap lift + QC specialist (§3, §12) | planner workflow profiles, QC job types, tests |
| M43-F | End-to-end demonstration (§13) | evidence artifacts, ffprobe reports, recorded preview |

---

## 15. Known limitations (honest)

1. **This workspace** is 2-vCPU/CPU-only: no local music/SFX model inference (ACE-Step viability ends at registry disclosure until suitable hardware); M33 master-render suites stay hardware-blocked here.
2. **Publication** is owner-gated (§14) until the three pending units land on the remote.
3. **Checkpoint licenses** (ACE-Step) are not yet verified — generation stays disabled, reported honestly, until the HF model card revision is recorded in the license register.
4. **Woosh** is rejected for commercial use (CC-BY-NC weights) — the SFX interface anticipates cleared replacements.
5. **Analysis caps:** silence analysis currently covers ≤3 clips/request (lift planned in M43-E); scene detection caps at 20 markers/plan (disclosed in warnings).
6. **Shot-level semantics** (shot size, camera movement, eyelines) are available only as far as JAZMII/VISUAL_INTELLIGENCE actually deliver — the Visual Analyst and Continuity Supervisor disclose the boundary rather than inventing observations.
