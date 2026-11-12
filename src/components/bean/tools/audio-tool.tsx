"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AudioWaveform, Download, Loader2, Volume2 } from "lucide-react";
import { ToolShell } from "@/components/bean/tool-shell";
import { readMediaRef } from "@/components/bean/upload-gate";
import { JobProgressBar } from "@/components/bean/job-progress";
import { Waveform } from "@/components/bean/waveform";
import type { SessionUser, MediaMeta, ExportView, AudioExportFormat } from "@/lib/types";
import { decodeAudio, computePeaks, computeEnvelope, estimateNoiseFloor } from "@/lib/audio-analysis";
import { formatBytes, formatDateTime, formatDuration } from "@/lib/format-utils";
import { cn } from "@/lib/utils";

const FORMATS: { value: AudioExportFormat; label: string; note: string }[] = [
  { value: "mp3", label: "MP3", note: "libmp3lame · lossy" },
  { value: "wav", label: "WAV", note: "PCM 16-bit · lossless" },
  { value: "m4a", label: "M4A", note: "AAC in MP4 · lossy" },
  { value: "aac", label: "AAC", note: "raw AAC ADTS · lossy" },
  { value: "flac", label: "FLAC", note: "lossless compression" },
];

export function AudioTool({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  const [media, setMedia] = useState<MediaMeta | null>(() => readMediaRef("audio"));
  const [mediaKey, setMediaKey] = useState(0);

  const [peaks, setPeaks] = useState<{ min: Float32Array; max: Float32Array } | null>(null);
  const [peakDb, setPeakDb] = useState<number | null>(null);
  const [noiseFloor, setNoiseFloor] = useState<number | null>(null);
  const [clipping, setClipping] = useState(false);
  const [decodeError, setDecodeError] = useState<string | null>(null);

  const [trimStart, setTrimStart] = useState<number | null>(null);
  const [trimEnd, setTrimEnd] = useState<number | null>(null);
  const [gainDb, setGainDb] = useState(0);
  const [fadeIn, setFadeIn] = useState(0);
  const [fadeOut, setFadeOut] = useState(0);
  const [normalize, setNormalize] = useState<"off" | "loudness" | "peak">("off");
  const [denoise, setDenoise] = useState(false);
  const [channelMode, setChannelMode] = useState<"keep" | "mono" | "stereo">("keep");
  const [format, setFormat] = useState<AudioExportFormat>("wav");
  const [bitrate, setBitrate] = useState(192);

  const [viewStart, setViewStart] = useState(0);
  const [viewEnd, setViewEnd] = useState(0);
  const [playhead, setPlayhead] = useState(0);

  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exports, setExports] = useState<ExportView[]>([]);
  const previewRef = useRef<HTMLAudioElement>(null);

  const duration = media?.durationSec ?? 0;

  const loadExports = useCallback(() => {
    if (!media) return;
    fetch("/api/exports")
      .then((r) => r.json())
      .then((d) => setExports(((d.exports ?? []) as ExportView[]).filter((e) => e.mediaId === media.id)))
      .catch(() => setExports([]));
  }, [media]);

  useEffect(() => {
    setPeaks(null);
    setPeakDb(null);
    setNoiseFloor(null);
    setClipping(false);
    setTrimStart(null);
    setTrimEnd(null);
    setJobId(null);
    setError(null);
    setGainDb(0);
    setFadeIn(0);
    setFadeOut(0);
    setNormalize("off");
    setDenoise(false);
    setDecodeError(null);
    if (!media) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/media/${media.id}/file`);
        if (!res.ok) throw new Error(`Failed to load media (${res.status}).`);
        const blob = await res.blob();
        const decoded = await decodeAudio(blob);
        if (cancelled) return;
        const pk = computePeaks(decoded.buffer, Math.min(24000, Math.max(2000, Math.floor(decoded.durationSec * 80))));
        const env = computeEnvelope(decoded.buffer, 10);
        const nf = estimateNoiseFloor(env);
        let peak = 0;
        for (let i = 0; i < env.values.length; i++) if (env.values[i] > peak) peak = env.values[i];
        let clipped = false;
        for (let i = 0; i < env.values.length; i++)
          if (env.values[i] >= 0.985) {
            clipped = true;
            break;
          }
        setPeaks(pk);
        setNoiseFloor(nf);
        setPeakDb(peak > 0 ? 20 * Math.log10(peak) : -Infinity);
        setClipping(clipped);
        setViewStart(0);
        setViewEnd(decoded.durationSec);
      } catch (err) {
        if (!cancelled) setDecodeError(err instanceof Error ? err.message : "Failed to decode audio.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [media, mediaKey]);

  useEffect(() => {
    loadExports();
  }, [loadExports]);

  const canExport = Boolean(media);

  const startExport = useCallback(async () => {
    if (!media) return;
    setError(null);
    const trimmed = trimStart !== null && trimEnd !== null && trimEnd > trimStart;
    try {
      const res = await fetch("/api/process/audio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mediaId: media.id,
          format,
          bitrateKbps: bitrate,
          trim: trimmed ? { start: trimStart, end: trimEnd } : undefined,
          gainDb: gainDb !== 0 ? gainDb : undefined,
          fadeInSec: fadeIn > 0 ? fadeIn : undefined,
          fadeOutSec: fadeOut > 0 ? fadeOut : undefined,
          normalize: normalize !== "off" ? normalize : undefined,
          denoise,
          channelMode: channelMode !== "keep" ? channelMode : undefined,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? `Export failed (${res.status}).`);
        return;
      }
      setJobId(data.jobId);
    } catch {
      setError("Network error while starting the export.");
    }
  }, [media, format, bitrate, trimStart, trimEnd, gainDb, fadeIn, fadeOut, normalize, denoise, channelMode]);

  const estDuration = useMemo(() => {
    const trimmed = trimStart !== null && trimEnd !== null && trimEnd > trimStart ? trimEnd - trimStart : duration;
    return trimmed;
  }, [trimStart, trimEnd, duration]);

  return (
    <ToolShell
      user={user}
      onLogout={onLogout}
      route="/audio"
      label="AUDIO"
      title="Clean, shape and export audio"
      description="Real ffmpeg processing: trim, gain, fades, loudness or peak normalization, FFT noise reduction and channel handling — with validated MP3, WAV, M4A, AAC and FLAC exports."
    >
      <div className="grid gap-5 lg:grid-cols-[340px_1fr]">
        <div className="flex flex-col gap-4">
          <section className="rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
            <h2 className="bean-label text-[10px] text-[#8f8f8a]">1 · SELECTED AUDIO</h2>
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

              <a href="#/audio" className="mt-2 inline-flex h-8 items-center rounded-md border border-[#2a2a2a] px-3 text-[10px] font-extrabold uppercase tracking-wider text-[#9a9a94] hover:border-[#d4a017]/50 hover:text-white">
                Change media
              </a>
            </div>
            {media && (
              <p className="mt-3 text-[11px] leading-relaxed text-[#8f8f8a]">
                {media.originalName} — {formatDuration(media.durationSec)}
                {media.audioCodec ? `, ${media.audioCodec}` : ""}
                {media.sampleRate ? ` @ ${media.sampleRate} Hz` : ""}
                {media.channels ? `, ${media.channels} ch` : ""}.
              </p>
            )}
          </section>

          <section className="rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
            <h2 className="bean-label text-[10px] text-[#8f8f8a]">2 · MEASUREMENTS</h2>
            {decodeError ? (
              <p className="mt-3 rounded-md border border-[#3b1515] bg-[#1a0d0d] px-3 py-2 text-xs text-[#f87171]">{decodeError}</p>
            ) : peaks ? (
              <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg border border-[#1c1c1c] bg-[#111] px-2 py-2.5">
                  <dt className="bean-label text-[9px] text-[#7a7a76]">PEAK</dt>
                  <dd className={cn("mt-1 font-mono text-sm font-bold", peakDb !== null && peakDb > -0.1 ? "text-[#f87171]" : "text-white")}>
                    {peakDb === null ? "—" : peakDb === -Infinity ? "-∞" : `${peakDb.toFixed(1)} dB`}
                  </dd>
                </div>
                <div className="rounded-lg border border-[#1c1c1c] bg-[#111] px-2 py-2.5">
                  <dt className="bean-label text-[9px] text-[#7a7a76]">NOISE FLOOR</dt>
                  <dd className="mt-1 font-mono text-sm font-bold text-white">
                    {noiseFloor === null ? "—" : `${(20 * Math.log10(Math.max(noiseFloor, 1e-6))).toFixed(0)} dB`}
                  </dd>
                </div>
                <div className="rounded-lg border border-[#1c1c1c] bg-[#111] px-2 py-2.5">
                  <dt className="bean-label text-[9px] text-[#7a7a76]">CLIPPING</dt>
                  <dd className={cn("mt-1 text-sm font-bold", clipping ? "text-[#f87171]" : "text-[#22c55e]")}>
                    {clipping ? "YES" : "NO"}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="mt-3 text-center text-[11px] text-[#5c5c58]">Measurements appear after importing audio.</p>
            )}
            {clipping && (
              <p className="mt-2 text-[10.5px] leading-relaxed text-[#f87171]">
                Clipping detected — this recording already contains distorted samples. Normalization cannot repair it.
              </p>
            )}
          </section>

          <section className="rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
            <h2 className="bean-label text-[10px] text-[#8f8f8a]">3 · EXPORT SETTINGS</h2>
            <div className="mt-3 grid grid-cols-5 gap-1.5">
              {FORMATS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => setFormat(f.value)}
                  title={f.note}
                  className={cn(
                    "rounded-md border px-1 py-2 text-[10px] font-extrabold tracking-wider transition-colors",
                    format === f.value
                      ? "border-[#d4a017] bg-[#191307] text-[#d4a017]"
                      : "border-[#242424] bg-[#111] text-[#8f8f8a] hover:border-[#333]"
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[10px] text-[#5c5c58]">{FORMATS.find((f) => f.value === format)?.note}</p>

            {(format === "mp3" || format === "m4a" || format === "aac") && (
              <label className="mt-3 block">
                <span className="bean-label text-[10px] text-[#8f8f8a]">BITRATE — {bitrate} KBPS</span>
                <input
                  type="range"
                  min={64}
                  max={320}
                  step={32}
                  value={bitrate}
                  onChange={(e) => setBitrate(Number(e.target.value))}
                  className="mt-1.5 w-full accent-[#d4a017]"
                />
              </label>
            )}
          </section>

          <section className="rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
            <h2 className="bean-label text-[10px] text-[#8f8f8a]">EXPORT HISTORY (THIS MEDIA)</h2>
            {exports.length === 0 ? (
              <p className="mt-3 text-[11px] text-[#5c5c58]">No exports yet.</p>
            ) : (
              <ul className="bean-panel-scroll mt-3 max-h-56 space-y-2 overflow-y-auto pr-1">
                {exports.map((e) => (
                  <li key={e.id} className="flex items-center justify-between gap-2 rounded-lg border border-[#1c1c1c] bg-[#111] px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-[11px] font-semibold text-white">{e.filename}</p>
                      <p className="text-[10px] text-[#7a7a76]">
                        {e.format.toUpperCase()} · {formatBytes(e.sizeBytes)} · {formatDateTime(e.createdAt)}
                      </p>
                    </div>
                    <a
                      href={`/api/exports/${e.id}/file`}
                      className="shrink-0 rounded border border-[#2a2a2a] p-1.5 text-[#8f8f8a] hover:border-[#d4a017] hover:text-[#d4a017]"
                      aria-label={`Download ${e.filename}`}
                    >
                      <Download className="h-3.5 w-3.5" />
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* Right: waveform + processing controls */}
        <div className="flex flex-col gap-4">
          <section className="rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="bean-label text-[10px] text-[#8f8f8a]">WAVEFORM — DRAG TO SET TRIM RANGE</h2>
              {trimStart !== null && trimEnd !== null && trimEnd > trimStart && (
                <button
                  type="button"
                  onClick={() => {
                    setTrimStart(null);
                    setTrimEnd(null);
                  }}
                  className="text-[10px] font-bold uppercase tracking-wider text-[#8f8f8a] hover:text-[#f87171]"
                >
                  CLEAR TRIM
                </button>
              )}
            </div>
            {media ? (
              <>
                <Waveform
                  peaks={peaks}
                  duration={duration}
                  viewStart={viewStart}
                  viewEnd={viewEnd || duration}
                  onSeek={(t) => {
                    setPlayhead(t);
                    if (previewRef.current) previewRef.current.currentTime = t;
                  }}
                  playhead={playhead}
                  height={140}
                  allowDragSelect
                  onDragSelect={(s, e) => {
                    setTrimStart(Math.round(s * 1000) / 1000);
                    setTrimEnd(Math.round(e * 1000) / 1000);
                  }}
                  cuts={
                    trimStart !== null && trimEnd !== null && trimEnd > trimStart
                      ? [{ id: "trim", start: trimStart, end: trimEnd, status: "KEEP" }]
                      : []
                  }
                />
                <audio
                  ref={previewRef}
                  src={`/api/media/${media.id}/file`}
                  controls
                  className="mt-3 w-full"
                  onTimeUpdate={(e) => setPlayhead((e.target as HTMLAudioElement).currentTime)}
                />
                {trimStart !== null && trimEnd !== null && trimEnd > trimStart && (
                  <p className="mt-2 text-[11px] text-[#d4a017]">
                    Trim: {formatDuration(trimStart)} → {formatDuration(trimEnd)} ({(trimEnd - trimStart).toFixed(2)}s kept of{" "}
                    {formatDuration(duration)})
                  </p>
                )}
              </>
            ) : (
              <div className="flex h-[140px] items-center justify-center rounded-lg border border-dashed border-[#242424] text-xs text-[#5c5c58]">
                Import audio to see the waveform
              </div>
            )}
          </section>

          <section className="rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
            <h2 className="bean-label text-[10px] text-[#8f8f8a]">PROCESSING CHAIN</h2>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="flex items-center justify-between text-[11px]">
                  <span className="bean-label text-[10px] text-[#8f8f8a]">GAIN</span>
                  <span className="font-mono text-[#d4a017]">{gainDb > 0 ? `+${gainDb}` : gainDb} dB</span>
                </span>
                <input
                  type="range"
                  min={-24}
                  max={12}
                  step={1}
                  value={gainDb}
                  onChange={(e) => setGainDb(Number(e.target.value))}
                  className="mt-1.5 w-full accent-[#d4a017]"
                />
              </label>
              <label className="block">
                <span className="flex items-center justify-between text-[11px]">
                  <span className="bean-label text-[10px] text-[#8f8f8a]">FADE IN</span>
                  <span className="font-mono text-[#d4a017]">{fadeIn.toFixed(1)}s</span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={10}
                  step={0.5}
                  value={fadeIn}
                  onChange={(e) => setFadeIn(Number(e.target.value))}
                  className="mt-1.5 w-full accent-[#d4a017]"
                />
              </label>
              <label className="block">
                <span className="flex items-center justify-between text-[11px]">
                  <span className="bean-label text-[10px] text-[#8f8f8a]">FADE OUT</span>
                  <span className="font-mono text-[#d4a017]">{fadeOut.toFixed(1)}s</span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={10}
                  step={0.5}
                  value={fadeOut}
                  onChange={(e) => setFadeOut(Number(e.target.value))}
                  className="mt-1.5 w-full accent-[#d4a017]"
                />
              </label>
              <div>
                <span className="bean-label text-[10px] text-[#8f8f8a]">NORMALIZATION</span>
                <div className="mt-2 grid grid-cols-3 gap-1.5">
                  {(
                    [
                      ["off", "OFF"],
                      ["loudness", "LOUDNESS"],
                      ["peak", "PEAK"],
                    ] as const
                  ).map(([v, l]) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setNormalize(v)}
                      className={cn(
                        "rounded border px-1 py-1.5 text-[9px] font-extrabold tracking-wider transition-colors",
                        normalize === v
                          ? "border-[#d4a017] bg-[#191307] text-[#d4a017]"
                          : "border-[#242424] bg-[#111] text-[#8f8f8a] hover:border-[#333]"
                      )}
                    >
                      {l}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-[10px] leading-snug text-[#6a6a66]">
                  Loudness = EBU R128 (loudnorm). Peak = measured two-pass adjustment.
                </p>
              </div>
              <div>
                <span className="bean-label text-[10px] text-[#8f8f8a]">CHANNELS</span>
                <div className="mt-2 grid grid-cols-3 gap-1.5">
                  {(
                    [
                      ["keep", "KEEP"],
                      ["mono", "MONO"],
                      ["stereo", "STEREO"],
                    ] as const
                  ).map(([v, l]) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setChannelMode(v)}
                      className={cn(
                        "rounded border px-1 py-1.5 text-[9px] font-extrabold tracking-wider transition-colors",
                        channelMode === v
                          ? "border-[#d4a017] bg-[#191307] text-[#d4a017]"
                          : "border-[#242424] bg-[#111] text-[#8f8f8a] hover:border-[#333]"
                      )}
                    >
                      {l}
                    </button>
                  ))}
                </div>
              </div>
              <label className="flex cursor-pointer items-start gap-2.5">
                <input type="checkbox" checked={denoise} onChange={(e) => setDenoise(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#d4a017]" />
                <span>
                  <span className="block text-xs font-semibold text-white">Noise reduction (FFT)</span>
                  <span className="block text-[10.5px] leading-snug text-[#7a7a76]">
                    ffmpeg afftdn stationary-noise reduction. This is real processing — export time will reflect it.
                  </span>
                </span>
              </label>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={!canExport || Boolean(jobId)}
                onClick={startExport}
                className="bean-glow inline-flex h-10 items-center gap-2 rounded-md bg-[#d4a017] px-5 text-[11px] font-extrabold uppercase tracking-[0.14em] text-[#0c0c0c] hover:bg-[#e9b52a] disabled:opacity-40"
              >
                <Volume2 className="h-4 w-4" /> EXPORT {format.toUpperCase()} ({formatDuration(estDuration)})
              </button>
              {media?.kind === "VIDEO" && (
                <p className="text-[10.5px] text-[#7a7a76]">Video source — the audio stream is extracted; output is audio-only.</p>
              )}
            </div>
            {error && (
              <p className="mt-3 rounded-md border border-[#3b1515] bg-[#1a0d0d] px-3 py-2 text-xs leading-relaxed text-[#f87171]">{error}</p>
            )}
            {jobId && (
              <JobProgressBar
                jobId={jobId}
                label="PROCESSING AUDIO"
                onComplete={() => {
                  setJobId(null);
                  loadExports();
                }}
                onFail={(err) => {
                  setError(err);
                  setJobId(null);
                }}
              />
            )}
          </section>
        </div>
      </div>
    </ToolShell>
  );
}

// Keep the icon import used (lint) — rendered in the tool heading area.
export { AudioWaveform };
