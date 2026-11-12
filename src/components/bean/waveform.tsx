"use client";

import { useCallback, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { formatTimeLabel, minorSubdivision, niceStep } from "@/lib/timeline-ruler";

export interface WaveCuts {
  id: string;
  start: number;
  end: number;
  status: "REMOVE" | "REVIEW" | "KEEP" | "APPROVED_REMOVE";
}

interface WaveformProps {
  peaks: { min: Float32Array; max: Float32Array } | null;
  duration: number;
  viewStart: number;
  viewEnd: number;
  onSeek: (t: number) => void;
  onZoomWindowChange?: (start: number, end: number) => void;
  cuts?: WaveCuts[];
  playhead?: number;
  height?: number;
  className?: string;
  allowDragSelect?: boolean;
  onDragSelect?: (start: number, end: number) => void;
  /** Live playhead source (playback/scrub). When it returns a number the
   *  overlay follows it every animation frame WITHOUT React re-renders. */
  playheadLive?: () => number | null;
  /** True while media is playing — enables the RAF overlay + auto-follow. */
  playing?: boolean;
  /** Continuous scrub updates (drag moves the playhead, not a selection). */
  onScrub?: (t: number) => void;
  onScrubStart?: () => void;
  onScrubEnd?: (t: number) => void;
  /** Wheel zoom request: (factor, sourceTimeUnderPointer). */
  onWheelZoom?: (factor: number, centerTime: number) => void;
  /** Auto-follow probe, called every frame while playing. */
  onFollowProbe?: (t: number) => void;
  /** Waveform peaks are being generated from the real audio right now. */
  peaksLoading?: boolean;
  /** Waveform generation failed — the honest reason is rendered. */
  peaksError?: string | null;
}

const CUT_COLORS: Record<WaveCuts["status"], { fill: string; stroke: string }> = {
  REMOVE: { fill: "rgba(239,68,68,0.30)", stroke: "rgba(239,68,68,0.75)" },
  APPROVED_REMOVE: { fill: "rgba(239,68,68,0.45)", stroke: "rgba(239,68,68,0.9)" },
  REVIEW: { fill: "rgba(249,115,22,0.28)", stroke: "rgba(249,115,22,0.7)" },
  KEEP: { fill: "rgba(34,197,94,0.16)", stroke: "rgba(34,197,94,0.45)" },
};

export function Waveform({
  peaks,
  duration,
  viewStart,
  viewEnd,
  onSeek,
  cuts = [],
  playhead,
  height = 128,
  className,
  allowDragSelect,
  onDragSelect,
  playheadLive,
  playing,
  onScrub,
  onScrubStart,
  onScrubEnd,
  onWheelZoom,
  onFollowProbe,
  peaksLoading,
  peaksError,
}: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const staticCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const staticKeyRef = useRef<string>("");
  const containerRef = useRef<HTMLDivElement>(null);
  const scrubbingRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const lastFollowRef = useRef(0);
  // Mirror of the `playhead` prop. drawOverlay reads this ref instead of the
  // prop so the overlay callback identity (and therefore the RAF loop and
  // every effect depending on it) stays stable while playback throttles the
  // prop at ~10 Hz for the text readouts. Declared BEFORE the draw effect so
  // the mirrored value is committed by the time that effect paints.
  const playheadPropRef = useRef(playhead);
  useEffect(() => {
    playheadPropRef.current = playhead;
  }, [playhead]);

  const viewDur = Math.max(0.01, viewEnd - viewStart);

  const xToTime = useCallback(
    (clientX: number) => {
      const el = containerRef.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return viewStart + frac * viewDur;
    },
    [viewStart, viewDur]
  );

  /* ---------------- static layer: grid + waveform + cuts ---------------- */
  const drawStatic = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const dpr = window.devicePixelRatio || 1;
    const w = container.clientWidth;
    const h = height;
    const key = `${w}x${h}x${dpr}|${viewStart}|${viewEnd}|${cuts.length}|${peaks ? peaks.max.length : 0}|${duration}|${peaksLoading ? 1 : 0}|${peaksError ?? ""}|${cuts.map((c) => c.id + c.status).join(",")}`;
    if (staticCanvasRef.current && staticKeyRef.current === key) return;

    const off = staticCanvasRef.current ?? document.createElement("canvas");
    off.width = Math.floor(w * dpr);
    off.height = Math.floor(h * dpr);
    const ctx = off.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);

    // Background
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, w, h);

    // Time ruler — major gridlines + labels from the ACTUAL view window
    // (niceStep of viewDur/8 — never hardcoded), plus minor subdivisions
    // rendered only when they stay readable at the current zoom level.
    const gridStep = niceStep(viewDur / 8);
    const minorStep = minorSubdivision(gridStep);
    const pxPerSec = w / viewDur;
    const mid = (h - 14) / 2;
    ctx.textAlign = "left";
    if (minorStep * pxPerSec >= 7) {
      ctx.strokeStyle = "#141414";
      ctx.lineWidth = 1;
      for (let t = Math.ceil(viewStart / minorStep) * minorStep; t < viewEnd; t += minorStep) {
        const x = ((t - viewStart) / viewDur) * w;
        ctx.beginPath();
        ctx.moveTo(x, h - 14);
        ctx.lineTo(x, h - 9);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, 4);
        ctx.stroke();
      }
    }
    ctx.strokeStyle = "#1a1a1a";
    ctx.fillStyle = "#5c5c58";
    ctx.font = "10px var(--font-geist-sans), sans-serif";
    ctx.lineWidth = 1;
    for (let t = Math.ceil(viewStart / gridStep) * gridStep; t < viewEnd; t += gridStep) {
      const x = ((t - viewStart) / viewDur) * w;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h - 14);
      ctx.stroke();
      // Professional rulers never clip the last label at the edge: when the
      // text would overflow, it flips to the right of alignment, anchored to
      // the same tick.
      const label = formatTimeLabel(t, gridStep);
      if (x + 3 + ctx.measureText(label).width > w - 2) {
        ctx.textAlign = "right";
        ctx.fillText(label, Math.max(x - 3, ctx.measureText(label).width + 2), h - 3);
        ctx.textAlign = "left";
      } else {
        ctx.fillText(label, x + 3, h - 3);
      }
    }

    // Waveform
    if (peaks && peaks.max.length > 0) {
      const n = peaks.max.length;
      const buckets = Math.max(1, Math.floor(w / 2));
      ctx.fillStyle = "#57534e";
      for (let b = 0; b < buckets; b++) {
        const t0 = viewStart + (b / buckets) * viewDur;
        const t1 = viewStart + ((b + 1) / buckets) * viewDur;
        const i0 = Math.floor((t0 / Math.max(duration, 0.001)) * n);
        const i1 = Math.max(i0 + 1, Math.floor((t1 / Math.max(duration, 0.001)) * n));
        let mn = 1;
        let mx = -1;
        for (let i = i0; i < Math.min(i1, n); i++) {
          if (peaks.min[i] < mn) mn = peaks.min[i];
          if (peaks.max[i] > mx) mx = peaks.max[i];
        }
        if (mn === 1) {
          mn = 0;
          mx = 0;
        }
        const x = (b / buckets) * w;
        const yTop = mid - mx * mid * 0.92;
        const yBot = mid - mn * mid * 0.92;
        ctx.fillRect(x, yTop, 1.4, Math.max(1, yBot - yTop));
      }
    } else {
      // Honest states — never a fake waveform, never a silent blank.
      ctx.font = "12px var(--font-geist-sans), sans-serif";
      ctx.textAlign = "center";
      if (peaksLoading) {
        ctx.fillStyle = "#d4a017";
        ctx.fillText("Generating waveform from the real audio…", w / 2, mid);
      } else if (peaksError) {
        ctx.fillStyle = "#f87171";
        ctx.fillText(peaksError.slice(0, 90), w / 2, mid);
      } else {
        ctx.fillStyle = "#333";
        ctx.fillText("No waveform loaded", w / 2, mid);
      }
      ctx.textAlign = "left";
    }

    // Cut overlays — REMOVE-ONLY timeline. The original recording is preserved
    // by default: only proposed removal ranges are marked (red). KEEP and
    // REVIEW content is never overlaid here; REVIEW candidates live in the
    // candidate review panel, and no mark means the audio stays untouched.
    for (const cut of cuts) {
      if (cut.status !== "REMOVE" && cut.status !== "APPROVED_REMOVE") continue;
      const cs = Math.max(cut.start, viewStart);
      const ce = Math.min(cut.end, viewEnd);
      if (ce <= cs) continue;
      const x0 = ((cs - viewStart) / viewDur) * w;
      const x1 = ((ce - viewStart) / viewDur) * w;
      const color = CUT_COLORS[cut.status] ?? CUT_COLORS.REMOVE;
      ctx.fillStyle = color.fill;
      ctx.fillRect(x0, 0, x1 - x0, h - 14);
      ctx.strokeStyle = color.stroke;
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 + 0.5, 0.5, x1 - x0 - 1, h - 15);
    }

    staticCanvasRef.current = off;
    staticKeyRef.current = key;
  }, [peaks, duration, viewStart, viewDur, viewEnd, cuts, height, peaksLoading, peaksError]);

  /* --------- overlay layer: blit static + playhead, RAF-driven ---------- */
  const drawOverlay = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    const off = staticCanvasRef.current;
    if (!canvas || !container) return;
    const dpr = window.devicePixelRatio || 1;
    const w = container.clientWidth;
    const h = height;
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (off) ctx.drawImage(off, 0, 0);
    ctx.scale(dpr, dpr);

    const t = playheadLive ? playheadLive() : playheadPropRef.current;
    if (t !== undefined && t !== null && t >= viewStart && t <= viewEnd) {
      const x = ((t - viewStart) / viewDur) * w;
      ctx.strokeStyle = "#d4a017";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h - 14);
      ctx.stroke();
      ctx.fillStyle = "#d4a017";
      ctx.beginPath();
      ctx.moveTo(x - 4, 0);
      ctx.lineTo(x + 4, 0);
      ctx.lineTo(x, 6);
      ctx.closePath();
      ctx.fill();
    }
  }, [playheadLive, viewStart, viewDur, viewEnd, height]);

  const draw = useCallback(() => {
    drawStatic();
    drawOverlay();
  }, [drawStatic, drawOverlay]);

  useEffect(() => {
    draw();
  }, [draw]);

  // Animation loop ONLY while playing (or the live playhead is active):
  // playhead moves, ruler/waveform stay aligned via the cached static layer,
  // and the parent is probed for auto-follow (throttled to ~5 probes/sec).
  // drawOverlay and onFollowProbe are stable across playhead updates, so
  // this loop is NOT torn down and re-created on every throttled state paint.
  useEffect(() => {
    if (!playing && !playheadLive) return;
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      const t: number | null | undefined = playheadLive ? playheadLive() : playheadPropRef.current;
      drawOverlay();
      if (onFollowProbe && typeof t === "number" && t !== null) {
        const now = performance.now();
        if (now - lastFollowRef.current > 200) {
          lastFollowRef.current = now;
          onFollowProbe(t);
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, playheadLive, drawOverlay, onFollowProbe]);

  useEffect(() => {
    const onResize = () => {
      staticKeyRef.current = "";
      draw();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [draw]);

  /* --------------------------- interaction ------------------------------ */
  // Pointer capture on the CONTAINER (not e.target) so dragging continues
  // even when the pointer leaves the playhead handle or the canvas —
  // backwards and forwards scrubbing behave identically.
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (allowDragSelect && onDragSelect) {
      // Legacy region-selection mode (used by other tools).
      const rect = containerRef.current!.getBoundingClientRect();
      containerRef.current!.setPointerCapture(e.pointerId);
      (e.target as HTMLElement).dataset.dragX0 = String(e.clientX - rect.left);
      (e.target as HTMLElement).dataset.dragX1 = String(e.clientX - rect.left);
      (e.target as HTMLElement).dataset.dragging = "1";
      return;
    }
    // Playhead scrub mode: press anywhere, drag continuously.
    containerRef.current!.setPointerCapture(e.pointerId);
    scrubbingRef.current = true;
    onScrubStart?.();
    const t = xToTime(e.clientX);
    onSeek(t);
    onScrub?.(t);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.dataset.dragging === "1") {
      const rect = containerRef.current!.getBoundingClientRect();
      target.dataset.dragX1 = String(e.clientX - rect.left);
      return;
    }
    if (scrubbingRef.current) {
      const t = xToTime(e.clientX);
      onSeek(t);
      onScrub?.(t);
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.dataset.dragging === "1") {
      const rect = containerRef.current!.getBoundingClientRect();
      const x0 = Number(target.dataset.dragX0 ?? 0);
      const x1 = Number(target.dataset.dragX1 ?? 0);
      delete target.dataset.dragging;
      const t0 = viewStart + (Math.min(x0, x1) / rect.width) * viewDur;
      const t1 = viewStart + (Math.max(x0, x1) / rect.width) * viewDur;
      if (Math.abs(t1 - t0) > 0.05) {
        onDragSelect?.(t0, t1);
      } else {
        onSeek(xToTime(e.clientX));
      }
      return;
    }
    if (scrubbingRef.current) {
      scrubbingRef.current = false;
      try {
        containerRef.current?.releasePointerCapture(e.pointerId);
      } catch {
        /* pointer already released */
      }
      onScrubEnd?.(xToTime(e.clientX));
    }
  };

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!onWheelZoom) return;
    // Zoom around the pointer position; the timestamp under the pointer is
    // preserved exactly (auto-cut anchors the zoom math on this time).
    e.preventDefault();
    const factor = e.deltaY < 0 ? 0.8 : 1.25;
    onWheelZoom(factor, xToTime(e.clientX));
  };

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative w-full cursor-crosshair touch-none overflow-hidden rounded-lg border border-[#1c1c1c]",
        className
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
    >
      <canvas ref={canvasRef} className="block" />
    </div>
  );
}

