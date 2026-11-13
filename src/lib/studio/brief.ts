/**
 * Social Video Studio — brief + platform profiles (M8.1 §2).
 *
 * Platform profiles are VALIDATED EXPORT SETTINGS mapped onto the real
 * sequence model (width/height 16..8192; rational fps). Publishing is NOT
 * represented as implemented — no authorized platform integrations exist
 * (M8.1 §2). English + Tamil are first-class languages; Tamil-safe text
 * handling lives with NIIKI's nikki-tamil font and RIISHE detection.
 */
import { z } from "zod";

export const StudioLanguage = z.enum(["en", "ta"]);
export type StudioLanguageId = z.infer<typeof StudioLanguage>;

export const StudioPlatform = z.enum(["youtube_shorts", "instagram_reels", "tiktok", "youtube_landscape", "square_social"]);
export type StudioPlatformId = z.infer<typeof StudioPlatform>;

export const StudioAspect = z.enum(["9:16", "16:9", "1:1", "4:5"]);

export interface PlatformProfile {
  platform: StudioPlatformId;
  label: string;
  aspect: "9:16" | "16:9" | "1:1" | "4:5";
  /** Sequence settings validated against the M1 model bounds. */
  width: number;
  height: number;
  fps: { num: number; den: number };
  maxDurationSec: number;
  note: string;
}

export const PLATFORM_PROFILES: Record<StudioPlatformId, PlatformProfile> = {
  youtube_shorts: {
    platform: "youtube_shorts", label: "YouTube Shorts", aspect: "9:16",
    width: 1080, height: 1920, fps: { num: 30, den: 1 }, maxDurationSec: 60,
    note: "Vertical 9:16; Shorts feed cap 60 s.",
  },
  instagram_reels: {
    platform: "instagram_reels", label: "Instagram Reels", aspect: "9:16",
    width: 1080, height: 1920, fps: { num: 30, den: 1 }, maxDurationSec: 90,
    note: "Vertical 9:16; Reels recommended cap 90 s.",
  },
  tiktok: {
    platform: "tiktok", label: "TikTok", aspect: "9:16",
    width: 1080, height: 1920, fps: { num: 30, den: 1 }, maxDurationSec: 180,
    note: "Vertical 9:16; TikTok standard cap 180 s.",
  },
  youtube_landscape: {
    platform: "youtube_landscape", label: "YouTube landscape", aspect: "16:9",
    width: 1920, height: 1080, fps: { num: 30, den: 1 }, maxDurationSec: 300,
    note: "Landscape 16:9 standard YouTube video.",
  },
  square_social: {
    platform: "square_social", label: "Square social video", aspect: "1:1",
    width: 1080, height: 1080, fps: { num: 30, den: 1 }, maxDurationSec: 120,
    note: "Square 1:1 feed video.",
  },
};

export const StudioBriefSchema = z.object({
  topic: z.string().min(3).max(300),
  keywords: z.array(z.string().max(60)).max(8).default([]),
  audience: z.string().max(200).default(""),
  language: StudioLanguage.default("en"),
  objective: z.string().max(200).default("inform"), // inform | promote | explain | entertain
  durationSec: z.number().int().min(15).max(300).default(45),
  platform: StudioPlatform.default("youtube_shorts"),
  tone: z.string().max(120).default("energetic, clear"),
  narrationVoice: z.string().max(60).default("tongtong"),
  narrationSpeed: z.number().min(0.5).max(2.0).default(1.0),
  visualStyle: z.string().max(160).default("clean modern social style"),
  captionsEnabled: z.boolean().default(true),
  musicMood: z.string().max(120).default("upbeat"),
  /** Optional user-supplied script — replaces LLM script writing (MPT parity). */
  customScript: z.string().max(8000).nullable().default(null),
});
export type StudioBrief = z.infer<typeof StudioBriefSchema>;

/** Validate a brief against the platform profile's real constraints. */
export function validateBriefForProfile(brief: StudioBrief): { ok: boolean; error?: string; profile: PlatformProfile } {
  const profile = PLATFORM_PROFILES[brief.platform];
  if (brief.durationSec > profile.maxDurationSec) {
    return { ok: false, error: `Duration ${brief.durationSec}s exceeds the ${profile.label} cap (${profile.maxDurationSec}s).`, profile };
  }
  return { ok: true, profile };
}

/** Sequence settings for a platform (feed into a real BEAN FX project). */
export function profileSequenceSettings(platform: StudioPlatformId): { width: number; height: number; fps: { num: number; den: number }; sampleRate: number } {
  const p = PLATFORM_PROFILES[platform];
  return { width: p.width, height: p.height, fps: p.fps, sampleRate: 48000 };
}
