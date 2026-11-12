"use client";

/**
 * BEAN FX — Clip inspector (Milestone 2, editor integration).
 *
 * Every control dispatches a validated, reversible command through the
 * session — nothing here mutates clip state directly. Readouts use the same
 * integer-frame timecode helpers as the rest of the editor.
 */
import { useMemo } from "react";
import { Volume2, Timer, Move3d, Captions as CaptionsIcon } from "lucide-react";
import type { Sequence } from "@/lib/editor/model";
import { formatTimecode } from "@/lib/editor/time";
import type { EditorSession } from "@/hooks/use-editor-session";

const fieldLabel = "bean-label text-[9px] text-[#8f8f8a]";
const sliderClass = "h-1 w-full accent-[#d4a017]";

export function ClipInspector({
  sequence,
  session,
}: {
  sequence: Sequence;
  session: EditorSession;
}) {
  const clip = useMemo(
    () => sequence.clips.find((c) => c.id === session.selectedClipId) ?? null,
    [sequence, session.selectedClipId],
  );
  const track = clip ? sequence.tracks.find((t) => t.id === clip.trackId) : null;

  if (!clip) {
    return (
      <div className="rounded-lg border border-[#2a2a2a] bg-[#0b0b0a] p-3">
        <span className={fieldLabel}>INSPECTOR</span>
        <p className="mt-2 text-xs text-[#8f8f8a]">Select a clip on the timeline to inspect and edit its properties.</p>
      </div>
    );
  }

  const applyProps = (patch: Record<string, unknown>) => {
    session.apply([{ type: "UpdateClipProperties", clipId: clip.id, ...patch }]);
  };

  return (
    <div className="flex flex-col gap-3 overflow-y-auto rounded-lg border border-[#2a2a2a] bg-[#0b0b0a] p-3">
      <div className="flex items-center justify-between">
        <span className={fieldLabel}>INSPECTOR</span>
        <span className={`bean-label text-[9px] ${track ? "text-[#d4a017]" : ""}`}>{track?.kind ?? "CLIP"}</span>
      </div>
      <div className="rounded border border-[#1c1c1a] bg-[#111110] p-2">
        <div className="truncate text-xs text-[#e6e6e0]">{clip.label || clip.captionText || clip.id}</div>
        <div className="mt-1 font-mono text-[10px] text-[#8f8f8a]">
          {formatTimecode(clip.timelineStartFrame, sequence.fps)} → {formatTimecode(clip.timelineStartFrame + clip.timelineDurationFrames, sequence.fps)}
        </div>
        <div className="font-mono text-[10px] text-[#5a5a55]">
          source {clip.sourceInFrame}–{clip.sourceOutFrame} @ {clip.sourceFps.num}/{clip.sourceFps.den} fps
        </div>
      </div>

      {/* Audio */}
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs text-[#d8d8d2]">
          <Volume2 className="h-3.5 w-3.5 text-[#d4a017]" /> Volume
        </span>
        <button
          type="button"
          onClick={() => applyProps({ muted: !clip.muted })}
          className={`rounded border px-1.5 py-0.5 text-[10px] ${clip.muted ? "border-[#c45c4c] text-[#c45c4c]" : "border-[#2a2a2a] text-[#8f8f8a]"}`}
        >
          {clip.muted ? "MUTED" : "LIVE"}
        </button>
      </div>
      <input
        type="range"
        min={0}
        max={2}
        step={0.05}
        value={clip.volume}
        onChange={(e) => applyProps({ volume: Number(e.target.value) })}
        className={sliderClass}
        aria-label="Clip volume"
      />

      {/* Speed */}
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs text-[#d8d8d2]">
          <Timer className="h-3.5 w-3.5 text-[#d4a017]" /> Playback speed
        </span>
        <span className="font-mono text-[10px] text-[#8f8f8a]">{clip.playbackSpeed.toFixed(2)}×</span>
      </div>
      <input
        type="range"
        min={0.25}
        max={4}
        step={0.25}
        value={clip.playbackSpeed}
        onChange={(e) => session.apply([{ type: "ChangePlaybackSpeed", clipId: clip.id, speed: Number(e.target.value) }])}
        className={sliderClass}
        aria-label="Playback speed"
      />

      {/* Fades */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <span className={fieldLabel}>FADE IN (FRAMES)</span>
          <input
            type="number"
            min={0}
            max={Math.max(0, clip.timelineDurationFrames - 1)}
            value={clip.fadeInFrames}
            onChange={(e) => applyProps({ fadeInFrames: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
            className="mt-1 w-full rounded border border-[#2a2a2a] bg-[#111110] px-1.5 py-1 font-mono text-[11px] text-[#e6e6e0] outline-none focus:border-[#d4a017]"
          />
        </div>
        <div>
          <span className={fieldLabel}>FADE OUT (FRAMES)</span>
          <input
            type="number"
            min={0}
            max={Math.max(0, clip.timelineDurationFrames - 1)}
            value={clip.fadeOutFrames}
            onChange={(e) => applyProps({ fadeOutFrames: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
            className="mt-1 w-full rounded border border-[#2a2a2a] bg-[#111110] px-1.5 py-1 font-mono text-[11px] text-[#e6e6e0] outline-none focus:border-[#d4a017]"
          />
        </div>
      </div>

      {/* Transform */}
      <div className="flex items-center gap-1.5 text-xs text-[#d8d8d2]">
        <Move3d className="h-3.5 w-3.5 text-[#d4a017]" /> Transform
      </div>
      <div className="grid grid-cols-2 gap-2 text-[10px] text-[#8f8f8a]">
        <label className="flex flex-col gap-1">
          OPACITY
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={clip.transform.opacity}
            onChange={(e) => applyProps({ transform: { ...clip.transform, opacity: Number(e.target.value) } })}
            className={sliderClass}
          />
        </label>
        <label className="flex flex-col gap-1">
          SCALE
          <input
            type="range"
            min={0.1}
            max={3}
            step={0.05}
            value={clip.transform.scale}
            onChange={(e) => applyProps({ transform: { ...clip.transform, scale: Number(e.target.value) } })}
            className={sliderClass}
          />
        </label>
        <label className="flex flex-col gap-1">
          X
          <input
            type="range"
            min={-960}
            max={960}
            step={2}
            value={clip.transform.x}
            onChange={(e) => applyProps({ transform: { ...clip.transform, x: Number(e.target.value) } })}
            className={sliderClass}
          />
        </label>
        <label className="flex flex-col gap-1">
          Y
          <input
            type="range"
            min={-540}
            max={540}
            step={2}
            value={clip.transform.y}
            onChange={(e) => applyProps({ transform: { ...clip.transform, y: Number(e.target.value) } })}
            className={sliderClass}
          />
        </label>
      </div>

      {/* Caption editing for caption clips */}
      {track?.kind === "CAPTION" && (
        <div className="flex flex-col gap-1.5">
          <span className="flex items-center gap-1.5 text-xs text-[#d8d8d2]">
            <CaptionsIcon className="h-3.5 w-3.5 text-[#9a7bd4]" /> Caption text
          </span>
          <textarea
            value={clip.captionText ?? ""}
            onChange={(e) => applyProps({ captionText: e.target.value.slice(0, 2000) })}
            rows={3}
            className="w-full resize-none rounded border border-[#2a2a2a] bg-[#111110] px-2 py-1.5 text-xs text-[#e6e6e0] outline-none focus:border-[#9a7bd4]"
          />
          <label className="flex flex-col gap-1 text-[10px] text-[#8f8f8a]">
            POSITION
            <select
              value={clip.captionStyle?.position ?? "BOTTOM"}
              onChange={(e) =>
                applyProps({
                  captionStyle: {
                    fontSize: clip.captionStyle?.fontSize ?? 48,
                    color: clip.captionStyle?.color ?? "#FFFFFF",
                    background: clip.captionStyle?.background ?? null,
                    position: e.target.value,
                  },
                })
              }
              className="rounded border border-[#2a2a2a] bg-[#111110] px-1.5 py-1 text-[11px] text-[#e6e6e0] outline-none"
            >
              <option value="TOP">TOP</option>
              <option value="CENTER">CENTER</option>
              <option value="BOTTOM">BOTTOM</option>
            </select>
          </label>
        </div>
      )}
    </div>
  );
}
