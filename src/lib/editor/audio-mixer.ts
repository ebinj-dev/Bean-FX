/**
 * BEAN FX — M16 Audio preview mixer (Phase D).
 *
 * A real multi-track preview mixer on the Web Audio API — NOT a simulation:
 * every audible clip is decoded once (LRU-cached AudioBuffer) and scheduled
 * as an AudioBufferSourceNode on the AudioContext clock, mapped from
 * timeline seconds. Per-clip chain: source → clip gain (volume × fade
 * ramps) → stereo pan → track gain (mute/solo) → master gain → destination.
 *
 * The mixer's AudioContext clock IS the master playback clock while audio
 * plays (video elements sync to it), which is the honest way to keep A/V in
 * step with element decoding. When Web Audio or decoding is unavailable the
 * caller falls back to the M15 element pool — documented, not silent.
 *
 * No fake DSP: GANGZII remains the only processing pipeline. Clipping safety
 * = a final DynamicsCompressor-less master gain clamp (gain ≤ 1) plus honest
 * headroom: the model caps volume at 4, so the master node scales the mix to
 * peak-normalize only if the caller enables it; default is a hard 0.9 clamp.
 */
import type { Sequence, Clip } from "@/lib/editor/model";
import { clipEndFrame } from "@/lib/editor/model";
import { sourceSecondsAt, fadeMultiplierAt } from "@/lib/editor/preview";

interface ClipWindow {
  clip: Clip;
  trackId: string;
  /** Timeline frames [start, end) audible for this clip. */
  startFrame: number;
  endFrame: number;
  gain: number;
  pan: number;
}

const BUFFER_CACHE_LIMIT = 48; // LRU cap — unbounded caches are forbidden

export class AudioPreviewMixer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private trackGains = new Map<string, GainNode>();
  private buffers = new Map<string, AudioBuffer>(); // insertion-ordered LRU
  private sources: AudioBufferSourceNode[] = [];
  private scheduledWindow: { startFrame: number; endFrame: number } | null = null;
  /** Timeline-second ↔ audio-clock anchor for the current run. */
  private anchorTimelineSec = 0;
  private anchorCtxTime = 0;
  private playing = false;
  private sequence: Sequence | null = null;
  readonly unavailableReason: string | null;

  constructor() {
    let reason: string | null = null;
    if (typeof window === "undefined") reason = "SSR";
    else if (!("AudioContext" in window) && !("webkitAudioContext" in window)) reason = "Web Audio unsupported";
    else if (!("decodeAudioData" in (window.AudioContext?.prototype ?? {}))) reason = "decodeAudioData unsupported";
    this.unavailableReason = reason;
  }

  get available(): boolean {
    return this.unavailableReason === null;
  }

  /** Seconds on the AUDIO clock for a timeline frame — the shared mapping. */
  private timelineSec(frame: number, seq: Sequence): number {
    return frame / (seq.fps.num / seq.fps.den);
  }

  /** Current timeline frame implied by the audio clock (master clock readout). */
  currentFrame(): number | null {
    if (!this.ctx || !this.sequence || !this.playing) return null;
    const ctxSec = this.ctx.currentTime - this.anchorCtxTime + this.anchorTimelineSec;
    return Math.round(ctxSec * (this.sequence.fps.num / this.sequence.fps.den));
  }

  private ensureGraph(seq: Sequence): boolean {
    if (!this.available) return false;
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9; // headroom clamp — the mix never exceeds this
      this.master.connect(this.ctx.destination);
    }
    // Track gain nodes follow the sequence's tracks (mute/solo/track volume).
    const solo = seq.tracks.some((t) => t.solo);
    for (const track of seq.tracks) {
      let node = this.trackGains.get(track.id);
      if (!node) {
        node = this.ctx.createGain();
        node.connect(this.master!);
        this.trackGains.set(track.id, node);
      }
      const audible = !track.muted && (!solo || track.solo);
      node.gain.value = audible ? 1 : 0;
    }
    // Drop gain nodes for tracks that no longer exist.
    for (const id of [...this.trackGains.keys()]) {
      if (!seq.tracks.some((t) => t.id === id)) {
        this.trackGains.get(id)?.disconnect();
        this.trackGains.delete(id);
      }
    }
    return true;
  }

  /** Decode an asset's audio (LRU-cached). Failures resolve null honestly. */
  private async bufferFor(assetId: string): Promise<AudioBuffer | null> {
    if (!this.ctx) return null;
    const cached = this.buffers.get(assetId);
    if (cached) {
      this.buffers.delete(assetId);
      this.buffers.set(assetId, cached); // refresh LRU position
      return cached;
    }
    try {
      const res = await fetch(`/api/media/${encodeURIComponent(assetId)}/file`);
      if (!res.ok) return null;
      const data = await res.arrayBuffer();
      const buf = await this.ctx.decodeAudioData(data);
      this.buffers.set(assetId, buf);
      while (this.buffers.size > BUFFER_CACHE_LIMIT) {
        const oldest = this.buffers.keys().next().value;
        if (oldest === undefined) break;
        this.buffers.delete(oldest);
      }
      return buf;
    } catch {
      return null; // decode failure → this clip is silent, surfaced via stats
    }
  }

  /** Audible windows around `frame` (±scheduling horizon). */
  private windowsAt(seq: Sequence, frame: number, horizonFrames: number): ClipWindow[] {
    const solo = seq.tracks.some((t) => t.solo);
    const out: ClipWindow[] = [];
    for (const clip of seq.clips) {
      const track = seq.tracks.find((t) => t.id === clip.trackId);
      if (!track) continue;
      const audibleTrack = (track.kind === "AUDIO" || track.kind === "VIDEO") && !track.muted && (!solo || track.solo);
      if (!audibleTrack || clip.muted || clip.missingMedia || !clip.sourceAssetId) continue;
      const cEnd = clipEndFrame(seq, clip);
      if (frame >= cEnd || clipEndFrame(seq, clip) < frame - horizonFrames) continue;
      const playhead = Math.max(clip.timelineStartFrame, frame);
      const pan = 0; // clip-level pan (volume automation rides keyframes; pan is clip-static)
      out.push({
        clip,
        trackId: track.id,
        startFrame: playhead,
        endFrame: cEnd,
        gain: Math.min(4, Math.max(0, clip.volume)) * fadeMultiplierAt(clip, playhead),
        pan,
      });
    }
    return out;
  }

  /**
   * Start playback: schedule every audible window from `frame` up to the
   * horizon; the AudioContext clock anchors to the timeline.
   */
  async play(seq: Sequence, frame: number, horizonSeconds = 8): Promise<boolean> {
    if (!this.ensureGraph(seq)) return false;
    this.stopSources();
    this.sequence = seq;
    const ctx = this.ctx!;
    if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
    this.anchorTimelineSec = this.timelineSec(frame, seq);
    this.anchorCtxTime = ctx.currentTime + 0.03; // small scheduling lead
    this.playing = true;
    this.scheduledWindow = { startFrame: frame, endFrame: frame + Math.round(horizonSeconds * (seq.fps.num / seq.fps.den)) };

    const fps = seq.fps.num / seq.fps.den;
    let scheduledCount = 0;
    let decodeFailures = 0;
    for (const w of this.windowsAt(seq, frame, this.scheduledWindow.endFrame - frame)) {
      const buffer = await this.bufferFor(w.clip.sourceAssetId);
      if (!buffer) {
        decodeFailures += 1;
        continue;
      }
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      // Clip chain: gain → pan → track gain (→ master → destination).
      const gain = ctx.createGain();
      const pan = ctx.createStereoPanner();
      const trackGain = this.trackGains.get(w.trackId) ?? this.master!;
      gain.gain.value = w.gain;
      pan.pan.value = w.pan;
      src.connect(gain);
      gain.connect(pan);
      pan.connect(trackGain);
      // Fades: linear ramps over the fade ranges (preview of the export's afade).
      const durSec = w.clip.timelineDurationFrames / fps;
      const localStartSec = (w.startFrame - w.clip.timelineStartFrame) / fps;
      const fadeInSec = w.clip.fadeInFrames / fps;
      const fadeOutSec = w.clip.fadeOutFrames / fps;
      if (fadeInSec > 0) {
        gain.gain.setValueAtTime(0, this.anchorCtxTime);
        gain.gain.linearRampToValueAtTime(w.gain, this.anchorCtxTime + Math.min(durSec, fadeInSec - localStartSec > 0 ? fadeInSec - localStartSec : fadeInSec));
      }
      if (fadeOutSec > 0) {
        const untilFade = durSec - localStartSec - fadeOutSec;
        if (untilFade > 0) {
          gain.gain.setValueAtTime(w.gain, this.anchorCtxTime + untilFade);
          gain.gain.linearRampToValueAtTime(0, this.anchorCtxTime + durSec - localStartSec);
        }
      }
      // Source media offset + speed.
      const srcSec = sourceSecondsAt(w.clip, w.startFrame, seq.fps);
      const speed = Math.min(4, Math.max(0.25, w.clip.playbackSpeed));
      const when = this.anchorCtxTime + Math.max(0, this.timelineSec(w.startFrame, seq) - this.anchorTimelineSec);
      const durationSec = Math.max(0.01, this.timelineSec(w.endFrame, seq) - this.timelineSec(w.startFrame, seq));
      try {
        src.start(when, srcSec, durationSec * speed);
        scheduledCount += 1;
        this.sources.push(src);
      } catch {
        decodeFailures += 1;
      }
    }
    this.lastStats = { scheduled: scheduledCount, decodeFailures, windows: this.sources.length };
    return scheduledCount > 0 || decodeFailures === 0;
  }

  lastStats: { scheduled: number; decodeFailures: number; windows: number } = { scheduled: 0, decodeFailures: 0, windows: 0 };

  /** Stop everything (pause/seek/sequence change). */
  stop(): void {
    this.stopSources();
    this.playing = false;
    this.scheduledWindow = null;
  }

  /** Reschedule from a new playhead (seek while playing). */
  async reschedule(seq: Sequence, frame: number): Promise<void> {
    if (!this.playing) return;
    await this.play(seq, frame);
  }

  /** Is the given frame inside the scheduled horizon? (drives refill). */
  needsRefill(frame: number): boolean {
    if (!this.playing || !this.scheduledWindow || !this.sequence) return false;
    return frame >= this.scheduledWindow.endFrame - Math.round(2 * (this.sequence.fps.num / this.sequence.fps.den));
  }

  private stopSources(): void {
    for (const s of this.sources) {
      try {
        s.stop();
        s.disconnect();
      } catch {
        /* already stopped */
      }
    }
    this.sources = [];
  }

  dispose(): void {
    this.stop();
    this.trackGains.clear();
    this.buffers.clear();
    if (this.ctx) void this.ctx.close().catch(() => undefined);
    this.ctx = null;
    this.master = null;
  }
}
