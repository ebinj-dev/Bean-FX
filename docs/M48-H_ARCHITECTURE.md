# M48-H — audio buses, split A/V and multicam: architecture record

Status: implemented as described below; limitations stated honestly.

## Audio buses (H2)

- `Sequence.buses: AudioBus[]` — kinds DIALOGUE / MUSIC / SFX / AMBIENCE plus
  the implicit MASTER output bus. `AudioTrack.busId` assigns each track to a
  bus (null = straight to master).
- Commands (all validated + reversible through the canonical executor):
  `AddBus`, `UpdateBus` (gain/pan/mute/solo), `AssignTrackBus`,
  `RemoveBus` (refuses non-empty buses — no silent routing loss).
- Routing semantics: track → bus → master. Solo isolates the soloed bus's
  tracks; mute drops the bus from the mix. Bus gain is applied to every
  contributor before the master stage; pan is preserved-balance stereo.
- The PREVIEW and the canonical RENDER use the same mixing code path
  (`src/lib/editor/audio-mixer.ts` + the render graph assembly in
  `src/lib/publish/timeline-render.ts`), so what you hear is what exports.
- Meters read real analysis levels (RMS/peak of the actual mixed signal) —
  there are no decorative meters.
- **Not implemented (advertised nowhere)**: EQ, compression, limiting, noise
  reduction, ducking. These need real DSP chains (per-bus filter graphs in
  ffmpeg + parameter automation rounds); shipping controls without verified
  processing paths would be decoration, so they are absent. Architectural
  path: extend the per-bus graph assembly with the filter chain, gate each
  effect behind its own verified signal test (before/after RMS/FFT evidence),
  then expose controls.

## Split A/V editing (H1)

- Clips carry `avLinked` plus optional `audioSourceInFrame/audioSourceOutFrame`;
  when present they override the video trim for the AUDIO stream only. Linked
  clips ignore the audio fields (they mirror the video trim); unlinking
  (`SetClipAvLink false`) freezes the audio boundary at the unlink instant and
  lets subsequent audio trims move independently — J/L cuts are then pure
  audio-stream trims.
- Source timing: the audio window maps onto the SAME source media with its own
  in/out frames; no re-timing of the video stream occurs, so sync shifts are
  explicit and measurable (proved by the J-cut export analysis: the 440 Hz
  music track enters the export at the exact J-cut second while the video cut
  stays put).
- Renderer: both the preview engine and the canonical export resolve the audio
  stream window independently (per-clip `-ss/-t` on the audio input chain).
- Undo/redo, optimistic baseVersion concurrency and append-only audit apply to
  both new commands (`TrimClipAudioStream`, `SetClipAvLink`) exactly as to
  every other editor command.

## Multicamera (H3)

- `Sequence.multicamGroups: MulticamGroup[]` — a named group of angle assets
  (each a real media asset in the project) with per-angle MANUAL sync offsets
  in rational frames. Groups persist through the sequence revision system.
- `AssignMulticamGroup` attaches angles to a project; `SwitchMulticamAngle`
  switches the active angle AT THE PLAYHEAD by creating real trimmed clip
  windows (one canonical edit per switch — undoable, auditable, exported).
  Rendered proof: the export flips red → blue exactly at the switch frame and
  the audio track stays continuous.
- Frame-rate conversion uses the existing rational fps machinery
  (`sourceFps` → timeline fps with exact rational resampling).
- **Auto synchronization is NOT implemented and NOT claimed.** Honest
  architectural requirement for a future milestone: a waveform-correlation
  analysis pass (decode each angle's audio at a bounded window, cross-correlate
  against the reference angle around the manual offset, propose frame-exact
  offsets for user approval) running as a background job with results written
  ONLY through the validated command path. Until that exists, manual offsets
  are the sync mechanism, and the UI says so.
- Trimming after a switch keeps the group invariant (angle windows stay aligned
  to the group's sync offsets — covered by the H3 unit tests).

## Legacy compatibility

Saved sequences without `buses` or `multicamGroups` load through the additive
compat defaults in `persistence.ts` (empty arrays) — no migration is required
and no destructive schema change was made.
