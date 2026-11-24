# Sound Design and Mixing (M42-C)

Executable today (real commands): per-clip volume (ChangeVolume), volume automation (SetKeyframe on `volume` — the ducking mechanism), fadeIn/fadeOutFrames, ChangePlaybackSpeed. Analysis available: silence detection (ffmpeg silencedetect), audio stream probing; beat/onset analysis via the M42-G tool chain when installed (librosa-based), otherwise disclosed.

Strategies per style: see each recipe's `audio` block. Delivery targets (never one universal number): dialogue-first deliverables voice −16 LUFS-ish integration with music −6 dB under speech (ducking keyframes), music-first social −14 LUFS-ish, broadcast-style conservative headroom. These are guidance ranges — actual normalization is not yet a render step (disclosed).

Risers/impacts/whooshes/foley/ambience require asset libraries or MCP sound tools — the plan lists them as `needs`; nothing is generated silently. Dialogue/music separation requires demucs (CONDITIONAL in the license register) — disclosed until owner-approved. Noise reduction is not implemented — disclosed. Clipping is DETECTED post-render (QA gate) and reported.
