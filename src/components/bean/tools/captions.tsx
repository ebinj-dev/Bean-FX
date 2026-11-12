"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Captions,
  Download,
  FilePlus2,
  Loader2,
  Search,
  Scissors,
  Merge,
  Trash2,
  Upload,
  Sparkles,
  AlertTriangle,
  Film,
} from "lucide-react";
import { ToolShell } from "@/components/bean/tool-shell";
import { readMediaRef } from "@/components/bean/upload-gate";
import { JobProgressBar } from "@/components/bean/job-progress";
import type { SessionUser, MediaMeta } from "@/lib/types";
import { decodeAudio, computeEnvelope, detectSilence } from "@/lib/audio-analysis";
import { parseSubtitles, serializeSrt, serializeVtt, validateCueOrder, alignTextToSpeech, type Cue } from "@/lib/srt-vtt";
import { formatDuration } from "@/lib/format-utils";
import { cn } from "@/lib/utils";

export function CaptionsTool({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  const [media, setMedia] = useState<MediaMeta | null>(() => readMediaRef("captions"));
  const [mediaKey, setMediaKey] = useState(0);

  const [cues, setCues] = useState<Cue[]>([]);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState<"transcribe" | "import" | null>(null);

  const [burnJobId, setBurnJobId] = useState<string | null>(null);
  const [burnError, setBurnError] = useState<string | null>(null);
  const [burnDone, setBurnDone] = useState<{ exportId: string } | null>(null);

  const previewRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isVideo = media?.kind === "VIDEO";

  // Reset when media changes.
  useEffect(() => {
    setCues([]);
    setSelectedId(null);
    setError(null);
    setWarnings([]);
    setBurnJobId(null);
    setBurnDone(null);
  }, [media?.id, mediaKey]);

  const seekTo = useCallback(
    (t: number) => {
      const el = previewRef.current;
      if (el) {
        el.currentTime = Math.max(0, t);
        void el.play().catch(() => undefined);
      }
    },
    []
  );

  const transcribe = useCallback(async () => {
    if (!media) return;
    setBusy("transcribe");
    setError(null);
    setStatus(null);
    setWarnings([]);
    try {
      const res = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediaId: media.id }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? `Transcription failed (${res.status}).`);
        return;
      }
      // Align the real transcript text to measured speech energy.
      const fileRes = await fetch(`/api/media/${media.id}/file`);
      if (!fileRes.ok) throw new Error("Could not reload media audio for alignment.");
      const blob = await fileRes.blob();
      const decoded = await decodeAudio(blob);
      const envelope = computeEnvelope(decoded.buffer, 10);
      const silence = detectSilence(envelope, { minSilenceSec: 0.35, sensitivity: "BALANCED" });
      const nf = silence.noiseFloor;
      const speech: { start: number; end: number }[] = [];
      let runStart = -1;
      const threshold = Math.max(nf * 2.2, 0.004);
      for (let i = 0; i < envelope.values.length; i++) {
        const t = i * envelope.windowSec;
        if (envelope.values[i] >= threshold) {
          if (runStart < 0) runStart = i;
        } else if (runStart >= 0) {
          if (t - runStart * envelope.windowSec >= 0.3) speech.push({ start: runStart * envelope.windowSec, end: t });
          runStart = -1;
        }
      }
      if (runStart >= 0) speech.push({ start: runStart * envelope.windowSec, end: decoded.durationSec });
      const merged: { start: number; end: number }[] = [];
      for (const s of speech) {
        const prev = merged[merged.length - 1];
        if (prev && s.start - prev.end < 0.4) prev.end = s.end;
        else merged.push({ ...s });
      }
      const aligned = alignTextToSpeech(data.text, merged);
      if (!aligned.length) {
        setError("The provider returned text but no speech energy was measurable — automatic alignment failed. Import an SRT/VTT instead.");
        return;
      }
      setCues(aligned);
      setWarnings((data.warnings ?? []) as string[]);
      setStatus(`Transcribed via ${data.provider}. ${aligned.length} cues created with ESTIMATED timing.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transcription failed.");
    } finally {
      setBusy(null);
    }
  }, [media]);

  const importFile = useCallback(async (file: File) => {
    setBusy("import");
    setError(null);
    setWarnings([]);
    try {
      const text = await file.text();
      const { cues: parsed, format } = parseSubtitles(text);
      setCues(parsed);
      const problems = validateCueOrder(parsed);
      setWarnings(problems.length ? [`Imported ${format.toUpperCase()} with validation warnings:`, ...problems] : []);
      setStatus(`Imported ${parsed.length} cues from ${format.toUpperCase()}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Subtitle import failed.");
    } finally {
      setBusy(null);
    }
  }, []);

  // Cue operations
  const updateCue = (id: string, patch: Partial<Cue>) =>
    setCues((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));

  const addCue = () => {
    const last = cues[cues.length - 1];
    const start = last ? Math.min(last.end, last.end + 0.1) : 0;
    const nc: Cue = { id: `cue-${Date.now()}`, start, end: start + 2, text: "New caption" };
    setCues((prev) => [...prev, nc]);
    setSelectedId(nc.id);
  };

  const splitCue = (id: string) => {
    const cue = cues.find((c) => c.id === id);
    if (!cue) return;
    const mid = (cue.start + cue.end) / 2;
    const words = cue.text.split(/\s+/);
    const half = Math.max(1, Math.ceil(words.length / 2));
    const a = words.slice(0, half).join(" ");
    const b = words.slice(half).join(" ") || "…";
    setCues((prev) =>
      prev
        .flatMap((c) =>
          c.id === id
            ? [
                { ...c, end: mid, text: a },
                { id: `${c.id}-b`, start: mid, end: cue.end, text: b },
              ]
            : [c]
        )
        .sort((x, y) => x.start - y.start)
    );
  };

  const mergeCue = (id: string) => {
    const idx = cues.findIndex((c) => c.id === id);
    if (idx < 0 || idx === cues.length - 1) return;
    const a = cues[idx];
    const b = cues[idx + 1];
    setCues((prev) =>
      prev
        .filter((c) => c.id !== a.id && c.id !== b.id)
        .concat({ id: a.id, start: a.start, end: b.end, text: `${a.text} ${b.text}` })
        .sort((x, y) => x.start - y.start)
    );
  };

  const deleteCue = (id: string) => setCues((prev) => prev.filter((c) => c.id !== id));

  const problems = useMemo(() => validateCueOrder(cues), [cues]);
  const filtered = useMemo(
    () => (query.trim() ? cues.filter((c) => c.text.toLowerCase().includes(query.toLowerCase())) : cues),
    [cues, query]
  );

  const download = useCallback(
    (format: "srt" | "vtt") => {
      if (!cues.length) return;
      const content = format === "srt" ? serializeSrt(cues) : serializeVtt(cues);
      const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(media?.originalName ?? "captions").replace(/\.[^.]+$/, "")}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    },
    [cues, media]
  );

  const burnIn = useCallback(async () => {
    if (!media || !cues.length) return;
    setBurnError(null);
    setBurnDone(null);
    try {
      const res = await fetch("/api/process/burn-captions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediaId: media.id, srtContent: serializeSrt(cues), fontSize: 20 }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setBurnError(data?.error ?? `Burn-in failed (${res.status}).`);
        return;
      }
      setBurnJobId(data.jobId);
    } catch {
      setBurnError("Network error while starting burn-in.");
    }
  }, [media, cues]);

  return (
    <ToolShell
      user={user}
      onLogout={onLogout}
      route="/captions"
      label="CAPTIONS"
      title="Transcribe, edit and export subtitles"
      description="Real transcription via the configured ASR provider, a full cue editor, and validated SRT/VTT import and export. Unicode text (English, Tamil, Hindi, mixed) is preserved."
    >
      <div className="grid gap-5 lg:grid-cols-[340px_1fr]">
        <div className="flex flex-col gap-4">
          <section className="rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
            <h2 className="bean-label text-[10px] text-[#8f8f8a]">1 · SOURCE MEDIA</h2>
            <div className="mt-3">
              {media ? (
                <p className="text-[12px] leading-relaxed text-[#9a9a94]">
                  <span className="font-semibold text-white">{media.originalName}</span>
                  {media.durationSec ? ` — ${media.durationSec.toFixed(1)}s` : ""}{media.audioCodec ? `, ${media.audioCodec}` : ""}.
                </p>
              ) : (
                <p className="text-[12px] text-[#7a7a76]">No media selected.</p>
              )}
              <a  className="hidden" aria-hidden />

              <a href="#/captions" className="mt-2 inline-flex h-8 items-center rounded-md border border-[#2a2a2a] px-3 text-[10px] font-extrabold uppercase tracking-wider text-[#9a9a94] hover:border-[#d4a017]/50 hover:text-white">
                Change media
              </a>
            </div>
          </section>

          <section className="rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
            <h2 className="bean-label text-[10px] text-[#8f8f8a]">2 · GENERATE / IMPORT</h2>
            <div className="mt-3 flex flex-col gap-2">
              <button
                type="button"
                disabled={!media || busy !== null}
                onClick={transcribe}
                className="bean-glow inline-flex h-10 items-center justify-center gap-2 rounded-md bg-[#d4a017] text-[11px] font-extrabold uppercase tracking-[0.14em] text-[#0c0c0c] hover:bg-[#e9b52a] disabled:opacity-40"
              >
                {busy === "transcribe" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                TRANSCRIBE (REAL ASR)
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy !== null}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-[#2a2a2a] bg-[#121212] text-[11px] font-extrabold uppercase tracking-[0.14em] text-white hover:border-[#3a3a3a] disabled:opacity-40"
              >
                {busy === "import" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                IMPORT SRT / VTT
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".srt,.vtt,text/plain"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importFile(f);
                  e.target.value = "";
                }}
              />
              <p className="text-[10px] leading-relaxed text-[#5c5c58]">
                The ASR provider returns plain text without timestamps. BEAN FX aligns the text to measured speech energy
                and labels every generated cue as ESTIMATED — review timing before exporting final subtitles. Nothing is
                invented when transcription fails.
              </p>
            </div>
          </section>

          {isVideo && cues.length > 0 && (
            <section className="rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
              <h2 className="bean-label text-[10px] text-[#8f8f8a]">BURN-IN (VIDEO ONLY)</h2>
              <p className="mt-2 text-[10.5px] leading-relaxed text-[#7a7a76]">
                Renders the captions permanently into a new MP4 via ffmpeg. This is distinct from the downloadable
                subtitle files.
              </p>
              <button
                type="button"
                onClick={burnIn}
                disabled={Boolean(burnJobId)}
                className="mt-3 inline-flex h-10 items-center justify-center gap-2 rounded-md border border-[#2e2410] bg-[#141007] px-4 text-[11px] font-extrabold uppercase tracking-[0.14em] text-[#d4a017] hover:bg-[#191307] disabled:opacity-40"
              >
                <Film className="h-4 w-4" /> BURN CAPTIONS INTO VIDEO
              </button>
              {burnError && (
                <p className="mt-2 rounded-md border border-[#3b1515] bg-[#1a0d0d] px-3 py-2 text-xs text-[#f87171]">{burnError}</p>
              )}
              {burnJobId && (
                <JobProgressBar
                  jobId={burnJobId}
                  label="BURNING CAPTIONS"
                  onComplete={(exportId) => setBurnDone({ exportId })}
                  onFail={(err) => setBurnError(err)}
                />
              )}
              {burnDone && (
                <a
                  href={`/api/exports/${burnDone.exportId}/file`}
                  className="mt-3 inline-flex h-10 items-center gap-2 rounded-md border border-[#1f2a1a] bg-[#0c120a] px-4 text-[11px] font-extrabold uppercase tracking-[0.14em] text-[#22c55e] hover:bg-[#0f1a0e]"
                >
                  <Download className="h-4 w-4" /> DOWNLOAD VIDEO
                </a>
              )}
            </section>
          )}

          {media && (
            <section className="rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
              <h2 className="bean-label text-[10px] text-[#8f8f8a]">PREVIEW</h2>
              <div className="mt-3 overflow-hidden rounded-lg border border-[#1c1c1c] bg-black">
                {isVideo ? (
                  <video
                    ref={(el) => {
                      previewRef.current = el;
                    }}
                    src={`/api/media/${media.id}/file`}
                    controls
                    className="max-h-56 w-full"
                  />
                ) : (
                  <audio
                    ref={(el) => {
                      previewRef.current = el;
                    }}
                    src={`/api/media/${media.id}/file`}
                    controls
                    className="w-full"
                  />
                )}
              </div>
              <p className="mt-2 text-[10px] text-[#5c5c58]">Click a cue to seek the preview to its start.</p>
            </section>
          )}
        </div>

        {/* Editor */}
        <div className="flex flex-col gap-4">
          <section className="rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="bean-label text-[10px] text-[#8f8f8a]">CAPTION EDITOR ({cues.length} CUES)</h2>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={addCue}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#2a2a2a] bg-[#121212] px-3 text-[10px] font-bold uppercase tracking-wider text-white hover:border-[#3a3a3a]"
                >
                  <FilePlus2 className="h-3.5 w-3.5" /> ADD
                </button>
                <button
                  type="button"
                  disabled={!cues.length}
                  onClick={() => download("srt")}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#d4a017] px-3 text-[10px] font-extrabold uppercase tracking-wider text-[#0c0c0c] hover:bg-[#e9b52a] disabled:opacity-40"
                >
                  <Download className="h-3.5 w-3.5" /> EXPORT SRT
                </button>
                <button
                  type="button"
                  disabled={!cues.length}
                  onClick={() => download("vtt")}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#2e2410] bg-[#141007] px-3 text-[10px] font-extrabold uppercase tracking-wider text-[#d4a017] hover:bg-[#191307] disabled:opacity-40"
                >
                  <Download className="h-3.5 w-3.5" /> EXPORT VTT
                </button>
              </div>
            </div>

            <div className="relative mt-3">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#5c5c58]" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search caption text…"
                className="h-9 w-full rounded-md border border-[#2a2a2a] bg-[#121212] pl-9 pr-3 text-sm text-white placeholder:text-[#555] focus:border-[#d4a017] focus:outline-none"
              />
            </div>

            {error && (
              <p className="mt-3 rounded-md border border-[#3b1515] bg-[#1a0d0d] px-3 py-2 text-xs leading-relaxed text-[#f87171]">
                {error}
              </p>
            )}
            {status && (
              <p className="mt-3 rounded-md border border-[#1f2a1a] bg-[#0c120a] px-3 py-2 text-xs leading-relaxed text-[#86efac]">
                {status}
              </p>
            )}
            {warnings.length > 0 && (
              <div className="mt-3 rounded-md border border-[#3a2408] bg-[#141006] px-3 py-2">
                <p className="flex items-center gap-1.5 text-xs font-bold text-[#fdba74]">
                  <AlertTriangle className="h-3.5 w-3.5" /> VALIDATION WARNINGS
                </p>
                <ul className="mt-1.5 list-inside list-disc text-[11px] leading-relaxed text-[#fdba74]">
                  {warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            {cues.length === 0 ? (
              <p className="mt-3 rounded-lg border border-dashed border-[#242424] px-4 py-10 text-center text-xs leading-relaxed text-[#5c5c58]">
                No captions yet. Transcribe the selected media or import an SRT/VTT file.
              </p>
            ) : (
              <div className="bean-panel-scroll mt-3 max-h-[560px] space-y-2 overflow-y-auto pr-1">
                {filtered.map((cue) => (
                  <div
                    key={cue.id}
                    className={cn(
                      "rounded-lg border px-3.5 py-3 transition-colors",
                      selectedId === cue.id ? "border-[#d4a017] bg-[#151007]" : "border-[#1c1c1c] bg-[#111] hover:border-[#2a2a2a]"
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedId(cue.id);
                          seekTo(cue.start);
                        }}
                        className="rounded border border-[#2a2a2a] bg-[#0d0d0d] px-2 py-1 font-mono text-[10px] text-[#d4a017] hover:border-[#d4a017]"
                        title="Seek preview to cue start"
                      >
                        ▶ {formatDuration(cue.start)} → {formatDuration(cue.end)}
                      </button>
                      <div className="flex-1" />
                      <button
                        type="button"
                        onClick={() => splitCue(cue.id)}
                        className="inline-flex items-center gap-1 rounded border border-[#2a2a2a] px-2 py-1 text-[9px] font-bold text-[#9a9a94] hover:text-white"
                      >
                        <Scissors className="h-3 w-3" /> SPLIT
                      </button>
                      <button
                        type="button"
                        onClick={() => mergeCue(cue.id)}
                        className="inline-flex items-center gap-1 rounded border border-[#2a2a2a] px-2 py-1 text-[9px] font-bold text-[#9a9a94] hover:text-white"
                      >
                        <Merge className="h-3 w-3" /> MERGE NEXT
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteCue(cue.id)}
                        className="inline-flex items-center gap-1 rounded border border-[#2a2a2a] px-2 py-1 text-[9px] font-bold text-[#9a9a94] hover:border-[#ef4444] hover:text-[#f87171]"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                    <textarea
                      value={cue.text}
                      rows={2}
                      onChange={(e) => updateCue(cue.id, { text: e.target.value })}
                      className="mt-2 w-full resize-y rounded-md border border-[#242424] bg-[#0d0d0d] px-3 py-2 text-sm leading-relaxed text-white focus:border-[#d4a017] focus:outline-none"
                    />
                    <div className="mt-2 flex items-center gap-3 text-[10px] text-[#7a7a76]">
                      <label className="flex items-center gap-1.5">
                        START
                        <input
                          type="number"
                          value={Number(cue.start.toFixed(3))}
                          step={0.1}
                          min={0}
                          onChange={(e) => updateCue(cue.id, { start: Math.max(0, Number(e.target.value)) })}
                          className="h-6 w-20 rounded border border-[#2a2a2a] bg-[#111] px-1.5 font-mono text-[11px] text-white focus:border-[#d4a017] focus:outline-none"
                        />
                      </label>
                      <label className="flex items-center gap-1.5">
                        END
                        <input
                          type="number"
                          value={Number(cue.end.toFixed(3))}
                          step={0.1}
                          min={0}
                          onChange={(e) => updateCue(cue.id, { end: Number(e.target.value) })}
                          className="h-6 w-20 rounded border border-[#2a2a2a] bg-[#111] px-1.5 font-mono text-[11px] text-white focus:border-[#d4a017] focus:outline-none"
                        />
                      </label>
                      <span>{(cue.end - cue.start).toFixed(2)}s</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </ToolShell>
  );
}

// Re-export icon used in header imports to avoid unused warnings in some tooling.
export { Captions };
