"use client";

/**
 * BEAN FX — Program monitor (M2 core; M16 real-time playback engine).
 *
 * M16 architecture:
 * - `PlaybackController` (lib/editor/playback.ts) owns the clock: anchor-based
 *   projection (no accumulated rounding drift), seek generations, dropped-frame
 *   telemetry. React re-renders happen on transport/seek/edits; the per-frame
 *   picture is painted by subscribing to the controller and imperatively
 *   updating the video/audio/canvas overlays — NOT by re-rendering the tree.
 * - Double-buffered video pool: the inactive element PRELOADS the next clip
 *   (same-track adjacency), so clip boundaries swap instantly instead of
 *   re-loading a source mid-playback.
 * - `AudioPreviewMixer` schedules the full audible mix on the Web Audio clock
 *   (clip gain × fade ramps, pan, track mute/solo, master clamp). Falls back
 *   to the M15 element pool when Web Audio is unavailable — honestly labeled.
 * - Effects: the preview filter chain comes from lib/editor/filters.ts — the
 *   SAME module that generates the FFmpeg chain for export (preview/export
 *   parity by construction).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Sequence, Effect } from "@/lib/editor/model";
import { activeAudioAt, activeCaptionAt, activeVideoClipAt, fadeMultiplierAt, sequenceEndFrame, sourceSecondsAt } from "@/lib/editor/preview";
import { activeGraphicsAt } from "@/lib/nikki/state";
import { drawGraphicsLayer, ensureNikkiFonts } from "@/lib/nikki/canvas";
import { formatTimecode } from "@/lib/editor/time";
import { api } from "@/lib/client-api";
import type { Rational } from "@/lib/editor/time";
import { PlaybackController, publishFrame, subscribeFrame } from "@/lib/editor/playback";
import { AudioPreviewMixer, setActiveMixer } from "@/lib/editor/audio-mixer";
import { cssEffectFilter, cssEffectFilterAt, CANVAS_VFX_TYPES, animatedEffectAt } from "@/lib/editor/filters";
import { applyCanvasVfx, blendFrameRing } from "@/lib/editor/vfx-canvas";
import { cssTransformStyle, transformAt, transformIsIdentity, type ResolvedTransform } from "@/lib/editor/transform";
import { volumeAutomationAt } from "@/lib/editor/audio";
import { unsupportedCodecMessage } from "@/lib/editor/codec-support";
import { CompositionCanvas } from "@/components/bean/editor/composition-canvas";
import type { EditToolId } from "@/lib/editor/tools";
import type { EditorSession } from "@/hooks/use-editor-session";

const AUDIO_POOL_SIZE = 4; // element-pool FALLBACK only (Web Audio removes the cap)
/** Seek the active video element when drift exceeds this many seconds. */
const DRIFT_THRESHOLD = 0.08;

// ── M45 Unit B — canvas VFX preview layer ────────────────────────────────────
// Effects with no CSS equivalent (chromaKey, masks, motionBlur) preview by
// drawing the decoded video frame into an offscreen canvas, applying the SAME
// parameterized ops the export chain runs (lib/editor/vfx-canvas.ts), and
// compositing the result on the sequence-resolution canvas. Preview caps the
// offscreen at 1280px wide — honest preview-quality < export-quality.
const VFX_PREVIEW_MAX_WIDTH = 1280;
const VFX_MOTION_RING = 4;
let vfxOffscreen: HTMLCanvasElement | null = null;
const vfxMotionRing: ImageData[] = [];
/** When a canvas-VFX layer owns the picture, the video element stays hidden. */
let vfxOwnsPicture = false;

function clipHasCanvasVfx(clip: { effects: Array<{ type: string; enabled: boolean }> }): boolean {
  return clip.effects.some((e) => e.enabled && (CANVAS_VFX_TYPES as string[]).includes(e.type));
}

/**
 * Paint the active clip's frame with its canvas-VFX effect stack onto the
 * sequence canvas. Returns true when the layer owns the picture this frame.
 */
function paintVfxFrame(
  ctx: CanvasRenderingContext2D,
  seq: Sequence,
  clip: { effects: Effect[]; timelineStartFrame: number },
  frame: number,
  videoEl: HTMLVideoElement,
  transform: ResolvedTransform | null,
): boolean {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!vw || !vh || videoEl.readyState < 2) return false;
  if (!vfxOffscreen) vfxOffscreen = document.createElement("canvas");
  const scale = Math.min(1, VFX_PREVIEW_MAX_WIDTH / vw);
  const ow = Math.max(2, Math.round(vw * scale));
  const oh = Math.max(2, Math.round(vh * scale));
  if (vfxOffscreen.width !== ow || vfxOffscreen.height !== oh) {
    vfxOffscreen.width = ow;
    vfxOffscreen.height = oh;
  }
  const off = vfxOffscreen.getContext("2d", { willReadFrequently: true });
  if (!off) return false;
  off.drawImage(videoEl, 0, 0, ow, oh);

  const clipRelFrame = Math.max(0, frame - clip.timelineStartFrame);
  const vfxEffects = clip.effects.filter((e) => e.enabled && (CANVAS_VFX_TYPES as string[]).includes(e.type));
  if (vfxEffects.length > 0) {
    const img = off.getImageData(0, 0, ow, oh);
    // Motion blur blends RAW frames (tmix semantics) — push before ops.
    if (vfxEffects.some((e) => e.type === "motionBlur")) {
      vfxMotionRing.push(off.getImageData(0, 0, ow, oh));
      while (vfxMotionRing.length > VFX_MOTION_RING) vfxMotionRing.shift();
    }
    for (const effect of vfxEffects) {
      const evaluated = animatedEffectAt(effect, clipRelFrame);
      if (evaluated.type === "motionBlur") {
        if (vfxMotionRing.length > 1) blendFrameRing(img, vfxMotionRing.slice(0, -1));
      } else {
        applyCanvasVfx(evaluated.type, img, evaluated.params);
      }
    }
    off.putImageData(img, 0, 0);
  }

  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  // Contain-fit the frame into sequence space (the same box the video
  // element's object-contain uses), then apply the clip transform in
  // sequence pixels (x/y are composition units on ResolvedTransform).
  const s = Math.min(ctx.canvas.width / ow, ctx.canvas.height / oh);
  const dw = ow * s;
  const dh = oh * s;
  ctx.save();
  if (transform && !transformIsIdentity(transform)) {
    ctx.globalAlpha = Math.max(0, Math.min(1, transform.opacity));
    ctx.translate(ctx.canvas.width / 2 + transform.x, ctx.canvas.height / 2 + transform.y);
    ctx.rotate((transform.rotation * Math.PI) / 180);
    ctx.scale(transform.scale, transform.scale);
    ctx.drawImage(vfxOffscreen, -dw / 2, -dh / 2, dw, dh);
  } else {
    ctx.drawImage(vfxOffscreen, (ctx.canvas.width - dw) / 2, (ctx.canvas.height - dh) / 2, dw, dh);
  }
  ctx.restore();
  return true;
}

/** Next same-track clip (for preloading) — adjacency by start frame. */
function nextClipOnTrack(sequence: Sequence, clipId: string) {
  const clip = sequence.clips.find((c) => c.id === clipId);
  if (!clip) return null;
  const end = clip.timelineStartFrame + clip.timelineDurationFrames;
  return (
    sequence.clips
      .filter((c) => c.trackId === clip.trackId && c.timelineStartFrame === end && !c.missingMedia && c.sourceAssetId)
      .sort((a, b) => a.timelineStartFrame - b.timelineStartFrame)[0] ?? null
  );
}

/**
 * M37 — transition PREVIEW with per-kind geometry: the preview now mirrors
 * what the export's xfade actually renders per kind (wipe/slide/push/zoom
 * move the INCOMING frame; fadeblack ramps THROUGH black; ZOOM_OUT exports
 * as a straight cut — xfade has no zoomout — so the preview honestly shows
 * the cut too, never a transition the export will skip).
 */
function paintTransitionLayer(ctx: CanvasRenderingContext2D, seq: Sequence, frame: number, slots: (HTMLVideoElement | null)[]): boolean {
  let painted = false;
  for (const t of seq.transitions) {
    if (frame < t.startFrame || frame >= t.endFrame) continue;
    const a = seq.clips.find((c) => c.id === t.clipAId);
    const b = seq.clips.find((c) => c.id === t.clipBId);
    if (!a || !b || a.trackId !== b.trackId || b.timelineStartFrame !== a.timelineStartFrame + a.timelineDurationFrames) continue;
    const track = seq.tracks.find((tr) => tr.id === b.trackId);
    if (!track || (track.kind !== "VIDEO" && track.kind !== "OVERLAY") || !track.visible) continue;
    if (t.kind === "CUT" || t.kind === "ZOOM_OUT") continue; // export renders a straight cut for these — preview agrees
    // The incoming clip must be the PRELOADED idle element (adjacent-next).
    const incomingAssetId = b.sourceAssetId;
    const incoming = slots.find((el) => el && el.dataset.asset === incomingAssetId && !el.className.includes("hidden"));
    const active = slots.find((el) => el && el.className.includes("max-h-full"));
    if (!incoming || incoming === active || incoming.readyState < 2) continue;
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const alpha = Math.min(1, Math.max(0, (frame - t.startFrame + 1) / Math.max(1, t.endFrame - t.startFrame)));
    try {
      ctx.save();
      switch (t.kind) {
        case "WIPE_LEFT": // incoming revealed left→right (xfade wipeleft)
          ctx.beginPath();
          ctx.rect(0, 0, W * alpha, H);
          ctx.clip();
          ctx.drawImage(incoming, 0, 0, W, H);
          break;
        case "WIPE_RIGHT":
          ctx.beginPath();
          ctx.rect(W - W * alpha, 0, W * alpha, H);
          ctx.clip();
          ctx.drawImage(incoming, 0, 0, W, H);
          break;
        case "SLIDE_LEFT": // incoming slides in from the right (xfade slideleft)
        case "PUSH_LEFT": // push approximation: incoming edge advances across the outgoing
          ctx.drawImage(incoming, W * (1 - alpha), 0, W, H);
          break;
        case "SLIDE_RIGHT":
        case "PUSH_RIGHT":
          ctx.drawImage(incoming, -W * (1 - alpha), 0, W, H);
          break;
        case "ZOOM_IN": // incoming grows from the center (xfade zoomin)
        {
          const s = 0.3 + 0.7 * alpha;
          const w = W * s;
          const h = H * s;
          ctx.globalAlpha = alpha;
          ctx.drawImage(incoming, (W - w) / 2, (H - h) / 2, w, h);
          break;
        }
        case "FADE_TO_BLACK": // through-black ramp (xfade fadeblack)
        case "FADE_FROM_BLACK":
          if (alpha < 0.5) {
            ctx.fillStyle = `rgba(0,0,0,${(alpha * 2).toFixed(3)})`;
            ctx.fillRect(0, 0, W, H);
          } else {
            ctx.globalAlpha = (alpha - 0.5) * 2;
            ctx.drawImage(incoming, 0, 0, W, H);
          }
          break;
        default: // CROSS_DISSOLVE — alpha ramp (xfade fade)
          ctx.globalAlpha = alpha;
          ctx.drawImage(incoming, 0, 0, W, H);
      }
      ctx.restore();
      painted = true;
    } catch {
      // decode not ready — the straight cut remains visible (honest degradation)
      ctx.restore();
    }
  }
  return painted;
}

export function ProgramMonitor({
  sequence,
  playhead,
  playing,
  onPlayhead,
  onPlayingChange,
  session,
  activeTool = "select",
  guides = false,
  snapEnabled = true,
  onDecodeError,
}: {
  sequence: Sequence | null;
  playhead: number;
  playing: boolean;
  onPlayhead: (frame: number) => void;
  onPlayingChange: (playing: boolean) => void;
  /** M15: present only in the editing workspace — enables the interactive
   *  composition canvas (selection boxes + transform handles). */
  session?: EditorSession;
  activeTool?: EditToolId;
  guides?: boolean;
  snapEnabled?: boolean;
  /** M16: real decode failures surface to the workspace notice bar. */
  onDecodeError?: (message: string | null) => void;
}) {
  // ---- element refs --------------------------------------------------------
  const videoARef = useRef<HTMLVideoElement | null>(null);
  const videoBRef = useRef<HTMLVideoElement | null>(null);
  const audioRefs = useRef<Array<HTMLAudioElement | null>>([]);
  const seqRef = useRef(sequence);
  const playheadRef = useRef(playhead);

  // ---- playback controller (owns the clock) --------------------------------
  const end = sequence ? sequenceEndFrame(sequence) : 0;
  const controller = useMemo(
    () => new PlaybackController(sequence?.fps ?? { num: 30, den: 1 }, playhead, end),
    // Recreate only when the sequence's timebase changes — frame continuity
    // survives ordinary edits. Primitive deps are deliberate (object identity
    // of `sequence` changes on every edit and would reset playback).
    // eslint-disable-next-line react-hooks/preserve-manual-memoization -- intentional narrow deps
    [sequence?.fps.num, sequence?.fps.den],
  );
  useEffect(() => {
    controller.setEnd(end);
  }, [controller, end]);
  useEffect(() => () => controller.dispose(), [controller]);

  // Controller events → React state (TRANSPORT-level only, never per-frame):
  // pause/settled frames sync the session; per-frame painting rides the bus.
  const wasPlayingRef = useRef(false);
  useEffect(() => {
    return controller.subscribe((clock) => {
      if (clock.playing !== wasPlayingRef.current) {
        wasPlayingRef.current = clock.playing;
        onPlayingChange(clock.playing);
      }
      if (!clock.playing) onPlayhead(clock.frame);
    });
  }, [controller, onPlayhead, onPlayingChange]);

  // Seek/play props → controller (session state remains the source of truth
  // for paused navigation; the controller projects while playing).
  useEffect(() => {
    const clock = controller.clock;
    if (!clock.playing && clock.frame !== playhead) controller.seek(playhead);
  }, [playhead, controller]);
  useEffect(() => {
    if (playing && !controller.clock.playing) controller.play();
    if (!playing && controller.clock.playing) controller.pause();
  }, [playing, controller]);

  // Per-frame paint: bus subscription drives the NIIKI/caption canvas layer
  // without React re-renders.
  const nikkiCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const nikkiCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  useEffect(() => {
    void ensureNikkiFonts().then(() => {
      const seq = seqRef.current;
      if (seq && nikkiCanvasRef.current) {
        nikkiCtxRef.current = nikkiCanvasRef.current.getContext("2d");
        const ctx = nikkiCtxRef.current;
        if (ctx) drawGraphicsLayer(ctx, seq, playheadRef.current, activeGraphicsAt(seq, playheadRef.current));
      }
    });
    return subscribeFrame((frame, isPlaying) => {
      const seq = seqRef.current;
      const ctx = nikkiCtxRef.current;
      if (!seq || !ctx) return;
      // M45 — canvas VFX layer: for clips with chroma key / masks / motion
      // blur the processed frame owns the picture (the video element stays
      // decoded but visually hidden; audio is unaffected).
      const activeClip = activeVideoClipAt(seq, frame);
      vfxOwnsPicture = false;
      if (activeClip && clipHasCanvasVfx(activeClip.clip)) {
        const el = [videoARef.current, videoBRef.current].find((v) => v && !v.className.includes("hidden"));
        if (el && paintVfxFrame(ctx, seq, activeClip.clip, frame, el, transformAt(activeClip.clip, frame))) {
          vfxOwnsPicture = true;
        }
      }
      paintTransitionLayer(ctx, seq, frame, [videoARef.current, videoBRef.current]);
      const graphics = activeGraphicsAt(seq, frame);
      if (graphics.length === 0) {
        if (!vfxOwnsPicture && (isPlaying || frame !== playheadRef.current)) ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        return;
      }
      drawGraphicsLayer(ctx, seq, frame, graphics);
    });
  }, []);
  // Pause path: repaint the graphics layer for the settled frame (React render).
  useEffect(() => {
    if (playing) return;
    const seq = sequence;
    const ctx = nikkiCtxRef.current;
    if (!seq || !ctx) return;
    // M45 — canvas VFX layer for the settled frame (same as the live path).
    const activeClip = activeVideoClipAt(seq, playhead);
    vfxOwnsPicture = false;
    if (activeClip && clipHasCanvasVfx(activeClip.clip)) {
      const el = [videoARef.current, videoBRef.current].find((v) => v && !v.className.includes("hidden"));
      if (el && paintVfxFrame(ctx, seq, activeClip.clip, playhead, el, transformAt(activeClip.clip, playhead))) {
        vfxOwnsPicture = true;
      }
    }
    paintTransitionLayer(ctx, seq, playhead, [videoARef.current, videoBRef.current]);
    const graphics = activeGraphicsAt(seq, playhead);
    if (graphics.length === 0) {
      if (!vfxOwnsPicture && !paintTransitionLayer(ctx, seq, playhead, [videoARef.current, videoBRef.current])) ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    } else drawGraphicsLayer(ctx, seq, playhead, graphics);
  }, [playhead, sequence, playing]);

  /**
   * M17 §6 — transition PREVIEW: inside a transition window between adjacent
   * same-track clips, draw the INCOMING clip's frame (available in the idle
   * preloaded video element) with an alpha ramp — real frames, same window
   * semantics as the export xfade. Returns true when a layer was painted.
   */

  // Keep refs mirrored for controller callbacks.
  useEffect(() => {
    playheadRef.current = playhead;
    seqRef.current = sequence;
  }, [playhead, sequence]);


  // ---- audio mixer (master when available) ---------------------------------
  const mixer = useMemo(() => new AudioPreviewMixer(), []);
  // M26 P2 — expose the live mixer for metering (mixer drawer reads levels).
  useEffect(() => {
    setActiveMixer(mixer);
    return () => setActiveMixer(null);
  }, [mixer]);
  useEffect(() => () => mixer.dispose(), [mixer]);
  const mixerReady = mixer.available;
  // M17 benchmark telemetry: window-scoped counters (never project state).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const w = window as unknown as { __beanfxPlayback?: Record<string, unknown> };
    w.__beanfxPlayback = {
      controller,
      clock: () => {
        const c = controller.clock;
        return { frame: c.frame, playing: c.playing, droppedFrames: c.droppedFrames, elapsedSeconds: c.elapsedSeconds };
      },
      mixerStats: () => ({ scheduled: mixer.lastStats.scheduled, decodeFailures: mixer.lastStats.decodeFailures, webAudio: mixerReady }),
      memoryMB: () => {
        const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
        return m ? Math.round(m.usedJSHeapSize / 1048576) : null;
      },
    };
  }, [controller, mixer, mixerReady]);

  // Transport events → mixer schedule/refill.
  const frameRef = useRef(playhead);
  // Render-time ref mirror is intentional: the mixer must see the live
  // playhead without a re-render per frame (react-hooks/refs is muted here).
  // eslint-disable-next-line react-hooks/refs -- intentional live mirror
  frameRef.current = playhead;
  useEffect(() => {
    if (!sequence) return;
    if (playing && mixerReady) {
      void mixer.play(sequence, frameRef.current);
    } else {
      mixer.stop();
    }
  }, [playing, mixerReady, sequence, mixer]);
  // Horizon refill while playing (checked at transport-level frequency).
  useEffect(() => {
    if (!playing || !mixerReady || !sequence) return;
    const id = window.setInterval(() => {
      if (mixer.needsRefill(controller.clock.frame)) void mixer.reschedule(sequence, controller.clock.frame);
    }, 2000);
    return () => window.clearInterval(id);
  }, [playing, mixerReady, sequence, mixer, controller]);
  // Seek while playing → reschedule the mix from the new point.
  const lastSeekGenRef = useRef(-1);
  useEffect(() => {
    const clock = controller.clock;
    if (clock.generation !== lastSeekGenRef.current) {
      lastSeekGenRef.current = clock.generation;
      if (clock.playing && mixerReady && sequence) void mixer.reschedule(sequence, clock.frame);
    }
  }, [playhead, controller, mixer, mixerReady, sequence]);

  // ---- resolved active media (per render — React only sees state changes) --
  const activeVideo = sequence ? activeVideoClipAt(sequence, playhead) : null;
  const videoAssetId = activeVideo && !activeVideo.clip.missingMedia && activeVideo.clip.sourceAssetId ? activeVideo.clip.sourceAssetId : null;
  const videoSrc = videoAssetId ? api.mediaUrl(videoAssetId) : null;
  const [activeAssetId, setActiveAssetId] = useState<string | null>(null);
  const [imageAssetIds, setImageAssetIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!videoAssetId) return;
    void api
      .mediaDetail(videoAssetId)
      .then((r) => {
        if ((r.media as { kind?: string }).kind === "IMAGE") {
          setImageAssetIds((prev) => (prev.has(videoAssetId) ? prev : new Set(prev).add(videoAssetId)));
        }
      })
      .catch(() => undefined);
  }, [videoAssetId]);
  const isImageAsset = videoAssetId !== null && imageAssetIds.has(videoAssetId);

  // M17: specific codec-compatibility messaging for decode failures.
  const [activeMime, setActiveMime] = useState<string | null>(null);
  useEffect(() => {
    if (!videoAssetId) {
      setActiveMime(null);
      return;
    }
    void api
      .mediaDetail(videoAssetId)
      .then((r) => setActiveMime((r.media as { mimeType?: string }).mimeType ?? null))
      .catch(() => undefined);
  }, [videoAssetId]);
  const decodeErrorMessage = useMemo(() => unsupportedCodecMessage(activeMime), [activeMime]);
  // Preview filter chain from the SAME module the export path uses.
  // M27 P2 — animated effect params are evaluated at the CURRENT playhead
  // (clip-relative frame) with the same interpolation math the export uses.
  const previewFilter = useMemo(() => {
    if (!activeVideo) return null;
    const clipRelFrame = Math.max(0, playhead - activeVideo.clip.timelineStartFrame);
    return cssEffectFilterAt(activeVideo.clip.effects, clipRelFrame);
  }, [activeVideo, playhead]);
  // M17 §7: before/after comparison — hold the COMPARE button to bypass the
  // preview filter (the export chain is unchanged; this is preview-only).
  const [comparing, setComparing] = useState(false);
  // M37 — clip transform preview: position/scale/rotation/opacity (static or
  // keyframed) evaluated at the CURRENT playhead through the SAME shared
  // module the export path uses (lib/editor/transform.ts — parity by
  // construction). x/y are composition pixels scaled by the element's
  // contain-fit factor so the preview tracks the sequence coordinates.
  const previewTransform = useMemo(() => {
    if (!activeVideo) return null;
    return transformAt(activeVideo.clip, playhead);
  }, [activeVideo, playhead]);
  // Image assets fit the frame differently than video elements — their display
  // factor is measured from the <img> itself and kept in state (a render-time
  // ref read would violate the react-compiler rules).
  const [imageDisplayScale, setImageDisplayScale] = useState(1);
  const imageTransformStyle = previewTransform ? cssTransformStyle(previewTransform, imageDisplayScale) : null;
  const displayScaleRef = useRef(1);
  const measureDisplayScale = useCallback(() => {
    if (!sequence) return;
    const el = [videoARef.current, videoBRef.current].find((v) => v && !v.className.includes("hidden")) ?? videoARef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      displayScaleRef.current = Math.min(rect.width / sequence.width, rect.height / sequence.height);
    }
  }, [sequence]);
  // Visibility + filter + transform for the ACTIVE pool element (imperative,
  // but driven by real state changes — asset swaps and effect/transform edits
  // — not per-frame; per-frame animation rides the frame bus below).
  useEffect(() => {
    const slots = [videoARef.current, videoBRef.current];
    measureDisplayScale();
    const activeTransform = previewTransform ? cssTransformStyle(previewTransform, displayScaleRef.current) : null;
    for (const el of slots) {
      if (!el) continue;
      const isActive = el.dataset.asset === activeAssetId && activeAssetId !== null && !isImageAsset;
      el.className = isActive ? "max-h-full max-w-full" : "hidden";
      el.style.filter = isActive && !comparing ? previewFilter ?? "" : "";
      // M37: clip transform (the export chain applies the same order:
      // rotate → scale → translate, so preview and export agree).
      // M45: when the canvas VFX layer owns the picture, the element stays
      // decoded but invisible — its processed frame is drawn on the canvas.
      const hideForVfx = isActive && (activeVideo ? clipHasCanvasVfx(activeVideo.clip) : false);
      if (isActive && activeTransform) {
        el.style.transform = activeTransform.transform ?? "";
        el.style.opacity = hideForVfx ? "0" : activeTransform.opacity ?? "";
      } else if (isActive && hideForVfx) {
        el.style.transform = "";
        el.style.opacity = "0";
      } else {
        el.style.transform = "";
        el.style.opacity = "";
      }
    }
  }, [activeAssetId, isImageAsset, previewFilter, comparing, previewTransform, measureDisplayScale, activeVideo]);
  // M37: display size changes (window resize) re-measure the composition→
  // display factor; settled transforms re-apply on the next React pass.
  useEffect(() => {
    const onResize = () => measureDisplayScale();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [measureDisplayScale]);
  // M37: keyframed transforms animate during PLAYBACK via the frame bus —
  // React re-renders are transport-level only, so the per-frame picture here
  // is imperative (same pattern as the NIIKI canvas painter above).
  useEffect(() => {
    return subscribeFrame((frame) => {
      const seq = seqRef.current;
      if (!seq) return;
      const active = activeVideoClipAt(seq, frame);
      if (!active) return;
      const t = cssTransformStyle(transformAt(active.clip, frame), displayScaleRef.current);
      for (const el of [videoARef.current, videoBRef.current]) {
        if (!el || el.className.includes("hidden")) continue;
        // M45 — the canvas VFX layer owns visibility while it is active.
        el.style.transform = t.transform ?? "";
        if (!vfxOwnsPicture) el.style.opacity = t.opacity ?? "";
      }
    });
  }, []);

  // ---- double-buffered video element driver --------------------------------
  // Which pool slot is active. Effect deps intentionally coarse: the driver
  // reads the resolver state per frame tick, not per render.
  const activeSlotRef = useRef<0 | 1>(0);
  const loadedAssetRef = useRef<[string | null, string | null]>([null, null]);
  const videoGenRef = useRef(0);
  useEffect(() => {
    const controller2 = controller;
    return controller2.subscribe((clock) => {
      const seq = seqRef.current;
      if (!seq) return;
      const frame = clock.playing ? clock.frame : frameRef.current;
      const active = activeVideoClipAt(seq, frame);
      const genAtStart = controller2.clock.generation;
      const slots = [videoARef.current, videoBRef.current];
      const currentSlot = slots[activeSlotRef.current];
      const idleSlot = slots[1 - activeSlotRef.current];
      const desiredAsset = active && !active.clip.missingMedia && active.clip.sourceAssetId ? active.clip.sourceAssetId : null;

      // Decode error surfacing (per element).
      // (Element error handlers are attached via JSX onError.)

      if (!active || !desiredAsset) {
        for (const el of slots) {
          if (el && !el.paused) el.pause();
        }
        return;
      }
      if (!currentSlot) return;
      const desiredTime = sourceSecondsAt(active.clip, frame, seq.fps as Rational);
      const slotIndex = activeSlotRef.current;

      // Clip change on the ACTIVE slot → swap to the preloaded idle slot when
      // it already holds the next asset; otherwise load in place.
      if (loadedAssetRef.current[slotIndex] !== desiredAsset) {
        const otherIndex = (1 - slotIndex) as 0 | 1;
        if (loadedAssetRef.current[otherIndex] === desiredAsset && idleSlot) {
          // Swap to the preloaded slot: hide the old element, show the new.
          activeSlotRef.current = otherIndex;
          const swapped = idleSlot;
          swapped.dataset.asset = desiredAsset;
          swapped.currentTime = desiredTime;
          if (clock.playing) void swapped.play().catch(() => undefined);
          const prev = currentSlot;
          if (prev && !prev.paused) prev.pause();
          setActiveAssetId(desiredAsset);
          return;
        }
        // In-place load (no preload available — e.g. the first clip).
        const gen = controller2.clock.generation;
        currentSlot.dataset.asset = desiredAsset;
        currentSlot.src = api.mediaUrl(desiredAsset);
        currentSlot.load();
        loadedAssetRef.current[slotIndex] = desiredAsset;
        setActiveAssetId(desiredAsset);
        const onReady = () => {
          // Stale-seek guard: only the latest generation may paint.
          if (controller2.clock.generation !== gen) return;
          try {
            currentSlot.currentTime = desiredTime;
          } catch {
            /* not seekable yet */
          }
          currentSlot.playbackRate = Math.min(4, Math.max(0.25, active.clip.playbackSpeed));
          const fade = 1; // fades apply to audio; picture fade rides the export path
          currentSlot.volume = Math.min(1, Math.max(0, active.clip.volume * fade * (active.track.muted ? 0 : 1)));
          if (clock.playing) void currentSlot.play().catch(() => undefined);
        };
        if (currentSlot.readyState >= 2) onReady();
        else currentSlot.addEventListener("loadeddata", onReady, { once: true });
        return;
      }
      // Same asset: drift correction + rate + volume (generation-guarded).
      const gen = controller2.clock.generation;
      if (Math.abs(currentSlot.currentTime - desiredTime) > (clock.playing ? DRIFT_THRESHOLD : 0.001)) {
        if (controller2.clock.generation === genAtStart) {
          try {
            currentSlot.currentTime = desiredTime;
          } catch {
            /* seek in flight — next tick corrects */
          }
        }
      }
      currentSlot.playbackRate = Math.min(4, Math.max(0.25, active.clip.playbackSpeed));
      currentSlot.volume = Math.min(1, Math.max(0, active.clip.volume * (active.track.muted ? 0 : 1)));
      if (clock.playing && currentSlot.paused) void currentSlot.play().catch(() => undefined);
      if (!clock.playing && !currentSlot.paused) {
        currentSlot.pause();
        if (controller2.clock.generation === gen) {
          try {
            currentSlot.currentTime = desiredTime;
          } catch {
            /* not seekable yet */
          }
        }
      }
      // PRELOAD: the idle slot takes the next same-track clip's source.
      const next = nextClipOnTrack(seq, active.clip.id);
      const idleIndex = (1 - slotIndex) as 0 | 1;
      if (next && idleSlot && loadedAssetRef.current[idleIndex] !== next.sourceAssetId) {
        loadedAssetRef.current[idleIndex] = next.sourceAssetId;
        // dataset.asset is set at SWAP time — preloading stays invisible.
        idleSlot.src = api.mediaUrl(next.sourceAssetId);
        idleSlot.load();
      }
    });
  }, [controller]);

  // Publish every projected frame on the bus (for imperative painters) —
  // driven by the controller subscription above; publish here so ALL subscribers
  // (timeline playhead, timecode) stay in step with the same tick.
  useEffect(() => {
    return controller.subscribe((clock) => {
      publishFrame(clock.frame, clock.playing);
    });
  }, [controller]);

  // ---- element-pool audio FALLBACK (Web Audio unavailable) ------------------
  const activeAudio = sequence ? activeAudioAt(sequence, playhead) : [];
  useEffect(() => {
    if (!sequence || mixerReady) return; // Web Audio owns the mix when available
    for (let i = 0; i < AUDIO_POOL_SIZE; i++) {
      const el = audioRefs.current[i];
      if (!el) continue;
      const contributor = activeAudio[i];
      if (!contributor || contributor.clip.missingMedia || !contributor.clip.sourceAssetId) {
        el.pause();
        continue;
      }
      const desiredTime = sourceSecondsAt(contributor.clip, playhead, sequence.fps as Rational);
      const src = api.mediaUrl(contributor.clip.sourceAssetId);
      const isVideoClipAudio = contributor.track.kind === "VIDEO";
      if (isVideoClipAudio) {
        el.pause();
        continue;
      }
      if (el.dataset.asset !== contributor.clip.sourceAssetId) {
        el.dataset.asset = contributor.clip.sourceAssetId;
        el.src = src;
        el.load();
      }
      el.playbackRate = Math.min(4, Math.max(0.25, contributor.clip.playbackSpeed));
      el.volume = Math.min(1, Math.max(0, contributor.gain * fadeMultiplierAt(contributor.clip, playhead)));
      if (Math.abs(el.currentTime - desiredTime) > (playing ? DRIFT_THRESHOLD : 0.05)) {
        try {
          el.currentTime = desiredTime;
        } catch {
          /* not seekable yet */
        }
      }
      if (playing) void el.play().catch(() => undefined);
      else el.pause();
    }
    // Dependency intentionally the resolved-mix signature (see M15).
  }, [activeAudio.map((a) => `${a.clip.id}:${a.clip.sourceAssetId}:${a.gain.toFixed(3)}`).join("|"), playhead, playing, sequence, mixerReady]);

  // ---- caption overlay ----------------------------------------------------
  const caption = sequence ? activeCaptionAt(sequence, playhead) : null;
  const fpsRational = sequence?.fps ?? { num: 30, den: 1 };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col rounded-lg border border-[#2a2a2a] bg-black">
      {/* SVG filter defs for temperature/tint (same semantics as the export
          colorbalance mapping — see lib/editor/filters.ts). */}
      <svg width="0" height="0" className="absolute" aria-hidden="true">
        <defs>
          <filter id="beanfx-temperature-warm">
            <feColorMatrix type="linear" values="1.25,0,0,0,0  0,1,0,0,0  0,0,0.75,0,0  0,0,0,1,0" />
          </filter>
          <filter id="beanfx-temperature-cool">
            <feColorMatrix type="linear" values="0.75,0,0,0,0  0,1,0,0,0  0,0,1.25,0,0  0,0,0,1,0" />
          </filter>
          <filter id="beanfx-tint-green">
            <feColorMatrix type="linear" values="1,0,0,0,0  0,1.25,0,0,0  0,0,1,0,0  0,0,0,1,0" />
          </filter>
          <filter id="beanfx-tint-magenta">
            <feColorMatrix type="linear" values="1.25,0,0,0,0  0,0.75,0,0,0  0,0,1.25,0,0  0,0,0,1,0" />
          </filter>
          {[1, 3, 5, 7, 9].map((n) => (
            <filter key={n} id={`beanfx-vignette-${n}`}>
              <feComponentTransfer>
                <feFuncR type="gamma" amplitude={`${1 - n * 0.06}`} exponent="1.6" offset="0" />
                <feFuncG type="gamma" amplitude={`${1 - n * 0.06}`} exponent="1.6" offset="0" />
                <feFuncB type="gamma" amplitude={`${1 - n * 0.06}`} exponent="1.6" offset="0" />
              </feComponentTransfer>
            </filter>
          ))}
        </defs>
      </svg>
      <div className="flex items-center justify-between border-b border-[#2a2a2a] px-3 py-1.5">
        <span className="bean-label text-[10px] text-[#8f8f8a]">PROGRAM MONITOR</span>
        <MonitorTimecode fpsRational={fpsRational} fallback={playhead} />
      </div>
      <div className="relative flex min-h-[220px] flex-1 items-center justify-center overflow-hidden bg-black">
        <video ref={videoARef} playsInline preload="auto" className="hidden" onEnded={() => onPlayingChange(false)} onError={() => onDecodeError?.(decodeErrorMessage ?? "Video decode error — the source may be unsupported or corrupted.")} />
        <video ref={videoBRef} playsInline preload="auto" className="hidden" onEnded={() => onPlayingChange(false)} onError={() => onDecodeError?.(decodeErrorMessage ?? "Video decode error — the source may be unsupported or corrupted.")} />
        {/* IMAGE assets are stills on VIDEO tracks — rendered as an <img>,
            never fed to the <video> decoder. Same preview filter + transform
            chains (M37: transform uses the same shared evaluator; the
            contain-fit display factor is measured from the img itself —
            state, not a render-time ref read). */}
        {isImageAsset && videoAssetId && activeVideo && (
          <img
            ref={(el) => {
              if (!el || !sequence) return;
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                const s = Math.min(rect.width / sequence.width, rect.height / sequence.height);
                setImageDisplayScale((prev) => (Math.abs(prev - s) > 0.01 ? s : prev));
              }
            }}
            src={api.mediaUrl(videoAssetId)}
            alt=""
            className="max-h-full max-w-full object-contain"
            style={{
              filter: previewFilter ?? "",
              transform: imageTransformStyle?.transform ?? undefined,
              opacity: imageTransformStyle?.opacity ?? undefined,
            }}
          />
        )}
        {/* NIIKI motion graphics canvas (per-frame bus painting above). */}
        {sequence && (
          <canvas ref={nikkiCanvasRef} width={sequence.width} height={sequence.height} className="pointer-events-none absolute inset-0 h-full w-full object-contain" />
        )}
        {/* Audio fallback pool */}
        {Array.from({ length: AUDIO_POOL_SIZE }).map((_, i) => (
          <audio key={i} ref={(el) => { audioRefs.current[i] = el; }} preload="auto" className="hidden" />
        ))}
        {!videoSrc && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-center">
            <span className="bean-label text-[10px] text-[#5a5a55]">
              {sequence && sequence.clips.length > 0 ? "MEDIA OFFLINE" : "NO CLIP AT PLAYHEAD"}
            </span>
            <span className="text-xs text-[#8f8f8a]">
              {sequence && sequence.clips.length > 0 ? "The source asset for this clip is not in the media library." : "Move the playhead over a clip, or add media from the library."}
            </span>
          </div>
        )}
        {caption?.captionText && (
          <div
            className="pointer-events-none absolute inset-x-0 flex justify-center px-6 text-center"
            style={{
              top: caption.captionStyle?.position === "TOP" ? "6%" : caption.captionStyle?.position === "CENTER" ? "46%" : "auto",
              bottom: caption.captionStyle?.position === "BOTTOM" || !caption.captionStyle?.position ? "8%" : "auto",
              fontSize: `${Math.max(12, (caption.captionStyle?.fontSize ?? 48) / 4)}px`,
              color: caption.captionStyle?.color ?? "#FFFFFF",
              textShadow: "0 2px 6px rgba(0,0,0,0.9)",
            }}
          >
            <span>{caption.captionText}</span>
          </div>
        )}
        {sequence && session && (
          <CompositionCanvas sequence={sequence} playhead={playhead} session={session} activeTool={activeTool} guides={guides} snapEnabled={snapEnabled} />
        )}
        {activeVideo && (
          <div className="pointer-events-none absolute left-3 top-2 rounded bg-black/60 px-2 py-0.5 text-[10px] text-[#8f8f8a]">
            {activeVideo.clip.label || activeVideo.clip.id} · {activeVideo.track.name}
            {mixerReady && playing ? " · web-audio mix" : !mixerReady ? " · element mix (Web Audio unavailable)" : ""}
          </div>
        )}
        {previewFilter && (
          <button
            type="button"
            title="Hold to compare before/after (bypasses the preview filter while held)"
            className="absolute right-3 bottom-2 rounded border border-[#d4a017]/60 bg-black/70 px-2 py-0.5 text-[10px] text-[#d4a017] hover:bg-[#d4a017] hover:text-black"
            onPointerDown={() => setComparing(true)}
            onPointerUp={() => setComparing(false)}
            onPointerLeave={() => setComparing(false)}
          >
            {comparing ? "BEFORE" : "COMPARE"}
          </button>
        )}
        {playing && <div className="pointer-events-none absolute right-3 top-2 rounded bg-[#d4a017]/20 px-2 py-0.5 text-[10px] text-[#d4a017]">PLAYING</div>}
      </div>
    </div>
  );
}

/** Timecode that follows the frame bus imperatively (no re-render per tick). */
function MonitorTimecode({ fpsRational, fallback }: { fpsRational: Rational; fallback: number }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    return subscribeFrame((frame) => {
      if (ref.current) ref.current.textContent = formatTimecode(frame, fpsRational);
    });
  }, [fpsRational]);
  return (
    <span ref={ref} className="font-mono text-xs text-[#d4a017]">
      {formatTimecode(fallback, fpsRational)}
    </span>
  );
}
