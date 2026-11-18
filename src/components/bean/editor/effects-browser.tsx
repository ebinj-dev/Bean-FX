"use client";

/**
 * M15 — Effects browser (left dock, EFFECTS tab).
 *
 * Only REAL implementations are listed, each applied through a validated M1
 * command: clip effects (opacity/volume/flipH/flipV/grayscale/blur via
 * AddEffect), transitions (CUT/CROSS_DISSOLVE/FADE_TO_BLACK/FADE_FROM_BLACK/
 * WIPE_LEFT/WIPE_RIGHT/SLIDE_LEFT/SLIDE_RIGHT via AddTransition at the
 * playhead on a video/audio track), fades (UpdateClipProperties) and speed
 * (ChangePlaybackSpeed). Unsupported things are NOT shown — no fake tiles.
 */
import { useState } from "react";
import { Plus } from "lucide-react";
import type { Sequence } from "@/lib/editor/model";
import { clipEndFrame } from "@/lib/editor/model";
import type { EditorSession } from "@/hooks/use-editor-session";

const CLIP_EFFECTS: { type: "opacity" | "volume" | "flipH" | "flipV" | "grayscale" | "blur"; label: string; params?: Record<string, number | string | boolean>; note: string }[] = [
  { type: "opacity", label: "Opacity", params: {}, note: "Constant opacity multiplier (keyframes via the inspector)" },
  { type: "volume", label: "Volume", params: {}, note: "Audio gain multiplier" },
  { type: "flipH", label: "Flip Horizontal", note: "Mirror the frame horizontally" },
  { type: "flipV", label: "Flip Vertical", note: "Mirror the frame vertically" },
  { type: "grayscale", label: "Grayscale", note: "Desaturate the clip" },
  { type: "blur", label: "Blur", params: { radius: 6 }, note: "Gaussian blur (radius parameter)" },
];

const TRANSITIONS: { kind: "CUT" | "CROSS_DISSOLVE" | "FADE_TO_BLACK" | "FADE_FROM_BLACK" | "WIPE_LEFT" | "WIPE_RIGHT" | "SLIDE_LEFT" | "SLIDE_RIGHT"; label: string }[] = [
  { kind: "CROSS_DISSOLVE", label: "Cross Dissolve" },
  { kind: "FADE_TO_BLACK", label: "Fade to Black" },
  { kind: "FADE_FROM_BLACK", label: "Fade from Black" },
  { kind: "WIPE_LEFT", label: "Wipe Left" },
  { kind: "WIPE_RIGHT", label: "Wipe Right" },
  { kind: "SLIDE_LEFT", label: "Slide Left" },
  { kind: "SLIDE_RIGHT", label: "Slide Right" },
];

export function EffectsBrowser({
  sequence,
  session,
  notice,
}: {
  sequence: Sequence | null;
  session: EditorSession;
  notice: (message: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const selectedClip = sequence?.clips.find((c) => c.id === session.selectedClipId) ?? null;
  const q = query.trim().toLowerCase();

  const applyEffect = (type: (typeof CLIP_EFFECTS)[number]["type"], params?: Record<string, number | string | boolean>) => {
    if (!selectedClip) {
      notice("Select a clip first — effects apply to the selection.");
      return;
    }
    const ok = session.apply([{ type: "AddEffect", clipId: selectedClip.id, effect: { id: session.newId("fx"), type, enabled: true, params: params ?? {} } }]);
    notice(ok ? null : "Effect refused by the engine.");
  };

  const applyTransition = (kind: (typeof TRANSITIONS)[number]["kind"]) => {
    if (!sequence) return;
    const track = sequence.tracks.find((t) => (t.kind === "VIDEO" || t.kind === "AUDIO") && !t.locked);
    if (!track) {
      notice("No unlocked video/audio track for a transition.");
      return;
    }
    const ok = session.apply([{ type: "AddTransition", transitionId: session.newId("tr"), trackId: track.id, kind, startFrame: session.playheadFrame, durationFrames: Math.round(sequence.fps.num / sequence.fps.den), params: {} }]);
    notice(ok ? null : "Transition refused by the engine (needs adjacent clips around the playhead).");
  };

  const applyFade = (edge: "in" | "out") => {
    if (!selectedClip || !sequence) return;
    const frames = Math.round(sequence.fps.num / sequence.fps.den);
    const ok = session.apply([
      {
        type: "UpdateClipProperties",
        clipId: selectedClip.id,
        ...(edge === "in" ? { fadeInFrames: Math.min(selectedClip.timelineDurationFrames - 1, frames) } : { fadeOutFrames: Math.min(selectedClip.timelineDurationFrames - 1, frames) }),
      },
    ]);
    notice(ok ? null : "Fade refused by the engine.");
  };

  const applySpeed = (speed: number) => {
    if (!selectedClip || !sequence) return;
    const end = clipEndFrame(sequence, selectedClip);
    const ok = session.apply([{ type: "ChangePlaybackSpeed", clipId: selectedClip.id, newPlaybackSpeed: speed }]);
    if (ok) notice(`Speed ${speed}× applied — clip now ends at frame ${Math.max(end, 0)} region; adjust trims as needed.`);
    else notice("Speed change refused by the engine.");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <input value={query} onChange={(e) => setQuery(e.target.value.slice(0, 60))} placeholder="Search effects…" className="mx-2 mt-2 rounded border border-[#2a2a2a] bg-[#111110] px-2 py-1 text-[11px] outline-none placeholder:text-[#5a5a55] focus:border-[#d4a017]" />
      <div className="min-h-0 flex-1 overflow-y-auto p-2 text-[11px]">
        <div className="bean-label mb-1 text-[9px] text-[#8f8f8a]">CLIP EFFECTS {selectedClip ? `→ ${selectedClip.label || selectedClip.id}` : "(select a clip)"}</div>
        <ul className="mb-3 space-y-1">
          {CLIP_EFFECTS.filter((fx) => !q || fx.label.toLowerCase().includes(q) || fx.type.includes(q)).map((fx) => (
            <li key={fx.type} className="rounded border border-[#1c1c1a] bg-[#111110] px-2 py-1.5">
              <div className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-[#e6e6e0]">{fx.label}</span>
                <button type="button" onClick={() => applyEffect(fx.type, fx.params)} title={`Apply ${fx.label} to the selected clip`} className="rounded border border-[#2a2a2a] p-0.5 text-[#a8a8a0] hover:border-[#d4a017] hover:text-[#d4a017]">
                  <Plus className="h-3 w-3" />
                </button>
              </div>
              <div className="text-[9px] text-[#6a6a64]">{fx.note}</div>
            </li>
          ))}
        </ul>
        <div className="bean-label mb-1 text-[9px] text-[#8f8f8a]">TRANSITIONS (at playhead)</div>
        <ul className="mb-3 space-y-1">
          {TRANSITIONS.filter((tr) => !q || tr.label.toLowerCase().includes(q)).map((tr) => (
            <li key={tr.kind} className="flex items-center gap-1.5 rounded border border-[#1c1c1a] bg-[#111110] px-2 py-1.5">
              <span className="min-w-0 flex-1 truncate text-[#e6e6e0]">{tr.label}</span>
              <button type="button" onClick={() => applyTransition(tr.kind)} title={`Add ${tr.label} at the playhead`} className="rounded border border-[#2a2a2a] p-0.5 text-[#a8a8a0] hover:border-[#d4a017] hover:text-[#d4a017]">
                <Plus className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
        <div className="bean-label mb-1 text-[9px] text-[#8f8f8a]">Fades &amp; speed {selectedClip ? `(→ ${selectedClip.label || selectedClip.id})` : "(select a clip)"}</div>
        <div className="flex flex-wrap gap-1">
          {[
            { label: "1s fade in", run: () => applyFade("in") },
            { label: "1s fade out", run: () => applyFade("out") },
            { label: "0.5×", run: () => applySpeed(0.5) },
            { label: "1×", run: () => applySpeed(1) },
            { label: "2×", run: () => applySpeed(2) },
          ].map((b) => (
            <button key={b.label} type="button" onClick={b.run} disabled={!selectedClip} className="rounded border border-[#2a2a2a] px-2 py-0.5 text-[10px] text-[#d8d8d2] hover:border-[#d4a017] hover:text-[#d4a017] disabled:opacity-40">
              {b.label}
            </button>
          ))}
        </div>
        <p className="mt-3 text-[9px] leading-relaxed text-[#6a6a64]">
          Every listed item compiles to a validated timeline command with a real preview/export path. Motion graphics presets live in AI STUDIO → NIIKI; M14 composition motion presets in AI STUDIO → COMPOSE.
        </p>
      </div>
    </div>
  );
}
