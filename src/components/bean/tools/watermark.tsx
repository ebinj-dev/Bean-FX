"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Eraser, Info, Loader2 } from "lucide-react";
import { ToolShell } from "@/components/bean/tool-shell";
import { readMediaRef } from "@/components/bean/upload-gate";
import { JobProgressBar } from "@/components/bean/job-progress";
import type { SessionUser, MediaMeta } from "@/lib/types";
import { formatDuration } from "@/lib/format-utils";
import { cn } from "@/lib/utils";

type Method = "blur" | "delogo" | "crop";

const METHOD_INFO: Record<Method, { label: string; note: string }> = {
  blur: {
    label: "BLUR",
    note: "Applies a strong box blur inside the region. The watermark becomes unreadable but the area stays visibly smoothed — nothing is reconstructed.",
  },
  delogo: {
    label: "DELOGO",
    note: "Interpolates the region from surrounding pixels (ffmpeg delogo). Works well for small static logos on fairly uniform backgrounds; larger regions produce smearing.",
  },
  crop: {
    label: "CROP",
    note: "Removes the band containing the watermark. Only valid when the region touches a frame edge. Output resolution changes.",
  },
};

interface Region {
  x: number; // normalized 0..1
  y: number;
  w: number;
  h: number;
}

export function WatermarkTool({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  const [media, setMedia] = useState<MediaMeta | null>(() => readMediaRef("watermark"));
  const [mediaKey, setMediaKey] = useState(0);
  const [method, setMethod] = useState<Method>("delogo");
  const [region, setRegion] = useState<Region | null>(null);
  const [drawing, setDrawing] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ exportId: string } | null>(null);
  const [frameTime, setFrameTime] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const resetToolState = () => {
    setRegion(null);
    setJobId(null);
    setDone(null);
    setError(null);
    setFrameTime(0);
  };

  const startJob = useCallback(async () => {
    if (!media || !region) return;
    setError(null);
    setDone(null);
    try {
      const res = await fetch("/api/process/watermark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediaId: media.id, method, region }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? `Processing failed (${res.status}).`);
        return;
      }
      setJobId(data.jobId);
    } catch {
      setError("Network error while starting processing.");
    }
  }, [media, method, region]);

  const px = (r: Region) =>
    media?.width && media?.height
      ? {
          x: Math.round(r.x * media.width),
          y: Math.round(r.y * media.height),
          w: Math.round(r.w * media.width),
          h: Math.round(r.h * media.height),
        }
      : null;

  const regionPx = region ? px(region) : null;

  const grabFrame = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    void v.pause();
    setFrameTime(v.currentTime);
  }, []);

  return (
    <ToolShell
      user={user}
      onLogout={onLogout}
      route="/watermark"
      label="WATERMARK"
      title="Watermark removal with honest methods"
      description="Select the watermark region directly on the frame, then apply blur, delogo interpolation, or edge crop. Each method states exactly what it does — none can reconstruct occluded pixels."
    >
      <div className="grid gap-5 lg:grid-cols-[340px_1fr]">
        <div className="flex flex-col gap-4">
          <section className="rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
            <h2 className="bean-label text-[10px] text-[#8f8f8a]">1 · SELECTED VIDEO</h2>
            <div className="mt-3">
{media ? (
                <p className="text-[12px] leading-relaxed text-[#9a9a94]">
                  <span className="font-semibold text-white">{media.originalName}</span>
                  {media.durationSec ? ` — ${media.durationSec.toFixed(1)}s` : ""}{media.audioCodec ? `, ${media.audioCodec}` : ""}.
                </p>
              ) : (
                <p className="text-[12px] text-[#7a7a76]">No media selected.</p>
              )}
              <a data-change-media className="hidden" aria-hidden />

              <a href="#/watermark" className="mt-2 inline-flex h-8 items-center rounded-md border border-[#2a2a2a] px-3 text-[10px] font-extrabold uppercase tracking-wider text-[#9a9a94] hover:border-[#d4a017]/50 hover:text-white">
                Change media
              </a>
            </div>
            {media && (
              <p className="mt-3 text-[11px] leading-relaxed text-[#8f8f8a]">
                {media.width}×{media.height}
                {media.fps ? ` @ ${media.fps} fps` : ""} · {formatDuration(media.durationSec)}. Only edit media you own
                or are authorized to modify — DRM-protected content is not supported.
              </p>
            )}
          </section>

          <section className="rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
            <h2 className="bean-label text-[10px] text-[#8f8f8a]">2 · METHOD</h2>
            <div className="mt-3 grid grid-cols-3 gap-1.5">
              {(Object.keys(METHOD_INFO) as Method[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMethod(m)}
                  className={cn(
                    "rounded-md border px-2 py-2 text-[10px] font-extrabold uppercase tracking-wider transition-colors",
                    method === m
                      ? "border-[#d4a017] bg-[#191307] text-[#d4a017]"
                      : "border-[#242424] bg-[#111] text-[#8f8f8a] hover:border-[#333]"
                  )}
                >
                  {METHOD_INFO[m].label}
                </button>
              ))}
            </div>
            <p className="mt-2.5 flex items-start gap-2 rounded-md border border-[#241f10] bg-[#120e05] px-3 py-2 text-[11px] leading-relaxed text-[#d4a017]">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {METHOD_INFO[method].note}
            </p>
          </section>

          <section className="rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
            <h2 className="bean-label text-[10px] text-[#8f8f8a]">3 · REGION</h2>
            {regionPx ? (
              <div className="mt-3 space-y-2">
                {(
                  [
                    ["X", "x", 0],
                    ["Y", "y", 0],
                    ["W", "w", 4],
                    ["H", "h", 4],
                  ] as [string, keyof Region, number][]
                ).map(([label, key, min]) => (
                  <label key={key} className="flex items-center justify-between gap-3 text-[11px] text-[#8f8f8a]">
                    <span className="bean-label text-[10px]">{label} (PX)</span>
                    <input
                      type="number"
                      min={min}
                      max={key === "x" || key === "w" ? (media?.width ?? 9999) : (media?.height ?? 9999)}
                      value={regionPx[key]}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (!Number.isFinite(v) || !media?.width || !media?.height) return;
                        setRegion((r) => {
                          if (!r) return r;
                          if (!media.width || !media.height) return r;
                          const next = { ...r };
                          if (key === "x") next.x = Math.max(0, Math.min(1, v / media.width));
                          else if (key === "y") next.y = Math.max(0, Math.min(1, v / media.height));
                          else if (key === "w") next.w = Math.max(0.002, Math.min(1 - next.x, v / media.width));
                          else next.h = Math.max(0.002, Math.min(1 - next.y, v / media.height));
                          return next;
                        });
                      }}
                      className="h-8 w-24 rounded border border-[#2a2a2a] bg-[#121212] px-2 font-mono text-xs text-white focus:border-[#d4a017] focus:outline-none"
                    />
                  </label>
                ))}
                <button
                  type="button"
                  onClick={() => setRegion(null)}
                  className="mt-1 w-full rounded-md border border-[#2a2a2a] py-2 text-[10px] font-bold uppercase tracking-wider text-[#9a9a94] hover:border-[#ef4444] hover:text-[#f87171]"
                >
                  CLEAR SELECTION
                </button>
              </div>
            ) : (
              <p className="mt-3 rounded-lg border border-dashed border-[#242424] px-4 py-6 text-center text-[11px] leading-relaxed text-[#5c5c58]">
                Pause the video at a representative frame, then drag a rectangle over the watermark.
              </p>
            )}
          </section>

          <section className="rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
            <h2 className="bean-label text-[10px] text-[#8f8f8a]">4 · PROCESS</h2>
            <button
              type="button"
              disabled={!media || !region || Boolean(jobId)}
              onClick={startJob}
              className="bean-glow mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-[#d4a017] text-[11px] font-extrabold uppercase tracking-[0.14em] text-[#0c0c0c] hover:bg-[#e9b52a] disabled:opacity-40"
            >
              <Eraser className="h-4 w-4" /> REMOVE WATERMARK
            </button>
            {error && (
              <p className="mt-3 rounded-md border border-[#3b1515] bg-[#1a0d0d] px-3 py-2 text-xs leading-relaxed text-[#f87171]">{error}</p>
            )}
            {jobId && (
              <JobProgressBar
                jobId={jobId}
                label="PROCESSING"
                onComplete={(exportId) => setDone({ exportId })}
                onFail={(err) => {
                  setError(err);
                  setJobId(null);
                }}
              />
            )}
            {done && (
              <a
                href={`/api/exports/${done.exportId}/file`}
                className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-[#1f2a1a] bg-[#0c120a] text-[11px] font-extrabold uppercase tracking-[0.14em] text-[#22c55e] hover:bg-[#0f1a0e]"
              >
                <Download className="h-4 w-4" /> DOWNLOAD RESULT
              </a>
            )}
          </section>
        </div>

        {/* Preview + before/after */}
        <div className="flex flex-col gap-4">
          <section className="rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="bean-label text-[10px] text-[#8f8f8a]">FRAME PREVIEW — DRAG TO SELECT REGION</h2>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={grabFrame}
                  disabled={!media}
                  className="inline-flex h-7 items-center rounded border border-[#242424] bg-[#111] px-2.5 text-[10px] font-bold text-[#9a9a94] hover:text-white disabled:opacity-40"
                >
                  PAUSE & HOLD FRAME
                </button>
                <span className="font-mono text-[10px] text-[#5c5c58]">t={frameTime.toFixed(2)}s</span>
              </div>
            </div>
            {media ? (
              <div
                ref={overlayRef}
                className="relative select-none overflow-hidden rounded-lg border border-[#1c1c1c] bg-black"
                onPointerDown={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const nx = (e.clientX - rect.left) / rect.width;
                  const ny = (e.clientY - rect.top) / rect.height;
                  setDrawing({ x0: nx, y0: ny, x1: nx, y1: ny });
                  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                }}
                onPointerMove={(e) => {
                  if (!drawing) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  setDrawing((d) =>
                    d ? { ...d, x1: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)), y1: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)) } : d
                  );
                }}
                onPointerUp={() => {
                  if (drawing) {
                    const r: Region = {
                      x: Math.min(drawing.x0, drawing.x1),
                      y: Math.min(drawing.y0, drawing.y1),
                      w: Math.abs(drawing.x1 - drawing.x0),
                      h: Math.abs(drawing.y1 - drawing.y0),
                    };
                    if (r.w > 0.01 && r.h > 0.01) setRegion(r);
                  }
                  setDrawing(null);
                }}
              >
                <video
                  ref={videoRef}
                  src={`/api/media/${media.id}/file`}
                  controls
                  className="max-h-[420px] w-full bg-black"
                  onSeeked={(e) => setFrameTime((e.target as HTMLVideoElement).currentTime)}
                />
                {/* Region overlay rectangle */}
                {(() => {
                  const r = drawing
                    ? {
                        x: Math.min(drawing.x0, drawing.x1),
                        y: Math.min(drawing.y0, drawing.y1),
                        w: Math.abs(drawing.x1 - drawing.x0),
                        h: Math.abs(drawing.y1 - drawing.y0),
                      }
                    : region;
                  if (!r) return null;
                  return (
                    <div
                      className="pointer-events-none absolute border-2 border-[#d4a017] bg-[#d4a017]/15"
                      style={{
                        left: `${r.x * 100}%`,
                        top: `${r.y * 100}%`,
                        width: `${r.w * 100}%`,
                        height: `${r.h * 100}%`,
                      }}
                    >
                      <span className="absolute -top-5 left-0 rounded bg-[#d4a017] px-1.5 py-0.5 text-[9px] font-extrabold text-[#0c0c0c]">
                        REGION {regionPx && !drawing ? `${regionPx.w}×${regionPx.h}px` : ""}
                      </span>
                    </div>
                  );
                })()}
              </div>
            ) : (
              <div className="flex h-[300px] items-center justify-center rounded-lg border border-dashed border-[#242424] text-xs text-[#5c5c58]">
                Import a video to preview frames and select the watermark region
              </div>
            )}
          </section>

          {/* Before/after comparison once processed */}
          {done && media && (
            <section className="rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
              <h2 className="bean-label mb-3 text-[10px] text-[#8f8f8a]">BEFORE / AFTER</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-[#8f8f8a]">BEFORE (ORIGINAL)</p>
                  <video src={`/api/media/${media.id}/file`} controls className="w-full rounded-lg border border-[#1c1c1c] bg-black" />
                </div>
                <div>
                  <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-[#d4a017]">AFTER (EXPORT)</p>
                  <video src={`/api/exports/${done.exportId}/file`} controls className="w-full rounded-lg border border-[#241f10] bg-black" />
                </div>
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-[#7a7a76]">
                Compare honestly: blur obscures, delogo interpolates, crop reframes. If the watermark is still readable,
                try a tighter region or a different method.
              </p>
            </section>
          )}
        </div>
      </div>
    </ToolShell>
  );
}
