/**
 * M47.1 §A1 — the audio format contract.
 *
 * One isomorphic detector used by BOTH the server (validating provider bytes
 * before they are labelled) and the browser (validating bytes before they are
 * played). The rule it enforces: a MIME label is derived from the REAL bytes,
 * never from an assumption. Raw PCM is the only format that needs wrapping —
 * and the wrap is an actual container header, not a MIME string rename.
 */

export type AudioFormat = "wav" | "mp3" | "ogg" | "flac" | "aac" | "webm" | "raw-pcm" | "unknown";

export interface AudioFormatInfo {
  format: AudioFormat;
  /** The MIME type the bytes actually carry — null when unknown/unheadered. */
  mime: string | null;
  /** True when the bytes carry a real container header (playable as-is). */
  headered: boolean;
}

const startsWith = (b: Uint8Array, i: number, s: string): boolean => {
  for (let k = 0; k < s.length; k++) {
    if (b[i + k] !== s.charCodeAt(k)) return false;
  }
  return true;
};

/** Detect the audio container from magic bytes. Works on ≥4 bytes. */
export function detectAudioFormat(bytes: Uint8Array): AudioFormatInfo {
  if (!bytes || bytes.length < 4) return { format: "unknown", mime: null, headered: false };
  // WAV — RIFF....WAVE
  if (startsWith(bytes, 0, "RIFF") && startsWith(bytes, 8, "WAVE")) {
    return { format: "wav", mime: "audio/wav", headered: true };
  }
  // MP3 — ID3 tag or MPEG audio frame sync (0xFFEx, layer bits ≠ 0).
  if (startsWith(bytes, 0, "ID3")) return { format: "mp3", mime: "audio/mpeg", headered: true };
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    const layerBits = (bytes[1] >> 1) & 0x03;
    if (layerBits === 0) return { format: "aac", mime: "audio/aac", headered: true }; // ADTS
    return { format: "mp3", mime: "audio/mpeg", headered: true };
  }
  if (startsWith(bytes, 0, "OggS")) return { format: "ogg", mime: "audio/ogg", headered: true };
  if (startsWith(bytes, 0, "fLaC")) return { format: "flac", mime: "audio/flac", headered: true };
  // WebM / EBML container.
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return { format: "webm", mime: "audio/webm", headered: true };
  }
  // No container header — provider raw PCM (the gateway documents 16 kHz mono
  // 16-bit LE for PCM output). Only safe to interpret when the caller asked
  // for that contract; the speak route does exactly that.
  return { format: "raw-pcm", mime: null, headered: false };
}

/** Wrap headerless 16-bit LE PCM into a real WAV container (actual RIFF header). */
export function wrapPcmAsWav(pcm: Uint8Array, rate = 16000, channels = 1, bits = 16): Uint8Array {
  const bps = (rate * channels * bits) / 8;
  const out = new Uint8Array(44 + pcm.length);
  const view = new DataView(out.buffer);
  const wstr = (i: number, s: string) => { for (let k = 0; k < s.length; k++) out[i + k] = s.charCodeAt(k); };
  wstr(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  wstr(8, "WAVE");
  wstr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, bps, true);
  view.setUint16(32, (channels * bits) / 8, true);
  view.setUint16(34, bits, true);
  wstr(36, "data");
  view.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

export interface ClientAudioValidation {
  ok: boolean;
  /** MIME the bytes actually carry after validation. */
  mime: string | null;
  format: AudioFormat;
  /** Set when the label had to be corrected because the bytes disagreed. */
  correctedFrom?: string;
  detail: string;
}

/**
 * Browser-side validation before playback: decode the head of a base64 audio
 * payload and trust the bytes over the label. Returned `mime` is what the
 * data URL must use; `ok:false` means unrecognised bytes — show an error,
 * never attempt playback.
 */
export function validateAudioBase64(b64: string, claimedMime?: string | null): ClientAudioValidation {
  try {
    const head = atob(b64.slice(0, 24));
    const bytes = new Uint8Array(head.length);
    for (let i = 0; i < head.length; i++) bytes[i] = head.charCodeAt(i);
    const info = detectAudioFormat(bytes);
    if (info.headered && info.mime) {
      const corrected = claimedMime && claimedMime !== info.mime ? claimedMime : undefined;
      return {
        ok: true,
        mime: info.mime,
        format: info.format,
        correctedFrom: corrected,
        detail: corrected
          ? `Labelled ${claimedMime} but bytes are ${info.format} — playing with the correct type.`
          : `Validated ${info.format} audio.`,
      };
    }
    return {
      ok: false,
      mime: claimedMime ?? null,
      format: info.format,
      detail: `The provider returned audio in an unrecognised container (head bytes: ${Array.from(bytes.slice(0, 4))
        .map((x) => x.toString(16).padStart(2, "0"))
        .join(" ")}) — playback refused. The text transcript remains authoritative.`,
    };
  } catch {
    return { ok: false, mime: null, format: "unknown", detail: "Audio payload could not be decoded — playback refused." };
  }
}
