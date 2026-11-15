"use client";

/**
 * BEAN FX — Professional multitrack timeline (M2 core, M15 extension).
 *
 * A real editing surface over persistent data (no mock blocks): every clip
 * block renders from the sequence model; every interaction commits validated
 * commands through the session (which persists them as new versions).
 *
 * M15 additions, all compiled to EXISTING M1 commands (see
 * lib/editor/tools.ts): tool modes (select / track-select / razor / slip /
 * slide / hand / zoom / text), snapping to clip edges and the playhead,
 * multi-selection with atomic group delete/move, right-click context menu,
 * copy/paste, audio waveforms from the real waveform API, keyframe markers,
 * per-track heights and add-track. Split/ripple/delete also live here.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Eye, EyeOff, Lock, Volume2, VolumeX, Headphones, Plus, Copy, ClipboardPaste, Scissors, Trash2, CopyPlus } from "lucide-react";
import type { Sequence, Track, Clip } from "@/lib/editor/model";
import { clipEndFrame } from "@/lib/editor/model";
import { formatTimecode } from "@/lib/editor/time";
import {
  RULER_HEIGHT,
  TRACK_HEIGHT,
  clipAtPoint,
  clipRect,
  frameToX,
  movePreview,
  rulerScale,
  trimPreview,
  trimPreviewToCommand,
  xToFrame,
  type ClipHit,
  type MovePreview,
  type TrimPreview,
} from "@/lib/editor/interaction";
import { sequenceEndFrame } from "@/lib/editor/preview";
import { slipCommand, slideCommands, type EditToolId } from "@/lib/editor/tools";
import { compileRoll, compileLift, compileExtract, compileGroupMove } from "@/lib/editor/edits";
import { subscribeFrame } from "@/lib/editor/playback";
import { thumbnailFor } from "@/lib/editor/thumbnails";
import type { EditorSession } from "@/hooks/use-editor-session";

const KIND_COLORS: Record<Track["kind"], { block: string; edge: string; text: string }> = {
  VIDEO: { block: "bg-[#3a2f14]/80", edge: "border-l-[#d4a017]", text: "text-[#d4a017]" },
  AUDIO: { block: "bg-[#12303a]/80", edge: "border-l-[#3fa7c4]", text: "text-[#3fa7c4]" },
  CAPTION: { block: "bg-[#241a3a]/80", edge: "border-l-[#9a7bd4]", text: "text-[#9a7bd4]" },
  GRAPHIC: { block: "bg-[#143a24]/80", edge: "border-l-[#4cc47f]", text: "text-[#4cc47f]" },
  OVERLAY: { block: "bg-[#3a1a1a]/80", edge: "border-l-[#c47f4c]", text: "text-[#c47f4c]" },
};

const HEADER_WIDTH = 148;

/** Waveform peaks cache (per asset id) — the real /api/media/[id]/waveform. */
const peaksCache = new Map<string, Promise<{ min: number[]; max: number[]; pointsPerSecond: number } | null>>();
function peaksFor(assetId: string): Promise<{ min: number[]; max: number[]; pointsPerSecond: number } | null> {
  let p = peaksCache.get(assetId);
  if (!p) {
    p = fetch(`/api/media/${encodeURIComponent(assetId)}/waveform`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => (d && Array.isArray(d.min) ? d : null))
      .catch(() => null);
    peaksCache.set(assetId, p);
  }
  return p;
}

function Waveform({ clip, width }: { clip: Clip; width: number }) {
  const [peaks, setPeaks] = useState<{ min: number[]; max: number[]; pointsPerSecond: number } | null>(null);
  useEffect(() => {
    let live = true;
    if (clip.sourceAssetId) void peaksFor(clip.sourceAssetId).then((p) => live && setPeaks(p));
    return () => {
      live = false;
    };
  }, [clip.sourceAssetId]);
  if (!peaks || width <= 0) return null;
  // Draw the clip's source window as bar pairs across the block width.
  const startSec = clip.sourceInFrame / (clip.sourceFps.num / clip.sourceFps.den) / clip.playbackSpeed;
  const endSec = clip.sourceOutFrame / (clip.sourceFps.num / clip.sourceFps.den) / clip.playbackSpeed;
  const bars = Math.max(8, Math.min(600, Math.floor(width / 2)));
  const pps = peaks.pointsPerSecond || 10;
  const path: string[] = [];
  for (let i = 0; i < bars; i++) {
    const sec = startSec + ((endSec - startSec) * i) / bars;
    const idx = Math.min(peaks.min.length - 1, Math.max(0, Math.round(sec * pps)));
    const lo = Math.abs(peaks.min[idx] ?? 0);
    const hi = Math.abs(peaks.max[idx] ?? 0);
    const h = Math.max(1, Math.min(1, Math.max(lo, hi)) * 100);
    path.push(`M${(i * width) / bars},${50 - h / 2}V${50 + h / 2}`);
  }
  return (
    <svg className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 w-full opacity-60" viewBox={`0 0 ${width} 100`} preserveAspectRatio="none">
      <path d={path.join("")} stroke="#3fa7c4" strokeWidth={1.4} fill="none" />
    </svg>
  );
}

/** Clip thumbnail: a REAL decoded frame (LRU-cached), only for VIDEO blocks. */
function ClipThumbnail({ assetId, width }: { assetId: string; width: number }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void thumbnailFor(assetId).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [assetId]);
  if (!url || width < 40) return null;
  return <img src={url} alt="" className="pointer-events-none absolute inset-0 h-full w-full rounded object-cover opacity-40" />;
}

interface DragState {
  kind: "move" | "trim" | "slip" | "slide";
  clipId: string;
  zone: "body" | "trim-in" | "trim-out";
  grabOffsetFrames: number;
  slipBase?: { sourceInFrame: number; sourceOutFrame: number; clientX: number };
  move?: MovePreview;
  trim?: TrimPreview;
  slipDelta?: number;
  slideDelta?: number;
}

export function EditorTimeline({
  sequence,
  playhead,
  session,
  zoom,
  onZoomChange,
  activeTool = "select",
  snap = true,
  notice,
  assetDurations,
}: {
  sequence: Sequence;
  playhead: number;
  session: EditorSession;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  activeTool?: EditToolId;
  snap?: boolean;
  notice?: (message: string | null) => void;
  /** M16: real asset durations (frames) from the media library — enables
   *  roll/slide extensions beyond the used window when media allows it. */
  assetDurations?: Map<string, number>;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollFrames, setScrollFrames] = useState(0);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; clipId: string | null } | null>(null);
  const [multiSelect, setMultiSelect] = useState<Set<string>>(new Set());
  const [trackHeights, setTrackHeights] = useState<Record<string, number>>({});
  const [clipboard, setClipboard] = useState<Clip | null>(null);
  const fps = sequence.fps;
  const ppf = 60 * Math.max(0.1, Math.min(8, zoom)) * (fps.den / fps.num);
  const end = Math.max(sequenceEndFrame(sequence) + Math.round(30 * fps.num / fps.den), 60 * Math.round(fps.num / fps.den));
  const contentWidth = HEADER_WIDTH + Math.ceil(end * ppf) + 240;
  const { majorFrames } = rulerScale(Math.max(600, end));
  void scrollFrames;

  // Snapping targets: every clip edge on every track + the playhead.
  const snapTargets = useMemo(() => {
    if (!snap) return null;
    const set = new Set<number>([playhead]);
    for (const c of sequence.clips) {
      set.add(c.timelineStartFrame);
      set.add(clipEndFrame(sequence, c));
    }
    return set;
  }, [snap, sequence, playhead]);

  const snapTo = useCallback(
    (frame: number) => {
      if (!snapTargets) return frame;
      let best = frame;
      let bestDist = Math.max(2, Math.round(8 / ppf)); // 8 px tolerance
      for (const t of snapTargets) {
        const d = Math.abs(t - frame);
        if (d < bestDist) {
          best = t;
          bestDist = d;
        }
      }
      return best;
    },
    [snapTargets, ppf],
  );

  const clampScroll = useCallback(
    (frames: number) => Math.max(0, Math.min(frames, Math.max(0, end - 120))),
    [end],
  );

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setScrollFrames(clampScroll(Math.round(el.scrollLeft / ppf)));
  }, [ppf, clampScroll]);

  /** Ruler pointer → playhead (scrub while dragging). */
  const seekFromEvent = useCallback(
    (clientX: number) => {
      const el = scrollRef.current;
      if (!el) return;
      const x = clientX - el.getBoundingClientRect().left + el.scrollLeft;
      session.setPlayhead(snap ? snapTo(xToFrame(x, zoom, fps, 0)) : xToFrame(x, zoom, fps, 0));
    },
    [session, zoom, fps, snap, snapTo],
  );

  const frameAtEvent = useCallback(
    (clientX: number) => {
      const el = scrollRef.current;
      if (!el) return 0;
      return xToFrame(clientX - el.getBoundingClientRect().left + el.scrollLeft, zoom, fps, 0);
    },
    [zoom, fps],
  );

  // ---- tool interactions ---------------------------------------------------
  const razorAt = useCallback(
    (hit: ClipHit, frame: number) => {
      const clip = hit.clip;
      if (frame <= clip.timelineStartFrame || frame >= clipEndFrame(sequence, clip)) return;
      session.apply([
        { type: "SplitClip", clipId: clip.id, atTimelineFrame: frame, newLeftId: clip.id, newRightId: session.newId("clip") },
      ]);
      notice?.(null);
    },
    [sequence, session, notice],
  );

  const addCaptionAt = useCallback(
    (trackId: string, frame: number) => {
      session.apply([
        {
          type: "AddCaption",
          clip: {
            id: session.newId("cap"),
            trackId,
            sourceAssetId: "",
            sourceInFrame: 0,
            sourceOutFrame: Math.round(2 * (fps.num / fps.den)),
            sourceFps: fps,
            timelineStartFrame: Math.max(0, frame),
            missingMedia: true,
            captionText: "New caption",
          },
        },
      ]);
      notice?.(null);
    },
    [session, fps, notice],
  );

  const startDrag = useCallback(
    (event: ReactPointerEvent, hit: ClipHit) => {
      event.preventDefault();
      event.stopPropagation();
      const frame = frameAtEvent(event.clientX);
      const track = sequence.tracks.find((t) => t.id === hit.clip.trackId);
      if (!track) return;
      if (track.locked) {
        notice?.("Track is locked — edit refused.");
        return;
      }
      // Tool dispatch.
      if (activeTool === "razor") {
        razorAt(hit, frame);
        return;
      }
      if (activeTool === "text" && track.kind === "CAPTION") {
        addCaptionAt(track.id, Math.max(0, frame));
        return;
      }
      try {
        (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
      } catch {
        // Synthetic/test pointers have no active pointer id — capture optional.
      }
      if (activeTool === "slip") {
        setDrag({ kind: "slip", clipId: hit.clip.id, zone: "body", grabOffsetFrames: 0, slipBase: { sourceInFrame: hit.clip.sourceInFrame, sourceOutFrame: hit.clip.sourceOutFrame, clientX: event.clientX } });
        session.select(hit.clip.id);
        return;
      }
      if (activeTool === "slide") {
        setDrag({ kind: "slide", clipId: hit.clip.id, zone: "body", grabOffsetFrames: frame - hit.clip.timelineStartFrame, slideDelta: 0 });
        session.select(hit.clip.id);
        return;
      }
      session.select(hit.clip.id);
      setMultiSelect((prev) => {
        if (event.shiftKey) return new Set([...prev, hit.clip.id]);
        return new Set([hit.clip.id]);
      });
      if (hit.zone === "body") {
        setDrag({
          kind: "move",
          clipId: hit.clip.id,
          zone: "body",
          grabOffsetFrames: frame - hit.clip.timelineStartFrame,
          move: { clipId: hit.clip.id, newTimelineStartFrame: hit.clip.timelineStartFrame },
        });
      } else {
        setDrag({ kind: "trim", clipId: hit.clip.id, zone: hit.zone, grabOffsetFrames: 0 });
      }
    },
    [session, sequence.tracks, frameAtEvent, activeTool, razorAt, addCaptionAt, notice],
  );

  const onDragMove = useCallback(
    (event: ReactPointerEvent) => {
      if (!drag) return;
      const frame = frameAtEvent(event.clientX);
      const clip = sequence.clips.find((c) => c.id === drag.clipId);
      if (!clip) return;
      if (drag.kind === "move") {
        const target = snapTo(frame - drag.grabOffsetFrames);
        setDrag({ ...drag, move: movePreview(clip, target, 1) });
      } else if (drag.kind === "trim") {
        setDrag({ ...drag, trim: trimPreview(sequence, clip, drag.zone as "trim-in" | "trim-out", snapTo(frame), fps, 1) });
      } else if (drag.kind === "slip" && drag.slipBase) {
        const deltaFrames = Math.round((event.clientX - drag.slipBase.clientX) / ppf);
        setDrag({ ...drag, slipDelta: deltaFrames });
      } else if (drag.kind === "slide") {
        setDrag({ ...drag, slideDelta: snapTo(frame - drag.grabOffsetFrames) - clip.timelineStartFrame });
      }
    },
    [drag, sequence, frameAtEvent, snapTo, ppf, fps],
  );

  const commitDrag = useCallback(() => {
    if (!drag) return;
    const clip = sequence.clips.find((c) => c.id === drag.clipId);
    setDrag(null);
    if (!clip) return;
    if (drag.kind === "move" && drag.move) {
      if (drag.move.newTimelineStartFrame !== clip.timelineStartFrame) {
        const ids = multiSelect.has(clip.id) && multiSelect.size > 1 ? [...multiSelect] : [clip.id];
        const base = clip.timelineStartFrame;
        const delta = drag.move.newTimelineStartFrame - base;
        const batch = ids
          .map((id) => sequence.clips.find((c) => c.id === id))
          .filter((c): c is Clip => Boolean(c))
          .map((c) => ({ type: "MoveClip", clipId: c.id, newTimelineStartFrame: Math.max(0, c.timelineStartFrame + delta) }));
        if (!session.apply(batch)) notice?.("Group move refused by the engine (overlaps on the target track).");
        else notice?.(null);
      }
      return;
    }
    if (drag.kind === "trim" && drag.trim) {
      session.apply([trimPreviewToCommand(sequence, drag.trim)]);
      return;
    }
    if (drag.kind === "slip" && drag.slipBase && drag.slipDelta) {
      const deltaSource = Math.round((drag.slipDelta * clip.sourceFps.num * fps.den) / (clip.sourceFps.den * fps.num) / clip.playbackSpeed);
      const cmd = slipCommand(clip, deltaSource);
      if (!cmd) {
        notice?.("Slip refused: the shift runs past the source media bounds.");
        return;
      }
      if (!session.apply([cmd])) notice?.("Slip refused by the engine.");
      else notice?.(null);
      return;
    }
    if (drag.kind === "slide" && drag.slideDelta) {
      const batch = slideCommands(sequence, clip, drag.slideDelta);
      if (!batch) {
        notice?.("Slide refused: neighbors cannot absorb the shift (source bounds or empty side).");
        return;
      }
      if (!session.apply(batch)) notice?.("Slide refused by the engine.");
      else notice?.(null);
    }
  }, [drag, sequence, session, multiSelect, fps, notice]);

  // Hand tool: pan by dragging anywhere in the lanes area.
  const handDrag = useRef<{ x: number; scrollLeft: number } | null>(null);
  const onHandDown = useCallback((e: ReactPointerEvent) => {
    const el = scrollRef.current;
    if (!el) return;
    handDrag.current = { x: e.clientX, scrollLeft: el.scrollLeft };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    } catch {
      // Synthetic/test pointers — capture optional.
    }
  }, []);
  const onHandMove = useCallback((e: ReactPointerEvent) => {
    const el = scrollRef.current;
    if (!el || !handDrag.current) return;
    el.scrollLeft = handDrag.current.scrollLeft - (e.clientX - handDrag.current.x);
  }, []);
  const onHandUp = useCallback(() => {
    handDrag.current = null;
  }, []);

  const zoomAt = useCallback(
    (clientX: number) => {
      const el = scrollRef.current;
      if (!el) return;
      const before = frameAtEvent(clientX);
      const nextZoom = Math.min(8, Math.max(0.2, zoom * 1.5));
      onZoomChange(nextZoom);
      requestAnimationFrame(() => {
        const el2 = scrollRef.current;
        if (!el2) return;
        const ppfNext = 60 * nextZoom * (fps.den / fps.num);
        el2.scrollLeft = before * ppfNext - (clientX - el2.getBoundingClientRect().left);
      });
    },
    [frameAtEvent, zoom, onZoomChange, fps],
  );

  const toggleTrack = useCallback(
    (trackId: string, patch: Partial<Pick<Track, "visible" | "muted" | "solo" | "locked">>) => {
      session.apply([{ type: "UpdateTrack", trackId, ...patch }]);
    },
    [session],
  );

  const selectFromFrame = useCallback(
    (trackId: string, frame: number) => {
      const ids = sequence.clips
        .filter((c) => c.trackId === trackId && clipEndFrame(sequence, c) > frame)
        .map((c) => c.id);
      setMultiSelect(new Set(ids));
      session.select(ids[0] ?? null);
      notice?.(ids.length ? `Track selection: ${ids.length} clip(s) — group delete/move available.` : "No clips forward from the playhead on this track.");
    },
    [sequence, session, notice],
  );

  // ---- context menu + clipboard -------------------------------------------
  const duplicateClip = useCallback(
    (clip: Clip) => {
      const track = sequence.tracks.find((t) => t.id === clip.trackId);
      if (!track || track.locked) {
        notice?.("Track is locked — duplicate refused.");
        return;
      }
      const pastedEnd = clipEndFrame(sequence, clip);
      session.apply([{ type: "AddClip", clip: { ...clip, id: session.newId("clip"), timelineStartFrame: pastedEnd } }]);
    },
    [sequence, session, notice],
  );

  const pasteClipboard = useCallback(
    (trackId: string | null) => {
      if (!clipboard) {
        notice?.("Clipboard is empty — copy a clip first (Ctrl+C).");
        return;
      }
      const target = trackId ?? clipboard.trackId;
      const track = sequence.tracks.find((t) => t.id === target);
      if (!track || track.locked) {
        notice?.("Target track is locked — paste refused.");
        return;
      }
      session.apply([{ type: "AddClip", clip: { ...clipboard, id: session.newId("clip"), trackId: target, timelineStartFrame: session.playheadFrame } }]);
      notice?.(null);
    },
    [clipboard, sequence, session, notice],
  );

  const groupDelete = useCallback(
    (ids: string[], ripple: boolean) => {
      if (ids.length === 0) return;
      const batch = ripple ? ids.map((id) => ({ type: "RippleDelete", clipId: id })) : ids.map((id) => ({ type: "RemoveClip", clipId: id }));
      if (!session.apply(batch)) {
        notice?.("Delete refused by the engine (locked track or invalid state).");
        return;
      }
      setMultiSelect(new Set());
      notice?.(null);
    },
    [session, notice],
  );

  // Keyboard: copy/paste (tool shortcuts live in the workspace shell).
  // Shift+Left/Right: group-move the multi-selection by ±1 frame (M16).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
      if (e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight") && multiSelect.size > 1) {
        e.preventDefault();
        const delta = e.key === "ArrowRight" ? 1 : -1;
        const op = compileGroupMove(sequence, [...multiSelect], delta);
        if (op && session.apply(op.commands)) notice?.(null);
        else notice?.("Group move refused (overlap or locked track).");
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === "c" || e.key === "C")) {
        const clip = sequence.clips.find((c) => c.id === session.selectedClipId);
        if (clip) {
          setClipboard(clip);
          notice?.("Clip copied.");
        }
      } else if ((e.metaKey || e.ctrlKey) && (e.key === "v" || e.key === "V")) {
        e.preventDefault();
        pasteClipboard(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sequence, session, pasteClipboard, notice]);

  const ticks = useMemo(() => {
    const list: number[] = [];
    for (let f = 0; f <= end; f += majorFrames) list.push(f);
    return list;
  }, [end, majorFrames]);

  // M16: the playhead line paints from the frame bus while playing — the
  // timeline component does NOT re-render per frame. Re-subscribes with
  // fresh zoom/fps mappings when they change.
  const playheadLineRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    return subscribeFrame((frame, isPlaying) => {
      const el = playheadLineRef.current;
      if (!el || !isPlaying) return;
      el.style.left = `${frameToX(frame, zoom, fps, 0)}px`;
    });
  }, [zoom, fps]);

  const lanePointerDown = useCallback(
    (e: ReactPointerEvent, track: Track) => {
      if (e.button === 2) return;
      if (activeTool === "hand") {
        onHandDown(e);
        return;
      }
      if (activeTool === "zoom") {
        zoomAt(e.clientX);
        return;
      }
      if (activeTool === "track-select") {
        selectFromFrame(track.id, frameAtEvent(e.clientX));
        return;
      }
      if (activeTool === "text" && track.kind === "CAPTION") {
        addCaptionAt(track.id, Math.max(0, frameAtEvent(e.clientX)));
        return;
      }
      if (!(e.target as HTMLElement).dataset.clipId) {
        session.select(null);
        setMultiSelect(new Set());
      }
    },
    [activeTool, onHandDown, zoomAt, selectFromFrame, frameAtEvent, addCaptionAt, session],
  );

  const totalTrackHeight = sequence.tracks.reduce((acc, t) => acc + (trackHeights[t.id] ?? TRACK_HEIGHT), 0);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-[#2a2a2a] bg-[#0b0b0a]">
      {/* Timeline toolbar */}
      <div className="flex items-center justify-between border-b border-[#2a2a2a] px-3 py-1.5">
        <span className="bean-label text-[10px] text-[#8f8f8a]">TIMELINE</span>
        <div className="flex items-center gap-2">
          <button type="button" title="Add video track" onClick={() => session.apply([{ type: "AddTrack", kind: "VIDEO", name: `V${sequence.tracks.filter((t) => t.kind === "VIDEO").length + 1}` }])} className="rounded border border-[#2a2a2a] p-1 text-[#a8a8a0] hover:border-[#d4a017] hover:text-[#d4a017]">
            <Plus className="h-3 w-3" />
          </button>
          <button type="button" title="Paste from clipboard at playhead (Ctrl+V)" onClick={() => pasteClipboard(null)} disabled={!clipboard} className="rounded border border-[#2a2a2a] p-1 text-[#a8a8a0] hover:border-[#d4a017] hover:text-[#d4a017] disabled:opacity-40">
            <ClipboardPaste className="h-3 w-3" />
          </button>
          <label className="flex items-center gap-2 text-[10px] text-[#8f8f8a]">
            ZOOM
            <input type="range" min={0.2} max={8} step={0.1} value={zoom} onChange={(e) => onZoomChange(Number(e.target.value))} className="h-1 w-28 accent-[#d4a017]" />
          </label>
        </div>
      </div>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className={`relative min-h-0 flex-1 overflow-x-auto overflow-y-auto ${activeTool === "hand" ? "cursor-grab" : ""}`}
        style={{ overscrollBehaviorX: "contain" }}
        onPointerMove={activeTool === "hand" ? onHandMove : undefined}
        onPointerUp={activeTool === "hand" ? onHandUp : undefined}
        onPointerLeave={activeTool === "hand" ? onHandUp : undefined}
      >
        <div style={{ width: contentWidth, minWidth: "100%" }} className="relative">
          {/* Ruler */}
          <div
            className="sticky top-0 z-20 cursor-col-resize select-none border-b border-[#2a2a2a] bg-[#111110]"
            style={{ height: RULER_HEIGHT }}
            onPointerDown={(e) => {
              if (activeTool === "zoom") {
                zoomAt(e.clientX);
                return;
              }
              try {
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              } catch {
                // Synthetic/test pointers — capture optional.
              }
              seekFromEvent(e.clientX);
            }}
            onPointerMove={(e) => {
              if (activeTool !== "zoom" && e.buttons & 1) seekFromEvent(e.clientX);
            }}
          >
            {ticks.map((f) => (
              <div key={f} className="absolute top-0 h-full border-l border-[#2a2a2a]" style={{ left: frameToX(f, zoom, fps, 0) }}>
                <span className="ml-1 font-mono text-[9px] leading-[24px] text-[#8f8f8a]">{formatTimecode(f, fps)}</span>
              </div>
            ))}
          </div>
          {/* Tracks */}
          <div className="relative" onContextMenu={(e) => e.preventDefault()}>
            {sequence.tracks.map((track) => {
              const colors = KIND_COLORS[track.kind];
              const height = trackHeights[track.id] ?? TRACK_HEIGHT;
              return (
                <div key={track.id} className="relative flex" style={{ height }}>
                  {/* Track header */}
                  <div className="sticky left-0 z-10 flex items-center gap-1 border-r border-[#2a2a2a] bg-[#111110] px-2" style={{ width: HEADER_WIDTH, minWidth: HEADER_WIDTH }}>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[11px] text-[#d8d8d2]">{track.name}</div>
                      <div className={`bean-label text-[9px] ${colors.text}`}>{track.kind}</div>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <div className="flex gap-0.5">
                        <button type="button" title={track.visible ? "Hide track" : "Show track"} onClick={() => toggleTrack(track.id, { visible: !track.visible })} className={`rounded p-0.5 ${track.visible ? "text-[#d8d8d2]" : "text-[#5a5a55]"}`}>
                          {track.visible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                        </button>
                        <button type="button" title={track.muted ? "Unmute track" : "Mute track"} onClick={() => toggleTrack(track.id, { muted: !track.muted })} className={`rounded p-0.5 ${track.muted ? "text-[#c45c4c]" : "text-[#d8d8d2]"}`}>
                          {track.muted ? <VolumeX className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />}
                        </button>
                      </div>
                      <div className="flex gap-0.5">
                        <button type="button" title={track.solo ? "Un-solo track" : "Solo track"} onClick={() => toggleTrack(track.id, { solo: !track.solo })} className={`rounded p-0.5 ${track.solo ? "text-[#d4a017]" : "text-[#5a5a55]"}`}>
                          <Headphones className="h-3 w-3" />
                        </button>
                        <button type="button" title={track.locked ? "Unlock track" : "Lock track"} onClick={() => toggleTrack(track.id, { locked: !track.locked })} className={`rounded p-0.5 ${track.locked ? "text-[#d4a017]" : "text-[#5a5a55]"}`}>
                          <Lock className="h-3 w-3" />
                        </button>
                      </div>
                      <div className="flex gap-0.5">
                        <button type="button" title="Taller track" onClick={() => setTrackHeights((h) => ({ ...h, [track.id]: Math.min(120, height + 14) }))} className="rounded px-1 text-[9px] text-[#8f8f8a] hover:text-[#d4a017]">
                          ▲
                        </button>
                        <button type="button" title="Shorter track" onClick={() => setTrackHeights((h) => ({ ...h, [track.id]: Math.max(28, height - 14) }))} className="rounded px-1 text-[9px] text-[#8f8f8a] hover:text-[#d4a017]">
                          ▼
                        </button>
                      </div>
                    </div>
                  </div>
                  {/* Lane */}
                  <div
                    className={`relative flex-1 border-b border-[#1c1c1a] ${track.locked ? "opacity-60" : ""}`}
                    onPointerDown={(e) => lanePointerDown(e, track)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      const hit = clipAtPoint(sequence, track.id, frameAtEvent(e.clientX), zoom, fps);
                      setMenu({ x: e.clientX, y: e.clientY, clipId: hit?.clip.id ?? null });
                    }}
                  >
                    {sequence.clips
                      .filter((c) => c.trackId === track.id)
                      .map((clip) => {
                        const dragging = drag?.clipId === clip.id;
                        const groupSelected = multiSelect.has(clip.id);
                        let start = clip.timelineStartFrame;
                        let duration = clip.timelineDurationFrames;
                        let slipShiftPx = 0;
                        let slideShiftPx = 0;
                        if (dragging && drag.kind === "move" && drag.move) start = drag.move.newTimelineStartFrame;
                        if (dragging && drag.kind === "trim" && drag.trim) {
                          const preview = drag.trim;
                          if (preview.newSourceInFrame !== undefined) {
                            const consumed = preview.newSourceInFrame - clip.sourceInFrame;
                            const shiftFrames = Math.round((consumed * fps.num * clip.sourceFps.den) / (fps.den * clip.sourceFps.num) / clip.playbackSpeed);
                            start = clip.timelineStartFrame + shiftFrames;
                            duration = clipEndFrame(sequence, clip) - start;
                          }
                          if (preview.newSourceOutFrame !== undefined) {
                            const newOut = preview.newSourceOutFrame;
                            duration = Math.round(((newOut - clip.sourceInFrame) * fps.num * clip.sourceFps.den) / (fps.den * clip.sourceFps.num) / clip.playbackSpeed);
                          }
                        }
                        if (dragging && drag.kind === "slip" && drag.slipDelta) {
                          slipShiftPx = drag.slipDelta * ppf;
                        }
                        if (dragging && drag.kind === "slide" && drag.slideDelta) {
                          slideShiftPx = drag.slideDelta * ppf;
                        }
                        const rect = clipRect({ ...clip, timelineStartFrame: start, timelineDurationFrames: Math.max(1, duration) }, zoom, fps, 0);
                        const selected = session.selectedClipId === clip.id;
                        const isAudio = track.kind === "AUDIO" && !clip.missingMedia;
                        const kfTimeline = clip.keyframes.map((k) => Math.round((k.frame * fps.num * clip.sourceFps.den) / (clip.sourceFps.num * fps.den) / clip.playbackSpeed) + start);
                        return (
                          <div
                            key={clip.id}
                            data-clip-id={clip.id}
                            className={`absolute inset-y-1.5 overflow-hidden rounded border ${colors.block} ${colors.edge} ${
                              selected || groupSelected ? "outline outline-2 outline-[#d4a017]" : ""
                            } ${dragging ? "z-10 opacity-90" : activeTool === "razor" ? "cursor-crosshair" : "cursor-grab"}`}
                            style={{ left: rect.left + slideShiftPx, width: rect.width }}
                            onPointerDown={(e) => {
                              const hit = clipAtPoint(sequence, clip.trackId, frameAtEvent(e.clientX), zoom, fps);
                              startDrag(e, hit ?? { clip, zone: "body" });
                            }}
                            onPointerMove={drag?.clipId === clip.id ? onDragMove : undefined}
                            onPointerUp={drag?.clipId === clip.id ? commitDrag : undefined}
                            onPointerCancel={drag?.clipId === clip.id ? commitDrag : undefined}
                          >
                            <div className="pointer-events-none px-1.5 py-0.5" style={{ transform: `translateX(${slipShiftPx}px)` }}>
                              <div className="truncate text-[10px] text-[#e6e6e0]">{clip.label || clip.captionText || clip.id}</div>
                              <div className="truncate font-mono text-[9px] text-[#8f8f8a]">
                                {formatTimecode(start, fps)} → {formatTimecode(start + Math.max(1, duration), fps)}
                                {clip.playbackSpeed !== 1 ? ` · ${clip.playbackSpeed}×` : ""}
                              </div>
                            </div>
                            {track.kind === "VIDEO" && !clip.missingMedia && clip.sourceAssetId && <ClipThumbnail assetId={clip.sourceAssetId} width={rect.width} />}
                            {isAudio && <Waveform clip={clip} width={rect.width} />}
                            {/* Keyframe markers (timeline-mapped) */}
                            {clip.keyframes.length > 0 && (
                              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1.5">
                                {kfTimeline.map((f, i) => (
                                  <span key={i} className="absolute bottom-0 h-1.5 w-1.5 -translate-x-1/2 rotate-45 bg-[#d4a017]" style={{ left: frameToX(f, zoom, fps, 0) - rect.left }} />
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                  </div>
                </div>
              );
            })}
            {/* Playhead — follows the frame bus imperatively while playing
                (no re-render per tick); the `playhead` prop anchors paused. */}
            <div ref={playheadLineRef} className="pointer-events-none absolute top-0 bottom-0 z-30 w-px bg-[#d4a017]" style={{ left: frameToX(playhead, zoom, fps, 0), height: totalTrackHeight + RULER_HEIGHT }}>
              <div className="absolute -left-1.5 top-0 h-2.5 w-3 bg-[#d4a017]" style={{ clipPath: "polygon(0 0, 100% 0, 50% 100%)" }} />
            </div>
          </div>
        </div>
      </div>
      {/* Context menu */}
      {menu && (
        <div className="fixed z-50 min-w-[180px] rounded border border-[#2a2a2a] bg-[#151513] py-1 shadow-xl" style={{ left: menu.x, top: menu.y }} onPointerLeave={() => setMenu(null)}>
          {menu.clipId ? (
            <>
              <button type="button" className="block w-full px-3 py-1 text-left text-[11px] text-[#d8d8d2] hover:bg-[#22221f]" onClick={() => {
                const clip = sequence.clips.find((c) => c.id === menu.clipId);
                setMenu(null);
                if (clip) razorAt({ clip, zone: "body" }, session.playheadFrame);
              }}>
                <Scissors className="mr-1.5 inline h-3 w-3" /> Split at playhead
              </button>
              <button type="button" className="block w-full px-3 py-1 text-left text-[11px] text-[#d8d8d2] hover:bg-[#22221f]" onClick={() => {
                const clip = sequence.clips.find((c) => c.id === menu.clipId);
                setMenu(null);
                if (clip) duplicateClip(clip);
              }}>
                <CopyPlus className="mr-1.5 inline h-3 w-3" /> Duplicate after clip
              </button>
              <button type="button" className="block w-full px-3 py-1 text-left text-[11px] text-[#d8d8d2] hover:bg-[#22221f]" onClick={() => {
                const clip = sequence.clips.find((c) => c.id === menu.clipId);
                setMenu(null);
                if (clip) {
                  setClipboard(clip);
                  notice?.("Clip copied.");
                }
              }}>
                <Copy className="mr-1.5 inline h-3 w-3" /> Copy
              </button>
              <button type="button" className="block w-full px-3 py-1 text-left text-[11px] text-[#c45c4c] hover:bg-[#22221f]" onClick={() => {
                setMenu(null);
                groupDelete([menu.clipId!], false);
              }}>
                <Trash2 className="mr-1.5 inline h-3 w-3" /> Delete
              </button>
              <button type="button" className="block w-full px-3 py-1 text-left text-[11px] text-[#c45c4c] hover:bg-[#22221f]" onClick={() => {
                setMenu(null);
                groupDelete([menu.clipId!], true);
              }}>
                <Trash2 className="mr-1.5 inline h-3 w-3" /> Ripple delete (close gap)
              </button>
              <button type="button" className="block w-full px-3 py-1 text-left text-[11px] text-[#d8d8d2] hover:bg-[#22221f]" onClick={() => {
                setMenu(null);
                // Lift = remove selection (or this clip) leaving a gap.
                const ids = multiSelect.size > 1 && multiSelect.has(menu.clipId!) ? [...multiSelect] : [menu.clipId!];
                const op = compileLift(sequence, ids);
                if (op && session.apply(op.commands)) notice?.(null);
                else notice?.("Lift refused (locked track).");
              }}>
                Lift (leave gap)
              </button>
              <button type="button" className="block w-full px-3 py-1 text-left text-[11px] text-[#d8d8d2] hover:bg-[#22221f]" onClick={() => {
                setMenu(null);
                const ids = multiSelect.size > 1 && multiSelect.has(menu.clipId!) ? [...multiSelect] : [menu.clipId!];
                const op = compileExtract(sequence, ids);
                if (op && session.apply(op.commands)) notice?.(null);
                else notice?.("Extract refused (locked track).");
              }}>
                Extract (remove + close gap)
              </button>
              <button type="button" className="block w-full px-3 py-1 text-left text-[11px] text-[#d8d8d2] hover:bg-[#22221f]" onClick={() => {
                setMenu(null);
                // Roll: nudge the boundary between this clip and its right
                // neighbor by 1 frame toward the right (Shift+click via menu
                // entries below give ±1 / ±5).
                const clip = sequence.clips.find((c) => c.id === menu.clipId);
                if (!clip) return;
                const right = sequence.clips
                  .filter((c) => c.trackId === clip.trackId && c.id !== clip.id && c.timelineStartFrame === clip.timelineStartFrame + clip.timelineDurationFrames)
                  .sort((a, b) => a.timelineStartFrame - b.timelineStartFrame)[0];
                if (!right) {
                  notice?.("Roll needs an adjacent right neighbor.");
                  return;
                }
                const op = compileRoll(sequence, clip.id, right.id, 1, assetDurations);
                if (op && session.apply(op.commands)) notice?.(null);
                else notice?.("Roll refused (source bounds).");
              }}>
                Roll edge right +1f (with neighbor)
              </button>
              <button type="button" className="block w-full px-3 py-1 text-left text-[11px] text-[#d8d8d2] hover:bg-[#22221f]" onClick={() => {
                setMenu(null);
                const clip = sequence.clips.find((c) => c.id === menu.clipId);
                if (!clip) return;
                const right = sequence.clips
                  .filter((c) => c.trackId === clip.trackId && c.id !== clip.id && c.timelineStartFrame === clip.timelineStartFrame + clip.timelineDurationFrames)
                  .sort((a, b) => a.timelineStartFrame - b.timelineStartFrame)[0];
                if (!right) {
                  notice?.("Roll needs an adjacent right neighbor.");
                  return;
                }
                const op = compileRoll(sequence, clip.id, right.id, -1, assetDurations);
                if (op && session.apply(op.commands)) notice?.(null);
                else notice?.("Roll refused (source bounds).");
              }}>
                Roll edge left −1f (with neighbor)
              </button>
            </>
          ) : (
            <button type="button" className="block w-full px-3 py-1 text-left text-[11px] text-[#d8d8d2] hover:bg-[#22221f]" onClick={() => {
              setMenu(null);
              pasteClipboard(null);
            }}>
              <ClipboardPaste className="mr-1.5 inline h-3 w-3" /> Paste at playhead
            </button>
          )}
        </div>
      )}
    </div>
  );
}
