/**
 * @beanfx/core — canonical project format v1 (M21 spec §1, §3)
 *
 * `.beanfx.json` — the interchange contract between Studio, hosts and MCP.
 * Design rules:
 *  - `formatVersion` is required and pinned to "beanfx-project-v1".
 *  - Every object uses passthrough parsing: unknown fields are PRESERVED
 *    verbatim through a read→write round trip (forward compatibility).
 *  - Media references are canonical `beanfx-asset://<id>` strings (§9).
 *  - Time is always integer frames on the sequence clock + the sequence's
 *    exact rational fps; no floating-point seconds anywhere.
 */
import { z } from "zod";
import { CORE_FORMAT_VERSION, ASSET_SCHEME } from "./types";

export const CanonicalRational = z.object({ num: z.number().int().positive(), den: z.number().int().positive() });

const AssetRefSchema = z
  .string()
  .regex(new RegExp(`^${ASSET_SCHEME}\\:\\/\\/[A-Za-z0-9_-]{1,64}$`), "must be beanfx-asset://<id>")
  .or(z.literal(""));

const BaseClip = z
  .object({
    id: z.string().min(1).max(64),
    trackId: z.string().min(1).max(64),
    asset: AssetRefSchema, // canonical reference ("" = placeholder, must set missingMedia)
    missingMedia: z.boolean().default(false),
    sourceInFrame: z.number().int().min(0),
    sourceOutFrame: z.number().int().min(0),
    sourceFps: CanonicalRational,
    timelineStartFrame: z.number().int().min(0),
    timelineDurationFrames: z.number().int().min(1),
    playbackSpeed: z.number().positive().max(16).default(1),
    volume: z.number().min(0).max(4).default(1),
    muted: z.boolean().default(false),
    fadeInFrames: z.number().int().min(0).default(0),
    fadeOutFrames: z.number().int().min(0).default(0),
    transform: z.record(z.string(), z.unknown()).default({}),
    captionText: z.string().max(2000).nullable().default(null),
    captionStyle: z.record(z.string(), z.unknown()).nullable().default(null),
    graphicTemplateId: z.string().max(64).nullable().default(null),
    graphicStyle: z.record(z.string(), z.unknown()).nullable().default(null),
    label: z.string().max(120).nullable().default(null),
    effects: z.array(z.record(z.string(), z.unknown())).max(32).default([]),
    keyframes: z.array(z.record(z.string(), z.unknown())).max(512).default([]),
  })
  .passthrough();

const BaseTrack = z
  .object({
    id: z.string().min(1).max(64),
    // Full Studio TrackKind union — converters are lossless for CAPTION/
    // GRAPHIC/OVERLAY tracks too (M1–M20 rule: never drop a track).
    kind: z.enum(["VIDEO", "AUDIO", "CAPTION", "GRAPHIC", "OVERLAY"]),
    name: z.string().min(1).max(80),
    visible: z.boolean().default(true),
    muted: z.boolean().default(false),
    solo: z.boolean().default(false),
    locked: z.boolean().default(false),
  })
  .passthrough();

const BaseTransition = z
  .object({
    id: z.string().min(1).max(64),
    trackId: z.string().min(1).max(64),
    kind: z.string().max(32),
    startFrame: z.number().int().min(0),
    endFrame: z.number().int().min(0),
    durationFrames: z.number().int().min(1),
    clipAId: z.string().min(1).max(64),
    clipBId: z.string().min(1).max(64),
    params: z.record(z.string(), z.number()).default({}),
  })
  .passthrough();

export const CanonicalAssetSchema = z
  .object({
    id: z.string().min(1).max(64),
    originalName: z.string().max(255),
    // Full Studio TrackKind union — converters are lossless for CAPTION/
    // GRAPHIC/OVERLAY tracks too (M1–M20 rule: never drop a track).
    kind: z.enum(["VIDEO", "AUDIO", "CAPTION", "GRAPHIC", "OVERLAY"]),
    mimeType: z.string().max(120),
    sizeBytes: z.number().int().min(0),
    durationSec: z.number().nonnegative().nullable().default(null),
    width: z.number().int().nullable().default(null),
    height: z.number().int().nullable().default(null),
    fps: CanonicalRational.nullable().default(null),
    /** Provenance is carried, never stripped (M14/M15 rule). */
    provenance: z.record(z.string(), z.unknown()).nullable().default(null),
  })
  .passthrough();

export const CanonicalEditOpSchema = z.object({
  id: z.string().min(1).max(64),
  /** Mirrors the M1–M20 command model; adapters apply these as transactions. */
  op: z.enum([
    "INSERT_CLIP",
    "OVERWRITE_CLIP",
    "MOVE_CLIP",
    "TRIM_CLIP",
    "SPLIT_CLIP",
    "DELETE_CLIP",
    "SET_CLIP_PROPS",
    "SET_TRANSITION",
    "REMOVE_TRANSITION",
    "ADD_TRACK",
    "REMOVE_TRACK",
  ]),
  /** Machine-checkable inverse of this op (M21 §10). */
  inverse: z.record(z.string(), z.unknown()).nullable().default(null),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string().optional(),
});

export const CanonicalProjectSchema = z
  .object({
    formatVersion: z.literal("beanfx-project-v1"),
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(120),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    baseVersion: z.number().int().min(0).default(0), // optimistic concurrency (§11)
    fps: CanonicalRational,
    width: z.number().int().min(16).max(8192),
    height: z.number().int().min(16).max(8192),
    sampleRate: z.number().int().min(8000).max(384000),
    tracks: z.array(BaseTrack).max(64),
    clips: z.array(BaseClip).max(20000),
    transitions: z.array(BaseTransition).max(4000),
    assets: z.array(CanonicalAssetSchema).max(5000).default([]),
    /** Reversible op journal (§10) — newest last. */
    editOps: z.array(CanonicalEditOpSchema).max(100000).default([]),
  })
  .passthrough();

export type CanonicalClip = z.infer<typeof BaseClip>;
export type CanonicalTrack = z.infer<typeof BaseTrack>;
export type CanonicalTransition = z.infer<typeof BaseTransition>;
export type CanonicalAsset = z.infer<typeof CanonicalAssetSchema>;
export type CanonicalEditOp = z.infer<typeof CanonicalEditOpSchema>;
export type CanonicalProject = z.infer<typeof CanonicalProjectSchema>;

export function parseCanonicalProject(raw: unknown): CanonicalProject {
  const p = CanonicalProjectSchema.safeParse(raw);
  if (!p.success) {
    throw new Error(`beanfx project parse failed: ${p.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return p.data;
}

export { CORE_FORMAT_VERSION };
