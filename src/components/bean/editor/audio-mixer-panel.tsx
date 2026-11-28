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

function BusMeter({ busId }: { busId: string }) {
  const [level, setLevel] = useState(0);
  const raf = useRef<number | null>(null);
  useEffect(() => {
    const tick = () => {
      const mixer = getActiveMixer();
      setLevel(mixer ? mixer.busLevel(busId) : 0);
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    };
  }, [busId]);
  return (
    <div className="h-2 w-16 overflow-hidden rounded bg-[#111110]" title="Live bus meter (real Web Audio peaks post-fader)">
      <div className="h-full bg-gradient-to-r from-[#3f6c45] to-[#d4a017]" style={{ width: `${Math.round(level * 100)}%` }} />
    </div>
  );
}

export function AudioMixerPanel({ sequence, session }: { sequence: Sequence; session: EditorSession }) {
  const mixable = sequence.tracks.filter((t) => t.kind === "AUDIO" || t.kind === "VIDEO");
  return (
    <div className="space-y-2 text-xs text-[#b8b8b2]">
      <p className="text-[10px] leading-relaxed text-[#8f8f8a]">
        Per-track faders and bus faders feed both the live preview and the FFmpeg export — the same values mix the real signal. Meters are real Web Audio peaks from the preview graph — they move while audio plays and stay at zero when idle.
      </p>

      {/* M48-H2 — bus strips: real fader/pan/mute/solo through reversible commands */}
      {sequence.buses.map((bus) => (
        <div key={bus.id} className="rounded border border-[#3a3424] bg-[#141310] px-2.5 py-2">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] text-[#d4a017]">{bus.name}</span>
            <div className="flex items-center gap-1.5">
              <button
                aria-label={`Bus mute ${bus.name}`}
                onClick={() => session.apply([{ type: "UpdateBus", busId: bus.id, muted: !bus.muted }])}
                className={`rounded border px-1.5 py-0.5 text-[9px] font-bold ${bus.muted ? "border-[#f87171]/60 text-[#f87171]" : "border-[#2a2a2a] text-[#8f8f8a]"}`}
              >M</button>
              <button
                aria-label={`Bus solo ${bus.name}`}
                onClick={() => session.apply([{ type: "UpdateBus", busId: bus.id, solo: !bus.solo }])}
                className={`rounded border px-1.5 py-0.5 text-[9px] font-bold ${bus.solo ? "border-[#d4a017]/60 text-[#d4a017]" : "border-[#2a2a2a] text-[#8f8f8a]"}`}
              >S</button>
              <BusMeter busId={bus.id} />
            </div>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <span className={faderLabel}>BUS</span>
            <input
              aria-label={`Bus fader ${bus.name}`}
              type="range"
              min={0}
              max={2}
              step={0.01}
              value={bus.gain}
              onChange={(e) => session.apply([{ type: "UpdateBus", busId: bus.id, gain: Number(e.target.value) }])}
              className="h-1 flex-1 accent-[#d4a017]"
            />
            <span className="w-10 text-right font-mono text-[10px] text-[#d4d4d0]">{bus.gain.toFixed(2)}</span>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span className={faderLabel}>PAN</span>
            <input
              aria-label={`Bus pan ${bus.name}`}
              type="range"
              min={-1}
              max={1}
              step={0.01}
              value={bus.pan}
              onChange={(e) => session.apply([{ type: "UpdateBus", busId: bus.id, pan: Number(e.target.value) }])}
              className="h-1 flex-1 accent-[#8f8f8a]"
            />
            <span className="w-10 text-right font-mono text-[10px] text-[#d4d4d0]">{bus.pan.toFixed(2)}</span>
          </div>
        </div>
      ))}

      {/* M48-H2 — add a bus (one of the four standard kinds) */}
      <div className="flex items-center gap-1.5">
        {(["DIALOGUE", "MUSIC", "SFX", "AMBIENCE"] as const).map((kind) => {
          const exists = sequence.buses.some((b) => b.kind === kind);
          return (
            <button
              key={kind}
              disabled={exists || sequence.buses.length >= 8}
              onClick={() => session.apply([{ type: "AddBus", bus: { id: `bus-${kind.toLowerCase()}-${Math.random().toString(36).slice(2, 7)}`, kind, name: kind.charAt(0) + kind.slice(1).toLowerCase(), gain: 1, pan: 0, muted: false, solo: false } }])}
              className="rounded border border-[#2a2a2a] px-1.5 py-0.5 text-[9px] text-[#8f8f8a] hover:border-[#d4a017]/50 hover:text-[#d4a017] disabled:opacity-30"
              title={exists ? `${kind} bus already exists` : `Add a ${kind} bus`}
            >+{kind.slice(0, 3)}</button>
          );
        })}
      </div>

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
          {sequence.buses.length > 0 && (
            <div className="mt-1 flex items-center gap-2">
              <span className={faderLabel}>BUS</span>
              <select
                aria-label={`Track bus assignment ${track.name}`}
                value={track.busId ?? ""}
                onChange={(e) => session.apply([{ type: "AssignTrackBus", trackId: track.id, busId: e.target.value === "" ? null : e.target.value }])}
                className="flex-1 rounded border border-[#2a2a2a] bg-[#111110] px-1 py-0.5 text-[10px] text-[#d8d8d2]"
              >
                <option value="">— master (no bus) —</option>
                {sequence.buses.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      ))}
      <p className="text-[10px] text-[#6a6a64]">Clip-level pan and volume live in the inspector; loudness/repair processing lives in the GANGZII audio tool. EQ/compression/limiting/ducking are NOT implemented — controls appear only when a real processing path exists.</p>
    </div>
  );
}
