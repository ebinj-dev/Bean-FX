import { execFile } from "child_process";
import { promises as fs } from "fs";
import path from "path";

export const MEDIA_ROOT = "/home/z/my-project/media-store";
export const MAX_UPLOAD_BYTES = 250 * 1024 * 1024; // 250 MB per file (declared limit)

export async function ensureMediaRoot() {
  await fs.mkdir(path.join(MEDIA_ROOT, "originals"), { recursive: true });
  await fs.mkdir(path.join(MEDIA_ROOT, "exports"), { recursive: true });
  await fs.mkdir(path.join(MEDIA_ROOT, "tmp"), { recursive: true });
}

export function safeExt(name: string): string {
  const ext = path.extname(name).toLowerCase().replace(/[^a-z0-9.]/g, "");
  return ext && ext.length <= 6 ? ext : "";
}

const ALLOWED_AUDIO_EXT = [".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".oga", ".webm", ".mp4", ".mov", ".aif", ".aiff"];
const ALLOWED_VIDEO_EXT = [".mp4", ".mov", ".webm", ".mkv", ".m4v"];
const ALLOWED_SUBTITLE_EXT = [".srt"];

export type MediaKind = "AUDIO" | "VIDEO" | "SUBTITLE" | "UNSUPPORTED";

export function classifyByExtension(ext: string): MediaKind {
  if (ALLOWED_VIDEO_EXT.includes(ext)) return "VIDEO";
  if (ALLOWED_AUDIO_EXT.includes(ext)) return "AUDIO";
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
