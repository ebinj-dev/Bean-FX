/**
 * M9 — Multi-platform export profile registry (§6).
 *
 * Every platform constraint encoded here was verified from the platform's own
 * documentation (sources recorded per profile; see docs/
 * M9_PROFESSIONAL_PUBLISHING.md §4 for the full citation table). Nothing is
 * invented: where a platform documents NO hard duration cap, `maxDurationSec`
 * stays null and the honest note says so. Bitrate defaults that are
 * engineering choices (not platform-mandated) are marked
 * `bitrateSource: "deployment-default"` so they are never confused with
 * official requirements.
 *
 * Versioned + configurable (§6): the registry has a version; a deployment can
 * override the WHOLE registry through BEANFX_EXPORT_PROFILES_JSON (a JSON
 * array validated by the same schema — an invalid override is refused loudly,
 * never silently merged).
 */
import { z } from "zod";

export const PROFILE_VERSION = "2026.11.27";

export const ExportProfileSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z][a-z0-9_]{2,40}$/, "profile id must be lowercase snake_case"),
    label: z.string().min(1).max(80),
    platform: z.enum(["youtube", "instagram", "tiktok", "generic"]),
    width: z.number().int().min(16).max(7680),
    height: z.number().int().min(16).max(4320),
    aspect: z.string().regex(/^\d+:\d+$/),
    fps: z.number().int().min(1).max(120),
    container: z.literal("mp4"),
    videoCodec: z.enum(["libx264"]),
    videoProfile: z.enum(["high", "main", "baseline"]),
    pixelFormat: z.enum(["yuv420p"]),
    audioCodec: z.enum(["aac"]),
    audioSampleRate: z.number().int().min(8000).max(192000),
    audioChannels: z.number().int().min(1).max(2),
    audioBitrateKbps: z.number().int().min(32).max(1024),
    videoBitrateKbps: z.number().int().min(100).max(200000),
    bitrateSource: z.enum(["official", "deployment-default"]),
    /** Hard duration cap encoded ONLY from a verified platform rule (null = none documented). */
    maxDurationSec: z.number().int().min(1).max(43200).nullable(),
    notes: z.string().max(600),
    /** Official documentation URLs backing the constraints (empty = generic profile with no platform authority — recorded honestly). */
    sources: z.array(z.string().url()).max(8).default([]),
  })
  .strict();

export type ExportProfile = z.infer<typeof ExportProfileSchema>;

const YOUTUBE_ENCODING_URL = "https://support.google.com/youtube/answer/1722171";
const YOUTUBE_SHORTS_URL = "https://support.google.com/youtube/answer/15424877";
const TIKTOK_INFEED_URL = "https://ads.tiktok.com/resources/help/article/tiktok-auction-in-feed-ads";
const TIKTOK_POLICY_URL = "https://ads.tiktok.com/resources/help/article/tiktok-ads-policy-ad-format-and-functionality";
const IG_PUBLISHING_URL = "https://developers.facebook.com/documentation/instagram-platform/content-publishing";

/**
 * The shipped registry. YouTube bitrates come from the platform's own SDR
 * table (1080p30 = 8 Mbps, 1080p60 = 12 Mbps, 720p30 = 5 Mbps; audio AAC-LC
 * 48 kHz stereo 384 kbps). Instagram/TikTok do not publish a mandatory
 * bitrate for organic uploads — the values below are deployment defaults and
 * labelled as such. YouTube/Shorts/landscape profiles fix fps at 30 (the
 * sequence default); YouTube accepts 24–60 and re-encodes — matching the
 * source rate is the platform's recommendation, which the export pipeline
 * honors by using the sequence's own fps when the caller passes it.
 */
const BUILT_IN_PROFILES: ExportProfile[] = [
  {
    id: "youtube_landscape",
    label: "YouTube landscape (16:9)",
    platform: "youtube",
    width: 1920,
    height: 1080,
    aspect: "16:9",
    fps: 30,
    container: "mp4",
    videoCodec: "libx264",
    videoProfile: "high",
    pixelFormat: "yuv420p",
    audioCodec: "aac",
    audioSampleRate: 48000,
    audioChannels: 2,
    audioBitrateKbps: 384,
    videoBitrateKbps: 8000,
    bitrateSource: "official",
    maxDurationSec: null,
    notes:
      "YouTube documents no hard upload duration cap on the encoding page; H.264 High, 4:2:0, progressive, faststart per YouTube's recommended upload settings.",
    sources: [YOUTUBE_ENCODING_URL],
  },
  {
    id: "youtube_shorts",
    label: "YouTube Shorts (9:16)",
    platform: "youtube",
    width: 1080,
    height: 1920,
    aspect: "9:16",
    fps: 30,
    container: "mp4",
    videoCodec: "libx264",
    videoProfile: "high",
    pixelFormat: "yuv420p",
    audioCodec: "aac",
    audioSampleRate: 48000,
    audioChannels: 2,
    audioBitrateKbps: 384,
    videoBitrateKbps: 8000,
    bitrateSource: "official",
    maxDurationSec: 180,
    notes:
      "A Short is up to 3 minutes (180 s) when square or vertical (official help); encoding follows the same SDR table as regular uploads.",
    sources: [YOUTUBE_SHORTS_URL, YOUTUBE_ENCODING_URL],
  },
  {
    id: "instagram_reels",
    label: "Instagram Reels (9:16)",
    platform: "instagram",
    width: 1080,
    height: 1920,
    aspect: "9:16",
    fps: 30,
    container: "mp4",
    videoCodec: "libx264",
    videoProfile: "high",
    pixelFormat: "yuv420p",
    audioCodec: "aac",
    audioSampleRate: 48000,
    audioChannels: 2,
    audioBitrateKbps: 256,
    videoBitrateKbps: 6000,
    bitrateSource: "deployment-default",
    maxDurationSec: null,
    notes:
      "Meta's Content Publishing doc (fetched 2026-11-13) documents the publish flow and the 100-posts/24h API limit but no hard Reels duration cap; 1080x1920@30 is the platform-recommended geometry. No cap is encoded from an unverified number.",
    sources: [IG_PUBLISHING_URL],
  },
  {
    id: "tiktok",
    label: "TikTok (9:16)",
    platform: "tiktok",
    width: 1080,
    height: 1920,
    aspect: "9:16",
    fps: 30,
    container: "mp4",
    videoCodec: "libx264",
    videoProfile: "high",
    pixelFormat: "yuv420p",
    audioCodec: "aac",
    audioSampleRate: 48000,
    audioChannels: 2,
    audioBitrateKbps: 256,
    videoBitrateKbps: 6000,
    bitrateSource: "deployment-default",
    maxDurationSec: null,
    notes:
      "TikTok's in-feed ad spec lists .mp4/.mov with vertical 9:16 recommended (>=540x960) and 'no restrictions' duration; the ad policy caps ADS at 5-60 s, which does not apply to organic posts. No organic cap is encoded from an unverified number.",
    sources: [TIKTOK_INFEED_URL, TIKTOK_POLICY_URL],
  },
  {
    id: "square_social",
    label: "Square social video (1:1)",
    platform: "generic",
    width: 1080,
    height: 1080,
    aspect: "1:1",
    fps: 30,
    container: "mp4",
    videoCodec: "libx264",
    videoProfile: "high",
    pixelFormat: "yuv420p",
    audioCodec: "aac",
    audioSampleRate: 48000,
    audioChannels: 2,
    audioBitrateKbps: 256,
    videoBitrateKbps: 6000,
    bitrateSource: "deployment-default",
    maxDurationSec: null,
    notes:
      "Generic 1:1 social geometry (no single platform authority — no official source exists, recorded honestly). Deployment defaults, adjustable via BEANFX_EXPORT_PROFILES_JSON.",
    sources: [],
  },
  {
    id: "custom_landscape",
    label: "Custom landscape (16:9)",
    platform: "generic",
    width: 1920,
    height: 1080,
    aspect: "16:9",
    fps: 30,
    container: "mp4",
    videoCodec: "libx264",
    videoProfile: "high",
    pixelFormat: "yuv420p",
    audioCodec: "aac",
    audioSampleRate: 48000,
    audioChannels: 2,
    audioBitrateKbps: 384,
    videoBitrateKbps: 8000,
    bitrateSource: "deployment-default",
    maxDurationSec: null,
    notes: "Deployment-configurable landscape profile following YouTube's SDR table for 1080p.",
    sources: [YOUTUBE_ENCODING_URL],
  },
  {
    id: "custom_portrait",
    label: "Custom portrait (9:16)",
    platform: "generic",
    width: 1080,
    height: 1920,
    aspect: "9:16",
    fps: 30,
    container: "mp4",
    videoCodec: "libx264",
    videoProfile: "high",
    pixelFormat: "yuv420p",
    audioCodec: "aac",
    audioSampleRate: 48000,
    audioChannels: 2,
    audioBitrateKbps: 256,
    videoBitrateKbps: 6000,
    bitrateSource: "deployment-default",
    maxDurationSec: null,
    notes: "Deployment-configurable portrait profile; geometry matches the vertical platform set.",
    sources: [YOUTUBE_ENCODING_URL],
  },
  {
    // M48-F — delivery breadth: real deployment-default profiles for the
    // remaining professional targets. platform: "generic" (no invented
    // platform rules); bitrates marked deployment-default; durations null
    // (no verified platform cap encoded).
    id: "facebook_feed",
    label: "Facebook feed (16:9)",
    platform: "generic",
    width: 1920,
    height: 1080,
    aspect: "16:9",
    fps: 30,
    container: "mp4",
    videoCodec: "libx264",
    videoProfile: "high",
    pixelFormat: "yuv420p",
    audioCodec: "aac",
    audioSampleRate: 48000,
    audioChannels: 2,
    audioBitrateKbps: 256,
    videoBitrateKbps: 8000,
    bitrateSource: "deployment-default",
    maxDurationSec: null,
    notes: "Deployment default for Facebook feed delivery. Facebook publishes recommended specs in its Help Center; no specific cap or bitrate is encoded without a verified source — record the citation before treating any number as official.",
    sources: [],
  },
  {
    id: "linkedin_feed",
    label: "LinkedIn feed (16:9)",
    platform: "generic",
    width: 1920,
    height: 1080,
    aspect: "16:9",
    fps: 30,
    container: "mp4",
    videoCodec: "libx264",
    videoProfile: "high",
    pixelFormat: "yuv420p",
    audioCodec: "aac",
    audioSampleRate: 48000,
    audioChannels: 2,
    audioBitrateKbps: 256,
    videoBitrateKbps: 8000,
    bitrateSource: "deployment-default",
    maxDurationSec: null,
    notes: "Deployment default for LinkedIn feed delivery. LinkedIn documents video specs in its Help Center; encode nothing as official without a verified citation.",
    sources: [],
  },
  {
    id: "x_post",
    label: "X post (16:9)",
    platform: "generic",
    width: 1280,
    height: 720,
    aspect: "16:9",
    fps: 30,
    container: "mp4",
    videoCodec: "libx264",
    videoProfile: "high",
    pixelFormat: "yuv420p",
    audioCodec: "aac",
    audioSampleRate: 48000,
    audioChannels: 2,
    audioBitrateKbps: 192,
    videoBitrateKbps: 5000,
    bitrateSource: "deployment-default",
    maxDurationSec: null,
    notes: "Deployment default for X (Twitter) post delivery. X documents media specs in its Help Center; nothing encoded as official without a verified citation.",
    sources: [],
  },
  {
    id: "presentation_hd",
    label: "Presentation (16:9, 1080p)",
    platform: "generic",
    width: 1920,
    height: 1080,
    aspect: "16:9",
    fps: 30,
    container: "mp4",
    videoCodec: "libx264",
    videoProfile: "high",
    pixelFormat: "yuv420p",
    audioCodec: "aac",
    audioSampleRate: 48000,
    audioChannels: 2,
    audioBitrateKbps: 256,
    videoBitrateKbps: 12000,
    bitrateSource: "deployment-default",
    maxDurationSec: null,
    notes: "High-quality playback for projection/presentation contexts; no platform authority — a conservative engineering default.",
    sources: [],
  },
  {
    id: "archival_master",
    label: "Archival master (16:9, high bitrate)",
    platform: "generic",
    width: 1920,
    height: 1080,
    aspect: "16:9",
    fps: 30,
    container: "mp4",
    videoCodec: "libx264",
    videoProfile: "high",
    pixelFormat: "yuv420p",
    audioCodec: "aac",
    audioSampleRate: 48000,
    audioChannels: 2,
    audioBitrateKbps: 384,
    videoBitrateKbps: 40000,
    bitrateSource: "deployment-default",
    maxDurationSec: null,
    notes: "Archival-master engineering default (high bitrate, full-size). A true mezzanine/ProRes master requires container/codec expansion and is NOT silently faked here.",
    sources: [],
  },
];

export interface ProfileRegistry {
  version: string;
  profiles: Record<string, ExportProfile>;
  source: "built-in" | "env-override";
}

function buildRegistry(profiles: ExportProfile[], source: ProfileRegistry["source"]): ProfileRegistry {
  const map: Record<string, ExportProfile> = {};
  for (const p of profiles) {
    ExportProfileSchema.parse(p); // fail loudly on any malformed entry
    if (map[p.id]) throw new Error(`duplicate export profile id: ${p.id}`);
    // Even dimensions are mandatory for H.264 4:2:0 — refuse odd geometry here.
    if (p.width % 2 !== 0 || p.height % 2 !== 0) throw new Error(`profile ${p.id}: H.264 requires even dimensions`);
    map[p.id] = p;
  }
  return { version: PROFILE_VERSION, profiles: map, source };
}

let cachedRegistry: ProfileRegistry | null = null;

/** Resolve the registry: BEANFX_EXPORT_PROFILES_JSON (full override) or built-in. */
export function exportProfileRegistry(): ProfileRegistry {
  if (cachedRegistry) return cachedRegistry;
  const raw = process.env.BEANFX_EXPORT_PROFILES_JSON;
  if (raw && raw.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`BEANFX_EXPORT_PROFILES_JSON is not valid JSON: ${err instanceof Error ? err.message : "parse failed"}`);
    }
    const list = z.array(ExportProfileSchema).min(1).parse(parsed);
    cachedRegistry = buildRegistry(list as ExportProfile[], "env-override");
  } else {
    cachedRegistry = buildRegistry(BUILT_IN_PROFILES, "built-in");
  }
  return cachedRegistry;
}

/** Test helper — reset the memoized registry after env changes. */
export function resetProfileRegistry(): void {
  cachedRegistry = null;
}

export function getExportProfile(id: string): ExportProfile | null {
  return exportProfileRegistry().profiles[id] ?? null;
}

export function listExportProfiles(): ExportProfile[] {
  return Object.values(exportProfileRegistry().profiles);
}

export interface VariantValidationFailure {
  code: string;
  message: string;
}

/**
 * Pre-flight validation of a master against a profile (§6: validate BEFORE
 * encoding). `masterDurationSec` is measured with ffprobe — never trusted
 * from the client.
 */
export function validateVariantTarget(
  profile: ExportProfile,
  masterDurationSec: number | null,
  masterWidth: number | null,
  masterHeight: number | null
): { ok: true } | { ok: false; failures: VariantValidationFailure[] } {
  const failures: VariantValidationFailure[] = [];
  if (profile.maxDurationSec !== null && masterDurationSec !== null && masterDurationSec > profile.maxDurationSec) {
    failures.push({
      code: "DURATION_CAP",
      message: `Master is ${masterDurationSec?.toFixed(1)}s; ${profile.label} allows at most ${profile.maxDurationSec}s (verified platform rule). Trim the timeline or pick another profile.`,
    });
  }
  if (masterDurationSec === null) {
    failures.push({ code: "DURATION_UNKNOWN", message: "Master duration could not be measured with ffprobe — refusing to encode an unmeasured source." });
  }
  if (!masterWidth || !masterHeight) {
    failures.push({ code: "DIMENSIONS_UNKNOWN", message: "Master dimensions could not be measured — refusing to encode." });
  }
  return failures.length ? { ok: false, failures } : { ok: true };
}

/**
 * Post-flight conformance report (§6 "export validation"): the produced file
 * is probed with ffprobe and checked against the profile.
 */
export function validateVariantOutput(probe: {
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  sampleRate: number | null;
  durationSec: number | null;
}, profile: ExportProfile): { ok: boolean; failures: VariantValidationFailure[] } {
  const failures: VariantValidationFailure[] = [];
  if (probe.width !== profile.width || probe.height !== profile.height) {
    failures.push({ code: "DIMENSIONS_MISMATCH", message: `Output is ${probe.width}x${probe.height}; profile requires ${profile.width}x${profile.height}.` });
  }
  if (probe.videoCodec !== "h264") {
    failures.push({ code: "VIDEO_CODEC_MISMATCH", message: `Output video codec is ${probe.videoCodec ?? "unknown"}; profile requires H.264.` });
  }
  if (probe.audioCodec !== "aac") {
    failures.push({ code: "AUDIO_CODEC_MISMATCH", message: `Output audio codec is ${probe.audioCodec ?? "unknown"}; profile requires AAC.` });
  }
  if (probe.sampleRate !== profile.audioSampleRate) {
    failures.push({ code: "SAMPLE_RATE_MISMATCH", message: `Output sample rate is ${probe.sampleRate ?? "unknown"}; profile requires ${profile.audioSampleRate} Hz.` });
  }
  if (probe.fps !== null && Math.abs(probe.fps - profile.fps) > 0.6) {
    failures.push({ code: "FPS_MISMATCH", message: `Output fps is ${probe.fps}; profile targets ${profile.fps}.` });
  }
  if (profile.maxDurationSec !== null && probe.durationSec !== null && probe.durationSec > profile.maxDurationSec + 1.0) {
    failures.push({ code: "DURATION_CAP_EXCEEDED", message: `Output is ${probe.durationSec.toFixed(1)}s; ${profile.label} cap is ${profile.maxDurationSec}s.` });
  }
  return { ok: failures.length === 0, failures };
}
