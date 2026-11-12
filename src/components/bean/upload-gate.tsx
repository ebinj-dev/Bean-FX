"use client";

/**
 * BEAN FX — dedicated per-tool media import page (shared).
 *
 * Classic flow (tools without `oneStep`): select + validate + upload →
 * Continue → tool editor.
 *
 * One-step flow (Auto Cut): selecting or dropping a file starts the upload
 * immediately, shows real progress, runs the existing server-side FFprobe
 * validation, and navigates straight into the editor on success — no UPLOAD
 * button, no intermediate success page, no CONTINUE step. Cancellation,
 * retry, replacement and duplicate protection are handled inline.
 */

import { useCallback, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, CheckCircle2, FileAudio, FileVideo, Loader2, RefreshCw, TriangleAlert, UploadCloud, X } from "lucide-react";
import { api, uploadMedia, MAX_CLIENT_UPLOAD_BYTES } from "@/lib/client-api";
import type { MediaMeta } from "@/lib/types";
import { ToolShell } from "@/components/bean/tool-shell";

export interface ToolUploadSpec {
  key: string; // "autocut" | "captions" | ...
  label: string;
  title: string;
  description: string;
  /** Extensions this tool actually accepts, lowercase with dot. */
  extensions: string[];
  /** Human list shown in the UI (must match the server-accepted set). */
  formatsLabel: string;
  /** What kind of stream the tool needs. */
  streamNote: string;
  /** One-step flow: upload starts on file selection and navigates to the
   *  editor automatically after server validation. */
  oneStep?: boolean;
}

export const MAX_UPLOAD_MB = Math.floor(MAX_CLIENT_UPLOAD_BYTES / 1024 / 1024);

export function mediaRefKey(toolKey: string) {
  return `beanfx.toolMedia.${toolKey}`;
}

export function readMediaRef(toolKey: string): MediaMeta | null {
  try {
    const raw = sessionStorage.getItem(mediaRefKey(toolKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { media: MediaMeta; at: number };
    return parsed?.media?.id ? parsed.media : null;
  } catch {
    return null;
  }
}

export function writeMediaRef(toolKey: string, media: MediaMeta) {
  sessionStorage.setItem(mediaRefKey(toolKey), JSON.stringify({ media, at: Date.now() }));
}

export function clearMediaRef(toolKey: string) {
  sessionStorage.removeItem(mediaRefKey(toolKey));
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const FRIENDLY_STATUS: Record<number, string> = {
  401: "Authentication expired. Please sign in again.",
  413: `File exceeds the ${MAX_UPLOAD_MB} MB limit.`,
  507: "Insufficient server storage.",
};

type UploadPhase = "idle" | "uploading" | "validating";

export function UploadGate({ user, onLogout, spec }: { user: import("@/lib/types").SessionUser; onLogout: () => void; spec: ToolUploadSpec }) {
  const [file, setFile] = useState<File | null>(null);
  const [media, setMedia] = useState<MediaMeta | null>(() => readMediaRef(spec.key));
  const [phase, setPhase] = useState<UploadPhase>("idle");
  const [pct, setPct] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  // Session-storage ref read at mount — replacement must not hide the dropzone.
  const [existingMedia, setExistingMedia] = useState<MediaMeta | null>(() => readMediaRef(spec.key));

  const uploading = phase !== "idle";

  /** Upload the given file with progress, then (one-step) navigate into the
   *  editor. The server validates with FFprobe inside the upload request, so
   *  the response is already a validated media record or a concrete error. */
  const uploadFile = useCallback(
    async (f: File) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setError(null);
      setNotice(null);
      setPct(0);
      setPhase("uploading");
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await uploadMedia(f, {
          onProgress: (p) => {
            setPct(p);
            if (p >= 100) setPhase("validating");
          },
          signal: controller.signal,
        });
        setMedia(res.media);
        setExistingMedia(res.media);
        writeMediaRef(spec.key, res.media);
        setPhase("idle");
        setPct(0);
        if (spec.oneStep) {
          // One-step: straight into the editor — no success page, no CONTINUE.
          window.location.hash = `#/${spec.key}/editor`;
        }
      } catch (err) {
        setPhase("idle");
        setPct(0);
        const status = (err as { status?: number }).status ?? 0;
        const msg = err instanceof Error ? err.message : "Upload failed.";
        setError(FRIENDLY_STATUS[status] ?? msg);
        setMedia(null);
        clearMediaRef(spec.key);
      } finally {
        abortRef.current = null;
        busyRef.current = false;
      }
    },
    [spec.key, spec.oneStep]
  );

  /** File selected via browse or drop: validate locally, guard duplicates,
   *  then (one-step) upload immediately. */
  const pick = useCallback(
    (f: File | null | undefined) => {
      if (!f) return;
      setError(null);
      setNotice(null);
      const ext = ("." + (f.name.split(".").pop() ?? "").toLowerCase()).replace(/[^.a-z0-9]/g, "");
      if (!spec.extensions.includes(ext)) {
        setError(`Unsupported media format "${ext || f.name}". Supported: ${spec.formatsLabel}.`);
        return;
      }
      if (f.size > MAX_CLIENT_UPLOAD_BYTES) {
        setError(`File exceeds the ${MAX_UPLOAD_MB} MB limit (${formatBytes(f.size)}).`);
        return;
      }
      if (f.size === 0) {
        setError("This file is empty (0 bytes).");
        return;
      }
      setFile(f);
      setMedia(null);
      clearMediaRef(spec.key);
      if (!spec.oneStep) return;

      // Duplicate upload protection: the same file (name + exact size) that is
      // already in this user's library is reused instead of uploaded again.
      void (async () => {
        try {
          const list = await api.listMedia();
          const twin = (list.media ?? []).find((m) => m.originalName === f.name && m.sizeBytes === f.size);
          if (twin) {
            setMedia(twin);
            setExistingMedia(twin);
            writeMediaRef(spec.key, twin);
            setNotice(`"${f.name}" is already in your library (same name and size) — reusing the existing validated copy instead of uploading it again.`);
            window.location.hash = `#/${spec.key}/editor`;
            return;
          }
        } catch {
          /* list unavailable — fall through to a normal upload */
        }
        void uploadFile(f);
      })();
    },
    [spec, uploadFile]
  );

  const cancelUpload = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const clearFile = useCallback(() => {
    setFile(null);
    setError(null);
    setNotice(null);
    setPct(0);
    setPhase("idle");
  }, []);

  const isVideo = /\.(mp4|mov|webm|mkv|m4v)$/i.test(file?.name ?? "");

  return (
    <ToolShell user={user} onLogout={onLogout} route={`/${spec.key}`} label={spec.label} title={spec.title} description={spec.description}>
      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-5">
          {spec.oneStep && existingMedia && !uploading && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#26402a] bg-[#0e170f] px-3.5 py-2.5">
              <p className="flex items-center gap-2 text-[12px] text-[#8fd694]">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                Current: <span className="font-semibold text-white">{existingMedia.originalName}</span>
                <span className="text-[#7a7a76]">
                  {existingMedia.kind} · {formatBytes(existingMedia.sizeBytes)}
                </span>
              </p>
              <a href={`#/${spec.key}/editor`} className="text-[10px] font-extrabold uppercase tracking-wider text-[#d4a017] hover:text-white">
                Open editor →
              </a>
            </div>
          )}

          {(!media || spec.oneStep) && (
            <div
              role="button"
              tabIndex={0}
              aria-label="Upload area — drop a file or press Enter to browse"
              onClick={() => !uploading && inputRef.current?.click()}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); inputRef.current?.click(); } }}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); if (!uploading) pick(e.dataTransfer.files?.[0]); }}
              className={`flex min-h-[300px] cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors focus-visible:outline-none focus-visible:border-[#d4a017] ${dragOver ? "border-[#d4a017] bg-[#141109]" : "border-[#2a2a2a] hover:border-[#d4a017]/50"}`}
            >
              {uploading ? (
                <>
                  <Loader2 className="h-10 w-10 animate-spin text-[#d4a017]" />
                  <p className="mt-4 text-sm font-semibold text-white">
                    {phase === "validating" ? "Validating media with FFprobe…" : `Uploading… ${pct}%`}
                  </p>
                  <div className="mt-3 h-1.5 w-64 overflow-hidden rounded-full bg-[#1c1c1c]">
                    <div className="h-full rounded-full bg-[#d4a017] transition-all" style={{ width: `${pct}%` }} />
                  </div>
                  <p className="mt-2 text-[11px] text-[#7a7a76]">{file?.name} — the editor opens automatically once validation passes</p>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      cancelUpload();
                    }}
                    className="mt-3 inline-flex h-8 items-center rounded-md border border-[#3b1515] bg-[#1a0d0d] px-3 text-[10px] font-extrabold uppercase tracking-wider text-[#f87171] hover:bg-[#2a1212]"
                  >
                    <X className="mr-1 h-3.5 w-3.5" /> Cancel upload
                  </button>
                </>
              ) : (
                <>
                  <UploadCloud className="h-10 w-10 text-[#d4a017]" />
                  <p className="mt-4 text-sm font-semibold text-white">
                    {spec.oneStep && file ? "Drop or browse to replace the file" : "Drag & drop your media here"}
                  </p>
                  <p className="mt-1 text-[12px] text-[#8f8f8a]">
                    {spec.oneStep ? "or — the upload starts immediately" : "or"}
                  </p>
                  <span className="mt-3 inline-flex h-9 items-center rounded-md bg-[#d4a017] px-4 text-[10px] font-extrabold uppercase tracking-wider text-[#0c0c0c] hover:bg-[#e9b52a]">
                    Browse Files
                  </span>
                  <p className="mt-4 text-[11px] leading-relaxed text-[#5c5c58]">{spec.formatsLabel} — up to {MAX_UPLOAD_MB} MB. Validated server-side with FFprobe.</p>
                </>
              )}
              <input
                ref={inputRef}
                type="file"
                accept={spec.extensions.join(",")}
                className="hidden"
                onChange={(e) => pick(e.target.files?.[0])}
              />
            </div>
          )}

          {error && (
            <div className="mt-6 flex items-start justify-between gap-3 rounded-md border border-[#3b1515] bg-[#1a0d0d] px-3 py-2.5">
              <p className="flex items-start gap-2 text-xs leading-relaxed text-[#f87171]"><TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error}</p>
              <button type="button" aria-label="Dismiss error" onClick={() => setError(null)}><X className="h-3.5 w-3.5 text-[#7a7a76]" /></button>
            </div>
          )}
          {notice && (
            <div className="mt-4 flex items-start justify-between gap-3 rounded-md border border-[#241f10] bg-[#141109] px-3 py-2.5">
              <p className="flex items-start gap-2 text-xs leading-relaxed text-[#d4a017]"><CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />{notice}</p>
              <button type="button" aria-label="Dismiss notice" onClick={() => setNotice(null)}><X className="h-3.5 w-3.5 text-[#7a7a76]" /></button>
            </div>
          )}

          {/* Two-step tools keep the explicit Upload action. One-step tools
              upload immediately on selection, so this card never blocks them. */}
          {file && !media && phase === "idle" && !spec.oneStep && (
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#1c1c1c] bg-[#111] px-4 py-3">
              <div className="flex items-center gap-3">
                {isVideo ? <FileVideo className="h-5 w-5 text-[#d4a017]" /> : <FileAudio className="h-5 w-5 text-[#d4a017]" />}
                <div>
                  <p className="text-[13px] font-semibold text-white">{file.name}</p>
                  <p className="text-[11px] text-[#7a7a76]">{formatBytes(file.size)} — ready to upload</p>
                </div>
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={clearFile} className="inline-flex h-8 items-center rounded-md border border-[#2a2a2a] px-3 text-[10px] font-extrabold uppercase tracking-wider text-[#9a9a94] hover:text-white">
                  Clear
                </button>
                <button type="button" onClick={() => void uploadFile(file)} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#d4a017] px-3.5 text-[10px] font-extrabold uppercase tracking-wider text-[#0c0c0c] hover:bg-[#e9b52a]">
                  <UploadCloud className="h-3.5 w-3.5" /> Upload
                </button>
              </div>
            </div>
          )}

          {/* Failure / cancellation recovery (one-step): retry the same file
              or pick a different one. */}
          {spec.oneStep && file && phase === "idle" && error && (
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#1c1c1c] bg-[#111] px-4 py-3">
              <div className="flex items-center gap-3">
                {isVideo ? <FileVideo className="h-5 w-5 text-[#d4a017]" /> : <FileAudio className="h-5 w-5 text-[#d4a017]" />}
                <div>
                  <p className="text-[13px] font-semibold text-white">{file.name}</p>
                  <p className="text-[11px] text-[#7a7a76]">{formatBytes(file.size)} — not uploaded</p>
                </div>
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={clearFile} className="inline-flex h-8 items-center rounded-md border border-[#2a2a2a] px-3 text-[10px] font-extrabold uppercase tracking-wider text-[#9a9a94] hover:text-white">
                  Choose a different file
                </button>
                <button type="button" onClick={() => void uploadFile(file)} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#d4a017] px-3.5 text-[10px] font-extrabold uppercase tracking-wider text-[#0c0c0c] hover:bg-[#e9b52a]">
                  <RefreshCw className="h-3.5 w-3.5" /> Retry upload
                </button>
              </div>
            </div>
          )}

          {/* Success card — two-step tools only; one-step navigates straight
              into the editor so no intermediate page is shown. */}
          {media && !spec.oneStep && (
            <div className="rounded-lg border border-[#26402a] bg-[#0e170f] px-4 py-3">
              <p className="flex items-center gap-2 text-[12px] font-semibold text-[#8fd694]"><CheckCircle2 className="h-4 w-4" /> Uploaded and validated by the server</p>
              <p className="mt-1 text-[13px] font-semibold text-white">{media.originalName}</p>
              <p className="text-[11px] text-[#7a7a76]">
                {media.kind} · {formatBytes(media.sizeBytes)}{media.durationSec ? ` · ${media.durationSec.toFixed(1)}s` : ""}
                {media.videoCodec ? ` · video: ${media.videoCodec}` : ""}{media.audioCodec ? ` · audio: ${media.audioCodec}` : ""}
                {media.sampleRate ? ` · ${Math.round(media.sampleRate / 1000)} kHz` : ""}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <a href={`#/${spec.key}/editor`} className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[#d4a017] px-4 text-[10px] font-extrabold uppercase tracking-wider text-[#0c0c0c] hover:bg-[#e9b52a]">
                  Continue to {spec.label} <ArrowRight className="h-3.5 w-3.5" />
                </a>
                <button type="button" onClick={() => { setMedia(null); setFile(null); clearMediaRef(spec.key); }} className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[#2a2a2a] px-3 text-[10px] font-extrabold uppercase tracking-wider text-[#9a9a94] hover:text-white">
                  <RefreshCw className="h-3.5 w-3.5" /> Upload different file
                </button>
              </div>
            </div>
          )}
        </div>

        <aside className="flex flex-col gap-4">
          <section className="rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
            <h2 className="bean-label text-[10px] text-[#8f8f8a]">SUPPORTED FORMATS</h2>
            <p className="mt-2 text-[12px] leading-relaxed text-[#9a9a94]">{spec.formatsLabel}</p>
            <p className="mt-2 text-[11px] leading-relaxed text-[#5c5c58]">{spec.streamNote}</p>
            <p className="mt-2 text-[11px] text-[#5c5c58]">Maximum file size: {MAX_UPLOAD_MB} MB. Files are validated with FFprobe after upload — extension and browser type alone are never trusted.</p>
            {spec.oneStep && (
              <p className="mt-2 text-[11px] leading-relaxed text-[#5c5c58]">
                One-step import: choosing a file starts the upload immediately and opens the editor as soon as the server
                has validated it. Analysis never starts before validation completes.
              </p>
            )}
          </section>
          <a href="#/studio" className="inline-flex h-9 items-center gap-1.5 self-start rounded-md border border-[#2a2a2a] px-3.5 text-[10px] font-extrabold uppercase tracking-wider text-[#9a9a94] hover:border-[#d4a017]/50 hover:text-white">
            <ArrowLeft className="h-3.5 w-3.5" /> Back to Studio
          </a>
        </aside>
      </div>
    </ToolShell>
  );
}
