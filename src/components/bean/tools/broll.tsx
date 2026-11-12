"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Clapperboard, Download, Loader2, Search, Sparkles, Trash2 } from "lucide-react";
import { ToolShell } from "@/components/bean/tool-shell";
import { MediaPicker } from "@/components/bean/media-picker";
import { readMediaRef } from "@/components/bean/upload-gate";
import type { SessionUser, MediaMeta, TranscriptSegment } from "@/lib/types";
import { formatBytes, formatDateTime, formatDuration } from "@/lib/format-utils";
import { cn } from "@/lib/utils";

interface Suggestion {
  brollId: string;
  brollName: string;
  matchedKeywords: string[];
  segmentStart: number;
  segmentEnd: number;
  segmentText: string;
}

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "is", "are", "was", "were",
  "this", "that", "it", "as", "be", "by", "from", "we", "you", "i", "they", "he", "she", "so", "if", "then",
  "about", "into", "over", "after", "before", "when", "what", "which", "who", "how", "can", "will", "just",
]);

export function BrollTool({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  const [library, setLibrary] = useState<MediaMeta[] | null>(null);
  const [mainMedia, setMainMedia] = useState<MediaMeta | null>(() => readMediaRef("broll"));
  const [mainKey, setMainKey] = useState(0);
  const [query, setQuery] = useState("");
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [suggestBusy, setSuggestBusy] = useState(false);
  const [suggestNote, setSuggestNote] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);

  const loadLibrary = useCallback(() => {
    fetch("/api/media")
      .then((r) => r.json())
      .then((d) => setLibrary(((d.media ?? []) as MediaMeta[]).filter((m) => m.role === "BROLL")))
      .catch(() => setLibrary([]));
  }, []);

  useEffect(() => {
    loadLibrary();
  }, [loadLibrary]);

  const filtered = useMemo(() => {
    if (!library) return [];
    const q = query.trim().toLowerCase();
    if (!q) return library;
    return library.filter(
      (m) => m.originalName.toLowerCase().includes(q) || (m.notes ?? "").toLowerCase().includes(q)
    );
  }, [library, query]);

  /**
   * Transcript-linked suggestions: transcribe the MAIN media (real ASR),
   * align to speech spans, extract content keywords per segment, and match
   * against the library's filenames + user-authored notes. If transcription
   * is unavailable, say so — nothing is fabricated.
   */
  const runSuggestions = useCallback(async () => {
    if (!mainMedia) return;
    setSuggestBusy(true);
    setSuggestNote(null);
    setSuggestions(null);
    setError(null);
    try {
      const res = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediaId: mainMedia.id }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setSuggestNote(`Transcription unavailable: ${data?.error ?? res.status}. Suggestions need genuine transcript evidence and cannot be generated.`);
        return;
      }
      const text: string = data.text;
      // Split into rough segments on sentence punctuation; timing is chunk-approximate.
      const sentences = text.split(/(?<=[.!?。！？])\s+/).filter((s) => s.trim().length > 0);
      const totalLen = sentences.reduce((a, s) => a + s.length, 0) || 1;
      const duration = mainMedia.durationSec ?? 0;
      let cursor = 0;
      const segments: TranscriptSegment[] = sentences.map((s, i) => {
        const frac = s.length / totalLen;
        const start = cursor;
        const end = Math.min(duration, cursor + frac * duration);
        cursor = end;
        return {
          id: `seg-${i}`,
          start: Math.round(start * 10) / 10,
          end: Math.round(end * 10) / 10,
          text: s.trim(),
          timingSource: "estimated",
        };
      });

      // Keyword matching against library metadata.
      const results: Suggestion[] = [];
      for (const seg of segments) {
        const words = seg.text
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\s]/gu, " ")
          .split(/\s+/)
          .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
        const unique = [...new Set(words)];
        for (const asset of library ?? []) {
          const haystack = `${asset.originalName} ${asset.notes ?? ""}`.toLowerCase();
          const matched = unique.filter((w) => haystack.includes(w));
          if (matched.length > 0) {
            results.push({
              brollId: asset.id,
              brollName: asset.originalName,
              matchedKeywords: matched.slice(0, 4),
              segmentStart: seg.start,
              segmentEnd: seg.end,
              segmentText: seg.text.slice(0, 140),
            });
            break;
          }
        }
      }
      setSuggestions(results.slice(0, 30));
      setSuggestNote(
        results.length
          ? `${results.length} keyword-matched suggestion(s) from ${segments.length} transcript segments. Timing is estimated from the transcript, not frame-accurate.`
          : `No library assets matched any transcript keywords. Tag your B-roll with notes describing its content (e.g. "city timelapse, night traffic") to improve matching.`
      );
    } catch (err) {
      setSuggestNote(err instanceof Error ? err.message : "Suggestion run failed.");
    } finally {
      setSuggestBusy(false);
    }
  }, [mainMedia, library]);

  const exportPlan = useCallback(() => {
    if (!mainMedia || !suggestions?.length) return;
    const plan = {
      generator: "BEAN FX",
      version: 1,
      generatedAt: new Date().toISOString(),
      note: "Insertion plan with estimated timing from transcript alignment. Verify before applying in any editor.",
      mainMedia: { id: mainMedia.id, name: mainMedia.originalName, durationSec: mainMedia.durationSec },
      insertions: suggestions.map((s) => ({
        brollMediaId: s.brollId,
        brollFile: s.brollName,
        insertAtSec: s.segmentStart,
        estimatedUntilSec: s.segmentEnd,
        matchedKeywords: s.matchedKeywords,
        transcriptContext: s.segmentText,
      })),
    };
    const blob = new Blob([JSON.stringify(plan, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `broll_plan_${mainMedia.originalName.replace(/\.[^.]+$/, "")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [mainMedia, suggestions]);

  const deleteAsset = useCallback(
    async (id: string) => {
      setError(null);
      try {
        const res = await fetch(`/api/media/${id}`, { method: "DELETE" });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error ?? "Delete failed.");
        loadLibrary();
        if (previewId === id) setPreviewId(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Delete failed.");
      }
    },
    [loadLibrary, previewId]
  );

  const preview = library?.find((m) => m.id === previewId) ?? null;

  return (
    <ToolShell
      user={user}
      onLogout={onLogout}
      route="/broll"
      label="B-ROLL"
      title="Your B-roll library, linked to the transcript"
      description="Upload your own footage with searchable metadata, preview it, and get transcript-linked insertion suggestions when real transcript evidence exists. No stock provider is bundled — this library is yours."
    >
      <div className="grid gap-5 lg:grid-cols-[340px_1fr]">
        <div className="flex flex-col gap-4">
          <section className="rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
            <h2 className="bean-label text-[10px] text-[#8f8f8a]">B-ROLL LIBRARY</h2>
            <div className="mt-3">
              <MediaPicker role="BROLL" selectedId={null} onSelect={() => {}} refreshKey={mainKey} />
            </div>
            <p className="mt-2 text-[10px] leading-relaxed text-[#5c5c58]">
              Files uploaded here are tagged as B-roll. Add descriptive notes below so keyword matching can find them.
            </p>
          </section>

          <section className="rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
            <h2 className="bean-label text-[10px] text-[#8f8f8a]">MAIN MEDIA (FOR SUGGESTIONS)</h2>
            <div className="mt-3">
                      {mainMedia ? (
                <p className="text-[12px] leading-relaxed text-[#9a9a94]">
                  <span className="font-semibold text-white">{mainMedia?.originalName ?? ""}</span>
                  {mainMedia?.durationSec ? ` — ${mainMedia?.durationSec.toFixed(1)}s` : ""}{mainMedia?.audioCodec ? `, ${mainMedia?.audioCodec}` : ""}.
                </p>
              ) : (
                <p className="text-[12px] text-[#7a7a76]">No media selected.</p>
              )}
              <a data-change-media className="hidden" aria-hidden />

              <a href="#/broll" className="mt-2 inline-flex h-8 items-center rounded-md border border-[#2a2a2a] px-3 text-[10px] font-extrabold uppercase tracking-wider text-[#9a9a94] hover:border-[#d4a017]/50 hover:text-white">
                Change media
              </a>
            </div>
            <button
              type="button"
              disabled={!mainMedia || suggestBusy || !library?.length}
              onClick={runSuggestions}
              className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-[#2e2410] bg-[#141007] text-[11px] font-extrabold uppercase tracking-[0.14em] text-[#d4a017] hover:bg-[#191307] disabled:opacity-40"
            >
              {suggestBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              SUGGEST FROM TRANSCRIPT
            </button>
            {suggestNote && (
              <p className="mt-2.5 rounded-md border border-[#2e2410] bg-[#161007] px-3 py-2 text-[11px] leading-relaxed text-[#d4a017]">
                {suggestNote}
              </p>
            )}
          </section>
        </div>

        <div className="flex flex-col gap-4">
          <section className="rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="bean-label text-[10px] text-[#8f8f8a]">ASSETS ({library?.length ?? 0})</h2>
              <div className="relative w-64">
                <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#5c5c58]" />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by keyword or note…"
                  className="h-9 w-full rounded-md border border-[#2a2a2a] bg-[#121212] pl-9 pr-3 text-sm text-white placeholder:text-[#555] focus:border-[#d4a017] focus:outline-none"
                />
              </div>
            </div>

            {error && (
              <p className="mt-3 rounded-md border border-[#3b1515] bg-[#1a0d0d] px-3 py-2 text-xs text-[#f87171]">{error}</p>
            )}

            {library === null ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-[#d4a017]" />
              </div>
            ) : filtered.length === 0 ? (
              <p className="mt-3 rounded-lg border border-dashed border-[#242424] px-4 py-10 text-center text-xs leading-relaxed text-[#5c5c58]">
                {library.length === 0
                  ? "Your B-roll library is empty. Upload footage on the left to get started."
                  : "No assets match that search."}
              </p>
            ) : (
              <div className="bean-panel-scroll mt-3 grid max-h-[420px] gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
                {filtered.map((m) => (
                  <div
                    key={m.id}
                    className={cn(
                      "rounded-lg border px-3.5 py-3",
                      previewId === m.id ? "border-[#d4a017] bg-[#151007]" : "border-[#1c1c1c] bg-[#111]"
                    )}
                  >
                    <button type="button" className="block w-full text-left" onClick={() => setPreviewId(m.id)}>
                      <p className="truncate text-[13px] font-semibold text-white">{m.originalName}</p>
                      <p className="mt-0.5 text-[11px] text-[#8f8f8a]">
                        {formatDuration(m.durationSec)}
                        {m.width && m.height ? ` · ${m.width}×${m.height}` : ""}
                        {m.fps ? ` @ ${m.fps}` : ""} · {formatBytes(m.sizeBytes)}
                      </p>
                      <p className="mt-0.5 text-[10px] text-[#5c5c58]">{formatDateTime(m.createdAt)}</p>
                      {m.notes && <p className="mt-1.5 line-clamp-2 text-[11px] text-[#9a9a94]">“{m.notes}”</p>}
                    </button>
                    <div className="mt-2.5 flex items-center gap-2">
                      <input
                        type="text"
                        defaultValue={m.notes ?? ""}
                        placeholder="Add keywords: e.g. city, night, traffic"
                        onBlur={async (e) => {
                          const notes = e.target.value.slice(0, 500);
                          await fetch(`/api/media/${m.id}`, {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ notes, role: "BROLL" }),
                          });
                          loadLibrary();
                        }}
                        className="h-7 min-w-0 flex-1 rounded border border-[#242424] bg-[#0d0d0d] px-2 text-[11px] text-white placeholder:text-[#555] focus:border-[#d4a017] focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => deleteAsset(m.id)}
                        className="rounded border border-[#2a2a2a] p-1.5 text-[#7a7a76] hover:border-[#ef4444] hover:text-[#f87171]"
                        aria-label={`Delete ${m.originalName}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {preview && (
            <section className="rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
              <h2 className="bean-label mb-3 text-[10px] text-[#8f8f8a]">PREVIEW — {preview.originalName}</h2>
              <video src={`/api/media/${preview.id}/file`} controls className="max-h-80 w-full rounded-lg border border-[#1c1c1c] bg-black" />
              <dl className="mt-3 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
                <Meta label="RESOLUTION" value={preview.width ? `${preview.width}×${preview.height}` : "—"} />
                <Meta label="FRAME RATE" value={preview.fps ? `${preview.fps} fps` : "—"} />
                <Meta label="DURATION" value={formatDuration(preview.durationSec)} />
                <Meta label="SIZE" value={formatBytes(preview.sizeBytes)} />
              </dl>
              <p className="mt-2 text-[10px] leading-relaxed text-[#5c5c58]">
                Source: your own upload. Licensing/attribution applies only to assets you add — BEAN FX bundles no
                third-party footage and fabricates none.
              </p>
            </section>
          )}

          {suggestions && suggestions.length > 0 && (
            <section className="rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="bean-label text-[10px] text-[#8f8f8a]">INSERTION SUGGESTIONS ({suggestions.length})</h2>
                <button
                  type="button"
                  onClick={exportPlan}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#2e2410] bg-[#141007] px-3 text-[10px] font-extrabold uppercase tracking-wider text-[#d4a017] hover:bg-[#191307]"
                >
                  <Download className="h-3.5 w-3.5" /> EXPORT PLAN (JSON)
                </button>
              </div>
              <div className="bean-panel-scroll mt-3 max-h-80 space-y-2 overflow-y-auto pr-1">
                {suggestions.map((s, i) => (
                  <div key={i} className="rounded-lg border border-[#241f10] bg-[#120e05] px-3.5 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-xs font-bold text-[#d4a017]">
                        Insert at {formatDuration(s.segmentStart)} → {formatDuration(s.segmentEnd)}
                      </span>
                      <Clapperboard className="h-3.5 w-3.5 text-[#8f8f8a]" />
                    </div>
                    <p className="mt-1.5 text-[12px] font-semibold text-white">{s.brollName}</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-[#9a9a94]">“{s.segmentText}”</p>
                    <p className="mt-1.5 flex flex-wrap gap-1.5">
                      {s.matchedKeywords.map((k) => (
                        <span key={k} className="rounded bg-[#1c1608] px-1.5 py-0.5 text-[10px] font-semibold text-[#d4a017]">
                          {k}
                        </span>
                      ))}
                    </p>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </ToolShell>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[#1c1c1c] bg-[#111] px-2.5 py-2">
      <dt className="bean-label text-[9px] text-[#7a7a76]">{label}</dt>
      <dd className="mt-0.5 font-mono text-xs font-bold text-white">{value}</dd>
    </div>
  );
}
