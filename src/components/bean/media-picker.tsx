"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, UploadCloud, XCircle } from "lucide-react";
import type { MediaMeta } from "@/lib/types";
import { uploadMedia } from "@/lib/client-api";
import { formatBytes, formatDateTime, formatDuration } from "@/lib/format-utils";
import { cn } from "@/lib/utils";

export function MediaPicker({
  kindFilter,
  selectedId,
  onSelect,
  refreshKey,
  role,
}: {
  kindFilter?: "AUDIO" | "VIDEO";
  selectedId: string | null;
  onSelect: (media: MediaMeta | null) => void;
  refreshKey?: number;
  role?: "BROLL";
}) {
  const [media, setMedia] = useState<MediaMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/media");
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed to load media library.");
      setMedia(data.media ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load media library.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const doUpload = useCallback(
    async (file: File) => {
      if (busyRef.current) return; // one upload at a time — no duplicate requests
      busyRef.current = true;
      setError(null);
      setUploadPct(0);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        await uploadMedia(file, {
          role,
          onProgress: (pct) => setUploadPct(pct),
          signal: controller.signal,
        });
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed.");
      } finally {
        setUploadPct(null);
        abortRef.current = null;
        busyRef.current = false;
      }
    },
    [load, role]
  );

  const visible = media?.filter((m) => (kindFilter ? m.kind === kindFilter : true)) ?? [];

  return (
    <div className="flex flex-col gap-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) void doUpload(f);
        }}
        className={cn(
          "flex flex-col items-center justify-center rounded-lg border border-dashed px-4 py-6 text-center transition-colors",
          dragOver ? "border-[#d4a017] bg-[#141007]" : "border-[#2a2a2a] bg-[#0d0d0d]"
        )}
      >
        <UploadCloud className="h-6 w-6 text-[#d4a017]" />
        <p className="mt-2 text-xs font-semibold text-white">
          Drag media here, or{" "}
          <button
            type="button"
            className="text-[#d4a017] underline-offset-2 hover:underline"
            onClick={() => fileInput.current?.click()}
          >
            browse files
          </button>
        </p>
        <p className="mt-1 text-[11px] text-[#7a7a76]">
          MP4 · MOV · WebM · MKV · MP3 · WAV · M4A · AAC · FLAC — up to 250 MB. Validated server-side with ffprobe.
        </p>
        <input
          ref={fileInput}
          type="file"
          className="hidden"
          accept="audio/*,video/*,.mp4,.mov,.webm,.mkv,.mp3,.wav,.m4a,.aac,.flac,.ogg"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void doUpload(f);
            e.target.value = "";
          }}
        />
        {uploadPct !== null && (
          <div className="mt-3 w-full max-w-xs">
            <div className="flex items-center justify-between text-[10px] font-semibold text-[#8f8f8a]">
              <span>UPLOADING…</span>
              <button
                type="button"
                className="inline-flex items-center gap-1 text-[#f87171] hover:underline"
                onClick={() => abortRef.current?.abort()}
              >
                <XCircle className="h-3 w-3" /> CANCEL
              </button>
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[#1c1c1c]">
              <div className="h-full bg-[#d4a017] transition-all" style={{ width: `${uploadPct}%` }} />
            </div>
            <p className="mt-1 text-right text-[10px] text-[#8f8f8a]">{uploadPct}%</p>
          </div>
        )}
      </div>

      {error && (
        <p className="rounded-md border border-[#3b1515] bg-[#1a0d0d] px-3 py-2 text-xs leading-relaxed text-[#f87171]">
          {error}
        </p>
      )}

      {media === null ? (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin text-[#d4a017]" />
        </div>
      ) : visible.length === 0 ? (
        <p className="rounded-lg border border-[#1c1c1c] bg-[#0d0d0d] px-4 py-6 text-center text-xs text-[#8f8f8a]">
          {kindFilter === "VIDEO"
            ? "No video files yet. Import a video to begin."
            : kindFilter === "AUDIO"
              ? "No audio files yet. Import audio or extract audio from video via the Audio tool."
              : "No media yet. Import a file above to begin."}
        </p>
      ) : (
        <div className="bean-panel-scroll max-h-72 space-y-2 overflow-y-auto pr-1" role="listbox" aria-label="Media library">
          {visible.map((m) => (
            <button
              key={m.id}
              type="button"
              role="option"
              aria-selected={selectedId === m.id}
              onClick={() => onSelect(selectedId === m.id ? null : m)}
              className={cn(
                "flex w-full items-center justify-between gap-3 rounded-lg border px-3.5 py-3 text-left transition-colors",
                selectedId === m.id
                  ? "border-[#d4a017] bg-[#151007]"
                  : "border-[#1c1c1c] bg-[#0d0d0d] hover:border-[#2e2e2e]"
              )}
            >
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-semibold text-white">{m.originalName}</span>
                <span className="mt-0.5 block text-[11px] text-[#8f8f8a]">
                  {m.kind} · {formatDuration(m.durationSec)}
                  {m.width && m.height ? ` · ${m.width}×${m.height}` : ""}
                  {m.fps ? ` · ${m.fps} fps` : ""}
                  {m.audioCodec ? ` · ${m.audioCodec}` : ""}
                  {m.sampleRate ? ` · ${m.sampleRate} Hz` : ""}
                  {" · "}
                  {formatBytes(m.sizeBytes)}
                </span>
                <span className="mt-0.5 block text-[10px] text-[#5c5c58]">Imported {formatDateTime(m.createdAt)}</span>
              </span>
              {selectedId === m.id && (
                <span className="bean-label shrink-0 text-[10px] text-[#d4a017]">SELECTED</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function useMediaLibrary() {
  const [media, setMedia] = useState<MediaMeta[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    fetch("/api/media")
      .then((r) => r.json())
      .then((d) => setMedia(d.media ?? []))
      .catch(() => setMedia([]));
  }, [refreshKey]);
  return { media, refresh: () => setRefreshKey((k) => k + 1) };
}
