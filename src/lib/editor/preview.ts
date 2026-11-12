/**
 * BEAN FX — Preview resolution (Milestone 2, editor integration).
 *
 * Pure functions that answer the only two questions the program monitor has:
 * "what is on screen at frame F" and "what does the mix sound like at frame F".
 * No DOM, no React — fully unit-tested. The monitor component consumes these
 * every frame; being pure keeps playback deterministic and testable.
 *
 * Compositing rule (matches model.ts): tracks composite top-down in track
 * order — the LAST matching visible track wins for video. Audio mixes
 * additively across tracks; solo on any track mutes everything else.
 */
import { clipEndFrame, type Clip, type Sequence, type Track } from "./model";
import type { Rational } from "./time";

export interface ActiveVideo {
  clip: Clip;
  track: Track;
  /** Highest compositing priority wins; later track = on top. */
  layer: number;
}

export interface ActiveAudio {
  clip: Clip;
  track: Track;
  /** 0..1 linear gain after mute/solo and clip volume (capped at 1). */
  gain: number;
}

function trackById(seq: Sequence, trackId: string): Track | undefined {
  return seq.tracks.find((t) => t.id === trackId);
}

function soloActive(seq: Sequence): boolean {
  return seq.tracks.some((t) => t.solo);
}

/** The clip shown in the program monitor at `frame`, or null (black). */
export function activeVideoClipAt(seq: Sequence, frame: number): ActiveVideo | null {
  let best: ActiveVideo | null = null;
  for (let i = 0; i < seq.tracks.length; i++) {
    const track = seq.tracks[i];
    if (track.kind !== "VIDEO" || !track.visible) continue;
    for (const clip of seq.clips) {
      if (clip.trackId !== track.id) continue;
      if (frame < clip.timelineStartFrame || frame >= clipEndFrame(seq, clip)) continue;
      // Later track order wins (overwrite); within one track the clip that
      // starts later wins (topmost in an overlap).
      if (!best || i >= best.layer) {
        best = { clip, track, layer: i };
      }
    }
  }
  return best;
}

/** Every audible contributor at `frame` (audio tracks and video clips' own
 *  audio), with the effective linear gain after mute/solo/volume. */
export function activeAudioAt(seq: Sequence, frame: number): ActiveAudio[] {
  const solo = soloActive(seq);
  const out: ActiveAudio[] = [];
  for (const clip of seq.clips) {
    if (frame < clip.timelineStartFrame || frame >= clipEndFrame(seq, clip)) continue;
    const track = trackById(seq, clip.trackId);
    if (!track) continue;
    const isAudioTrack = track.kind === "AUDIO";
    const isVideoTrack = track.kind === "VIDEO";
    if (!isAudioTrack && !isVideoTrack) continue; // captions/graphics are silent
    if (track.muted || clip.muted) continue;
    if (solo && !track.solo) continue;
    // Gain: clip volume × track contribution; cap at 1.0 to protect the mix.
    const gain = Math.min(1, Math.max(0, clip.volume));
    out.push({ clip, track, gain });
  }
  return out;
}

/** Caption visible at `frame`, or null. */
export function activeCaptionAt(seq: Sequence, frame: number): Clip | null {
  // Topmost caption track wins; within a track, the latest-starting caption.
  let best: Clip | null = null;
  let bestLayer = -1;
  for (let i = 0; i < seq.tracks.length; i++) {
    const track = seq.tracks[i];
    if (track.kind !== "CAPTION" || !track.visible) continue;
    for (const clip of seq.clips) {
      if (clip.trackId !== track.id) continue;
      if (frame < clip.timelineStartFrame || frame >= clipEndFrame(seq, clip)) continue;
      if (i > bestLayer || (i === bestLayer && (!best || clip.timelineStartFrame >= best.timelineStartFrame))) {
        best = clip;
        bestLayer = i;
      }
    }
  }
  return best;
}

/**
 * Source-media seconds for a timeline frame inside `clip` — the mapping the
 * monitor uses to position the real <video>/<audio> element. Integer frame
 * math only; seconds appear exactly once, at the boundary with the element.
 */
export function sourceSecondsAt(clip: Clip, timelineFrame: number, seqFps: Rational): number {
  const offsetFrames = Math.max(0, timelineFrame - clip.timelineStartFrame);
  // timeline frames → source frames (inverse of the stored duration mapping)
  const srcOffset = Math.round((offsetFrames * clip.playbackSpeed * clip.sourceFps.num * seqFps.den) / (clip.sourceFps.den * seqFps.num));
  const srcFrame = clip.sourceInFrame + srcOffset;
  return srcFrame / clip.sourceFps.num * clip.sourceFps.den;
}

/** Fade multiplier (0..1) at a clip-relative frame — preview-only, matches
 *  what the renderer will apply via FFmpeg in M9. */
export function fadeMultiplierAt(clip: Clip, timelineFrame: number): number {
  const local = Math.max(0, timelineFrame - clip.timelineStartFrame);
  const dur = clip.timelineDurationFrames;
  let m = 1;
  if (clip.fadeInFrames > 0 && local < clip.fadeInFrames) m = Math.min(m, local / clip.fadeInFrames);
  if (clip.fadeOutFrames > 0 && local > dur - clip.fadeOutFrames) {
    m = Math.min(m, Math.max(0, (dur - local) / clip.fadeOutFrames));
  }
  return Math.max(0, Math.min(1, m));
}

/** Sequence end (last clip end) in frames — the timeline's scroll extent. */
export function sequenceEndFrame(seq: Sequence): number {
  let end = 0;
  for (const c of seq.clips) end = Math.max(end, clipEndFrame(seq, c));
  return end;
}
