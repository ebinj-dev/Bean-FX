import { execFile } from "child_process";
import { db } from "@/lib/db";
import { jobManager } from "@/lib/job-runner";
import { PermanentJobError, completeJob, finishJob, handleJobError, JOB_TYPE_MEDIA_PROXY } from "@/lib/job-helpers";
import { pathExists } from "@/lib/media-storage";

/**
 * M3.2 — deep media analysis. Runs ffprobe in the background worker (never in
 * an HTTP handler), extracts the full stream/format picture, and persists it
 * on the MediaAsset row. Results drive the editor, the proxy decision, and
 * the corruption/unsupported reporting.
 */

interface ProbeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  codec_long_name?: string;
  width?: number;
  height?: number;
  sample_aspect_ratio?: string;
  display_aspect_ratio?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  time_base?: string;
  start_time?: string;
  duration?: string;
  nb_frames?: string;
  bit_rate?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
  side_data_list?: { rotation?: number; displaymatrix?: string }[];
  tags?: Record<string, string>;
}

interface ProbeFormat {
  filename?: string;
  format_name?: string;
  duration?: string;
  size?: string;
  bit_rate?: string;
}

interface ProbeJson {
  streams?: ProbeStream[];
  format?: ProbeFormat;
}

export interface DeepProbe {
  formatName: string | null;
  durationSec: number | null;
  sizeBytes: number | null;
  bitRate: number | null;
  width: number | null;
  height: number | null
  fpsAvg: number | null;
  fpsNominal: number | null;
  isVfr: boolean;
  aspectRatio: string | null;
  timeBase: string | null;
  startTimeSec: number | null;
  nbFrames: number | null;
  rotation: number;
  videoCodec: string | null;
  audioCodec: string | null;
  sampleRate: number | null;
  channels: number | null;
  channelLayout: string | null;
  hasVideo: boolean;
  hasAudio: boolean;
  mime: string | null;
}

function parseRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const [num, den] = rate.split("/").map(Number);
  if (!num || !den) return null;
  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 && fps < 1000 ? fps : null;
}

function parseNum(v: string | number | undefined): number | null {
  if (v === undefined || v === null || v === "N/A") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mimeFromContainer(formatName: string | null, hasVideo: boolean): string | null {
  if (!formatName) return null;
  const f = formatName.toLowerCase();
  if (f.includes("webm")) return hasVideo ? "video/webm" : "audio/webm";
  if (f.includes("matroska")) return "video/x-matroska";
  if (f.includes("mov") || f.includes("mp4") || f.includes("m4a") || f.includes("3gp")) return hasVideo ? "video/mp4" : "audio/mp4";
  if (f.includes("ogg")) return "audio/ogg";
  if (f.includes("wav")) return "audio/wav";
  if (f.includes("flac")) return "audio/flac";
  if (f.includes("mp3")) return "audio/mpeg";
  if (f.includes("aac") || f.includes("adts")) return "audio/aac";
  if (f.includes("aiff")) return "audio/aiff";
  return null;
}

/** Deep ffprobe of a real file. Throws PermanentJobError for unreadable media. */
export function probeMediaDeep(storagePath: string): Promise<DeepProbe> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffprobe",
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", storagePath],
      { timeout: 90_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          // A killed/timed-out probe is transient; an ffprobe rejection on a
          // complete file is deterministic — retrying cannot fix bad bytes.
          if ((err as { killed?: boolean }).killed) {
            return reject(new Error(`ffprobe timed out: ${err.message}`));
          }
          return reject(new PermanentJobError(`Media inspection failed: ${err.message}`));
        }
        let data: ProbeJson;
        try {
          data = JSON.parse(stdout);
        } catch {
          return reject(new PermanentJobError("Media inspection returned invalid data."));
        }
        const streams = data.streams ?? [];
        const video = streams.find((s) => s.codec_type === "video");
        const audio = streams.find((s) => s.codec_type === "audio");
        if (!video && !audio) {
          return reject(new PermanentJobError("File contains no audio or video streams."));
        }
        const format = data.format ?? {};
        const durationStr = format.duration ?? video?.duration ?? audio?.duration;
        const durationSec = parseNum(durationStr);

        const fpsAvg = parseRate(video?.avg_frame_rate);
        const fpsNominal = parseRate(video?.r_frame_rate);
        // VFR: nominal and average frame rates genuinely diverge (tolerance
        // 0.5% to absorb rounding in encoders like variable-GOP H.264).
        const isVfr = Boolean(
          video &&
            fpsAvg !== null &&
            fpsNominal !== null &&
            Math.abs(fpsAvg - fpsNominal) / Math.max(fpsAvg, fpsNominal) > 0.005
        );

        // Rotation: display-matrix side data (ffprobe ≥ 5) — the angle is
        // reported in ffprobe's own convention, normalized to [0, 360); the
        // legacy "rotate" tag carries the same convention.
        let rotation = 0;
        for (const sd of video?.side_data_list ?? []) {
          if (typeof sd?.rotation === "number") {
            rotation = ((sd.rotation % 360) + 360) % 360;
            break;
          }
        }
        if (rotation === 0 && video?.tags?.rotate !== undefined) {
          const legacy = parseNum(video.tags.rotate);
          if (legacy !== null) rotation = ((legacy % 360) + 360) % 360;
        }

        resolve({
          formatName: format.format_name ?? null,
          durationSec: durationSec !== null && durationSec > 0 ? durationSec : null,
          sizeBytes: parseNum(format.size),
          bitRate: parseNum(format.bit_rate) !== null && parseNum(format.bit_rate)! <= 2_000_000_000 ? parseNum(format.bit_rate) : null,
          width: video?.width ?? null,
          height: video?.height ?? null,
          fpsAvg,
          fpsNominal,
          isVfr,
          aspectRatio: video?.display_aspect_ratio ?? null,
          timeBase: video?.time_base ?? null,
          startTimeSec: parseNum(video?.start_time),
          nbFrames: parseNum(video?.nb_frames),
          rotation,
          videoCodec: video?.codec_name ?? null,
          audioCodec: audio?.codec_name ?? null,
          sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
          channels: audio?.channels ?? null,
          channelLayout: audio?.channel_layout ?? null,
          hasVideo: Boolean(video),
          hasAudio: Boolean(audio),
          mime: mimeFromContainer(format.format_name ?? null, Boolean(video)),
        });
      }
    );
  });
}

/** Proxy eligibility: meaningful resolution + bounded duration keep proxies useful and cheap. */
const PROXY_MIN_LONG_EDGE = 1280;
const PROXY_MAX_DURATION_SEC = 4 * 3600;

export function proxyEligible(probe: { hasVideo: boolean; width: number | null; height: number | null; durationSec: number | null }): boolean {
  if (!probe.hasVideo) return false;
  const longEdge = Math.max(probe.width ?? 0, probe.height ?? 0);
  if (longEdge < PROXY_MIN_LONG_EDGE) return false;
  if (probe.durationSec === null || probe.durationSec <= 0 || probe.durationSec > PROXY_MAX_DURATION_SEC) return false;
  return true;
}

/**
 * MEDIA_PROBE handler: probe the original file and persist the full metadata
 * picture, then queue proxy generation when the source justifies one.
 */
export async function runProbeJob(job: {
  id: string;
  userId: string;
  attempts: number;
  maxAttempts: number;
  paramsJson: string | null;
}): Promise<void> {
  const params = JSON.parse(job.paramsJson ?? "{}") as { mediaId?: string };
  const mediaId = params.mediaId;
  if (!mediaId) throw new PermanentJobError("Probe job is missing its mediaId parameter.");

  const asset = await db.mediaAsset.findUnique({ where: { id: mediaId } });
  if (!asset) throw new PermanentJobError("Media asset no longer exists.");
  if (asset.userId !== job.userId) throw new PermanentJobError("Media asset does not belong to the job owner.");
  if (asset.kind === "SUBTITLE") {
    await finishJob(job.id, { status: "COMPLETED", progress: 100, stage: "Completed", message: "Subtitles need no probing." });
    return;
  }
  if (!(await pathExists(asset.storagePath))) {
    throw new PermanentJobError("Original media file is missing from storage.");
  }

  try {
    await jobManager.setProgress(job.id, 10, "Probing");
    const probe = await probeMediaDeep(asset.storagePath);

    await jobManager.setProgress(job.id, 60, "Analyzing");
    if (asset.kind === "AUDIO" && !probe.hasAudio) {
      throw new PermanentJobError("This file has no audio stream and cannot be used as audio.");
    }

    // Trimmed but complete stream/format summary (a few KB) for diagnostics.
    const metaSummary = {
      format: { format_name: probe.formatName, duration: probe.durationSec, size: probe.sizeBytes, bit_rate: probe.bitRate },
      video: probe.hasVideo
        ? {
            codec: probe.videoCodec,
            width: probe.width,
            height: probe.height,
            avg_frame_rate: probe.fpsAvg,
            r_frame_rate: probe.fpsNominal,
            is_vfr: probe.isVfr,
            display_aspect_ratio: probe.aspectRatio,
            time_base: probe.timeBase,
            start_time: probe.startTimeSec,
            nb_frames: probe.nbFrames,
            rotation: probe.rotation,
          }
        : null,
      audio: probe.hasAudio
        ? { codec: probe.audioCodec, sample_rate: probe.sampleRate, channels: probe.channels, channel_layout: probe.channelLayout }
        : null,
    };

    await jobManager.setProgress(job.id, 85, "Saving metadata");
    await db.mediaAsset.update({
      where: { id: asset.id },
      data: {
        probeStatus: "READY",
        probeError: null,
        probeMetaJson: JSON.stringify(metaSummary),
        formatName: probe.formatName,
        bitRate: probe.bitRate,
        isVfr: probe.hasVideo ? probe.isVfr : null,
        rotation: probe.hasVideo ? probe.rotation : null,
        aspectRatio: probe.aspectRatio,
        timeBase: probe.timeBase,
        durationSec: probe.durationSec,
        width: probe.width,
        height: probe.height,
        fps: probe.fpsAvg,
        videoCodec: probe.videoCodec,
        audioCodec: probe.audioCodec,
        sampleRate: probe.sampleRate,
        channels: probe.channels,
        // Real container MIME instead of a blanket octet-stream.
        mimeType: probe.mime ?? asset.mimeType,
      },
    });

    await jobManager.setProgress(job.id, 95, "Queuing proxy");
    if (proxyEligible({ hasVideo: probe.hasVideo, width: probe.width, height: probe.height, durationSec: probe.durationSec })) {
      try {
        await db.mediaAsset.update({ where: { id: asset.id }, data: { proxyStatus: "QUEUED", proxyError: null } });
        await db.job.create({
          data: {
            userId: job.userId,
            type: JOB_TYPE_MEDIA_PROXY,
            status: "QUEUED",
            stage: "Queued",
            paramsJson: JSON.stringify({ mediaId: asset.id }),
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await db.mediaAsset
          .update({ where: { id: asset.id }, data: { proxyStatus: "FAILED", proxyError: `Proxy could not be queued: ${msg}` } })
          .catch(() => undefined);
      }
    } else if (probe.hasVideo) {
      await db.mediaAsset.update({ where: { id: asset.id }, data: { proxyStatus: "NONE" } });
    }
    await completeJob(job.id, `Analysis complete: ${probe.hasVideo ? `${probe.width}×${probe.height}${probe.isVfr ? " VFR" : ""}` : "audio-only"}${probe.hasAudio ? `, ${probe.audioCodec ?? "audio"}` : ""}.`);
  } catch (err) {
    await db.mediaAsset
      .update({
        where: { id: asset.id },
        data: { probeStatus: "FAILED", probeError: (err instanceof Error ? err.message : String(err)).slice(0, 500) },
      })
      .catch(() => undefined);
    await handleJobError(job.id, err, job.attempts, job.maxAttempts, "Media analysis failed");
  } finally {
    // Reset a probe that was left PROCESSING by a failed attempt with no
    // attempts left (failJob above already terminal; this covers requeue).
    await db.mediaAsset
      .updateMany({ where: { id: asset.id, probeStatus: "PROCESSING" }, data: { probeStatus: "PENDING" } })
      .catch(() => undefined);
  }
}
