"use client";

/**
 * BEAN FX — Multitrack timeline (Milestone 2, editor integration).
 *
 * A real editing surface over persistent data (no mock blocks): every clip
 * block renders from the sequence model; every interaction commits validated
 * commands through the session (which persists them as new versions).
 * Supported here: ruler scrubbing, clip selection, body drag (move),
 * edge drag (trim in/out), track visibility/mute/solo/lock, playhead, zoom,
 * horizontal scroll. Split/ripple/delete live in the toolbar.
 */
import { useCallback, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Eye, EyeOff, Lock, Volume2, VolumeX, Headphones } from "lucide-react";
import type { Sequence, Track } from "@/lib/editor/model";
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
import type { EditorSession } from "@/hooks/use-editor-session";

const KIND_COLORS: Record<Track["kind"], { block: string; edge: string; text: string }> = {
  VIDEO: { block: "bg-[#3a2f14]/80", edge: "border-l-[#d4a017]", text: "text-[#d4a017]" },
  AUDIO: { block: "bg-[#12303a]/80", edge: "border-l-[#3fa7c4]", text: "text-[#3fa7c4]" },
  CAPTION: { block: "bg-[#241a3a]/80", edge: "border-l-[#9a7bd4]", text: "text-[#9a7bd4]" },
  GRAPHIC: { block: "bg-[#143a24]/80", edge: "border-l-[#4cc47f]", text: "text-[#4cc47f]" },
  OVERLAY: { block: "bg-[#3a1a1a]/80", edge: "border-l-[#c47f4c]", text: "text-[#c47f4c]" },
};

const HEADER_WIDTH = 128;

interface DragState {
  kind: "move" | "trim";
  clipId: string;
  zone: "body" | "trim-in" | "trim-out";
  grabOffsetFrames: number;
  move?: MovePreview;
  trim?: TrimPreview;
}

export function EditorTimeline({
  sequence,
  playhead,
  session,
  zoom,
  onZoomChange,
}: {
  sequence: Sequence;
  playhead: number;
  session: EditorSession;
  zoom: number;
  onZoomChange: (zoom: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollFrames, setScrollFrames] = useState(0);
  const [drag, setDrag] = useState<DragState | null>(null);
  const fps = sequence.fps;
  const ppf = 60 * Math.max(0.1, Math.min(8, zoom)) * (fps.den / fps.num);
  const end = Math.max(sequenceEndFrame(sequence) + Math.round(30 * fps.num / fps.den), 60 * Math.round(fps.num / fps.den));
  const contentWidth = HEADER_WIDTH + Math.ceil(end * ppf) + 240;
  const { majorFrames } = rulerScale(Math.max(600, end));

  const clampScroll = useCallback(
    (frames: number) => Math.max(0, Math.min(frames, Math.max(0, end - 120))),
    [end],
  );

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setScrollFrames(clampScroll(Math.round((el.scrollLeft) / ppf)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ppf, clampScroll]);

  /** Ruler pointer → playhead (scrub while dragging). */
  const seekFromEvent = useCallback(
    (clientX: number) => {
      const el = scrollRef.current;
      if (!el) return;
      const x = clientX - el.getBoundingClientRect().left + el.scrollLeft;
      session.setPlayhead(xToFrame(x, zoom, fps, 0));
    },
    [session, zoom, fps],
  );

  const startDrag = useCallback(
    (event: ReactPointerEvent, hit: ClipHit) => {
      event.preventDefault();
      event.stopPropagation();
      session.select(hit.clip.id);
      if (hit.clip.trackId && sequence.tracks.find((t) => t.id === hit.clip.trackId)?.locked) return;
      const el = scrollRef.current;
      if (!el) return;
      const frame = xToFrame(event.clientX - el.getBoundingClientRect().left + el.scrollLeft, zoom, fps, 0);
      (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
      setDrag({
        kind: hit.zone === "body" ? "move" : "trim",
        clipId: hit.clip.id,
        zone: hit.zone,
        grabOffsetFrames: hit.zone === "body" ? frame - hit.clip.timelineStartFrame : 0,
      });
    },
    [session, sequence.tracks, zoom, fps],
  );

  const onDragMove = useCallback(
    (event: ReactPointerEvent) => {
      if (!drag) return;
      const el = scrollRef.current;
      if (!el) return;
      const frame = xToFrame(event.clientX - el.getBoundingClientRect().left + el.scrollLeft, zoom, fps, 0);
      const clip = sequence.clips.find((c) => c.id === drag.clipId);
      if (!clip) return;
      if (drag.kind === "move") {
        const preview = movePreview(clip, frame - drag.grabOffsetFrames, 1);
        setDrag({ ...drag, move: preview });
      } else {
        const preview = trimPreview(sequence, clip, drag.zone as "trim-in" | "trim-out", frame, fps, 1);
        setDrag({ ...drag, trim: preview });
      }
    },
    [drag, sequence, zoom, fps],
  );

  const commitDrag = useCallback(() => {
    if (!drag) return;
    const clip = sequence.clips.find((c) => c.id === drag.clipId);
    setDrag(null);
    if (!clip) return;
    if (drag.kind === "move" && drag.move) {
      if (drag.move.newTimelineStartFrame !== clip.timelineStartFrame) {
        session.apply([
          { type: "MoveClip", clipId: clip.id, newTimelineStartFrame: drag.move.newTimelineStartFrame },
        ]);
      }
      return;
    }
    if (drag.kind === "trim" && drag.trim) {
      const cmd = trimPreviewToCommand(sequence, drag.trim);
      session.apply([cmd]);
    }
  }, [drag, sequence, session]);

  const toggleTrack = useCallback(
    (trackId: string, patch: Partial<Pick<Track, "visible" | "muted" | "solo" | "locked">>) => {
      session.apply([{ type: "UpdateTrack", trackId, ...patch }]);
    },
    [session],
  );

  const ticks = useMemo(() => {
    const list: number[] = [];
    for (let f = 0; f <= end; f += majorFrames) list.push(f);
    return list;
  }, [end, majorFrames]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-[#2a2a2a] bg-[#0b0b0a]">
      <div className="flex items-center justify-between border-b border-[#2a2a2a] px-3 py-1.5">
        <span className="bean-label text-[10px] text-[#8f8f8a]">TIMELINE</span>
        <label className="flex items-center gap-2 text-[10px] text-[#8f8f8a]">
          ZOOM
          <input
            type="range"
            min={0.2}
            max={8}
            step={0.1}
            value={zoom}
            onChange={(e) => onZoomChange(Number(e.target.value))}
            className="h-1 w-28 accent-[#d4a017]"
          />
        </label>
      </div>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="relative min-h-0 flex-1 overflow-x-auto overflow-y-auto"
        style={{ overscrollBehaviorX: "contain" }}
      >
        <div style={{ width: contentWidth, minWidth: "100%" }} className="relative">
          {/* Ruler */}
          <div
            className="sticky top-0 z-20 cursor-col-resize select-none border-b border-[#2a2a2a] bg-[#111110]"
            style={{ height: RULER_HEIGHT }}
            onPointerDown={(e) => {
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              seekFromEvent(e.clientX);
            }}
            onPointerMove={(e) => {
              if (e.buttons & 1) seekFromEvent(e.clientX);
            }}
          >
            {ticks.map((f) => (
              <div
                key={f}
                className="absolute top-0 h-full border-l border-[#2a2a2a]"
                style={{ left: frameToX(f, zoom, fps, 0) }}
              >
                <span className="ml-1 font-mono text-[9px] leading-[24px] text-[#8f8f8a]">{formatTimecode(f, fps)}</span>
              </div>
            ))}
          </div>
          {/* Tracks */}
          <div className="relative">
            {sequence.tracks.map((track) => {
              const colors = KIND_COLORS[track.kind];
              return (
                <div key={track.id} className="relative flex" style={{ height: TRACK_HEIGHT }}>
                  {/* Track header */}
                  <div
                    className="sticky left-0 z-10 flex items-center gap-1 border-r border-[#2a2a2a] bg-[#111110] px-2"
                    style={{ width: HEADER_WIDTH, minWidth: HEADER_WIDTH }}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[11px] text-[#d8d8d2]">{track.name}</div>
                      <div className={`bean-label text-[9px] ${colors.text}`}>{track.kind}</div>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <div className="flex gap-0.5">
                        <button
                          type="button"
                          title={track.visible ? "Hide track" : "Show track"}
                          onClick={() => toggleTrack(track.id, { visible: !track.visible })}
                          className={`rounded p-0.5 ${track.visible ? "text-[#d8d8d2]" : "text-[#5a5a55]"}`}
                        >
                          {track.visible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                        </button>
                        <button
                          type="button"
                          title={track.muted ? "Unmute track" : "Mute track"}
                          onClick={() => toggleTrack(track.id, { muted: !track.muted })}
                          className={`rounded p-0.5 ${track.muted ? "text-[#c45c4c]" : "text-[#d8d8d2]"}`}
                        >
                          {track.muted ? <VolumeX className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />}
                        </button>
                      </div>
                      <div className="flex gap-0.5">
                        <button
                          type="button"
                          title={track.solo ? "Un-solo track" : "Solo track"}
                          onClick={() => toggleTrack(track.id, { solo: !track.solo })}
                          className={`rounded p-0.5 ${track.solo ? "text-[#d4a017]" : "text-[#5a5a55]"}`}
                        >
                          <Headphones className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          title={track.locked ? "Unlock track" : "Lock track"}
                          onClick={() => toggleTrack(track.id, { locked: !track.locked })}
                          className={`rounded p-0.5 ${track.locked ? "text-[#d4a017]" : "text-[#5a5a55]"}`}
                        >
                          <Lock className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  </div>
                  {/* Lane */}
                  <div
                    className={`relative flex-1 border-b border-[#1c1c1a] ${track.locked ? "opacity-60" : ""}`}
                    onPointerDown={(e) => {
                      // Click on empty lane deselects.
                      if (!(e.target as HTMLElement).dataset.clipId) session.select(null);
                    }}
                  >
                    {sequence.clips
                      .filter((c) => c.trackId === track.id)
                      .map((clip) => {
                        const dragging = drag?.clipId === clip.id;
                        // Live geometry: preview overrides while dragging.
                        let start = clip.timelineStartFrame;
                        let duration = clip.timelineDurationFrames;
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
                        const rect = clipRect({ ...clip, timelineStartFrame: start, timelineDurationFrames: Math.max(1, duration) }, zoom, fps, 0);
                        const selected = session.selectedClipId === clip.id;
                        return (
                          <div
                            key={clip.id}
                            data-clip-id={clip.id}
                            className={`absolute inset-y-1.5 overflow-hidden rounded border ${colors.block} ${colors.edge} ${
                              selected ? "outline outline-2 outline-[#d4a017]" : ""
                            } ${dragging ? "z-10 cursor-grabbing opacity-80" : "cursor-grab"}`}
                            style={{ left: rect.left, width: rect.width }}
                            onPointerDown={(e) => {
                              const hit = clipAtPoint(sequence, clip.trackId, xToFrame(e.clientX - (scrollRef.current?.getBoundingClientRect().left ?? 0) + (scrollRef.current?.scrollLeft ?? 0), zoom, fps, 0), zoom, fps);
                              startDrag(e, hit ?? { clip, zone: "body" });
                            }}
                            onPointerMove={drag?.clipId === clip.id ? onDragMove : undefined}
                            onPointerUp={drag?.clipId === clip.id ? commitDrag : undefined}
                            onPointerCancel={drag?.clipId === clip.id ? commitDrag : undefined}
                          >
                            <div className="pointer-events-none px-1.5 py-0.5">
                              <div className="truncate text-[10px] text-[#e6e6e0]">
                                {clip.label || clip.captionText || clip.id}
                              </div>
                              <div className="truncate font-mono text-[9px] text-[#8f8f8a]">
                                {formatTimecode(start, fps)} → {formatTimecode(start + Math.max(1, duration), fps)}
                                {clip.playbackSpeed !== 1 ? ` · ${clip.playbackSpeed}×` : ""}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </div>
              );
            })}
            {/* Playhead */}
            <div
              className="pointer-events-none absolute top-0 bottom-0 z-30 w-px bg-[#d4a017]"
              style={{ left: frameToX(playhead, zoom, fps, 0), height: sequence.tracks.length * TRACK_HEIGHT + RULER_HEIGHT }}
            >
              <div className="absolute -left-1.5 top-0 h-2.5 w-3 bg-[#d4a017]" style={{ clipPath: "polygon(0 0, 100% 0, 50% 100%)" }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
