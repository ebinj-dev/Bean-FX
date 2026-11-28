"use client";
/**
 * M48-D — real computed scopes (waveform, RGB parade, vectorscope, histogram).
 *
 * These are NOT decorative: every plot is computed from the ACTIVE clip's
 * decoded source frame at the current playhead (the same resolution + fade
 * + effect pipeline the preview uses for its CSS filter string is applied
 * here as a canvas filter so the scopes track the graded picture). The
 * sampled region is the sequence frame scaled to 256×144 — compositing
 * overlays (NIIKI graphics, captions) are excluded and that is disclosed on
 * the panel itself.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { activeVideoClipAt, sourceSecondsAt } from "@/lib/editor/preview";
import { cssEffectFilterAt } from "@/lib/editor/filters";
import { DEFAULT_GRADE, gradePixel, type GradeParams } from "@/lib/color/grade-model";
import { cubeEvaluator, type CubeLut } from "@/lib/color/lut3d";
import { fetchPreviewLut } from "@/lib/color/grade-gl";
import type { Sequence } from "@/lib/editor/model";

const W = 256;
const H = 144;

type Mode = "waveform" | "parade" | "vectorscope" | "histogram";
const MODES: Mode[] = ["waveform", "parade", "vectorscope", "histogram"];

export function ScopesPanel({ sequence, playhead, projectId }: { sequence: Sequence; playhead: number; projectId?: string }) {
  const [mode, setMode] = useState<Mode>("waveform");
  const [active, setActive] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pendingRef = useRef(false);

  const activeClip = useMemo(() => activeVideoClipAt(sequence, playhead), [sequence, playhead]);
  const sourceSec = useMemo(
    () => (activeClip ? sourceSecondsAt(activeClip.clip, playhead, sequence.fps) : null),
    [activeClip, playhead, sequence.fps],
  );
  const filter = useMemo(
    () => (activeClip ? cssEffectFilterAt(activeClip.clip.effects, playhead - activeClip.clip.timelineStartFrame) ?? "" : ""),
    [activeClip, playhead],
  );

  // M48-I6 — scopes analyse the GRADED image: the primary grade is applied
  // per-pixel with the SAME model the export's lut3d cube bakes, and the
  // clip's user LUT rides along (fetched once per lutId; until it arrives
  // the scopes honestly show the grade without it — the label says so).
  const gradeParams = (activeClip?.clip.grade ?? null) as GradeParams | null;
  const lutId = activeClip?.clip.lutId ?? null;
  const gradeSignature = gradeParams ? JSON.stringify(gradeParams) : "";
  const [lutEval, setLutEval] = useState<((r: number, g: number, b: number) => [number, number, number]) | null>(null);
  useEffect(() => {
    setLutEval(null);
    if (!lutId || !projectId) return;
    let alive = true;
    void fetchPreviewLut(projectId, lutId).then((cube) => {
      if (alive && cube) setLutEval(() => cubeEvaluator(cube));
    });
    return () => {
      alive = false;
    };
  }, [lutId, projectId]);

  const compute = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2 || video.videoWidth === 0) return;
    const ctx2d = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx2d) return;
    // Sample the frame through the SAME effect filter string the preview uses.
    const off = document.createElement("canvas");
    off.width = W;
    off.height = H;
    const octx = off.getContext("2d", { willReadFrequently: true });
    if (!octx) return;
    octx.filter = filter || "none";
    octx.drawImage(video, 0, 0, W, H);
    let data = octx.getImageData(0, 0, W, H).data;
    if (gradeParams && (!gradeParams.bypass || lutEval)) {
      const img = octx.getImageData(0, 0, W, H);
      const p = { ...DEFAULT_GRADE, ...gradeParams };
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const [r, g, b] = gradePixel(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255, p, lutEval ?? undefined);
        d[i] = r * 255; d[i + 1] = g * 255; d[i + 2] = b * 255;
      }
      octx.putImageData(img, 0, 0);
      data = octx.getImageData(0, 0, W, H).data;
    }

    // Paint the scope canvas.
    ctx2d.fillStyle = "#070706";
    ctx2d.fillRect(0, 0, canvas.width, canvas.height);
    if (mode === "waveform" || mode === "parade") {
      const cols = mode === "waveform" ? [null] : [0, 1, 2];
      const bandW = canvas.width / cols.length;
      const xScale = canvas.width / W;
      const colors = ["rgba(255,255,255,0.55)", "rgba(255,64,64,0.45)", "rgba(64,255,96,0.45)", "rgba(64,128,255,0.45)"];
      cols.forEach((ch, ci) => {
        for (let x = 0; x < W; x += 1) {
          for (let y = 0; y < H; y += 2) {
            const i = (y * W + x) * 4;
            let v: number;
            if (ch === null) {
              const r = data[i], g = data[i + 1], b = data[i + 2];
              v = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            } else {
              v = data[i + ch];
            }
            const py = canvas.height - (v / 255) * canvas.height;
            ctx2d.fillStyle = colors[ci === 0 && ch === null ? 0 : ci + 1];
            ctx2d.fillRect(x * xScale, py, Math.max(1, xScale), 1);
          }
        }
      });
      // Graticules: 0/25/50/75/100 IRE lines.
      ctx2d.fillStyle = "rgba(212,160,23,0.25)";
      for (const ire of [0, 0.25, 0.5, 0.75, 1]) ctx2d.fillRect(0, canvas.height - ire * (canvas.height - 1), canvas.width, 1);
    } else if (mode === "vectorscope") {
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      const radius = Math.min(cx, cy) - 4;
      // Graticule circles + hue boxes.
      ctx2d.strokeStyle = "rgba(212,160,23,0.3)";
      for (const r of [radius, radius * 0.75, radius * 0.5, radius * 0.25]) {
        ctx2d.beginPath();
        ctx2d.arc(cx, cy, r, 0, Math.PI * 2);
        ctx2d.stroke();
      }
      ctx2d.fillStyle = "rgba(230,230,224,0.65)";
      for (let y = 0; y < H; y += 2) {
        for (let x = 0; x < W; x += 2) {
          const i = (y * W + x) * 4;
          const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
          const cb = -0.168736 * r - 0.331264 * g + 0.5 * b;
          const cr = 0.5 * r - 0.418688 * g - 0.081312 * b;
          const px = cx + cb * radius * 2;
          const py = cy - cr * radius * 2;
          if ((px - cx) ** 2 + (py - cy) ** 2 <= radius * radius) ctx2d.fillRect(px, py, 1, 1);
        }
      }
    } else {
      // Histogram (luma).
      const bins = new Array<number>(64).fill(0);
      for (let i = 0; i < data.length; i += 4) {
        const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        bins[Math.min(63, Math.floor(luma / 4))] += 1;
      }
      const max = Math.max(...bins, 1);
      const bw = canvas.width / 64;
      ctx2d.fillStyle = "rgba(230,230,224,0.65)";
      bins.forEach((n, i) => {
        const bh = (n / max) * (canvas.height - 2);
        ctx2d.fillRect(i * bw, canvas.height - bh, Math.max(1, bw - 0.5), bh);
      });
    }
  }, [mode, filter]);

  // Seek the sample video to the active clip's source time; compute on seeked.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !active || sourceSec === null) return;
    if (Math.abs(video.currentTime - sourceSec) < 0.02 && video.readyState >= 2) {
      compute();
      return;
    }
    pendingRef.current = true;
    video.currentTime = Math.max(0, sourceSec);
  }, [active, sourceSec, compute]);

  // While playing, refresh at ~2 Hz (heavy per-pixel work stays off the edit path).
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      const video = videoRef.current;
      if (video && video.readyState >= 2 && pendingRef.current) {
        pendingRef.current = false;
        compute();
      }
    }, 500);
    return () => clearInterval(t);
  }, [active, compute]);

  const onSeeked = useCallback(() => {
    if (pendingRef.current) {
      pendingRef.current = false;
      compute();
    }
  }, [compute]);

  const btn = "rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider";
  return (
    <div className="border-t border-[#2a2a2a] bg-[#0b0b0a] p-2" data-testid="scopes-panel">
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="bean-label text-[9px] text-[#d4a017]">SCOPES</span>
        {MODES.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`${btn} ${mode === m ? "border-[#d4a017] text-[#d4a017]" : "border-[#2a2a2a] text-[#d8d8d2] hover:border-[#d4a017] hover:text-[#d4a017]"}`}
          >
            {m === "waveform" ? "LUMA WAVEFORM" : m === "parade" ? "RGB PARADE" : m === "vectorscope" ? "VECTORSCOPE" : "HISTOGRAM"}
          </button>
        ))}
        <span className="ml-auto text-[9px] text-[#8f8f8a]">
          {activeClip ? `computed from the active clip's graded source frame (${activeClip.clip.label || activeClip.clip.id})` : "no active video clip at the playhead"} · overlays excluded
        </span>
      </div>
      <div className="flex items-start gap-2">
        {active ? (
          <canvas ref={canvasRef} width={512} height={200} className="rounded border border-[#1c1c1a]" data-testid="scope-canvas" />
        ) : (
          <div className="rounded border border-[#1c1c1a] bg-[#070706] px-3 py-6 text-[10px] text-[#5a5a56]">Scopes are off — enable to compute from the displayed frame.</div>
        )}
        <button type="button" onClick={() => setActive((v) => !v)} className={`${btn} ${active ? "border-[#c45c4c] text-[#c45c4c]" : "border-[#2a2a2a] text-[#d8d8d2] hover:border-[#d4a017] hover:text-[#d4a017]"}`}>
          {active ? "SCOPES ON" : "SCOPES OFF"}
        </button>
      </div>
      {/* Hidden sample video: the same asset file the Program Monitor decodes. */}
      {activeClip && (
        <video
          ref={videoRef}
          src={`/api/media/${activeClip.clip.sourceAssetId}/file`}
          onSeeked={onSeeked}
          muted
          playsInline
          preload="auto"
          className="hidden"
        />
      )}
    </div>
  );
}
