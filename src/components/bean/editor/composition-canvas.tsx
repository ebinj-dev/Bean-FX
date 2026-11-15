"use client";

/**
 * M15 Phase C — Interactive composition canvas over the Program Monitor.
 *
 * Reads the SAME sequence state the export path evaluates (lib/editor/preview
 * + nikki state) and overlays REAL, draggable layer geometry: bounding boxes
 * for every visual layer active at the playhead (graphics measured from the
 * NIIKI text metrics, captions measured with the same font stack, video clips
 * as the full frame). Dragging commits validated M1 commands
 * (UpdateClipProperties transform) as ONE undoable step; a live ghost box
 * previews the gesture before commit. No separate visual interpretation —
 * the boxes are computed from the same transform fields the renderer uses.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Sequence, Clip, Transform } from "@/lib/editor/model";
import { clipEndFrame } from "@/lib/editor/model";
import { activeGraphicsAt } from "@/lib/nikki/state";
import { ensureNikkiFonts } from "@/lib/nikki/canvas";
import type { EditorSession } from "@/hooks/use-editor-session";
import type { EditToolId } from "@/lib/editor/tools";

interface LayerBox {
  clipId: string;
  label: string;
  kind: "video" | "graphic" | "caption";
  /** Composition-pixel rect (center + size), rotation applied at render. */
  cx: number;
  cy: number;
  w: number;
  h: number;
  rotation: number;
  scale: number;
  opacity: number;
}

const HANDLE = 9;

/** Text metrics for graphics/captions — measured with the same font the
 *  canvas layer draws (fallback estimate when fonts are not ready). Pure:
 *  the ctx is passed in and only used transiently. */
const measureCanvas: HTMLCanvasElement | null = typeof document === "undefined" ? null : document.createElement("canvas");
const measureCtxOrNull: CanvasRenderingContext2D | null = measureCanvas?.getContext("2d") ?? null;

function measureTextBox(clip: Clip, seqW: number, seqH: number, fontsReady: boolean): { w: number; h: number } {
  const text = clip.graphicStyle?.primaryText ?? clip.captionText ?? "";
  const fontSize = Math.round(((clip.graphicStyle?.primarySizePct ?? 8) / 100) * seqH) || clip.captionStyle?.fontSize || 48;
  const ctx = measureCtxOrNull;
  if (ctx && fontsReady && text) {
    ctx.font = `600 ${fontSize}px "Noto Sans SC", "DejaVu Sans", sans-serif`;
    const lines = text.split("\n");
    const maxW = Math.max(...lines.map((l) => ctx.measureText(l).width), fontSize);
    const lineHeight = fontSize * 1.25;
    return { w: Math.min(seqW * 0.96, maxW + fontSize * 0.5), h: Math.min(seqH * 0.96, lines.length * lineHeight + fontSize * 0.4) };
  }
  return { w: Math.min(seqW * 0.6, Math.max(fontSize * 4, text.length * fontSize * 0.55)), h: fontSize * 1.5 };
}

export function CompositionCanvas({
  sequence,
  playhead,
  session,
  activeTool,
  guides,
  snapEnabled,
}: {
  sequence: Sequence;
  playhead: number;
  session: EditorSession;
  activeTool: EditToolId;
  guides: boolean;
  snapEnabled: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [wrapRect, setWrapRect] = useState<{ w: number; h: number } | null>(null);
  const [fontsReady, setFontsReady] = useState(false);
  const measureRef = useRef<HTMLCanvasElement | null>(null);
  void measureRef;
  // Gesture state lives in a REF so the move/up handlers are ALWAYS attached
  // (state-gated handlers lose events that arrive before the re-render —
  // synthetic dispatches and very fast real drags both hit this).
  const gestureRef = useRef<null | { clipId: string; mode: "move" | "scale" | "rotate"; startClientX: number; startClientY: number; base: Transform; baseW: number; baseH: number; live: Transform }>(null);
  const [gestureLive, setGestureLive] = useState<null | { clipId: string; mode: "move" | "scale" | "rotate"; base: Transform; live: Transform }>(null);
  // M16 Phase E: multi-selection + group moves + keyboard nudge + Escape cancel.
  const [multiIds, setMultiIds] = useState<Set<string>>(new Set());

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setWrapRect({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    void ensureNikkiFonts().then(() => setFontsReady(true));
    return () => ro.disconnect();
  }, []);

  // Fit the composition (object-contain math, same as the video element).
  const fit = useMemo(() => {
    if (!wrapRect) return null;
    const scale = Math.min(wrapRect.w / sequence.width, wrapRect.h / sequence.height);
    return { scale, w: sequence.width * scale, h: sequence.height * scale, left: (wrapRect.w - sequence.width * scale) / 2, top: (wrapRect.h - sequence.height * scale) / 2 };
  }, [wrapRect, sequence.width, sequence.height]);

  const measureBox = useCallback((clip: Clip) => measureTextBox(clip, sequence.width, sequence.height, fontsReady), [sequence.width, sequence.height, fontsReady]);

  // Layers active at the playhead — computed from the SAME resolvers the
  // renderer uses (activeGraphicsAt / caption resolver / video resolver).
  const layers = useMemo<LayerBox[]>(() => {
    const out: LayerBox[] = [];
    for (const track of sequence.tracks) {
      if (!track.visible) continue;
      for (const clip of sequence.clips) {
        if (clip.trackId !== track.id) continue;
        if (playhead < clip.timelineStartFrame || playhead >= clipEndFrame(sequence, clip)) continue;
        const t = clip.transform;
        if (track.kind === "VIDEO" || track.kind === "OVERLAY") {
          if (!clip.graphicStyle) {
            out.push({ clipId: clip.id, label: clip.label || clip.id, kind: "video", cx: sequence.width / 2 + t.x, cy: sequence.height / 2 + t.y, w: sequence.width, h: sequence.height, rotation: t.rotation, scale: t.scale, opacity: t.opacity });
            continue;
          }
        }
        if (track.kind === "GRAPHIC" || track.kind === "OVERLAY") {
          const st = activeGraphicsAt(sequence, playhead).find((g) => g.clip.id === clip.id)?.state;
          const base = measureBox(clip);
          const cxPct = st?.xPct ?? 50;
          const cyPct = st?.yPct ?? 50;
          out.push({
            clipId: clip.id,
            label: clip.label || clip.captionText?.slice(0, 20) || clip.id,
            kind: "graphic",
            cx: (cxPct / 100) * sequence.width + t.x,
            cy: (cyPct / 100) * sequence.height + t.y,
            w: base.w * (st?.scalePct ?? 100) / 100,
            h: base.h * (st?.scalePct ?? 100) / 100,
            rotation: st?.rotation ?? t.rotation,
            scale: st?.scalePct ?? t.scale * 100,
            opacity: st?.opacity ?? t.opacity,
          });
          continue;
        }
        if (track.kind === "CAPTION") {
          const base = measureBox(clip);
          const pos = clip.captionStyle?.position ?? "BOTTOM";
          const cy = pos === "TOP" ? sequence.height * 0.12 : pos === "CENTER" ? sequence.height * 0.5 : sequence.height * 0.88;
          out.push({ clipId: clip.id, label: clip.captionText?.slice(0, 20) || clip.id, kind: "caption", cx: sequence.width / 2 + t.x, cy: cy + t.y, w: base.w, h: base.h, rotation: t.rotation, scale: t.scale, opacity: t.opacity });
        }
      }
    }
    return out;
  }, [sequence, playhead, measureBox]);

  const selected = layers.find((l) => l.clipId === session.selectedClipId) ?? null;

  // Gesture → composition coordinates.
  const toComp = useCallback(
    (clientX: number, clientY: number) => {
      if (!fit || !wrapRef.current) return { x: 0, y: 0 };
      const rect = wrapRef.current.getBoundingClientRect();
      return { x: (clientX - rect.left - fit.left) / fit.scale, y: (clientY - rect.top - fit.top) / fit.scale };
    },
    [fit],
  );

  const startGesture = useCallback(
    (e: React.PointerEvent, mode: "move" | "scale" | "rotate", layer: LayerBox) => {
      e.preventDefault();
      e.stopPropagation();
      const clip = sequence.clips.find((c) => c.id === layer.clipId);
      if (!clip) return;
      if (e.shiftKey) {
        setMultiIds((prev) => new Set([...prev, clip.id]));
      } else if (multiIds.size > 1 && !multiIds.has(clip.id)) {
        setMultiIds(new Set([clip.id]));
      }
      session.select(clip.id);
      gestureRef.current = { clipId: clip.id, mode, startClientX: e.clientX, startClientY: e.clientY, base: { ...clip.transform }, baseW: layer.w, baseH: layer.h, live: { ...clip.transform } };
      setGestureLive({ clipId: clip.id, mode, base: { ...clip.transform }, live: { ...clip.transform } });
      try {
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      } catch {
        // Synthetic/test pointers have no active pointer id — capture is
        // optional (real drags capture; automation dispatches skip it).
      }
    },
    [sequence, session, multiIds],
  );

  const onGestureMove = useCallback(
    (e: React.PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || !fit) return;
      const dxComp = (e.clientX - gesture.startClientX) / fit.scale;
      const dyComp = (e.clientY - gesture.startClientY) / fit.scale;
      let live = { ...gesture.base };
      if (gesture.mode === "move") {
        live = { ...live, x: gesture.base.x + dxComp, y: gesture.base.y + dyComp };
        if (snapEnabled) {
          // Snap to frame center / thirds when within 12 composition px.
          const snapsX = [sequence.width / 2, sequence.width / 3, (2 * sequence.width) / 3];
          const snapsY = [sequence.height / 2, sequence.height / 3, (2 * sequence.height) / 3];
          const sel = layers.find((l) => l.clipId === gesture.clipId);
          if (sel) {
            const cx = sequence.width / 2 + live.x;
            const cy = sequence.height / 2 + live.y;
            for (const s of snapsX) if (Math.abs(cx - s) < 12) live = { ...live, x: live.x + (s - cx) };
            for (const s of snapsY) if (Math.abs(cy - s) < 12) live = { ...live, y: live.y + (s - cy) };
          }
        }
      } else if (gesture.mode === "scale") {
        const factor = Math.max(0.05, 1 + dxComp / Math.max(60, gesture.baseW / 2));
        live = { ...live, scale: Math.min(20, Math.max(0.01, gesture.base.scale * factor)) };
      } else {
        live = { ...live, rotation: Math.max(-360, Math.min(360, gesture.base.rotation + dxComp / 2)) };
      }
      gestureRef.current = { ...gesture, live };
      setGestureLive({ clipId: gesture.clipId, mode: gesture.mode, base: gesture.base, live: { ...live } });
    },
    [fit, snapEnabled, sequence.width, sequence.height, layers],
  );

  const commitGesture = useCallback(() => {
    const g = gestureRef.current;
    if (!g) return;
    gestureRef.current = null;
    setGestureLive(null);
    const base = g.base;
    const changed = Math.abs(g.live.x - base.x) > 0.5 || Math.abs(g.live.y - base.y) > 0.5 || Math.abs(g.live.scale - base.scale) > 0.005 || Math.abs(g.live.rotation - base.rotation) > 0.5;
    if (!changed) return;
    // Multi-selection: the same DELTA applies to every selected visual layer
    // (scale/rotate stay single-layer — a shared pivot is not modeled).
    const ids = g.mode === "move" && multiIds.size > 1 && multiIds.has(g.clipId) ? [...multiIds] : [g.clipId];
    const dx = g.live.x - base.x;
    const dy = g.live.y - base.y;
    const batch = ids.map((id) => {
      const clip = sequence.clips.find((c) => c.id === id);
      if (!clip) return null;
      if (id === g.clipId) return { type: "UpdateClipProperties", clipId: id, transform: g.live };
      return { type: "UpdateClipProperties", clipId: id, transform: { ...clip.transform, x: clip.transform.x + dx, y: clip.transform.y + dy } };
    }).filter(Boolean);
    if (batch.length > 0) session.apply(batch);
  }, [session, multiIds, sequence]);

  const display = (layer: { cx: number; cy: number; w: number; h: number }) =>
    fit
      ? { left: fit.left + (layer.cx - layer.w / 2) * fit.scale, top: fit.top + (layer.cy - layer.h / 2) * fit.scale, width: layer.w * fit.scale, height: layer.h * fit.scale }
      : { left: 0, top: 0, width: 0, height: 0 };

  // Escape: cancel the active gesture (ghost reverts, nothing committed).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      gestureRef.current = null;
      setGestureLive(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Arrow-key nudging of the selected visual layer(s): 1 px, Shift = 10 px.
  // Lives on the canvas so it follows the transform-tool focus semantics.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (activeTool !== "transform" || !session.selectedClipId) return;
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
      const deltas: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const d = deltas[e.key];
      if (!d) return;
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const ids = multiIds.size > 1 && multiIds.has(session.selectedClipId) ? [...multiIds] : [session.selectedClipId];
      const batch = ids
        .map((id) => sequence.clips.find((c) => c.id === id))
        .filter((c): c is NonNullable<typeof c> => Boolean(c))
        .map((c) => ({ type: "UpdateClipProperties", clipId: c.id, transform: { ...c.transform, x: c.transform.x + d[0] * step, y: c.transform.y + d[1] * step } }));
      if (batch.length > 0) session.apply(batch);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeTool, session, multiIds, sequence]);

  const interactive = activeTool === "transform";
  const shown = gestureLive
    ? layers.map((l) =>
        l.clipId === gestureLive.clipId
          ? {
              ...l,
              cx: l.cx + (gestureLive.live.x - gestureLive.base.x),
              cy: l.cy + (gestureLive.live.y - gestureLive.base.y),
              w: l.w * (gestureLive.live.scale / Math.max(0.001, gestureLive.base.scale || 1)),
              rotation: gestureLive.mode === "rotate" ? gestureLive.live.rotation : l.rotation,
            }
          : l,
      )
    : layers;
  const shownSelected = shown.find((l) => l.clipId === session.selectedClipId) ?? null;

  return (
    <div ref={wrapRef} className="absolute inset-0" onPointerMove={onGestureMove} onPointerUp={commitGesture} onPointerCancel={commitGesture}>
      {/* Guides: thirds + center */}
      {guides && fit && (
        <div className="pointer-events-none absolute" style={{ left: fit.left, top: fit.top, width: fit.w, height: fit.h }}>
          {[1, 2].map((i) => (
            <div key={`v${i}`} className="absolute top-0 h-full w-px bg-white/20" style={{ left: `${(i * 100) / 3}%` }} />
          ))}
          {[1, 2].map((i) => (
            <div key={`h${i}`} className="absolute left-0 w-full border-t border-white/20" style={{ top: `${(i * 100) / 3}%` }} />
          ))}
          <div className="absolute left-1/2 top-0 h-full w-px bg-white/30" />
          <div className="absolute left-0 top-1/2 h-px w-full bg-white/30" />
        </div>
      )}
      {/* Layer boxes */}
      {fit &&
        shown.map((layer) => {
          const rect = display(layer);
          const isSelected = layer.clipId === session.selectedClipId;
          return (
            <div
              key={layer.clipId}
              className={`absolute ${interactive ? "cursor-move" : "pointer-events-none"} ${isSelected ? "" : "opacity-60"}`}
              style={{ ...rect, transform: `rotate(${layer.rotation}deg)` }}
              onPointerDown={interactive ? (e) => startGesture(e, "move", layer) : undefined}
            >
              <div className={`absolute inset-0 border ${isSelected ? "border-[#d4a017]" : "border-white/50 border-dashed"}`} />
              <span className="absolute -top-4 left-0 whitespace-nowrap text-[9px] text-[#d4a017]/90">{layer.label}</span>
              {interactive && isSelected && (
                <>
                  {/* Corner scale handles */}
                  {[["-left-1 -top-1", "nw"], ["-right-1 -top-1", "ne"], ["-left-1 -bottom-1", "sw"], ["-right-1 -bottom-1", "se"]].map(([pos, dir]) => (
                    <span
                      key={dir}
                      role="button"
                      aria-label={`Scale handle ${dir}`}
                      className="absolute z-10 block h-2 w-2 rounded-sm border border-black/60 bg-[#d4a017]"
                      style={{ [pos.startsWith("-left") ? "left" : "right"]: -4, [pos.endsWith("top-1") ? "top" : "bottom"]: -4 } as React.CSSProperties}
                      onPointerDown={(e) => startGesture(e, "scale", layer)}
                    />
                  ))}
                  {/* Rotate handle */}
                  <span
                    role="button"
                    aria-label="Rotate handle"
                    className="absolute -top-7 left-1/2 z-10 block h-2.5 w-2.5 -translate-x-1/2 rounded-full border border-black/60 bg-[#d4a017]"
                    onPointerDown={(e) => startGesture(e, "rotate", layer)}
                  />
                  <span className="absolute -top-7 left-1/2 h-2 w-px -translate-x-1/2 bg-[#d4a017]/60" style={{ top: -8 }} />
                </>
              )}
            </div>
          );
        })}
      {interactive && layers.length === 0 && (
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded bg-black/70 px-2 py-0.5 text-[10px] text-[#8f8f8a]">
          No visual layer at the playhead — the Transform tool edits layers where they are live.
        </div>
      )}
      {interactive && shownSelected && <div className="pointer-events-none absolute right-2 top-2 rounded bg-black/70 px-2 py-0.5 text-[10px] text-[#d4a017]">TRANSFORM · drag to move · corner to scale · top dot to rotate</div>}
      {gestureLive && <div className="pointer-events-none absolute bottom-2 right-2 rounded bg-black/80 px-2 py-0.5 font-mono text-[10px] text-[#d4a017]">x {Math.round(gestureLive.live.x)} · y {Math.round(gestureLive.live.y)} · scale {gestureLive.live.scale.toFixed(2)} · rot {Math.round(gestureLive.live.rotation)}°</div>}
      <span className="hidden">{HANDLE}</span>
    </div>
  );
}
