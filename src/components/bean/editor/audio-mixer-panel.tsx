"use client";

/**
 * BEAN FX — Audio mixer drawer (M26 P2).
 *
 * Real per-track faders (engine `UpdateTrack` commands — reversible, autosaved)
 * and REAL peak meters read from the live Web Audio graph (AudioPreviewMixer
 * analyser taps). No fabricated levels: meters move only while audio plays.
 * The same fader values reach the FFmpeg export (timeline-render).
 */
import { useEffect, useRef, useState } from "react";
import type { Sequence } from "@/lib/editor/model";
import type { EditorSession } from "@/hooks/use-editor-session";
import { getActiveMixer } from "@/lib/editor/audio-mixer";

const faderLabel = "bean-label text-[9px] text-[#8f8f8a]";

function TrackMeter({ trackId }: { trackId: string }) {
  const [level, setLevel] = useState(0);
  const raf = useRef<number | null>(null);
  useEffect(() => {
    const tick = () => {
      const mixer = getActiveMixer();
      setLevel(mixer ? mixer.trackLevel(trackId) : 0);
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    };
  }, [trackId]);
  return (
    <div className="h-2 w-16 overflow-hidden rounded bg-[#111110]" title="Live peak meter (moves while playing — real Web Audio levels)">
      <div className="h-full bg-gradient-to-r from-[#4cc47f] via-[#d4a017] to-[#c45c4c]" style={{ width: `${Math.round(level * 100)}%` }} />
    </div>
  );
}

export function AudioMixerPanel({ sequence, session }: { sequence: Sequence; session: EditorSession }) {
  const mixable = sequence.tracks.filter((t) => t.kind === "AUDIO" || t.kind === "VIDEO");
  return (
    <div className="space-y-2 text-xs text-[#b8b8b2]">
      <p className="text-[10px] leading-relaxed text-[#8f8f8a]">
        Per-track faders feed both the live preview and the FFmpeg export (multiplied with clip volume). Meters are real Web Audio peaks from the preview graph — they move while audio plays and stay at zero when idle.
      </p>
      {mixable.map((track) => (
        <div key={track.id} className="rounded border border-[#2a2a2a] bg-[#111110] px-2.5 py-2">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] text-[#d8d8d2]">{track.name}</span>
            <TrackMeter trackId={track.id} />
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <span className={faderLabel}>FADER</span>
            <input
              aria-label={`Track fader ${track.name}`}
              type="range"
              min={0}
              max={2}
              step={0.01}
              value={track.volume ?? 1}
              onChange={(e) => session.apply([{ type: "UpdateTrack", trackId: track.id, volume: Number(e.target.value) }])}
              className="h-1 flex-1 accent-[#d4a017]"
            />
            <span className="w-10 text-right font-mono text-[10px] text-[#d4d4d0]">{(track.volume ?? 1).toFixed(2)}</span>
          </div>
        </div>
      ))}
      <p className="text-[10px] text-[#6a6a64]">Clip-level pan and volume live in the inspector; loudness/repair processing lives in the GANGZII audio tool.</p>
    </div>
  );
}
