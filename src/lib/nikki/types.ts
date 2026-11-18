/**
 * NIIKI — motion graphics data model (M6). ADDITIVE to the M1 editor model:
 * new zod schemas (graphic style + animation specs + templates) plus enum
 * extensions in editor/model.ts. Old stored sequences keep parsing (all new
 * fields optional/nullable with defaults) — validated by the regression suite.
 *
 * A graphic clip = M1 Clip (on a GRAPHIC track, with graphicTemplateId) +
 * GraphicStyle (editable content/look) + an AnimationSpec (structured,
 * editable after application) + the M1 keyframe model (per-property curves).
 */
import { z } from "zod";

// ── look ────────────────────────────────────────────────────────────────────
export const NikkiAlign = z.enum(["LEFT", "CENTER", "RIGHT"]);
export type NikkiAlignT = z.infer<typeof NikkiAlign>;
export const NikkiShape = z.enum(["none", "bar", "card", "underline"]);
export const NikkiAnchor = z.enum(["LOWER_LEFT", "LOWER_CENTER", "LOWER_RIGHT", "UPPER_LEFT", "UPPER_CENTER", "UPPER_RIGHT", "CENTER", "TITLE_SAFE"]);
export type NikkiAnchor = z.infer<typeof NikkiAnchor>;
export const NikkiHex = z.string().regex(/^#[0-9a-fA-F]{3,8}$/, "hex color like #RRGGBB or #RRGGBBAA");

export const NikkiShadowSchema = z.object({
  enabled: z.boolean().default(true),
  offsetX: z.number().min(-20).max(20).default(2),
  offsetY: z.number().min(-20).max(20).default(2),
  color: NikkiHex.default("#00000080"),
});
export type NikkiShadow = z.infer<typeof NikkiShadowSchema>;

export const NikkiShapeSchema = z.object({
  kind: NikkiShape.default("none"),
  color: NikkiHex.default("#101010CC"),
  accentColor: NikkiHex.default("#D4A017"),
  /** Bar/card thickness in % of frame height (drawbox h / bar accent). */
  thicknessPct: z.number().min(0.5).max(50).default(6),
  widthPct: z.number().min(5).max(100).default(42),
  /** Accent stripe on the leading edge of the bar (width in % of the bar). */
  accentPct: z.number().min(0).max(50).default(3),
});
export type NikkiShapeSpec = z.infer<typeof NikkiShapeSchema>;

// ── kinetic typography ──────────────────────────────────────────────────────
export const NikkiTextAnimMode = z.enum([
  "none",
  "fade", // whole-text fade
  "slide", // slide-in (with direction)
  "scale", // scale-in
  "typewriter", // character reveal, no stagger (same visual class, bounded)
  "wordReveal", // word-by-word fade/rise
  "charReveal", // character-by-character fade (bounded count)
]);
export const NikkiDirection = z.enum(["left", "right", "up", "down"]);

export const NikkiTextAnimSchema = z
  .object({
    mode: NikkiTextAnimMode.default("none"),
    /** Entrance duration in frames (per unit). */
    durationFrames: z.number().int().min(1).max(300).default(18),
    /** Stagger between words/characters in frames. */
    staggerFrames: z.number().int().min(0).max(60).default(3),
    direction: NikkiDirection.default("up"),
    /** Slide distance in % of frame width/height. */
    distancePct: z.number().min(0).max(50).default(6),
    /** Exit animation (fade/slide/scale out). */
    exitMode: z.enum(["none", "fade", "slide", "scale"]).default("none"),
    exitDurationFrames: z.number().int().min(1).max(300).default(14),
    exitDistancePct: z.number().min(0).max(50).default(6),
    /** Animated letter tracking in 1/100 em over the entrance. */
    trackingFrom: z.number().min(-10).max(50).default(0),
    trackingTo: z.number().min(-10).max(50).default(0),
  })
  .prefault({});

export type NikkiTextAnim = z.infer<typeof NikkiTextAnimSchema>;

/** Word emphasis: exact-match words get their own color/scale (editable). */
export const NikkiHighlightSchema = z.object({
  word: z.string().min(1).max(60),
  color: NikkiHex.default("#D4A017"),
  scalePct: z.number().min(50).max(200).default(115),
});
export type NikkiHighlight = z.infer<typeof NikkiHighlightSchema>;

// ── the graphic clip's editable style ───────────────────────────────────────
export const NikkiGraphicStyleSchema = z.object({
  /** Template this clip was created from (versioned registry id). */
  templateId: z.string().min(1).max(64),
  /** Registry version the style was seeded from — upgrades are explicit. */
  templateVersion: z.number().int().min(1).max(99).default(1),
  primaryText: z.string().min(1).max(300),
  secondaryText: z.string().max(300).default(""),
  fontFamily: z.enum(["nikki-sans", "nikki-tamil"]).default("nikki-sans"),
  primarySizePct: z.number().min(1).max(30).default(4.2), // % of frame height
  secondarySizePct: z.number().min(1).max(20).default(2.6),
  primaryColor: NikkiHex.default("#FFFFFF"),
  secondaryColor: NikkiHex.default("#D4D4D0"),
  strokeWidth: z.number().min(0).max(20).default(0),
  strokeColor: NikkiHex.default("#000000"),
  shadow: NikkiShadowSchema.prefault({}),
  shape: NikkiShapeSchema.prefault({}),
  anchor: NikkiAnchor.default("LOWER_LEFT"),
  /** Anchor offsets in % of frame width/height (editable after apply). */
  offsetX: z.number().min(-50).max(50).default(6),
  offsetY: z.number().min(-50).max(50).default(8),
  align: NikkiAlign.default("LEFT"),
  textAnim: NikkiTextAnimSchema.prefault({}),
  highlights: z.array(NikkiHighlightSchema).max(12).default([]),
});
export type NikkiGraphicStyle = z.infer<typeof NikkiGraphicStyleSchema>;

// ── templates (structured, versioned assets) ────────────────────────────────
export const NikkiTemplateCategory = z.enum(["caption", "lower-third", "title", "banner", "logo", "callout"]);
export interface NikkiTemplate {
  id: string;
  version: number;
  label: string;
  category: z.infer<typeof NikkiTemplateCategory>;
  description: string;
  style: NikkiGraphicStyle;
}

/** Resolved graphic state at one frame — the preview draws THIS and the
 *  renderer derives the same numbers. */
export interface NikkiFrameState {
  xPct: number;
  yPct: number;
  scalePct: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  opacity: number;
  blur: number;
  letterSpacingEm: number;
  /** Visible portion of the text per the animation mode (typewriter/char). */
  visibleChars: number;
  /** Per-word visibility windows at this frame (wordReveal mode). */
  wordStates: { index: number; opacity: number; risePct: number }[];
  shapeOpacity: number;
  shapeProgress: number;
}

export interface NikkiTextUnit {
  text: string;
  start: number;
  /** First frame where the unit is fully visible (inclusive). */
  full: number;
}
