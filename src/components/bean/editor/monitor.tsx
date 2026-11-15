"use client";

/**
 * BEAN FX — Program monitor (Milestone 2, editor integration).
 *
 * REAL playback, not a simulation: actual media elements are driven by the
 * timeline model. At every playhead frame the pure preview resolver decides
 * which media is active; this component maps that decision onto real
 * <video>/<audio> elements (source, currentTime, playbackRate, volume) and
 * renders caption overlays. The playhead itself is advanced by a
 * requestAnimationFrame clock in sequence frames — the authoritative editing
 * clock stays integer frames.
 *
 * Audio pool: up to 4 simultaneous audio contributors are previewed (audio
 * tracks plus video clips' own audio); contributors beyond the pool are
 * documented preview limitations, never silently mixed wrong — the export
 * path renders the full mix (M9).
 */
import { useEffect, useRef, useState } from "react";
import type { Sequence } from "@/lib/editor/model";
import { activeAudioAt, activeCaptionAt, activeVideoClipAt, fadeMultiplierAt, sequenceEndFrame, sourceSecondsAt } from "@/lib/editor/preview";
import { activeGraphicsAt } from "@/lib/nikki/state";
import { drawGraphicsLayer, ensureNikkiFonts } from "@/lib/nikki/canvas";
import { formatTimecode } from "@/lib/editor/time";
import { api } from "@/lib/client-api";
import type { Rational } from "@/lib/editor/time";
import { CompositionCanvas } from "@/components/bean/editor/composition-canvas";
import type { EditToolId } from "@/lib/editor/tools";
import type { EditorSession } from "@/hooks/use-editor-session";

const AUDIO_POOL_SIZE = 4;
/** Seek the media element when drift exceeds this many seconds. */
const DRIFT_THRESHOLD = 0.08;

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
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRefs = useRef<Array<HTMLAudioElement | null>>([]);
  const playheadRef = useRef(playhead);
  const seqRef = useRef(sequence);
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number | null>(null);

  // Mirror the latest props into refs for the playback clock callbacks.
  // (Assignment happens after render, never during render — the clock only
  // reads these from rAF/event callbacks, which always run post-render.)
  useEffect(() => {
    playheadRef.current = playhead;
    seqRef.current = sequence;
  }, [playhead, sequence]);

  // ---- playback clock: rAF advances the integer-frame playhead ----------
  useEffect(() => {
    if (!playing || !sequence) {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastTickRef.current = null;
      return;
    }
    const fps = sequence.fps.num / sequence.fps.den;
    const end = sequenceEndFrame(sequence);
    const tick = (now: number) => {
      if (lastTickRef.current === null) {
        lastTickRef.current = now;
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      const elapsed = (now - lastTickRef.current) / 1000;
      lastTickRef.current = now;
      const next = Math.round(playheadRef.current + elapsed * fps);
      if (next >= end) {
        onPlayhead(end);
        onPlayingChange(false);
        return;
      }
      onPlayhead(next);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastTickRef.current = null;
    };
  }, [playing, sequence, onPlayhead, onPlayingChange]);

  // ---- video element follows the resolved active clip -------------------
  const activeVideo = sequence ? activeVideoClipAt(sequence, playhead) : null;
  const videoAssetId = activeVideo && !activeVideo.clip.missingMedia && activeVideo.clip.sourceAssetId ? activeVideo.clip.sourceAssetId : null;
  const videoSrc = videoAssetId ? api.mediaUrl(videoAssetId) : null;
  // IMAGE assets render as stills, not through the <video> decoder: the kind
  // comes from the owner-scoped asset detail (fetched once per asset id).
  const [imageAssetIds, setImageAssetIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!videoAssetId) return;
    void api
      .mediaDetail(videoAssetId)
      .then((r) => {
        if ((r.media as { kind?: string }).kind === "IMAGE") {
          setImageAssetIds((prev) => {
            if (prev.has(videoAssetId)) return prev;
            const next = new Set(prev);
            next.add(videoAssetId);
            return next;
          });
        }
      })
      .catch(() => undefined);
  }, [videoAssetId]);
  const isImageAsset = videoAssetId !== null && imageAssetIds.has(videoAssetId);
  const loadedAssetRef = useRef<string | null>(null);
  const pendingSeekRef = useRef<number | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !sequence || !activeVideo || !videoSrc || isImageAsset) {
      if (video && (!videoSrc || isImageAsset)) {
        // Also stop a previously-playing clip when an image still takes over —
        // the <img> covers the picture but would leave its audio running.
        video.pause();
        video.removeAttribute("src");
        video.load();
        loadedAssetRef.current = null;
      }
      return;
    }
    const { clip } = activeVideo;
    const desiredTime = sourceSecondsAt(clip, playhead, sequence.fps as Rational);
    if (loadedAssetRef.current !== videoAssetId) {
      loadedAssetRef.current = videoAssetId;
      pendingSeekRef.current = desiredTime;
      video.src = videoSrc;
      video.load();
    } else {
      pendingSeekRef.current = null;
      if (Math.abs(video.currentTime - desiredTime) > (playing ? DRIFT_THRESHOLD : 0.001)) {
        try {
          video.currentTime = desiredTime;
        } catch {
          /* not seekable yet */
        }
      }
    }
    video.playbackRate = Math.min(4, Math.max(0.25, clip.playbackSpeed));
    const fade = fadeMultiplierAt(clip, playhead);
    video.volume = Math.min(1, Math.max(0, clip.volume * fade));
    if (playing) {
      void video.play().catch(() => {
        // Autoplay/decode refusal is surfaced by the stopped picture, not a fake playing state.
      });
    } else {
      video.pause();
      try {
        video.currentTime = desiredTime;
      } catch {
        /* not seekable yet */
      }
    }
  }, [videoSrc, playhead, playing, sequence]);

  // ---- audio pool follows the resolved mix ------------------------------
  const activeAudio = sequence ? activeAudioAt(sequence, playhead) : [];
  useEffect(() => {
    if (!sequence) return;
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
        // Video clips' own audio plays through the video element — skip here.
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
      if (playing) {
        void el.play().catch(() => {
          /* decode refusal → silent, honest */
        });
      } else {
        el.pause();
      }
    }
  }, [activeAudio.map((a) => `${a.clip.id}:${a.clip.sourceAssetId}:${a.gain.toFixed(3)}`).join("|"), playhead, playing, sequence]);

  // ---- caption overlay ----------------------------------------------------
  const caption = sequence ? activeCaptionAt(sequence, playhead) : null;
  const fpsRational = sequence?.fps ?? { num: 30, den: 1 };

  // ---- NIIKI motion graphics layer (real canvas preview) ------------------
  const nikkiCanvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    void ensureNikkiFonts().then(() => {
      if (nikkiCanvasRef.current) {
        // Redraw once fonts arrive (first frames may render with fallback).
        const seq = seqRef.current;
        if (!seq) return;
        const ctx = nikkiCanvasRef.current.getContext("2d");
        if (!ctx) return;
        drawGraphicsLayer(ctx, seq, playheadRef.current, activeGraphicsAt(seq, playheadRef.current));
      }
    });
  }, []);
  useEffect(() => {
    const canvas = nikkiCanvasRef.current;
    if (!canvas || !sequence) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const graphics = activeGraphicsAt(sequence, playhead);
    if (graphics.length === 0) {
      // Clear a previously drawn layer so stale graphics never linger.
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    drawGraphicsLayer(ctx, sequence, playhead, graphics);
  }, [playhead, sequence]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col rounded-lg border border-[#2a2a2a] bg-black">
      <div className="flex items-center justify-between border-b border-[#2a2a2a] px-3 py-1.5">
        <span className="bean-label text-[10px] text-[#8f8f8a]">PROGRAM MONITOR</span>
        <span className="font-mono text-xs text-[#d4a017]">{formatTimecode(playhead, fpsRational)}</span>
      </div>
      <div className="relative flex min-h-[220px] flex-1 items-center justify-center overflow-hidden bg-black">
        <video
          ref={videoRef}
          playsInline
          preload="auto"
          className="max-h-full max-w-full"
          onEnded={() => onPlayingChange(false)}
        />
        {/* NIIKI motion graphics: a transparent canvas sized to the sequence,
            CSS-scaled over the video — redrawn per playhead frame from the
            SAME state the FFmpeg render path evaluates. */}
        {sequence && (
          <canvas
            ref={nikkiCanvasRef}
            width={sequence.width}
            height={sequence.height}
            className="pointer-events-none absolute inset-0 h-full w-full object-contain"
          />
        )}
        {/* IMAGE assets are stills on VIDEO tracks — rendered as an <img>,
            never fed to the <video> decoder. */}
        {isImageAsset && videoSrc && (
           
          <img src={videoSrc} alt="" className="max-h-full max-w-full object-contain" />
        )}
        {/* Audio pool (audio tracks only — video clips' audio rides the video element) */}
        {Array.from({ length: AUDIO_POOL_SIZE }).map((_, i) => (
          <audio key={i} ref={(el) => { audioRefs.current[i] = el; }} preload="auto" className="hidden" />
        ))}
        {!videoSrc && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-center">
            <span className="bean-label text-[10px] text-[#5a5a55]">
              {sequence && sequence.clips.length > 0 ? "MEDIA OFFLINE" : "NO CLIP AT PLAYHEAD"}
            </span>
            <span className="text-xs text-[#8f8f8a]">
              {sequence && sequence.clips.length > 0
                ? "The source asset for this clip is not in the media library."
                : "Move the playhead over a clip, or add media from the library."}
            </span>
          </div>
        )}
        {/* Captions render whenever one is active at the playhead — a
            caption-only timeline (no video clip) is still a valid composition
            and must not silently show nothing. */}
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
          </div>
        )}
        {playing && <div className="pointer-events-none absolute right-3 top-2 rounded bg-[#d4a017]/20 px-2 py-0.5 text-[10px] text-[#d4a017]">PLAYING</div>}
      </div>
    </div>
  );
}
