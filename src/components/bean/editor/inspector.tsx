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
import { FILTER_EFFECTS, filterSpec, APPROXIMATE_PREVIEW, ffmpegEffectChain, cssEffectFilter, audioGainMultiplier } from "@/lib/editor/filters";
import type { Effect } from "@/lib/editor/model";

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
        max={4}
        step={0.05}
        value={clip.volume}
        onChange={(e) => session.apply([{ type: "ChangeVolume", clipId: clip.id, volume: Number(e.target.value) }])}
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

      {/* ── M16 Effects + Color correction ─────────────────────────────── */}
      <EffectsSection clip={clip} session={session} />
    </div>
  );
}

/**
 * M16 Phase F — effect parameters, enable/disable, order, reset and the
 * COLOR section. Every change is a validated command batch:
 * enable/disable and re-parameterize = [RemoveEffect, AddEffect] (same id,
 * new flags), reorder = remove-all + re-add in the new order. The parity
 * note shows the exact preview CSS and export FFmpeg chains generated by
 * lib/editor/filters.ts — the single source of truth for both.
 */
function EffectsSection({ clip, session }: { clip: import("@/lib/editor/model").Clip; session: EditorSession }) {
  const effects = clip.effects;
  const visual = effects.filter((e) => e.type !== "volume");
  const setEffects = (next: Effect[]) => {
    session.apply([...effects.map((e) => ({ type: "RemoveEffect", clipId: clip.id, effectId: e.id })), ...next.map((e) => ({ type: "AddEffect", clipId: clip.id, effect: e }))]);
  };
  const withEffect = (effect: Effect, mutate: (e: Effect) => Effect) => {
    session.apply([
      { type: "RemoveEffect", clipId: clip.id, effectId: effect.id },
      { type: "AddEffect", clipId: clip.id, effect: mutate(effect) },
    ]);
  };
  const addEffect = (type: (typeof FILTER_EFFECTS)[number]["type"] | "volume") => {
    const spec = type === "volume" ? null : filterSpec(type);
    const params = spec ? { [spec.param.key]: spec.param.default } : { value: 1 };
    session.apply([{ type: "AddEffect", clipId: clip.id, effect: { id: session.newId("fx"), type, enabled: true, params } }]);
  };
  const moveEffect = (index: number, delta: -1 | 1) => {
    const next = [...effects];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setEffects(next);
  };
  const colorSpecs = FILTER_EFFECTS.filter((f) => f.group === "color");
  const hasColor = effects.some((e) => colorSpecs.some((c) => c.type === e.type));

  return (
    <div className="rounded border border-[#1c1c1a] bg-[#111110] p-2">
      <div className="flex items-center justify-between">
        <span className={fieldLabel}>EFFECTS ({effects.length})</span>
        {visual.length > 0 && (
          <button type="button" onClick={() => setEffects(effects.map((e) => (e.type === "volume" ? e : { ...e, enabled: false })))} className="text-[9px] text-[#8f8f8a] hover:text-[#d4a017]" title="Bypass all visual effects (remove them to delete)">
            BYPASS
          </button>
        )}
      </div>
      {/* Existing effects: parameters, enable, order */}
      <ul className="mt-1 space-y-1.5">
        {effects.map((effect, index) => {
          const spec = filterSpec(effect.type);
          const approx = APPROXIMATE_PREVIEW.includes(effect.type);
          return (
            <li key={effect.id} className="rounded bg-[#161614] px-2 py-1.5">
              <div className="flex items-center gap-1">
                <span className="min-w-0 flex-1 truncate text-[11px] text-[#e6e6e0]">
                  {spec?.label ?? effect.type}
                  {approx ? <span className="ml-1 text-[8px] text-[#c47f4c]" title="Preview approximates this export-only chain">≈</span> : null}
                </span>
                <button type="button" title="Move up" onClick={() => moveEffect(index, -1)} className="px-0.5 text-[9px] text-[#6a6a64] hover:text-[#d4a017]">▲</button>
                <button type="button" title="Move down" onClick={() => moveEffect(index, 1)} className="px-0.5 text-[9px] text-[#6a6a64] hover:text-[#d4a017]">▼</button>
                <button
                  type="button"
                  title={effect.enabled ? "Disable" : "Enable"}
                  onClick={() => withEffect(effect, (e) => ({ ...e, enabled: !e.enabled }))}
                  className={`rounded px-1 py-0.5 text-[9px] ${effect.enabled ? "border border-[#d4a017]/50 text-[#d4a017]" : "border border-[#2a2a2a] text-[#6a6a64]"}`}
                >
                  {effect.enabled ? "ON" : "OFF"}
                </button>
                <button type="button" title="Reset parameter" onClick={() => withEffect(effect, (e) => ({ ...e, params: spec ? { [spec.param.key]: spec.param.default } : e.params }))} className="px-1 text-[9px] text-[#8f8f8a] hover:text-[#d4a017]">
                  ↺
                </button>
                <button type="button" title="Remove effect" onClick={() => session.apply([{ type: "RemoveEffect", clipId: clip.id, effectId: effect.id }])} className="px-1 text-[9px] text-[#c45c4c] hover:text-[#e06c55]">
                  ✕
                </button>
              </div>
              {spec && effect.enabled && (
                <label className="mt-1 flex items-center gap-1.5">
                  <span className="w-10 shrink-0 text-[9px] text-[#6a6a64]">{spec.param.key}{spec.param.unit ? ` (${spec.param.unit})` : ""}</span>
                  <input
                    type="range"
                    min={spec.param.min}
                    max={spec.param.max}
                    step={spec.param.step}
                    value={Number(effect.params[spec.param.key] ?? spec.param.default)}
                    onChange={(e) => withEffect(effect, (x) => ({ ...x, params: { ...x.params, [spec.param.key]: Number(e.target.value) } }))}
                    className={sliderClass}
                  />
                  <span className="w-9 shrink-0 text-right font-mono text-[9px] text-[#a8a8a0]">{Number(effect.params[spec.param.key] ?? spec.param.default).toFixed(2)}</span>
                </label>
              )}
            </li>
          );
        })}
        {effects.length === 0 && <li className="text-[10px] text-[#6a6a64]">No effects. Add below — every item is a real previewed/exported chain.</li>}
      </ul>
      {/* Add visual/audio effects */}
      <div className="mt-2 flex flex-wrap gap-1">
        {FILTER_EFFECTS.filter((f) => f.group !== "color").map((f) => (
          <button key={f.type} type="button" onClick={() => addEffect(f.type)} className="rounded border border-[#2a2a2a] px-1.5 py-0.5 text-[9px] text-[#d8d8d2] hover:border-[#d4a017] hover:text-[#d4a017]">
            + {f.label}
          </button>
        ))}
        <button type="button" onClick={() => addEffect("volume")} className="rounded border border-[#2a2a2a] px-1.5 py-0.5 text-[9px] text-[#d8d8d2] hover:border-[#3fa7c4] hover:text-[#3fa7c4]">
          + Volume
        </button>
      </div>

      {/* COLOR section */}
      <div className="mt-2 border-t border-[#1c1c1a] pt-2">
        <div className="flex items-center justify-between">
          <span className={fieldLabel}>COLOR</span>
          {hasColor && (
            <button
              type="button"
              title="Remove all color corrections"
              onClick={() => setEffects(effects.filter((e) => !colorSpecs.some((c) => c.type === e.type)))}
              className="text-[9px] text-[#8f8f8a] hover:text-[#d4a017]"
            >
              RESET
            </button>
          )}
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          {colorSpecs.map((f) => (
            <button key={f.type} type="button" onClick={() => addEffect(f.type)} className="rounded border border-[#2a2a2a] px-1.5 py-0.5 text-[9px] text-[#d8d8d2] hover:border-[#d4a017] hover:text-[#d4a017]">
              + {f.label}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[9px] leading-relaxed text-[#6a6a64]">
          Color operates in the player&apos;s default sRGB-ish space on both paths (documented in lib/editor/filters.ts). Highlight/shadow controls are tone-curve approximations on the export `eq` chain — marked ≈ above.
        </p>
        <ParityNote effects={effects} />
      </div>
    </div>
  );
}

/** Shows the REAL generated preview (CSS) and export (FFmpeg) chains. */
function ParityNote({ effects }: { effects: Effect[] }) {
  const css = cssEffectFilter(effects);
  const ff = ffmpegEffectChain(effects);
  const gain = audioGainMultiplier(effects);
  if (!css && !ff && gain === 1) return null;
  return (
    <p className="mt-1 font-mono text-[8px] leading-relaxed text-[#5a5a55]">
      preview: {css ?? "—"} · export: {ff ?? "—"}
      {gain !== 1 ? ` · gain ×${gain.toFixed(2)}` : ""}
    </p>
  );
}
