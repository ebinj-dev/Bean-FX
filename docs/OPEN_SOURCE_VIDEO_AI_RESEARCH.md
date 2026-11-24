# BEAN FX — Open-Source Video-AI Repository Research & License Register

**Milestone:** M42-B · **Status:** living document · **Last reviewed:** 2026-11-24 (web-search verification; SHA pins to be captured at integration time)

Purpose: register the open-source projects relevant to BEAN FX's AI editing roadmap (RIISHE, media analysis, transcription, enhancement), record their exact licensing, and record an integration decision per candidate. This document is the gate required by the M42 spec (§12): **no code from a candidate enters BEAN FX without an entry here and a decision of APPROVED or CONDITIONAL.**

Verification method: repository license files and metadata were checked via web search on the date above; before actually vendoring or pinning any dependency, re-verify the license at the pinned commit and record the commit SHA in the "Pinned" column. A repository's code license does not cover its model weights, datasets, bundled assets, or transitive dependencies — each is listed separately where relevant.

Decision legend:

- **APPROVED** — permissive license, compatible architecture, integrate when the feature needs it.
- **CONDITIONAL** — integrate only with the stated conditions (e.g. owner approval, subprocess isolation, license re-verification).
- **REFERENCE ONLY** — study behavior/architecture; do not copy code.
- **REJECTED** — incompatible license or no realistic integration value.

---

## 1. Editorial and timeline

### OpenTimelineIO — AcademySoftwareFoundation/OpenTimelineIO
- URL: https://github.com/AcademySoftwareFoundation/OpenTimelineIO
- License: **Apache-2.0** (code); Python API under the same license. C++ core + Python bindings.
- Purpose: editorial interchange (EDL/XML/OTIO), timeline representation, cross-NLE conversion.
- Model weights / datasets: none.
- Transitive deps: standard Python libs; optional `otio-cmx3600` adapters are separate plugins.
- Codec/patent concerns: none (metadata only — never touches media bytes).
- Maintenance: active ASFFoundation project, frequent releases.
- Proposed integration: optional export/import adapter for the project-archive manifest → OTIO timeline (new, additive); pure metadata mapping written in BEAN FX, using OTIO only as a *format reference* or via a Python subprocess if installed.
- **Decision: APPROVED (format-level first; runtime dependency only if/when owner approves adding the Python package).**

## 2. Scene analysis and computer vision

### PySceneDetect — Breakthrough/PySceneDetect
- URL: https://github.com/Breakthrough/PySceneDetect
- License: **BSD-3-Clause** (code); depends on OpenCV (Apache-2.0 for 4.5+).
- Purpose: shot/scene-boundary detection (ContentDetector, AdaptiveDetector, ThresholdDetector).
- Model weights: none (classical CV).
- Codec concerns: none (decodes via OpenCV; BEAN FX would feed it already-decoded frames or file paths).
- Maintenance: active.
- Proposed integration: **preferred scene-cut engine for M42-G media analysis.** BEAN FX already runs Python-side OpenCV tooling (temporal intelligence, `src/lib/creative/visual/temporal/tracking.ts`); add a `scripts/media-analysis/scenes.py` that shells out to PySceneDetect if installed and falls back to the original ffmpeg `scdet`/select-filter approach when it is not — honest capability reporting either way.
- **Decision: APPROVED (optional dependency; fallback path mandatory).**

### OpenCV — opencv/opencv
- URL: https://github.com/opencv/opencv
- License: **Apache-2.0 for 4.5.0 and later** (older versions: 3-clause BSD with patent-grant terms / GPL for some very old builds). The runtime BEAN FX uses (`opencv-python-headless` 4.13 / `opencv-contrib-python-headless` 5.1) is Apache-2.0.
- Purpose: frame extraction, motion analysis, CSRT tracking (via `opencv-contrib`'s `cv2.legacy`), foreground detection — already in use.
- Model weights: none (classical CV); DNN module users must supply their own weights (license checked separately per model).
- **Decision: APPROVED (already a runtime dependency — preserved as-is).**

## 3. Speech and subtitles

### Whisper — openai/whisper
- URL: https://github.com/openai/whisper
- License: **MIT** (code). **Model weights: MIT** (OpenAI released the checkpoints under MIT).
- Purpose: speech recognition + timestamps.
- Concerns: original Whisper is not the fastest path; BEAN FX would prefer faster-whisper or a provider-backed ASR. Python/torch dependency is heavy — subprocess isolation required.
- **Decision: CONDITIONAL (only via faster-whisper, or as provider-backed ASR; never a hard runtime dependency).**

### faster-whisper — SYSTRAN/faster-whisper
- URL: https://github.com/SYSTRAN/faster-whisper
- License: **MIT** (code). Uses CTranslate2 (MIT) runtime. **Model weights: converted from OpenAI Whisper checkpoints (MIT); conversion scripts included.**
- Purpose: efficient transcription inference (CTranslate2), CPU-friendly — fits the no-Ollama, hardware-aware requirement (§6.4/§18).
- Proposed integration: optional local ASR engine behind the BEAN FX ASR capability; invoked as an isolated subprocess; model files downloaded to a user-controlled cache only with explicit consent (network download = data sharing disclosure).
- **Decision: CONDITIONAL (approved design, integration gated on owner approval for the ~200 MB+ model download and the extra Python dependency).**

### WhisperX — m-bain/whisperX
- URL: https://github.com/m-bain/whisperX
- License: **BSD-2-Clause** (LICENSE file verified via search, 2026-11-24).
- Purpose: word-level timestamps (forced alignment via wav2vec2) and diarization workflows (pyannote).
- Concerns: alignment model weights (wav2vec2-based, various licenses — check per checkpoint); pyannote diarization models are **gated behind HF terms** (not freely redistributable — requires user account/consent). GPL dependency? No — but pyannote.audio is MIT while its *models* carry their own terms.
- **Decision: CONDITIONAL (word-timing only with permissively-licensed alignment checkpoints; diarization marked NOT APPROVED until the model terms are cleared).**

### Subtitle Edit — SubtitleEdit/subtitleedit
- URL: https://github.com/SubtitleEdit/subtitleedit
- License: **MIT**.
- Purpose: subtitle editing/conversion reference (srt/vtt/ass handling).
- Proposed integration: REFERENCE ONLY — BEAN FX's caption needs (SRT/VTT generation from transcript segments) are small and original implementations are simpler than adopting a C# WinForms application.
- **Decision: REFERENCE ONLY.**

### libass — libass/libass
- URL: https://github.com/libass/libass
- License: **ISC**.
- Purpose: ASS/SSA subtitle rendering (the industry burner for styled captions).
- Proposed integration: BEAN FX renders captions through the existing FFmpeg pipeline; ffmpeg's `subtitles`/`ass` filters use libass when built in. Verify the local ffmpeg build flags before claiming styled-caption burn-in.
- **Decision: APPROVED (via the existing ffmpeg build — no new vendoring; verify build flags at integration time).**

## 4. AI image/video enhancement

### Real-ESRGAN — xinntao/Real-ESRGAN
- URL: https://github.com/xinntao/Real-ESRGAN
- License: **BSD-3-Clause** for the *repository code* (verified via search, 2026-11-24). **Model weights: the realesr-general/RealESRGAN checkpoints carry their own license files (BSD-3-Clause for most; check per-checkpoint README before shipping any weight).**
- Purpose: image/video restoration and upscaling.
- Concerns: torch inference; heavy for CPU-only hosts; must stay optional with honest capability reporting.
- **Decision: CONDITIONAL (upscaling capability slot; owner approval + hardware profile check required before any integration).**

### RIFE (ECCV2022) — hzwer/ECCV2022-RIFE
- URL: https://github.com/hzwer/ECCV2022-RIFE
- License: **MIT** for the repository code. **Model weights: the trained checkpoints are distributed under the same repo license unless stated otherwise per release — re-verify at pin time.**
- Purpose: video frame interpolation (speed ramps, slow-motion smoothing).
- **Decision: CONDITIONAL (frame-interpolation slot; same gating as Real-ESRGAN).**

## 5. MCP

### MCP TypeScript SDK — modelcontextprotocol/typescript-sdk
- URL: https://github.com/modelcontextprotocol/typescript-sdk
- License: **MIT** (code). Documentation/examples in the repo are MIT unless marked otherwise; check bundled materials separately per the M42 spec.
- Purpose: MCP client/server implementation — the foundation for BEAN FX's existing MCP client (`src/lib/mcp*`, Desktop Bridge tool surfaces) and any future server-side tool exposure.
- Proposed integration: already the architecture's transport layer; keep the SDK version pinned and record it in the dependency report.
- **Decision: APPROVED (already in use — preserve and pin).**

## 6. Media infrastructure

### FFmpeg — FFmpeg/FFmpeg
- URL: https://github.com/FFmpeg/FFmpeg
- License: **LGPL-2.1+** base; **optional GPL components** (`--enable-gpl`, e.g. libx264/libx265) change the *binary's* effective license to GPL for that build. Distributing BEAN FX itself does not redistribute ffmpeg (users/deployments install their own), which keeps the LGPL/GPL combination a deployment concern, not a code-contamination concern. **Never link ffmpeg GPL-enabled libraries into BEAN FX code — BEAN FX invokes the ffmpeg executable as a separate process.**
- Purpose: the existing render/analysis pipeline — preserved unchanged (no second engine, per M42 §23).
- **Decision: APPROVED (executive subprocess use; document build flags in the dependency report).**

### GStreamer — GStreamer/gstreamer
- License: **LGPL-2.1+** core; plugin licenses vary (some GPL, some with patent-encumbered codecs).
- **Decision: REJECTED for integration** (no second media engine — M42 §23). Kept as reading reference only.

## 7. Reference implementations — licensing caution (spec §12/§13)

| Project | License | Decision | Reason |
| --- | --- | --- | --- |
| Kdenlive (KDE/kdenlive) | **GPL-3.0** | REFERENCE ONLY | Study UX concepts (proxy workflow, effect stacks); never copy source. |
| ComfyUI (Comfy-Org/ComfyUI) | **GPL-3.0** | REFERENCE ONLY | Node-graph pattern study only. |
| Video2X (K4YT3X/video2x) | **AGPL-3.0** | REJECTED for code | AGPL contamination risk; if upscaling is ever offered, invoke a *separately installed* Video2X binary is still risky — prefer Real-ESRGAN via CONDITIONAL path. |
| Blender (blender/blender) | **GPL** | REFERENCE ONLY | Motion-graphics concepts only. |
| Remotion (remotion-dev/remotion) | **custom/commercial conditions** | REJECTED for dependency | Not an unrestricted permissive license; do not treat as open-source dependency. |

## 8. Additional candidates (searched categories per spec §12)

| Category | Candidate | License | Decision |
| --- | --- | --- | --- |
| Audio separation | vmorrisons/*demucs variants* (facebookresearch/demucs) | MIT (code); model weights MIT (released checkpoints) | CONDITIONAL — dialogue/music separation slot; torch dep; owner approval for model download. |
| Speaker diarization | pyannoteAI/pyannote | MIT (code); **models gated** | NOT APPROVED until model terms cleared (see WhisperX note). |
| Voice activity detection | snakers4/silero-vad | MIT (code + weights) | APPROVED (small, CPU-friendly — speech-detection slot). |
| Music beat analysis | (librosa ecosystem) librosa | ISC | APPROVED (beat/onset tracking for beat-synced cutting; pure-Python, permissive). |
| Optical flow | OpenCV Farnebæk/TVL1 | Apache-2.0 | APPROVED (already available via existing cv2). |
| Stabilization | ffmpeg `deshake`/vidstab (m-storsved/vid.stab) | GPL for vidstab plugin | CONDITIONAL — only if the installed ffmpeg build already includes it; never vendor the GPL filter source. |
| Video summarization | research-grade only | various | REFERENCE ONLY (no stable maintained project; revisit later). |
| Background removal | image matting repos | mostly MIT/Apache code, **weights vary** | CONDITIONAL per checkpoint; not scheduled for M42. |
| Subtitle rendering | libass | ISC | APPROVED (see §3). |
| Timeline interchange | OpenTimelineIO | Apache-2.0 | APPROVED (see §1). |
| AI agent tool integration | modelcontextprotocol/typescript-sdk | MIT | APPROVED (see §5). |

## 9. License acceptance checklist (applied to every APPROVED/CONDITIONAL entry)

- [x] Repository URL + owner recorded
- [x] License recorded (code / weights / datasets separately)
- [ ] Commit SHA pinned **at integration time** (column to fill on first vendoring)
- [x] Transitive dependency risk noted
- [x] Codec/patent concerns noted where relevant
- [x] Commercial-use restrictions checked (none restrict BEAN FX's internal use for APPROVED items)
- [x] Copyleft obligations: GPL/AGPL items are REFERENCE ONLY / REJECTED — no source copying
- [x] Security/maintenance: active projects preferred; dead projects not approved

## 10. FilmCraft-inspired product research (spec §13)

Public behavior studied for workflow concepts only (prompt-driven editing, plan-preview-apply loops, revision-by-conversation, social reframing): **no proprietary code, assets, prompts, schemas, or branding were copied**; the implementation in BEAN FX is original, built on the existing canonical command architecture. No FilmCraft private API was accessed. This note records the legal posture required by M42 §13.

## 11. Summary decision table

| Candidate | Decision | M42 phase consuming it |
| --- | --- | --- |
| OpenTimelineIO | APPROVED (format-level) | later export adapter |
| PySceneDetect | APPROVED (optional dep + fallback) | M42-G analysis |
| OpenCV | APPROVED (in use) | M42-G analysis |
| faster-whisper | CONDITIONAL | M42-G transcription (owner gate) |
| WhisperX | CONDITIONAL (alignment only) | M42-G word timing (owner gate) |
| Whisper (original) | CONDITIONAL via faster-whisper | — |
| Subtitle Edit | REFERENCE ONLY | — |
| libass | APPROVED via ffmpeg build | captions burn-in |
| Real-ESRGAN | CONDITIONAL | future upscaling |
| RIFE | CONDITIONAL | future interpolation |
| MCP TypeScript SDK | APPROVED (in use) | M42-D registry |
| FFmpeg | APPROVED (subprocess, existing) | all phases |
| GStreamer | REJECTED (no second engine) | — |
| demucs / silero-vad / librosa | CONDITIONAL / APPROVED / APPROVED | M42-G audio |
| pyannote models | NOT APPROVED (model terms) | — |
| Kdenlive / ComfyUI / Blender | REFERENCE ONLY | — |
| Video2X / Remotion | REJECTED | — |

**Rule reaffirmed:** GPL/AGPL code is never copied into BEAN FX without documented legal review and explicit owner approval. Everything M42 actually executes is original BEAN FX code on the existing architecture, plus permissively-licensed optional subprocess tools with mandatory fallbacks.
