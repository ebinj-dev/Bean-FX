/**
 * BEAN FX — M16 Playback engine (Phase B).
 *
 * Framework-free controller: the stable playback clock, frame scheduling,
 * seek generations and media readiness live HERE, outside React. The monitor
 * subscribes; playback state never mixes with persistent project data.
 *
 * Clock: ANCHOR-BASED — playhead = startPlayhead + (now − startWall) × fps,
 * rounded to an integer frame once per tick. No accumulation of rounded
 * values, so scrubbing/playing for hours cannot drift. Rational FPS is
 * respected (fps is a Rational; all arithmetic derives seconds from it).
 *
 * Seeks: every seek bumps a generation. Media callbacks carry the generation
 * they were scheduled for; stale callbacks are dropped before they can paint.
 *
 * Scheduling: rAF ticks request frames; the tick loop pauses automatically
 * when the tab is hidden (visibilitychange) and resumes cleanly.
 */

export interface PlaybackClock {
  /** Current integer playhead frame (authoritative, integer-frame time). */
  readonly frame: number;
  /** Whether the transport is playing. */
  readonly playing: boolean;
  /** Monotonic generation — increments on every seek/play-state change. */
  readonly generation: number;
  /** Wall-clock seconds of continuous playback accumulated this run. */
  readonly elapsedSeconds: number;
  /** Frames whose rAF tick was late by > 1.5 frame intervals (drops). */
  readonly droppedFrames: number;
}

export type PlaybackListener = (clock: PlaybackClock) => void;

interface Anchor {
  /** Sequence frame the current run started from. */
  startFrame: number;
  /** performance.now() (ms) when the run started. */
  startWallMs: number;
}

export class PlaybackController {
  private anchor: Anchor | null = null;
  private currentFrame: number;
  private readonly fps: { num: number; den: number };
  private endFrame: number;
  private generation = 0;
  private rafId: number | null = null;
  private lastTickMs: number | null = null;
  /** Telemetry: ticks that arrived late (> 1.5 frame intervals) since play(). */
  private droppedTicks = 0;
  private accumulatedSeconds = 0;
  private readonly listeners = new Set<PlaybackListener>();
  private visible = true;

  /** M16: the sequence end moves on edits — update it without recreating
   *  the controller (frame continuity across edits is required). */
  setEnd(frame: number): void {
    this.endFrame = Math.max(0, Math.round(frame));
  }

  constructor(fps: { num: number; den: number }, initialFrame: number, endFrame: number) {
    this.fps = fps;
    this.currentFrame = Math.max(0, Math.round(initialFrame));
    this.endFrame = Math.max(0, endFrame);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibility);
    }
  }

  dispose(): void {
    this.stopRaf();
    this.listeners.clear();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibility);
    }
  }

  private onVisibility = () => {
    // Hidden tab: stop scheduling. The anchor is rebuilt on resume so the
    // hidden interval is not counted as playback time.
    this.visible = document.visibilityState === "visible";
    if (!this.visible && this.anchor) {
      const elapsed = (performance.now() - this.anchor.startWallMs) / 1000;
      this.accumulatedSeconds += elapsed;
      this.currentFrame = this.projectedFrame();
      this.anchor = null;
      this.stopRaf();
    }
    if (this.visible && this.anchor === null && this.playing_) {
      // Resume: rebuild the anchor from the paused frame — the hidden time is
      // NOT counted as playback.
      this.anchor = { startFrame: this.currentFrame, startWallMs: performance.now() };
      this.startRaf();
      this.emit();
    }
  };

  private playing_ = false;

  get clock(): PlaybackClock {
    return {
      frame: this.projectedFrame(),
      playing: this.playing_,
      generation: this.generation,
      elapsedSeconds: this.accumulatedSeconds + (this.anchor ? (performance.now() - this.anchor.startWallMs) / 1000 : 0),
      droppedFrames: this.droppedTicks,
    };
  }

  subscribe(listener: PlaybackListener): () => void {
    this.listeners.add(listener);
    listener(this.clock);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const clock = this.clock;
    for (const l of this.listeners) {
      l(clock);
    }
  }

  /** playhead projected from the anchor — the ONLY place time is computed. */
  private projectedFrame(): number {
    if (!this.anchor) return this.currentFrame;
    const fpsNum = this.fps.num / this.fps.den;
    const projected = this.anchor.startFrame + ((performance.now() - this.anchor.startWallMs) / 1000) * fpsNum;
    return Math.max(this.anchor.startFrame, Math.min(this.endFrame, Math.round(projected)));
  }

  play(): void {
    if (this.playing_ || this.endFrame === 0) return;
    this.droppedTicks = 0;
    if (this.currentFrame >= this.endFrame) this.currentFrame = 0; // restart from the top like an NLE
    this.anchor = { startFrame: this.currentFrame, startWallMs: performance.now() };
    this.playing_ = true;
    this.generation += 1;
    this.lastTickMs = null;
    this.startRaf();
    this.emit();
  }

  pause(): void {
    if (!this.playing_) return;
    this.currentFrame = this.projectedFrame();
    this.accumulatedSeconds += this.anchor ? (performance.now() - this.anchor.startWallMs) / 1000 : 0;
    this.anchor = null;
    this.playing_ = false;
    this.generation += 1;
    this.stopRaf();
    this.emit();
  }

  /** Frame-accurate seek — valid while playing (re-anchors) or paused. */
  seek(frame: number): void {
    const target = Math.max(0, Math.min(this.endFrame, Math.round(frame)));
    this.currentFrame = target;
    if (this.playing_ && this.anchor) {
      this.anchor = { startFrame: target, startWallMs: performance.now() };
    }
    this.generation += 1;
    this.emit();
  }

  step(delta: number): void {
    this.pause();
    this.seek(this.currentFrame + delta);
  }

  /** Test hook: force the projected frame without real time passing.
   *  Mirrors the rAF tick's end-stop so headless runs behave identically. */
  advanceForTest(seconds: number): void {
    if (!this.anchor) return;
    this.anchor.startWallMs -= seconds * 1000;
    if (this.projectedFrame() >= this.endFrame) {
      this.currentFrame = this.endFrame;
      this.pause();
    }
  }

  private startRaf(): void {
    if (this.rafId !== null || typeof requestAnimationFrame === "undefined") return;
    const tick = (now: number) => {
      this.rafId = null;
      if (!this.playing_ || !this.anchor) return;
      if (this.lastTickMs !== null) {
        // Frame-budget telemetry: a tick late by > 1.5 frame intervals means
        // the previous frame was scheduled late (dropped).
        const frameIntervalMs = 1000 / (this.fps.num / this.fps.den);
        if (now - this.lastTickMs > frameIntervalMs * 1.5) this.droppedTicks += 1;
      }
      this.lastTickMs = now;
      const frame = this.projectedFrame();
      if (frame >= this.endFrame) {
        this.currentFrame = this.endFrame;
        this.pause();
        return;
      }
      this.currentFrame = frame;
      this.emit();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopRaf(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.lastTickMs = null;
  }
}

/**
 * Seek-generation guard shared by media elements: `run` executes only when
 * `generation` is still current; returns false when the request was stale.
 */
export function withSeekGeneration(generation: number, current: () => number, run: () => void): boolean {
  if (generation !== current()) return false;
  run();
  return true;
}

/**
 * M16 — Frame-tick bus. The monitor publishes every projected frame here;
 * consumers that paint per-frame UI (timeline playhead line, timecode text)
 * subscribe and update the DOM imperatively — React re-renders stay reserved
 * for state changes (edits, seeks, transport), not 30–60 Hz frame ticks.
 */
type FrameListener = (frame: number, playing: boolean) => void;
const frameListeners = new Set<FrameListener>();

export function publishFrame(frame: number, playing: boolean): void {
  for (const l of frameListeners) l(frame, playing);
}

export function subscribeFrame(listener: FrameListener): () => void {
  frameListeners.add(listener);
  return () => frameListeners.delete(listener);
}
