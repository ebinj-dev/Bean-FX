/**
 * @beanfx/core — converters between the Studio Sequence model and the
 * canonical project format v1 (M21 spec §1, §3).
 *
 * Contract: `sequenceToCanonical` then `canonicalToSequence` is a LOSSLESS
 * identity on every M1–M20 sequence feature (fps, tracks, clips, transforms,
 * captions, effects, keyframes, transitions). Canonical projects carry the
 * originals in their typed fields; unknown canonical fields are preserved
 * by the passthrough schemas. A conversion failure never mutates its input.
 */
import { z } from "zod";
import { SequenceSchema, type Sequence, type TrackKind } from "../editor/model";
import {
  CanonicalProjectSchema,
  parseCanonicalProject,
  type CanonicalProject,
} from "./project-schema";
import { assetRef } from "./types";

/** Studio Sequence → canonical project. Does NOT mutate the input. */
export function sequenceToCanonical(seq: unknown, opts?: { projectId?: string; baseVersion?: number }): CanonicalProject {
  const parsed = SequenceSchema.safeParse(seq);
  if (!parsed.success) {
    throw new Error(`sequence parse failed: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const s = parsed.data;
  const project: CanonicalProject = {
    formatVersion: "beanfx-project-v1",
    id: opts?.projectId ?? s.id,
    name: s.name,
    baseVersion: opts?.baseVersion ?? 0,
    fps: { num: s.fps.num, den: s.fps.den },
    width: s.width,
    height: s.height,
    sampleRate: s.sampleRate,
    tracks: s.tracks.map((t) => ({ ...t })),
    clips: s.clips.map((c) => ({
      ...c,
      asset: c.sourceAssetId ? assetRef(c.sourceAssetId) : "",
      transform: c.transform as unknown as Record<string, unknown>,
      captionStyle: (c.captionStyle ?? null) as unknown as Record<string, unknown> | null,
      graphicStyle: (c.graphicStyle ?? null) as unknown as Record<string, unknown> | null,
      effects: c.effects as unknown as Record<string, unknown>[],
      keyframes: c.keyframes as unknown as Record<string, unknown>[],
    })),
    transitions: s.transitions.map((t) => ({ ...t })),
    assets: [],
    editOps: [],
  };
  const check = CanonicalProjectSchema.safeParse(project);
  if (!check.success) {
    throw new Error(`canonical emit failed: ${check.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return check.data;
}

/** Canonical project → Studio Sequence. Does NOT mutate the input. */
export function canonicalToSequence(project: unknown): Sequence {
  const c = parseCanonicalProject(project);
  const seq = {
    id: c.id,
    name: c.name,
    fps: { num: c.fps.num, den: c.fps.den },
    width: c.width,
    height: c.height,
    sampleRate: c.sampleRate,
    tracks: c.tracks.map((t) => ({
      id: t.id,
      kind: t.kind as TrackKind,
      name: t.name,
      visible: t.visible,
      muted: t.muted,
      solo: t.solo,
      locked: t.locked,
    })),
    clips: c.clips.map((clip) => {
      const ref = /^beanfx-asset:\/\/(.+)$/.exec(clip.asset);
      return {
        ...clip,
        sourceAssetId: ref ? ref[1] : "",
        transform: clip.transform as never,
        captionStyle: clip.captionStyle as never,
        graphicStyle: clip.graphicStyle as never,
        effects: clip.effects as never[],
        keyframes: clip.keyframes as never[],
      };
    }),
    transitions: c.transitions.map((t) => ({ ...t, kind: t.kind as never })),
  };
  const parsed = SequenceSchema.safeParse(seq);
  if (!parsed.success) {
    throw new Error(`canonical→sequence failed: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

/** Round-trip equality on the JSON representations (ignoring canonical-only fields). */
export function sequenceRoundTripEqual(seq: unknown): boolean {
  const can = sequenceToCanonical(seq);
  const back = canonicalToSequence(can);
  const again = sequenceToCanonical(back, { projectId: can.id, baseVersion: can.baseVersion });
  return stableStringify(stripCanonicalOnly(again)) === stableStringify(stripCanonicalOnly(can));
}

function stripCanonicalOnly(p: CanonicalProject): Record<string, unknown> {
  const { assets: _a, editOps: _e, createdAt: _c, updatedAt: _u, ...rest } = p;
  return rest as unknown as Record<string, unknown>;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
    }
    return v;
  });
}

export { z };
