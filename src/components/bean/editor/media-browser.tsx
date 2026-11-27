"use client";

/**
 * M15 — Project & media browser (left dock, MEDIA tab).
 *
 * REAL import: files upload through the M3 resumable pipeline
 * (`uploadMedia` → /api/media/upload/* — probes run in the durable worker).
 * Search/filter over the real library; every asset places onto the first
 * compatible unlocked track at the playhead (same M3-probe-aware placement
 * the editor always used). Proxy/original + missing-media status shown from
 * the real probe data — no invented state.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Film, Image as ImageIcon, Music, Search, Upload, Loader2, AlertTriangle } from "lucide-react";
import type { MediaMeta } from "@/lib/types";
import { api, uploadMedia, MAX_CLIENT_UPLOAD_BYTES } from "@/lib/client-api";

export function MediaBrowser({
  media,
  onRefresh,
  onPlace,
  importing,
  onImport,
  onLoadSource,
}: {
  media: MediaMeta[] | null;
  onRefresh: () => void;
  onPlace: (asset: MediaMeta) => void;
  importing: boolean;
  onImport: (files: FileList) => void;
  /** M48-C — load the asset into the Source Monitor for in/out marking. */
  onLoadSource?: (asset: MediaMeta) => void;
}) {
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<"ALL" | "VIDEO" | "AUDIO" | "IMAGE">("ALL");
  const fileRef = useRef<HTMLInputElement | null>(null);

  const filtered = useMemo(() => {
    const list = media ?? [];
    return list.filter((m) => (kindFilter === "ALL" ? true : m.kind === kindFilter)).filter((m) => (query ? m.originalName.toLowerCase().includes(query.toLowerCase()) : true));
  }, [media, query, kindFilter]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 border-b border-[#2a2a2a] px-2 py-1.5">
        <Search className="h-3 w-3 text-[#8f8f8a]" />
        <input value={query} onChange={(e) => setQuery(e.target.value.slice(0, 80))} placeholder="Search media…" className="min-w-0 flex-1 bg-transparent text-[11px] text-[#e6e6e0] outline-none placeholder:text-[#5a5a55]" />
        {(["ALL", "VIDEO", "AUDIO", "IMAGE"] as const).map((k) => (
          <button key={k} type="button" onClick={() => setKindFilter(k)} className={`rounded px-1.5 py-0.5 text-[9px] uppercase ${kindFilter === k ? "bg-[#d4a017]/15 text-[#d4a017]" : "text-[#6a6a64] hover:text-[#a8a8a0]"}`}>
            {k[0]}
          </button>
        ))}
      </div>
      <div className="px-2 py-1.5">
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="video/*,audio/*,image/*"
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) onImport(e.target.files);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={importing}
          className="flex w-full items-center justify-center gap-1.5 rounded border border-dashed border-[#2a2a2a] px-2 py-2 text-[11px] text-[#a8a8a0] transition-colors hover:border-[#d4a017] hover:text-[#d4a017] disabled:opacity-50"
        >
          {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          {importing ? "Importing…" : "Import video, audio or images"}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {media === null ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-[#d4a017]" />
          </div>
        ) : filtered.length === 0 ? (
          <p className="px-1 text-[11px] leading-relaxed text-[#8f8f8a]">No media matches. Import files above — the library is shared across the whole workspace.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {filtered.map((m) => (
              <li key={m.id} className="flex gap-2 rounded border border-[#1c1c1a] bg-[#111110] px-2 py-1.5">
                {/* M45 — real probe-generated poster thumbnail when available. */}
                {m.thumbnailUrl ? (
                  <img
                    src={m.thumbnailUrl}
                    alt=""
                    loading="lazy"
                    className="h-12 w-[72px] shrink-0 rounded object-cover"
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                  />
                ) : null}
                <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  {m.kind === "VIDEO" ? <Film className="h-3 w-3 shrink-0 text-[#d4a017]" /> : m.kind === "AUDIO" ? <Music className="h-3 w-3 shrink-0 text-[#3fa7c4]" /> : <ImageIcon className="h-3 w-3 shrink-0 text-[#4cc47f]" />}
                  <span className="min-w-0 flex-1 truncate text-[11px] text-[#e6e6e0]" title={m.originalName}>
                    {m.originalName}
                  </span>
                  {m.probeStatus === "FAILED" && <span title={m.probeError ?? "Probe failed"}><AlertTriangle className="h-3 w-3 shrink-0 text-[#c45c4c]" /></span>}
                </div>
                <div className="mt-1 flex items-center justify-between">
                  <span className="font-mono text-[9px] text-[#5a5a55]">
                    {m.durationSec ? `${m.durationSec.toFixed(1)}s` : m.kind === "IMAGE" ? "still" : "?"} · {m.fps ? `${m.fps.toFixed(2)}fps` : m.kind}
                    {m.probeStatus === "FAILED" ? " · probe failed" : ""}
                  </span>
                  <button
                    type="button"
                    onClick={() => onPlace(m)}
                    className="rounded border border-[#2a2a2a] px-1.5 py-0.5 text-[10px] text-[#d8d8d2] hover:border-[#d4a017] hover:text-[#d4a017]"
                    title="Place at playhead on the first compatible track"
                  >
                    + place
                  </button>
                  <button
                    type="button"
                    onClick={() => onLoadSource?.(m)}
                    className="rounded border border-[#2a2a2a] px-1.5 py-0.5 text-[10px] text-[#d8d8d2] hover:border-[#d4a017] hover:text-[#d4a017]"
                    title="Load into the Source Monitor (mark IN/OUT, then insert/overwrite/append)"
                  >
                    source
                  </button>
                </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex items-center justify-between border-t border-[#2a2a2a] px-2 py-1">
        <span className="text-[9px] text-[#5a5a55]">{(media ?? []).length} asset(s) · ≤{Math.round(MAX_CLIENT_UPLOAD_BYTES / 1024 / 1024 / 1024)}GB each</span>
        <button type="button" onClick={onRefresh} className="text-[9px] text-[#8f8f8a] hover:text-[#d4a017]">
          refresh
        </button>
      </div>
    </div>
  );
}

/** Import helper shared with the workspace shell: sequential resumable uploads. */
export function useMediaImport(refresh: () => void, onNotice: (message: string) => void) {
  const [importing, setImporting] = useState(false);
  const importFiles = useCallback(
    async (files: FileList) => {
      setImporting(true);
      const done: string[] = [];
      const failed: string[] = [];
      try {
        for (const file of Array.from(files)) {
          try {
            await uploadMedia(file, { onProgress: () => undefined });
            done.push(file.name);
          } catch (err) {
            failed.push(`${file.name}: ${err instanceof Error ? err.message : "upload failed"}`);
          }
        }
        refresh();
        if (failed.length > 0) onNotice(`Imported ${done.length} file(s); ${failed.length} failed — ${failed[0].slice(0, 120)}`);
        else if (done.length > 0) onNotice(`Imported ${done.join(", ")} — probe runs in the background; place once analysis finishes.`);
      } finally {
        setImporting(false);
      }
    },
    [refresh, onNotice],
  );
  return { importing, importFiles };
}

export { api };
