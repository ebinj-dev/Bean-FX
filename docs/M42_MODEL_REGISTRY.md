# M42-D — Model Capability Registry (documentation)

Source of truth: `src/lib/ai/models.ts` (probed live) · API: `GET /api/ai/models` (authenticated) · MCP: `ai.models.list` (read-only tool).

## What it registers

Only integrations that EXIST in the repository:

| Model id | Provider | Type | Capabilities | Readiness probe |
| --- | --- | --- | --- | --- |
| `glm-chat` | zai-gateway | LLM | reasoning, creative-direction, code-generation, captions, translation | z-ai SDK module present (gateway adapter) or z-ai CLI on PATH |
| `zai-video` (JAZMII) | jazmii | VIDEO | video-understanding, video-enhancement | z-ai CLI present |
| `zai-image` (LAXII) | laxii | IMAGE | image-generation, background-removal | z-ai CLI present |
| `ffmpeg-analysis` | beanfx-local | TOOL | video-understanding, audio-analysis, sound-analysis | ffmpeg AND ffprobe binaries respond to `-version` |
| `opencv-cv` | beanfx-local | TOOL | image-analysis, scene-classification, video-understanding | `cv2` importable AND `cv2.legacy.TrackerCSRT_create` available (contrib) |
| `pyscenedetect` | beanfx-local | TOOL | scene-classification, video-understanding | `scenedetect` module importable; falls back to ffmpeg `scdet` when absent (disclosed) |
| `librosa-beats` | beanfx-local | TOOL | sound-analysis, audio-analysis | `librosa` importable; beat-sync discloses the fallback when absent |
| `asr-speech` | zai-gateway | ASR | transcription, captions | `BEANFX_ASR_ENABLED` set AND gateway SDK present |
| `faster-whisper` | beanfx-optional | TOOL | transcription, word-alignment | owner-enabled (`BEANFX_ENABLE_FASTER_WHISPER=1`) + module probe — license register CONDITIONAL |
| `pyscenedetect-pro` | beanfx-optional | TOOL | scene-classification | owner-enabled + module probe |

## Honesty contracts (enforced by tests)

1. `ready` is true ONLY after the probe succeeds at read time; every not-ready entry carries a `readyReason` stating the exact missing prerequisite.
2. `cost` is always a string: `"COST UNKNOWN"` (optionally with terms notes) or a `local — no API cost` description. No numeric cost is ever fabricated.
3. The capability vocabulary (`MODEL_CAPABILITIES`, 20 entries) is closed; unknown capabilities fail validation.
4. No invented providers: the provider allowlist is enforced by test.
5. Secrets never appear — the registry exposes configuration STATE (booleans/reasons), never values.

## Routing (spec §6.3)

`routeForCapability(registry, capability)` returns the first READY model providing the capability, plus per-candidate readiness and an explicit `fallbackReason` when nothing is ready. The chat UI defaults to **automatic routing**; the user can pin a specific ready model per operation. RIISHE's final editorial decisions stay with the reasoning-capable LLM (gateway) — when it is unconfigured the chat says so and the deterministic path is labeled "rules".
