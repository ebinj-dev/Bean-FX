/**
 * M9 — Export variant engine (§6).
 *
 * Builds SERVER-SIDE ffmpeg arguments for transcoding a completed master
 * (a NIKKI render ExportFile or an owned VIDEO MediaAsset) into a validated
 * platform profile. No client-supplied ffmpeg text ever reaches these args —
 * the caller passes ids; everything else is derived from the profile registry
 * and real ffprobe measurements. The existing renderer/queue are reused: the
 * heavy lifting stays `jobManager.runFfmpeg` on the M3 worker (EXPORT_VARIANT
 * handler in jobs.ts).
 */
import { execFile } from "child_process";
import { evenDim } from "@/lib/media-storage";
import type { ExportProfile } from "./profiles";

export interface MasterProbeSummary {
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasAudio: boolean;
}

interface FfprobeJson {
  streams?: Array<{ codec_type?: string; width?: number; height?: number; avg_frame_rate?: string; duration?: string }>;
  format?: { duration?: string };
}

function parseFps(rate: string | undefined): number | null {
  if (!rate) return null;
  const [num, den] = rate.split("/").map(Number);
  if (!num || !den) return null;
  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 && fps < 1000 ? Math.round(fps * 1000) / 1000 : null;
}

/** Probe a master file for the variant pipeline (measured, never trusted). */
export function probeMaster(filePath: string): Promise<MasterProbeSummary> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffprobe",
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath],
      { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new Error(`Master inspection failed: ${err.message}`));
        try {
          const data = JSON.parse(stdout) as FfprobeJson;
          const streams = data.streams ?? [];
          const video = streams.find((s) => s.codec_type === "video");
          const audio = streams.find((s) => s.codec_type === "audio");
          const durationStr = data.format?.duration ?? video?.duration;
          const durationSec = durationStr ? Number(durationStr) : null;
          resolve({
            durationSec: durationSec && Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null,
            width: video?.width ?? null,
            height: video?.height ?? null,
            fps: parseFps(video?.avg_frame_rate),
            hasAudio: Boolean(audio),
          });
        } catch {
          reject(new Error("Master inspection returned invalid data."));
        }
      },
    );
  });
}

/**
 * Build the full ffmpeg argument list for one variant.
 * Geometry: scale (preserve aspect) then pad to the profile canvas with black
 * bars — never crop or stretch creator content. fps is normalized to the
 * profile rate. Audio: re-encoded to the profile's AAC spec; a silent master
 * produces a silent output (`-an`) recorded in the summary.
 */
export function buildVariantArgs(
  sourcePath: string,
  outPath: string,
  profile: ExportProfile,
  master: MasterProbeSummary
): { args: string[]; summary: string[] } {
  const w = evenDim(profile.width);
  const h = evenDim(profile.height);
  const vf = [
    `scale=w=${w}:h=${h}:force_original_aspect_ratio=decrease`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`,
    "setsar=1",
    `fps=${profile.fps}`,
  ].join(",");

  const maxrate = Math.round(profile.videoBitrateKbps * 1.45);
  const bufsize = Math.round(profile.videoBitrateKbps * 2.5);

  const args = [
    "-i",
    sourcePath,
    "-map",
    "0:v:0",
    "-vf",
    vf,
    "-c:v",
    profile.videoCodec,
    "-profile:v",
    profile.videoProfile,
    "-preset",
    "medium",
    "-pix_fmt",
    profile.pixelFormat,
    "-b:v",
    `${profile.videoBitrateKbps}k`,
    "-maxrate",
    `${maxrate}k`,
    "-bufsize",
    `${bufsize}k`,
    "-g",
    String(profile.fps * 2), // closed-GOP style keyframe cadence (2 s)
  ];

  const summary: string[] = [
    `${w}x${h} @ ${profile.fps} fps (scale+pad, no crop)`,
    `${profile.videoCodec} ${profile.videoProfile} ${profile.pixelFormat} @ ${profile.videoBitrateKbps} kbps (${profile.bitrateSource})`,
  ];

  if (master.hasAudio) {
    args.push(
      "-map",
      "0:a:0?",
      "-c:a",
      profile.audioCodec,
      "-b:a",
      `${profile.audioBitrateKbps}k`,
      "-ar",
      String(profile.audioSampleRate),
      "-ac",
      String(profile.audioChannels),
    );
    summary.push(`${profile.audioCodec} ${profile.audioSampleRate} Hz ${profile.audioChannels}ch @ ${profile.audioBitrateKbps} kbps`);
  } else {
    args.push("-an");
    summary.push("master has no audio stream — output is silent (-an)");
  }

  args.push("-movflags", "+faststart", outPath);
  return { args, summary };
}
