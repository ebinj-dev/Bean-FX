# Editing Grammar and Techniques — BEAN FX Knowledge Base

M42-C reference for RIISHE. Every entry: definition, when to use, execution requirement (E = executable in BEAN FX today, D = disclosed gap), risks, quality check.

## 1. Cutting and continuity

| Technique | Definition | Use when | Execution | Risk / QC |
| --- | --- | --- | --- | --- |
| Straight cut | Instant switch, no transition | Default everywhere | E — clip order + RemoveClip | Watch for jump-cut feel between similar framings |
| Continuity editing | Preserve screen direction, eyelines, action flow across cuts | Narrative scenes | E — order + placement planning | Broken axis; QC: track motion direction across adjacent clips |
| Match cut | Cut linking two shots by graphic/action similarity | Scene transitions, style moments | D (needs visual similarity analysis); partial via shot-boundary ordering | Forced matches feel gimmicky |
| Action match | Cut mid-movement to the continuing action | Chase/sports/travel | E — cut points at motion peaks (frame-accurate) | Cutting before/after the peak kills momentum |
| Cut on action | Cut during movement so the eye follows | Dialogue→movement, montages | E | Same as above |
| Jump cut | Visible time skip within a continuous shot | Podcasts, tutorials, urgency | E — RemoveClip/SplitClip within one asset | Intentional vs accidental; QC: only where style declares it |
| Smash cut | Abrupt cut to a contrasting shot/sound | Reveals, comedy, horror | E — order + FADE contrast | Needs audio contrast to read |
| Invisible cut | Hide the cut inside motion/black/whip | Vlogs, cinematic travel | D (mask/whip not supported) | — |
| J-cut | Audio of the next shot starts before its video | Dialogue scenes, trailers | Partial: pre-roll audio clip on the audio track (E via placement) | Mis-timed J-cuts feel sloppy; keep ≤ 12 frames |
| L-cut | Audio of the previous shot continues over the next | Interviews, dialogue | E — audio clip trimmed past the video cut | Same |
| Cross-cutting | Alternate between simultaneous lines of action | Suspense, parallel stories | E — interleaved placement | Keep each line's continuity |
| Parallel editing | Cross-cutting toward convergence | Trailers, action | E | Same |
| Montage | Compressed sequence showing change over time | Training, growth, travel | E — many short clips | Needs distinct shots; no repetition |
| Metric montage | Cuts at fixed intervals regardless of content | Trailer acceleration | E — fixed placement | Monotony risk; vary within ±20% |
| Rhythmic montage | Cuts follow internal rhythm (motion/music) | Music videos | E with beat analysis; else D | Off-beat cuts destroy it |
| Tonal montage | Cuts follow emotional tone | Brand films | E — ordering | Subjective; validate with user |
| Intellectual montage | Juxtaposition creates meaning | Experimental | E — ordering | Rarely what users want; confirm |
| Elliptical editing | Omit time between beats | Recaps, summaries | E — RemoveClip | Lose essential context |
| Long take | Hold a shot | Openers, emotional beats | E — single long clip | Static frames feel dead; add push-in keyframes |
| Multi-camera editing | Switch angles on one event | Podcasts, performances | E — track layout + punch-ins | Angle-hop risk |
| Reaction cut | Cut to listener | Dialogue emphasis | E — needs second angle/take | — |
| Cutaway | Brief supporting shot | Documentaries | E — insert clip on overlay/track | Don't contradict speech |
| Insert shot | Detail close-up inserted | Tutorials, products | E | — |
| Establishing shot | Wide that locates the scene | Scene openers | E | Hold ≥ 2 s |

## 2. Transitions

| Technique | Execution in BEAN FX |
| --- | --- |
| Hard cut | E — default |
| Dissolve | E — `CROSS_DISSOLVE` (real xfade), 8–24 frames |
| Fade in/out | E — per-clip `fadeInFrames`/`fadeOutFrames` |
| Fade through black | E — `FADE_TO_BLACK` (through-black xfade) / `FADE_FROM_BLACK` |
| Fade through white | D (no white xfade) |
| Wipe / push / slide / whip pan / mask / shape / light leak / film burn | D — decorative families not in TransitionKind; disclosed, never faked |
| Zoom | E — `ZOOM_IN` (real zoomin xfade); `ZOOM_OUT` is an honest skip |
| Match transition | D (similarity analysis) |
| Motion-based transition | Partial — big push-in keyframe before the cut reads as one |
| Audio-led transition | E — J/L-cut placement + audio fades |

## 3. Timing and rhythm

- **Slow pacing**: avg shot ≥ 3 s. For testimony, reflection, luxury. QC: nothing drags > 8 s without movement.
- **Fast pacing**: avg ≤ 1.2 s. For hype, gaming, reels. QC: readability — the subject must register.
- **Rhythmic cutting**: cuts follow motion/music beats; E with beat analysis (librosa tool or MCP), else disclosed.
- **Beat synchronization**: land cuts on transients ±1 frame at section boundaries.
- **Dialogue-driven editing**: cuts follow speech rhythm; never mid-word.
- **Emotional pacing**: hold longer on emotion, cut quicker on information.
- **Build-up and release**: accelerate into the peak, then hold one longer shot.
- **Suspense timing**: extend the pre-reveal shot.
- **Comedic timing**: cut on the beat AFTER the punchline.
- **Silence and pauses**: E — keep deliberate pauses (don't over-trim); QC list flags accidental > 1.5 s dead air unless the style declares pause-keeping.

## 4. Motion

| Technique | Execution |
| --- | --- |
| Speed ramp | E — `ChangePlaybackSpeed` + speed keyframe segments via playbackSpeed per clip segment |
| Slow/fast motion | E — playbackSpeed < / > 1 |
| Reverse playback | D (no reverse decode path) |
| Freeze frame | Partial — a 1-frame clip extended (visible as stutter); honest limitation |
| Time remapping | E — speed ramps between keyframes (piecewise segments) |
| Motion tracking | D (no object tracker wired to commands) |
| Stabilization | D unless host ffmpeg has vidstab; disclosed |
| Pan and scan | E — x/y keyframes within the frame |
| Digital push-in | E — scale keyframes 1.0→1.05–1.12, EASE_IN_OUT |
| Animated reframing | E — x keyframes (vertical-reframe recipe) |
| Split screen / PiP | E — overlay track placement + transform |

**Rule**: any technique whose execution column says D must appear in the plan's `disclosedGaps`, and RIISHE must offer the closest supported alternative.
