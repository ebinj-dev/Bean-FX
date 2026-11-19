import { execFile } from "child_process";
import { createHash } from "crypto";
import { createReadStream, promises as fs } from "fs";
import path from "path";
import { db } from "@/lib/db";

/**
 * Storage root (§4): every media file lives under one configurable root.
 * BEANFX_DATA_DIR overrides the default; relative values resolve against the
 * project directory. Empty-after-trim and filesystem-root values are refused
 * with a clear error (the startup validation surfaces it loudly).
 */
function resolveDataDir(): string {
  const raw = process.env.BEANFX_DATA_DIR;
  if (raw === undefined) return "/home/z/my-project/media-store";
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("BEANFX_DATA_DIR is set but empty — set it to an absolute directory path.");
  }
  const resolved = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(process.cwd(), trimmed);
  if (resolved === path.parse(resolved).root) {
    throw new Error("BEANFX_DATA_DIR must be a dedicated subdirectory, not a filesystem root.");
  }
  return resolved;
}

export const MEDIA_ROOT = resolveDataDir();
export const MAX_UPLOAD_BYTES = 250 * 1024 * 1024; // 250 MB per file (declared limit)
/** Resumable chunked uploads may go beyond the single-shot cap (M3). */
export const MAX_CHUNKED_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
/** Per-user storage quota (originals + proxies + exports). Env-overridable for tests. */
export const USER_QUOTA_BYTES = Number(process.env.BEANFX_USER_QUOTA_BYTES ?? 5 * 1024 * 1024 * 1024);
export const PROXIES_DIR = path.join(MEDIA_ROOT, "proxies");

/** True when `candidate` resolves strictly inside MEDIA_ROOT (symlink-aware). */
export function isInsideMediaRoot(candidate: string): boolean {
  const resolved = path.resolve(candidate);
  return resolved === MEDIA_ROOT || resolved.startsWith(MEDIA_ROOT + path.sep);
}

/**
 * Resolve a server-generated relative path against the storage root,
 * refusing anything that escapes it (defense in depth — the ids feeding
 * these paths are already regex-validated).
 */
export function pathInsideMediaRoot(...segments: string[]): string {
  const joined = path.join(MEDIA_ROOT, ...segments);
  if (!isInsideMediaRoot(joined)) {
    throw new Error(`refusing path outside the storage root: ${segments.join("/")}`);
  }
  return joined;
}

/**
 * Verify the storage root is real and writable: creates it if needed, then
 * round-trips a probe file. A symlinked root is allowed (deliberate volume
 * mounts) — the probe confirms bytes actually land somewhere writable.
 */
export async function validateStorageRoot(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await fs.mkdir(path.join(MEDIA_ROOT, "originals"), { recursive: true });
    const probe = pathInsideMediaRoot(".write-probe");
    await fs.writeFile(probe, "ok");
    await fs.rm(probe, { force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function ensureMediaRoot() {
  await fs.mkdir(path.join(MEDIA_ROOT, "originals"), { recursive: true });
  await fs.mkdir(path.join(MEDIA_ROOT, "exports"), { recursive: true });
  await fs.mkdir(path.join(MEDIA_ROOT, "tmp"), { recursive: true });
  await fs.mkdir(PROXIES_DIR, { recursive: true });
}

export function safeExt(name: string): string {
  const ext = path.extname(name).toLowerCase().replace(/[^a-z0-9.]/g, "");
  return ext && ext.length <= 6 ? ext : "";
}

const ALLOWED_AUDIO_EXT = [".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".oga", ".webm", ".mp4", ".mov", ".aif", ".aiff"];
const ALLOWED_VIDEO_EXT = [".mp4", ".mov", ".webm", ".mkv", ".m4v"];
const ALLOWED_SUBTITLE_EXT = [".srt"];
const ALLOWED_IMAGE_EXT = [".jpg", ".jpeg", ".png", ".webp"];

export type MediaKind = "AUDIO" | "VIDEO" | "SUBTITLE" | "IMAGE" | "UNSUPPORTED";

export function classifyByExtension(ext: string): MediaKind {
  if (ALLOWED_VIDEO_EXT.includes(ext)) return "VIDEO";
  if (ALLOWED_AUDIO_EXT.includes(ext)) return "AUDIO";
  if (ALLOWED_IMAGE_EXT.includes(ext)) return "IMAGE";
  if (ALLOWED_SUBTITLE_EXT.includes(ext)) return "SUBTITLE";
  return "UNSUPPORTED";
}

export interface FfprobeResult {
  durationSec: number | null;
  width: number | null;
  height: number | null
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  sampleRate: number | null;
  channels: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  sample_rate?: string;
  channels?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
}

interface FfprobeJson {
  streams?: FfprobeStream[];
  format?: { duration?: string };
}

function parseFps(rate: string | undefined): number | null {
  if (!rate) return null;
  const [num, den] = rate.split("/").map(Number);
  if (!num || !den) return null;
  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 && fps < 1000 ? Math.round(fps * 1000) / 1000 : null;
}

/** Inspect real media with ffprobe. Never trust client metadata. */
export function ffprobe(filePath: string): Promise<FfprobeResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffprobe",
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath],
      { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new Error(`Media inspection failed: ${err.message}`));
        let data: FfprobeJson;
        try {
          data = JSON.parse(stdout);
        } catch {
          return reject(new Error("Media inspection returned invalid data."));
        }
        const streams = data.streams ?? [];
        const video = streams.find((s) => s.codec_type === "video");
        const audio = streams.find((s) => s.codec_type === "audio");
        const durationStr = data.format?.duration ?? audio?.duration ?? video?.duration;
        const durationSec = durationStr ? Number(durationStr) : null;
        resolve({
          durationSec: durationSec && Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null,
          width: video?.width ?? null,
          height: video?.height ?? null,
          fps: parseFps(video?.avg_frame_rate ?? video?.r_frame_rate),
          videoCodec: video?.codec_name ?? null,
          audioCodec: audio?.codec_name ?? null,
          sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
          channels: audio?.channels ?? null,
          hasVideo: Boolean(video),
          hasAudio: Boolean(audio),
        });
      }
    );
  });
}

export async function getFreeDiskBytes(): Promise<number> {
  const stats = await fs.statfs(MEDIA_ROOT);
  return stats.bavail * stats.bsize;
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Delete a file best-effort (used for cleanup after failure/cancel). */
export async function removeFileQuiet(p: string) {
  await fs.unlink(p).catch(() => undefined);
}

export function exportFileName(base: string, format: string): string {
  const stem = base.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 60) || "export";
  return `${stem}_${Date.now()}.${format}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// M3 media pipeline primitives (additive — nothing above changed behavior).
// ─────────────────────────────────────────────────────────────────────────────

export interface SniffResult {
  /** Container family detected from magic bytes ("unknown" when unrecognized). */
  family: string;
  /** Best-effort MIME type for the container, or null when unknown. */
  mime: string | null;
}

/**
 * Identify the container from the file's leading bytes — the client's declared
 * type is never trusted. Reads only what it is given (first 32 bytes suffice).
 */
export function sniffContainer(head: Buffer): SniffResult {
  if (head.length >= 12 && head.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = head.subarray(8, 12).toString("latin1");
    return { family: "ftyp", mime: brand === "qt  " ? "video/quicktime" : "video/mp4" };
  }
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return { family: "matroska", mime: "video/webm" };
  }
  if (head.length >= 4 && head.subarray(0, 4).toString("latin1") === "OggS") {
    return { family: "ogg", mime: "audio/ogg" };
  }
  if (head.length >= 12 && head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WAVE") {
    return { family: "wav", mime: "audio/wav" };
  }
  if (head.length >= 4 && head.subarray(0, 4).toString("latin1") === "fLaC") {
    return { family: "flac", mime: "audio/flac" };
  }
  if (head.length >= 3 && head.subarray(0, 3).toString("latin1") === "ID3") {
    return { family: "mp3", mime: "audio/mpeg" };
  }
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) {
    // MPEG audio frame sync (bare MP3) or ADTS AAC (0xFFF1/0xFFF9 syncword).
    return { family: head[1] === 0xf1 || head[1] === 0xf9 ? "aac-adts" : "mp3", mime: head[1] === 0xf1 || head[1] === 0xf9 ? "audio/aac" : "audio/mpeg" };
  }
  if (head.length >= 12 && head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") {
    return { family: "webp", mime: "image/webp" };
  }
  if (head.length >= 4 && head[0] === 0x89 && head.subarray(1, 4).toString("latin1") === "PNG") {
    return { family: "png", mime: "image/png" };
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return { family: "jpeg", mime: "image/jpeg" };
  }
  return { family: "unknown", mime: null };
}

/** Container families an upload may claim, by extension class. */
const MAGIC_FAMILIES_BY_CLASS: Record<"AUDIO" | "VIDEO" | "IMAGE", Set<string>> = {
  VIDEO: new Set(["ftyp", "matroska"]),
  AUDIO: new Set(["ftyp", "matroska", "ogg", "wav", "flac", "mp3", "aac-adts"]),
  IMAGE: new Set(["png", "jpeg", "webp"]),
};

/** True when the sniffed container is plausible for the declared class. */
export function sniffMatchesClass(sniff: SniffResult, kind: "AUDIO" | "VIDEO" | "IMAGE"): boolean {
  const families = MAGIC_FAMILIES_BY_CLASS[kind];
  return families.has(sniff.family);
}

/** Streamed sha256 of a file (hex) — used for dedup and integrity. */
export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: Buffer) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export interface QuotaStatus {
  usedBytes: number;
  quotaBytes: number;
  remainingBytes: number;
}

/** Current storage usage for one user: originals + proxies + exports. */
export async function computeUserUsage(userId: string): Promise<QuotaStatus> {
  const [mediaSum, proxySum, exportSum] = await Promise.all([
    db.mediaAsset.aggregate({ _sum: { sizeBytes: true }, where: { userId } }),
    db.mediaAsset.aggregate({ _sum: { proxySizeBytes: true }, where: { userId } }),
    db.exportFile.aggregate({ _sum: { sizeBytes: true }, where: { userId } }),
  ]);
  const usedBytes = (mediaSum._sum.sizeBytes ?? 0) + (proxySum._sum.proxySizeBytes ?? 0) + (exportSum._sum.sizeBytes ?? 0);
  const quotaBytes = USER_QUOTA_BYTES;
  return { usedBytes, quotaBytes, remainingBytes: Math.max(0, quotaBytes - usedBytes) };
}

/** True when `incomingBytes` more bytes would still fit the user's quota. */
export async function hasQuotaFor(userId: string, incomingBytes: number): Promise<QuotaStatus & { ok: boolean }> {
  const status = await computeUserUsage(userId);
  return { ...status, ok: status.usedBytes + incomingBytes <= status.quotaBytes };
}

/** Round to an even integer — H.264 requires even dimensions. */
export function evenDim(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/**
 * Delete a media file only when no other MediaAsset row references the same
 * content-addressed path (dedup makes several rows share one file).
 */
export async function deleteMediaFileIfLastReference(storagePath: string, deletedAssetId: string): Promise<boolean> {
  const others = await db.mediaAsset.count({ where: { storagePath, id: { not: deletedAssetId } } });
  if (others > 0) return false;
  await removeFileQuiet(storagePath);
  return true;
}


// ── M28 — disk-space guard ──────────────────────────────────────────────────
// Transcodes and renders reserve transient space (proxies ≈ source bitrate ×
// duration; a 1080p render window can reserve several hundred MB). Starting a
// job when the disk is nearly full corrupts outputs silently — refuse instead,
// with an actionable message.

/** Minimum free bytes required before starting a big transcode/render. */
export const MIN_FREE_DISK_BYTES = 512 * 1024 * 1024; // 512 MiB

/** Pure helper (unit-tested): is `free` enough for a job needing `need`? */
export function hasEnoughDisk(freeBytes: number, needBytes: number = 0, minFree: number = MIN_FREE_DISK_BYTES): boolean {
  return freeBytes >= Math.max(minFree, needBytes);
}

/** statvfs -style free bytes of the filesystem holding `dir` (≤0 on failure). */
export async function freeDiskBytes(dir: string): Promise<number> {
  try {
    const st = await (await import("fs")).promises.statfs(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return -1; // unknown — callers decide whether to proceed (fail-open)
  }
}

/**
 * Guard a job about to write into `dir`. Throws PermanentJobError when free
 * space is below the floor; unknown capacity fails OPEN (probes/storages on
 * exotic mounts must not brick the pipeline) — logged, not hidden.
 */
export async function assertDiskSpace(dir: string, needBytes: number = 0, minFree: number = MIN_FREE_DISK_BYTES): Promise<void> {
  const { PermanentJobError } = await import("@/lib/job-helpers");
  const free = await freeDiskBytes(dir);
  if (free < 0) return; // unknown capacity — fail open
  if (!hasEnoughDisk(free, needBytes, minFree)) {
    throw new PermanentJobError(
      `Not enough disk space to run this job: ${(free / 1024 / 1024).toFixed(0)} MiB free on the media volume, ${(minFree / 1024 / 1024).toFixed(0)} MiB required. Free space (delete old exports or uploads) and retry — originals are untouched.`
    );
  }
}
