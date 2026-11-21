/**
 * M31 SHOWCASE STUDIO — Composition primitives (Phase 6).
 *
 * ORIGINAL deterministic motion layer on the EXISTING canonical timeline:
 * every primitive emits plain editor-model data (property keyframes, effect
 * parameter keyframes, NIIKI graphic styles, transform, captions) that flows
 * through the SAME validated AddClip/UpdateClip commands as manual editing.
 * No second animation timebase: `frame` is CLIP-RELATIVE on the timeline clock,
 * exactly like the editor's keyframes (src/lib/editor/model.ts).
 *
 * Rules:
 * - Pure functions → deterministic, unit-testable, render==preview.
 * - Emitting a primitive NEVER invents content: text/stat values must come
 *   from the approved storyboard/artifact (stat-reveal refuses unverified numbers).
 * - Keyframes are emitted pre-sorted, within clip duration, ≤ editor caps.
 */
import { z } from "zod";

// ── Editor-model-shaped emission types ──────────────────────────────────────
export const PropertyKeyframeSchema = z.object({
  id: z.string().max(64),
  property: z.enum(["opacity", "scale", "x", "y", "volume", "rotation", "scaleX", "scaleY", "blur", "letterSpacing"]),
  frame: z.number().int().min(0),
  value: z.number(),
  interpolation: z.enum(["LINEAR", "HOLD", "EASE", "EASE_IN", "EASE_OUT", "EASE_IN_OUT", "BEZIER"]).default("EASE_OUT"),
});
export const EffectEmitSchema = z.object({
  id: z.string().max(64),
  type: z.enum(["blur", "brightness", "contrast", "saturation", "temperature", "highlights", "shadows", "sharpen", "vignette", "whites", "blacks", "crop"]),
  enabled: z.boolean().default(true),
  params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).default({}),
  keyframes: z.array(z.object({ id: z.string().max(64), param: z.string().max(32), frame: z.number().int().min(0), value: z.number(), interpolation: z.enum(["HOLD", "LINEAR", "EASE_IN", "EASE_OUT", "EASE_IN_OUT"]).default("EASE_IN_OUT") })).max(256).default([]),
  animatedParams: z.array(z.string().max(32)).max(16).default([]),
});
export const GraphicEmitSchema = z.object({
  /** A REAL registered NIIKI template id (src/lib/nikki/templates.ts) the
   *  showcase primitive composes onto — never a fake registry entry. */
  templateId: z.string().max(64),
  primaryText: z.string().max(300),
  secondaryText: z.string().max(300).default(""),
  anchor: z.enum(["UPPER_LEFT", "UPPER_CENTER", "UPPER_RIGHT", "CENTER", "LOWER_LEFT", "LOWER_CENTER", "LOWER_RIGHT"]).default("LOWER_LEFT"),
  textAnim: z.object({ mode: z.enum(["none", "fade", "slide", "scale", "typewriter", "wordReveal", "charReveal"]).default("fade"), durationFrames: z.number().int().min(1).default(18) }).default({ mode: "fade", durationFrames: 18 }),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#FFFFFF"),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#D4A017"),
});
export type PropertyKeyframe = z.infer<typeof PropertyKeyframeSchema>;
export type EffectEmit = z.infer<typeof EffectEmitSchema>;
export type GraphicEmit = z.infer<typeof GraphicEmitSchema>;

export interface PrimitiveEmission {
  primitive: string;
  keyframes: PropertyKeyframe[];
  effects: EffectEmit[];
  graphic: GraphicEmit | null;
  note: string;
}

// ── Easing (deterministic — the renderer/preview interpolate identically) ───
export const INTERP = { linear: "LINEAR", easeOut: "EASE_OUT", easeIn: "EASE_IN", easeInOut: "EASE_IN_OUT", hold: "HOLD" } as const;
type Interp = (typeof INTERP)[keyof typeof INTERP];

let kfSeq = 0;
function kf(property: PropertyKeyframe["property"], frame: number, value: number, interp: Interp = INTERP.easeOut): PropertyKeyframe {
  kfSeq = (kfSeq + 1) % 1_000_000;
  return { id: `show-kf-${kfSeq.toString(36)}`, property, frame: Math.max(0, Math.round(frame)), value, interpolation: interp };
}
let efSeq = 0;
function effect(type: EffectEmit["type"], params: Record<string, number | string | boolean>, keyframes: EffectEmit["keyframes"] = [], animatedParams: string[] = []): EffectEmit {
  efSeq = (efSeq + 1) % 1_000_000;
  return { id: `show-ef-${efSeq.toString(36)}`, type, enabled: true, params, keyframes, animatedParams };
}
function efk(param: string, frame: number, value: number, interpolation: "HOLD" | "LINEAR" | "EASE_IN" | "EASE_OUT" | "EASE_IN_OUT" = "EASE_IN_OUT"): EffectEmit["keyframes"][number] {
  efSeq = (efSeq + 1) % 1_000_000;
  return { id: `show-efk-${efSeq.toString(36)}`, param, frame: Math.max(0, Math.round(frame)), value, interpolation };
}

function graphic(partial: Partial<GraphicEmit> & { templateId: string; primaryText: string }): GraphicEmit {
  return GraphicEmitSchema.parse(partial);
}

// ── Primitives ──────────────────────────────────────────────────────────────
export type PrimitiveId =
  | "hero-product-reveal" | "cinematic-title" | "feature-spotlight" | "ui-demonstration"
  | "floating-product-frame" | "split-screen-comparison" | "product-showcase"
  | "stat-reveal" | "end-card" | "logo-reveal" | "cta-scene";

export interface PrimitiveContext {
  fps: number;
  durationFrames: number;
  /** Approved text for this scene's overlay (from the storyboard). */
  overlayText?: string;
  secondaryText?: string;
  /** Brand accent (validated hex) from the product-understanding artifact. */
  accentColor?: string;
  /** For stat-reveal ONLY: a verified claim + its evidence reference. */
  verifiedStat?: { value: string; evidence: string };
  /** Split-screen direction. */
  split?: "left" | "right";
}

export interface PrimitiveDef {
  id: PrimitiveId;
  label: string;
  description: string;
  minDurationFrames: number;
  emit(ctx: PrimitiveContext): PrimitiveEmission;
}

const D = (f: number, fps: number) => Math.max(1, Math.round(f * fps)); // seconds → frames

const RAW_PRIMITIVES: PrimitiveDef[] = [
  {
    id: "hero-product-reveal",
    label: "Hero product reveal",
    description: "Product resolves from soft blur + 92% scale to full frame with a settled hold — the classic premium reveal.",
    minDurationFrames: 24,
    emit: ({ fps, durationFrames }) => {
      const settle = D(0.6, fps);
      return {
        primitive: "hero-product-reveal",
        keyframes: [
          kf("scale", 0, 0.92, INTERP.easeOut), kf("scale", settle, 1.0),
          kf("opacity", 0, 0, INTERP.easeOut), kf("opacity", D(0.25, fps), 1),
          kf("blur", 0, 8, INTERP.easeOut), kf("blur", settle, 0),
        ],
        effects: [], // blur resolves via the `blur` property keyframes above (no duplicate effect layer)
        graphic: null,
        note: "scale/opacity/blur resolve over the first ~0.6s, then hold.",
      };
    },
  },
  {
    id: "cinematic-title",
    label: "Cinematic title",
    description: "Word-reveal title treatment on the approved headline; letters settle once and stay readable.",
    minDurationFrames: 36,
    emit: ({ fps, durationFrames, overlayText, accentColor }) => ({
      primitive: "cinematic-title",
      keyframes: [],
      effects: [],
      graphic: graphic({
        templateId: "title-scale-in",
        primaryText: overlayText ?? "",
        anchor: "CENTER",
        textAnim: { mode: "wordReveal", durationFrames: D(0.7, fps) },
        primaryColor: "#FFFFFF",
        accentColor: accentColor ?? "#D4A017",
      }),
      note: "NIIKI wordReveal within the first ~0.7s; title must hold ≥1.2s for readability.",
    }),
  },
  {
    id: "feature-spotlight",
    label: "Feature spotlight",
    description: "Slow push-in with vignette focus on one product element; text enters after the move starts.",
    minDurationFrames: 36,
    emit: ({ fps, durationFrames, overlayText }) => {
      const push = Math.max(D(1.0, fps), Math.round(durationFrames * 0.7));
      return {
        primitive: "feature-spotlight",
        keyframes: [kf("scale", 0, 1.0, INTERP.linear), kf("scale", Math.min(push, durationFrames - 1), 1.08, INTERP.easeInOut)],
        effects: [effect("vignette", { amount: 0.35 })],
        graphic: overlayText ? graphic({ templateId: "lower-third-card", primaryText: overlayText, anchor: "LOWER_LEFT", textAnim: { mode: "slide", durationFrames: D(0.4, fps) } }) : null,
        note: "Push-in completes before the hold-out; vignette keeps focus center-weighted.",
      };
    },
  },
  {
    id: "ui-demonstration",
    label: "UI demonstration",
    description: "Real UI capture with a gentle drift zoom; cursor/click accents are LABELLED illustrative via metadata, never faked as captured behavior.",
    minDurationFrames: 36,
    emit: ({ fps, durationFrames }) => {
      const drift = Math.max(durationFrames - 2, D(1.2, fps));
      return {
        primitive: "ui-demonstration",
        keyframes: [
          kf("scale", 0, 1.0, INTERP.linear), kf("scale", drift, 1.04, INTERP.easeInOut),
          kf("x", 0, 0, INTERP.linear), kf("x", drift, -6, INTERP.easeInOut),
        ],
        effects: [effect("sharpen", { amount: 0.2 })],
        graphic: null,
        note: "Drift keeps the capture alive without misrepresenting the UI; interactive accents must come from the demonstration plan (illustrative=true when simulated).",
      };
    },
  },
  {
    id: "floating-product-frame",
    label: "Floating product frame",
    description: "Subtle vertical bob and breathing scale around a centered product shot.",
    minDurationFrames: 36,
    emit: ({ fps, durationFrames }) => {
      const period = D(2.0, fps);
      const kfs: PropertyKeyframe[] = [kf("y", 0, -4, INTERP.easeInOut)];
      for (let f = period; f < durationFrames; f += period) kfs.push(kf("y", f, (Math.round(f / period) % 2 === 0) ? -4 : 4, INTERP.easeInOut));
      return {
        primitive: "floating-product-frame",
        keyframes: [...kfs, kf("scale", 0, 1.0, INTERP.linear), kf("scale", durationFrames - 1, 1.02, INTERP.easeInOut)],
        effects: [],
        graphic: null,
        note: "±4px bob at a 2s period — motion without distraction.",
      };
    },
  },
  {
    id: "split-screen-comparison",
    label: "Split-screen comparison",
    description: "Problem/solution or before/after halves via the crop effect; the split line stays static for readability.",
    minDurationFrames: 48,
    emit: ({ fps, durationFrames, split }) => {
      const half = 50;
      const crop = effect("crop", split === "right" ? { left: half, right: 0, top: 0, bottom: 0 } : { left: 0, right: half, top: 0, bottom: 0 });
      return {
        primitive: "split-screen-comparison",
        keyframes: [kf("opacity", 0, 0, INTERP.easeOut), kf("opacity", D(0.3, fps), 1)],
        effects: [crop],
        graphic: null,
        note: "Apply to the SECOND clip; the pair shares timelineStartFrame. `split` chooses the visible half.",
      };
    },
  },
  {
    id: "product-showcase",
    label: "Product showcase orbit",
    description: "Slow lateral arc (x drift + slight rotation) presenting the product like a turntable.",
    minDurationFrames: 48,
    emit: ({ fps, durationFrames }) => ({
      primitive: "product-showcase",
      keyframes: [
        kf("x", 0, 14, INTERP.easeInOut), kf("x", durationFrames - 1, -14, INTERP.easeInOut),
        kf("rotation", 0, 1.5, INTERP.easeInOut), kf("rotation", durationFrames - 1, -1.5, INTERP.easeInOut),
      ],
      effects: [],
      graphic: null,
      note: "Arc amplitude ±14px / ±1.5° — presentational, not flashy.",
    }),
  },
  {
    id: "stat-reveal",
    label: "Number/stat reveal",
    description: "A verified product stat resolves on screen. REFUSES to render when the value lacks recorded evidence.",
    minDurationFrames: 36,
    emit: ({ fps, verifiedStat, accentColor }) => {
      if (!verifiedStat?.value || !verifiedStat.evidence) {
        return { primitive: "stat-reveal", keyframes: [], effects: [], graphic: null, note: "REFUSED — no verified stat/evidence provided. A stat without evidence is never rendered." };
      }
      return {
        primitive: "stat-reveal",
        keyframes: [kf("scale", 0, 0.85, INTERP.easeOut), kf("scale", D(0.5, fps), 1.0), kf("opacity", 0, 0), kf("opacity", D(0.3, fps), 1)],
        effects: [],
        graphic: graphic({ templateId: "news-banner", primaryText: verifiedStat.value, secondaryText: verifiedStat.evidence.slice(0, 120), anchor: "CENTER", textAnim: { mode: "fade", durationFrames: D(0.35, fps) }, accentColor: accentColor ?? "#D4A017" }),
        note: `Evidence recorded: ${verifiedStat.evidence.slice(0, 80)}`,
      };
    },
  },
  {
    id: "end-card",
    label: "End card",
    description: "Product name + CTA close-out; hold long enough to read (≥1.5s at 24fps+).",
    minDurationFrames: 36,
    emit: ({ fps, overlayText, secondaryText, accentColor }) => ({
      primitive: "end-card",
      keyframes: [kf("opacity", 0, 0, INTERP.easeOut), kf("opacity", D(0.25, fps), 1), kf("scale", 0, 0.97, INTERP.easeOut), kf("scale", D(0.45, fps), 1.0)],
      effects: [],
      graphic: graphic({ templateId: "title-intro-slide", primaryText: overlayText ?? "", secondaryText: secondaryText ?? "", anchor: "CENTER", textAnim: { mode: "slide", durationFrames: D(0.4, fps) }, accentColor: accentColor ?? "#D4A017" }),
      note: "CTA text comes from the approved artifact — never an invented claim.",
    }),
  },
  {
    id: "logo-reveal",
    label: "Logo reveal",
    description: "Logo resolves from blur with a subtle scale overshoot and settle.",
    minDurationFrames: 24,
    emit: ({ fps }) => {
      const settle = D(0.5, fps);
      return {
        primitive: "logo-reveal",
        keyframes: [kf("blur", 0, 10, INTERP.easeOut), kf("blur", settle, 0), kf("scale", 0, 1.06, INTERP.easeOut), kf("scale", D(0.7, fps), 1.0)],
        effects: [],
        graphic: null,
        note: "Apply to the logo/brand clip; overshoot settles by ~0.7s.",
      };
    },
  },
  {
    id: "cta-scene",
    label: "CTA scene",
    description: "Final call-to-action with a single gentle pulse; readable, platform-safe, no flashing.",
    minDurationFrames: 36,
    emit: ({ fps, durationFrames, overlayText, accentColor }) => {
      const pulsePeriod = D(1.6, fps);
      const pulse: PropertyKeyframe[] = [];
      for (let f = D(0.8, fps); f + pulsePeriod / 2 < durationFrames; f += pulsePeriod) {
        pulse.push(kf("scale", f, 1.0, INTERP.easeInOut), kf("scale", f + pulsePeriod / 2, 1.03, INTERP.easeInOut));
      }
      return {
        primitive: "cta-scene",
        keyframes: [kf("opacity", 0, 0), kf("opacity", D(0.3, fps), 1), ...pulse],
        effects: [],
        graphic: graphic({ templateId: "section-heading", primaryText: overlayText ?? "", anchor: "CENTER", textAnim: { mode: "fade", durationFrames: D(0.3, fps) }, accentColor: accentColor ?? "#D4A017" }),
        note: "Pulse amplitude 3% at ~1.6s period — calm by design.",
      };
    },
  },
];

/** Public registry: every emission leaves with GLOBALLY frame-sorted keyframes
 *  (the editor requires sorted keyframes; sorting is stable so same-frame
 *  pairs keep emission order). Deterministic, applied to all primitives. */
export const COMPOSITION_PRIMITIVES: PrimitiveDef[] = RAW_PRIMITIVES.map((p) => ({
  ...p,
  emit: (ctx: PrimitiveContext): PrimitiveEmission => {
    const em = p.emit(ctx);
    return { ...em, keyframes: [...em.keyframes].sort((a, b) => a.frame - b.frame) };
  },
}));

export function getPrimitive(id: string): PrimitiveDef | null {
  return COMPOSITION_PRIMITIVES.find((p) => p.id === id) ?? null;
}

/** Validate an emission against the editor caps (keyframes sorted, in-range). */
export function validateEmission(em: PrimitiveEmission, ctx: PrimitiveContext): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  const sorted = [...em.keyframes].sort((a, b) => a.frame - b.frame);
  for (let i = 0; i < em.keyframes.length; i++) {
    if (em.keyframes[i].frame !== sorted[i].frame) { issues.push("keyframes must be pre-sorted by frame"); break; }
  }
  for (const k of em.keyframes) {
    if (k.frame > ctx.durationFrames - 1) issues.push(`keyframe ${k.id} frame ${k.frame} exceeds clip duration ${ctx.durationFrames}`);
    if (k.frame < 0) issues.push(`negative keyframe frame on ${k.id}`);
  }
  if (em.keyframes.length > 512) issues.push("over editor cap of 512 property keyframes");
  if (em.effects.length > 32) issues.push("over editor cap of 32 effects");
  for (const e of em.effects) {
    if (e.keyframes.length > 256) issues.push(`effect ${e.id} over 256 param keyframes`);
  }
  if (ctx.durationFrames < (getPrimitive(em.primitive)?.minDurationFrames ?? 1)) issues.push(`clip too short for ${em.primitive}`);
  return { ok: issues.length === 0, issues };
}

// ── NIKKI graphic style construction (real registry, full schema validity) ──
import { templateById } from "@/lib/nikki/templates";
import type { NikkiGraphicStyle, NikkiTemplate } from "@/lib/nikki/types";

/** Clone a REAL NIKKI template style and apply the showcase primitive's text/
 *  look overrides — guarantees a schema-valid NikkiGraphicStyle every time. */
export function nikkiStyleFor(g: GraphicEmit): { templateId: string; style: NikkiGraphicStyle } | null {
  const template: NikkiTemplate | null = templateById(g.templateId);
  if (!template) return null;
  const style: NikkiGraphicStyle = {
    ...template.style,
    templateId: template.id,
    templateVersion: template.version,
    primaryText: g.primaryText.slice(0, 300),
    secondaryText: g.secondaryText.slice(0, 300),
    anchor: g.anchor,
    textAnim: { ...template.style.textAnim, mode: g.textAnim.mode, durationFrames: g.textAnim.durationFrames },
    primaryColor: g.primaryColor,
  };
  return { templateId: template.id, style };
}
