"use client";

import type { MediaMeta, JobView, ExportView } from "@/lib/types";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      /* keep default */
    }
    throw new ApiError(message, res.status);
  }
  return res.json() as Promise<T>;
}

export const api = {
  me: () => fetch("/api/auth/me").then((r) => handle<{ user: { id: string; email: string; name: string | null } | null }>(r)),

  login: (email: string, password: string) =>
    fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    }).then(handle),

  register: (email: string, password: string, name?: string) =>
    fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, name }),
    }).then(handle),

  logout: () => fetch("/api/auth/logout", { method: "POST" }).then(handle),

  listMedia: () => fetch("/api/media").then((r) => handle<{ media: MediaMeta[] }>(r)),

  deleteMedia: (id: string) => fetch(`/api/media/${id}`, { method: "DELETE" }).then(handle),

  updateMedia: (id: string, data: { role?: string | null; notes?: string | null }) =>
    fetch(`/api/media/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }).then(handle),

  mediaUrl: (id: string) => `/api/media/${id}/file`,

  transcribe: (mediaId: string) =>
    fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mediaId }),
    })
      .then((r) =>
        handle<{
          text: string;
          provider: string;
          timingGranularity: "word" | "segment" | "none";
          warnings: string[];
        }>(r)
      ),

  riishe: (payload: unknown) =>
    fetch("/api/riishe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then((r) =>
      handle<{
        ok: boolean;
        model: string;
        suggestions: { id: string; action: "REMOVE" | "KEEP" | "REVIEW"; confidence: number; reason: string; riskNotes?: string | null }[];
        summary: string | null;
        candidatesClassified: number;
      }>(r)
    ),

  startAudio: (payload: unknown) =>
    fetch("/api/process/audio", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).then(
      (r) => handle<{ jobId: string }>(r)
    ),

  startAutocut: (payload: unknown) =>
    fetch("/api/process/autocut", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).then(
      (r) => handle<{ jobId: string; estimatedFinalSec: number }>(r)
    ),

  startWatermark: (payload: unknown) =>
    fetch("/api/process/watermark", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).then(
      (r) => handle<{ jobId: string; methodNote: string }>(r)
    ),

  startBurnCaptions: (payload: unknown) =>
    fetch("/api/process/burn-captions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).then(
      (r) => handle<{ jobId: string }>(r)
    ),

  job: (id: string) =>
    fetch(`/api/jobs/${id}`).then((r) =>
      handle<{ job: JobView }>(r)
    ),

  cancelJob: (id: string) => fetch(`/api/jobs/${id}`, { method: "DELETE" }).then(handle),

  exports: (kind?: string) =>
    fetch(`/api/exports${kind ? `?kind=${kind}` : ""}`).then((r) => handle<{ exports: ExportView[] }>(r)),

  deleteExport: (id: string) => fetch(`/api/exports?id=${id}`, { method: "DELETE" }).then(handle),

  exportUrl: (id: string) => `/api/exports/${id}/file`,

  projects: () => fetch("/api/projects").then((r) => handle<{ projects: { id: string; name: string; description: string | null; mediaCount: number; createdAt: string; updatedAt: string }[] }>(r)),

  createProject: (name: string, description?: string) =>
    fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, description }) }).then(handle),
};

/** Client-side hard cap matching the server's MAX_UPLOAD_BYTES (250 MB). */
export const MAX_CLIENT_UPLOAD_BYTES = 250 * 1024 * 1024;

/** Files up to this size go out as one request; larger files are chunked. */
const SINGLE_SHOT_LIMIT = 5 * 1024 * 1024;
const START_CHUNK_BYTES = 5 * 1024 * 1024;
/** Floor for the adaptive shrink: survives any gateway that accepts ~256 KB bodies. */
const MIN_CHUNK_BYTES = 256 * 1024;

type UploadOpts = { role?: "BROLL"; notes?: string; onProgress?: (pct: number) => void; signal?: AbortSignal };

type RawUploadResult = { status: number; ok: boolean; text: string };

/**
 * One XHR request with real upload progress. Resolves with status + raw body
 * so callers can tell an app JSON error apart from an infrastructure rejection.
 */
function xhrUpload(
  blob: Blob,
  headers: Record<string, string>,
  onProgress: (pct: number) => void,
  signal?: AbortSignal
): Promise<RawUploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/media");
    for (const [name, value] of Object.entries(headers)) {
      try { xhr.setRequestHeader(name, value); } catch { /* header rejected — skip optional ones */ }
    }
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => resolve({ status: xhr.status, ok: xhr.status >= 200 && xhr.status < 300, text: xhr.responseText });
    xhr.onerror = () => reject(new ApiError("Network error during upload.", 0));
    xhr.onabort = () => reject(new ApiError("Upload cancelled.", 0));
    signal?.addEventListener("abort", () => xhr.abort());
    xhr.send(blob);
  });
}

/** Filename header: ISO-8859-1 wire format — percent-encode, server decodes. */
function filenameHeader(file: File): string {
  try {
    return encodeURIComponent(file.name);
  } catch {
    return "upload" + (file.name.match(/\.[a-z0-9]+/i)?.[0] ?? "");
  }
}

/** Turn a raw non-2xx response into the error the UI shows. */
function interpretFailure(res: RawUploadResult): ApiError {
  let err: ApiError;
  try {
    const data = JSON.parse(res.text);
    err = new ApiError(String(data?.error ?? `Upload failed (${res.status})`), res.status);
  } catch {
    // not JSON — likely a gateway/proxy layer, include the body excerpt
    const snippet = res.text.trim().slice(0, 140);
    err = new ApiError(`Upload failed (${res.status})${snippet ? `: ${snippet}` : ""}`, res.status);
  }
  (err as ApiError & { raw?: RawUploadResult }).raw = res;
  return err;
}

/**
 * True when a chunk failure looks like an infrastructure body rejection rather
 * than a deterministic app error (the app always answers with JSON `error`),
 * so retrying with a smaller chunk size can actually get through.
 */
function isShrinkableFailure(res: RawUploadResult): boolean {
  if (res.status === 0 || res.status === 413) return true;
  if (res.status !== 400) return false;
  try {
    return !JSON.parse(res.text)?.error;
  } catch {
    return true;
  }
}

function newUploadId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Single-request upload — the original behavior for small files. */
async function uploadSingleShot(file: File, opts: UploadOpts): Promise<{ media: MediaMeta }> {
  const headers: Record<string, string> = { "x-filename": filenameHeader(file) };
  if (opts.role) headers["x-role"] = opts.role;
  if (opts.notes) headers["x-notes"] = encodeURIComponent(opts.notes);
  const res = await xhrUpload(file, headers, (f) => opts.onProgress?.(Math.round(f * 100)), opts.signal);
  if (!res.ok) throw interpretFailure(res);
  return JSON.parse(res.text) as { media: MediaMeta };
}

/** Sequential chunk upload; the server assembles and validates on the last chunk. */
async function uploadChunked(file: File, opts: UploadOpts, chunkSize: number): Promise<{ media: MediaMeta }> {
  const uploadId = newUploadId();
  const chunkTotal = Math.ceil(file.size / chunkSize);
  let uploadedBytes = 0;
  let finalRes: RawUploadResult | null = null;

  for (let index = 0; index < chunkTotal; index++) {
    if (opts.signal?.aborted) throw new ApiError("Upload cancelled.", 0);
    const start = index * chunkSize;
    const blob = file.slice(start, Math.min(start + chunkSize, file.size));
    const headers: Record<string, string> = {
      "x-filename": filenameHeader(file),
      "x-upload-id": uploadId,
      "x-chunk-index": String(index),
      "x-chunk-total": String(chunkTotal),
      "x-upload-size": String(file.size),
      "Content-Type": "application/octet-stream",
    };
    if (opts.role) headers["x-role"] = opts.role;
    if (opts.notes) headers["x-notes"] = encodeURIComponent(opts.notes);

    const res = await xhrUpload(
      blob,
      headers,
      (f) => opts.onProgress?.(Math.round(((uploadedBytes + blob.size * f) / file.size) * 100)),
      opts.signal
    );
    if (!res.ok) throw interpretFailure(res);
    uploadedBytes += blob.size;
    finalRes = res;
  }
  // The final chunk's response carries the completed media record.
  return JSON.parse(finalRes!.text) as { media: MediaMeta };
}

/** XHR upload with REAL progress events (fetch cannot report upload progress).
 *  Large files are split into sequential chunks so no single request body has
 *  to cross a restrictive preview gateway; if a gateway still rejects a body,
 *  the chunk size is halved and the upload restarts (down to 256 KB).
 *  A 401 is verified against /api/auth/me first: if the session is genuinely
 *  gone the auth error surfaces as-is; if the session is still valid (e.g. a
 *  transient server hiccup answered 401) the upload is retried exactly once. */
export async function uploadMedia(file: File, opts: UploadOpts): Promise<{ media: MediaMeta }> {
  try {
    return await uploadMediaOnce(file, opts);
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401 || opts.signal?.aborted) throw err;
    const stillAuthed = await fetch("/api/auth/me")
      .then((r) => r.json())
      .then((res) => Boolean(res?.user))
      .catch(() => false);
    if (!stillAuthed) throw err;
    return uploadMediaOnce(file, opts);
  }
}

async function uploadMediaOnce(file: File, opts: UploadOpts): Promise<{ media: MediaMeta }> {
  if (file.size <= SINGLE_SHOT_LIMIT) return uploadSingleShot(file, opts);

  let chunkSize = START_CHUNK_BYTES;
  for (;;) {
    try {
      return await uploadChunked(file, opts, chunkSize);
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      const raw = (err as ApiError & { raw?: RawUploadResult }).raw;
      // Status 0 = the request died at the network/infrastructure level —
      // a smaller body may get through, so treat it like a shrinkable rejection.
      const shrinkable = raw ? isShrinkableFailure(raw) : err instanceof ApiError && err.status === 0;
      if (shrinkable && chunkSize > MIN_CHUNK_BYTES) {
        chunkSize = Math.max(MIN_CHUNK_BYTES, Math.floor(chunkSize / 2));
        continue;
      }
      throw err;
    }
  }
}
