# Style Capability Matrix (M42 §11) — regenerated from style-recipes.json

Legend: SUPPORTED = every recipe step has a real execution path · PARTIAL = core steps executable, some steps disclosed · DISCLOSED-GAP = named capabilities unavailable; engine offers alternatives, never fakes.

| Style id | Core editing | Beat/audio sync | Captions | Color | Notes |
| --- | --- | --- | --- | --- | --- |
| cinematic-trailer | SUPPORTED | PARTIAL (risers/SFX need assets/MCP) | PARTIAL (title card only) | SUPPORTED | |
| cinematic-storytelling | SUPPORTED | SUPPORTED (fades/ducking) | PARTIAL | SUPPORTED | |
| instagram-reel | SUPPORTED | PARTIAL (music bed asset needed) | SUPPORTED (word captions; timing needs ASR) | SUPPORTED | |
| documentary-interview | SUPPORTED | SUPPORTED | PARTIAL (ASR needed; diarization NOT APPROVED) | SUPPORTED | |
| wedding-highlight | SUPPORTED | PARTIAL (licensed music user-provided) | PARTIAL | SUPPORTED | |
| gaming-highlight | SUPPORTED | PARTIAL (SFX spike detection needs audio events) | SUPPORTED | SUPPORTED | speed ramps real |
| product-ad | SUPPORTED | PARTIAL (VO asset needed) | SUPPORTED (callouts) | SUPPORTED | |
| tutorial-explainer | SUPPORTED | SUPPORTED | PARTIAL (ASR needed) | SUPPORTED | |
| music-video-montage | SUPPORTED | PARTIAL (beat analysis tool optional; disclosed) | PARTIAL (karaoke needs aligned lyrics) | SUPPORTED | |
| sports-recap | SUPPORTED | PARTIAL (moment detection disclosed) | SUPPORTED (callouts) | SUPPORTED | replay ramps real |
| podcast-video | SUPPORTED | SUPPORTED (silencedetect) | PARTIAL (speaker labels need diarization — disclosed) | SUPPORTED | punch-ins real |
| vertical-reframe | SUPPORTED | — | PARTIAL | inherit | center-crop fallback disclosed |

**Disclosed global gaps (spec-honest):** motion tracking, stabilization (unless host ffmpeg has vidstab), wipe/mask/shape/light-leak/film-burn transitions, reverse playback, freeze-frame-from-thin-air, white-fade, noise reduction, source separation (demucs CONDITIONAL), diarization (model terms), true 3D/VFX. Each is disclosed in plans; none is faked.
