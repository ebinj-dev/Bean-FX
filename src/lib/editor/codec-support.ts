/**
 * BEAN FX — M17 Phase B: browser codec compatibility matrix.
 *
 * A single honest probe (MediaSource/canPlayType based) that answers "can
 * THIS browser decode THIS codec/container" — never assumed. The monitor
 * surfaces the matrix result when a clip fails to decode, so an unsupported
 * codec produces a SPECIFIC message ("HEVC not supported by this browser —
 * the proxy workflow can transcode it") instead of a generic failure.
 *
 * The matrix is measured at runtime; the shipped TABLE is the catalogue of
 * what we test, not a claim. Proxy/transcode workflows (M4 media-proxy)
 * remain the fallback for unsupported inputs.
 */

export interface CodecEntry {
  /** Short id used in messages and tests. */
  id: string;
  label: string;
  container: string;
  /** canPlayType argument for the video codec. */
  videoType: string;
  /** canPlayType argument for the audio codec, or null when audio-only. */
  audioType: string | null;
  kind: "video" | "audio";
  /** Honest note shown when unsupported. */
  fallback: string;
}

export const CODEC_MATRIX: CodecEntry[] = [
  {
    id: "h264-mp4", label: "H.264 · MP4", container: "mp4", kind: "video",
    videoType: 'video/mp4; codecs="avc1.42E01E"', audioType: 'audio/mp4; codecs="mp4a.40.2"',
    fallback: "Transcode to a proxy via the media library (M4 proxy workflow).",
  },
  {
    id: "hevc-mp4", label: "H.265/HEVC · MP4", container: "mp4", kind: "video",
    videoType: 'video/mp4; codecs="hvc1.1.6.L93.B0"', audioType: 'audio/mp4; codecs="mp4a.40.2"',
    fallback: "HEVC is hardware-dependent — use the proxy workflow if unsupported.",
  },
  {
    id: "vp9-webm", label: "VP9 · WebM", container: "webm", kind: "video",
    videoType: 'video/webm; codecs="vp09.00.10.08"', audioType: 'audio/webm; codecs="opus"',
    fallback: "VP9 support is standard in Chromium/Firefox; proxies cover the rest.",
  },
  {
    id: "av1-webm", label: "AV1 · WebM", container: "webm", kind: "video",
    videoType: 'video/webm; codecs="av01.0.05M.08"', audioType: 'audio/webm; codecs="opus"',
    fallback: "AV1 decoding is CPU-bound on many machines — proxies recommended.",
  },
  {
    id: "aac", label: "AAC · M4A", container: "mp4", kind: "audio",
    videoType: "", audioType: 'audio/mp4; codecs="mp4a.40.2"',
    fallback: "Decode through the Web Audio mixer (wide AAC support).",
  },
  {
    id: "opus", label: "Opus · WebM", container: "webm", kind: "audio",
    videoType: "", audioType: 'audio/webm; codecs="opus"',
    fallback: "Opus is standard in browsers; WAV imports decode natively.",
  },
  {
    id: "wav-pcm", label: "PCM/WAV", container: "wav", kind: "audio",
    videoType: "", audioType: 'audio/wav; codecs="1"',
    fallback: "WAV decodes natively in the mixer and FFmpeg path.",
  },
];

export interface CodecSupport {
  id: string;
  label: string;
  /** "probably" | "maybe" | "" per the HTML spec's honesty tiers. */
  video: string;
  audio: string;
  /** probably/maybe → supported; "" → unsupported (honest tiers preserved). */
  supported: boolean;
  fallback: string;
}

/** Probe THIS browser — returns the measured matrix, never a hard-coded claim. */
export function probeCodecMatrix(): CodecSupport[] {
  if (typeof document === "undefined") return [];
  const v = document.createElement("video");
  const a = document.createElement("audio");
  return CODEC_MATRIX.map((entry) => {
    const video = entry.videoType ? (v.canPlayType(entry.videoType) as string) : "";
    const audio = entry.audioType ? (a.canPlayType(entry.audioType) as string) : "";
    const kindDecodable = entry.kind === "video" ? video !== "" : audio !== "";
    return {
      id: entry.id,
      label: entry.label,
      video,
      audio,
      supported: kindDecodable,
      fallback: entry.fallback,
    };
  });
}

/** Specific, honest decode-failure message for an asset's MIME/container. */
export function unsupportedCodecMessage(mimeType: string | null): string | null {
  const matrix = probeCodecMatrix();
  const mime = (mimeType ?? "").toLowerCase();
  const hit = CODEC_MATRIX.filter((c) => !matrix.find((m) => m.id === c.id)?.supported).find(
    (c) => mime.includes(c.container),
  );
  if (hit) return `${hit.label} is not supported by this browser. ${hit.fallback}`;
  return null;
}
