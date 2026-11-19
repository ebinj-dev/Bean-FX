/**
 * M28 — runtime media capability detection. Export profiles and proxy plans
 * name encoders (libx265, prores_ks, libvpx-vp9 …); whether they exist is a
 * property of the DEPLOYED ffmpeg build, never of the dropdown. This module
 * asks the actual binary once per process and caches the answer.
 */
import { execFile } from "child_process";

export interface MediaCapabilities {
  encoders: Set<string>;
  muxers: Set<string>;
  ffmpegVersion: string;
  probedAt: number;
}

let cache: MediaCapabilities | null = null;

function runFfmpeg(args: string[], timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`ffmpeg capability probe failed: ${err.message}`));
      resolve(stdout);
    });
  });
}

function parseNames(section: string, output: string): Set<string> {
  const names = new Set<string>();
  let inSection = false;
  for (const line of output.split("\n")) {
    if (line.startsWith("-----")) {
      inSection = line.includes(section);
      continue;
    }
    if (!inSection) continue;
    // Encoder lines: " A..D xxx    Label …" / muxer lines: " E xx xxx    Label".
    const m = /^ [A-Z.]{3,6}\s+([a-z0-9_-]+)\s/.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}

/** Probe the deployed ffmpeg ONCE per process (module-lifetime cache). */
export async function getMediaCapabilities(force = false): Promise<MediaCapabilities> {
  if (cache && !force) return cache;
  const [encodersOut, muxersOut, versionOut] = await Promise.all([
    runFfmpeg(["-hide_banner", "-encoders"]),
    runFfmpeg(["-hide_banner", "-muxers"]),
    runFfmpeg(["-hide_banner", "-version"]),
  ]);
  cache = {
    encoders: parseNames("Encoders", encodersOut),
    muxers: parseNames("File formats", muxersOut),
    ffmpegVersion: versionOut.split("\n")[0]?.replace(/^ffmpeg version /, "").trim() ?? "unknown",
    probedAt: Date.now(),
  };
  return cache;
}

/** Test seam — inject a capability snapshot (no ffmpeg spawn in unit tests). */
export function setMediaCapabilitiesForTests(cap: MediaCapabilities | null): void {
  cache = cap;
}

export interface CodecNeed {
  /** ffmpeg encoder name, e.g. "libx265", "prores_ks". */
  encoder: string;
  /** Output format (muxer), e.g. "mp4", "matroska", "webm". */
  muxer: string;
  /** Human label for error messages. */
  label: string;
}

/** The codec needs of every M9 export family, mapped to real encoder names. */
export const EXPORT_CODEC_NEEDS: Record<string, CodecNeed> = {
  H264: { encoder: "libx264", muxer: "mp4", label: "H.264 (libx264)" },
  H265: { encoder: "libx265", muxer: "mp4", label: "H.265/HEVC (libx265)" },
  PRORES: { encoder: "prores_ks", muxer: "mov", label: "ProRes 422 (prores_ks)" },
  VP9: { encoder: "libvpx-vp9", muxer: "webm", label: "VP9 (libvpx-vp9)" },
  AAC_AUDIO: { encoder: "aac", muxer: "mp4", label: "AAC audio (native encoder)" },
  PCM_AUDIO: { encoder: "pcm_s16le", muxer: "wav", label: "PCM audio (WAV)" },
};

/**
 * Truthful capability report for one codec family. A missing encoder or muxer
 * means the export button must say CONFIGURATION REQUIRED — not fail mid-render.
 */
export async function checkExportCodecAvailable(family: keyof typeof EXPORT_CODEC_NEEDS): Promise<{ available: boolean; reason: string | null; need: CodecNeed; ffmpegVersion: string }> {
  const need = EXPORT_CODEC_NEEDS[family];
  const caps = await getMediaCapabilities();
  const reasons: string[] = [];
  if (!caps.encoders.has(need.encoder)) reasons.push(`encoder "${need.encoder}" is not compiled into this ffmpeg build`);
  if (!caps.muxers.has(need.muxer)) reasons.push(`muxer "${need.muxer}" is not available in this ffmpeg build`);
  return { available: reasons.length === 0, reason: reasons.length ? reasons.join("; ") : null, need, ffmpegVersion: caps.ffmpegVersion };
}
