"use client";

/**
 * NIIKI — canvas preview renderer (M6 §8).
 *
 * Draws the resolved NikkiFrameState for one frame onto a 2D canvas. This is
 * the REAL preview path used by the program monitor (no screenshots, no
 * mockups): the monitor's playhead clock triggers a redraw per frame and this
 * module evaluates the SAME state the export path renders.
 *
 * Font handling: the bundled Noto fonts are loaded via the FontFace API
 * (nikki-sans / nikki-tamil) before drawing; until a font is ready the
 * browser falls back (documented) and the canvas re-renders on load.
 */
import type { Clip, Sequence } from "@/lib/editor/model";
import type { NikkiFrameState, NikkiGraphicStyle } from "./types";
import { segmentWords, highlightFor } from "./typography";

/** Font family name registered by the monitor's font loader. */
export const NIKKI_FONTS = {
  "nikki-sans": { file: "/fonts/NotoSans-Bold.ttf", family: "Nikki Sans" },
  "nikki-tamil": { file: "/fonts/NotoSansTamil-Regular.ttf", family: "Nikki Tamil" },
} as const;

let fontsLoaded = false;
/** Idempotent FontFace load; resolves when both bundled fonts are usable. */
export async function ensureNikkiFonts(): Promise<void> {
  if (fontsLoaded || typeof document === "undefined") return;
  const loads = Object.values(NIKKI_FONTS).map(async (f) => {
    const face = new FontFace(f.family, `url(${f.file})`);
    await face.load();
    (document.fonts as FontFaceSet).add(face);
  });
  await Promise.all(loads).catch(() => undefined);
  fontsLoaded = true;
}

const hexToRgba = (hex: string, alpha: number): string => {
  const m = hex.replace("#", "");
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  const aHex = m.length >= 8 ? parseInt(m.slice(6, 8), 16) / 255 : 1;
  return `rgba(${r},${g},${b},${(aHex * alpha).toFixed(3)})`;
};

/**
 * Draw one graphic clip's state. ctx must be sized to seqW×seqH; the anchor
 * point is the local origin (position/rotation/scale applied once around it).
 */
export function drawGraphicFrame(
  ctx: CanvasRenderingContext2D,
  style: NikkiGraphicStyle,
  state: NikkiFrameState,
  seq: { width: number; height: number },
): void {
  const W = seq.width;
  const H = seq.height;
  const x = (state.xPct / 100) * W;
  const y = (state.yPct / 100) * H;
  const scale = Math.max(0.001, (state.scalePct / 100) * state.scaleX);

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, state.opacity));
  ctx.translate(x, y);
  ctx.rotate((state.rotation * Math.PI) / 180);
  ctx.scale((state.scalePct / 100) * state.scaleX, (state.scalePct / 100) * state.scaleY);

  const family = NIKKI_FONTS[style.fontFamily]?.family ?? "Nikki Sans";
  const fontSpec = (px: number): string => `${Math.round(px)}px "${family}", "Noto Sans Tamil", "Noto Sans", sans-serif`;
  const primaryPx = (style.primarySizePct / 100) * H;
  const secondaryPx = (style.secondarySizePct / 100) * H;
  const letterSpacing = state.letterSpacingEm * primaryPx;
  const mode = style.textAnim.mode;

  /** One text run at the local origin's baseline. */
  const drawTextRun = (text: string, sizePx: number, color: string, alphaMult: number, trackingPx: number): void => {
    ctx.font = fontSpec(sizePx);
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = trackingPx !== 0 || style.align === "LEFT" ? "left" : ctx.textAlign;
    if (style.shadow.enabled) {
      ctx.shadowColor = hexToRgba(style.shadow.color, 0.9 * alphaMult);
      ctx.shadowOffsetX = style.shadow.offsetX;
      ctx.shadowOffsetY = style.shadow.offsetY;
    }
    const drawWithAlign = (drawFn: (x: number) => void): void => {
      if (trackingPx !== 0) {
        // manual per-cluster tracking (Unicode-safe: clusters, not code units)
        const clusters = Array.from(text);
        const widths = clusters.map((c) => ctx.measureText(c).width + trackingPx);
        const total = widths.reduce((s, w) => s + w, 0) - (widths.length ? trackingPx : 0);
        let cx = style.align === "CENTER" ? -total / 2 : style.align === "RIGHT" ? -total : 0;
        clusters.forEach((c, i) => {
          ctx.save();
          ctx.translate(cx, 0);
          drawFn(0);
          cx += widths[i];
          ctx.restore();
          void c;
          void i;
        });
        return;
      }
      drawFn(0);
    };
    if (style.strokeWidth > 0) {
      ctx.lineWidth = style.strokeWidth;
      ctx.strokeStyle = hexToRgba(style.strokeColor, alphaMult);
      drawWithAlign((x0) => ctx.strokeText(text, x0, 0));
    }
    ctx.fillStyle = hexToRgba(color, alphaMult);
    drawWithAlign((x0) => ctx.fillText(text, x0, 0));
    ctx.shadowColor = "transparent";
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  };

  // ── shape behind the text (local space; origin = anchor) ─────────────────
  if (style.shape.kind !== "none") {
    ctx.globalAlpha *= Math.max(0, Math.min(1, state.shapeOpacity));
    const primaryLines = style.primaryText.split("\n").length;
    const blockH = primaryPx * primaryLines * 1.15 + (style.secondaryText ? secondaryPx * 1.35 : 0);
    const barW = (style.shape.widthPct / 100) * W * Math.max(0.001, state.shapeProgress);
    const thickness = (style.shape.thicknessPct / 100) * H;
    const pad = primaryPx * 0.55;
    let bx = style.align === "CENTER" ? -barW / 2 : style.align === "RIGHT" ? -barW - pad : -pad;
    let by = style.anchor.startsWith("UPPER") ? -pad * 0.7 : -primaryPx * 0.85;
    if (style.shape.kind === "card" || style.shape.kind === "bar") {
      ctx.fillStyle = hexToRgba(style.shape.color, 1);
      ctx.fillRect(bx, by, barW, blockH + thickness);
      if (style.shape.accentPct > 0) {
        const accentW = (style.shape.accentPct / 100) * barW;
        ctx.fillStyle = hexToRgba(style.shape.accentColor, 1);
        ctx.fillRect(style.align === "RIGHT" ? bx + barW - accentW : bx, by, accentW, blockH + thickness);
      }
    } else if (style.shape.kind === "underline") {
      const underlineW = (style.shape.widthPct / 100) * W * Math.max(0.001, state.shapeProgress);
      const uw = Math.max(0.7, style.shape.thicknessPct / 100) * H;
      ctx.fillStyle = hexToRgba(style.shape.accentColor, 1);
      const ux = style.align === "CENTER" ? -underlineW / 2 : style.align === "RIGHT" ? -underlineW : 0;
      ctx.fillRect(ux, primaryPx * primaryLines * 1.22, underlineW, uw);
    }
    ctx.globalAlpha = Math.max(0, Math.min(1, state.opacity));
  }

  // ── text ─────────────────────────────────────────────────────────────────
  if (mode === "wordReveal") {
    // Per-word draw at measured offsets so alpha/rise/highlight work per word.
    const wordList = segmentWords(style.primaryText);
    ctx.font = fontSpec(primaryPx);
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    const spaceW = ctx.measureText(" ").width + letterSpacing;
    const widths = wordList.map((w) => {
      let wWidth = 0;
      for (const ch of Array.from(w.text)) wWidth += ctx.measureText(ch).width + letterSpacing;
      return Math.max(0, wWidth - letterSpacing);
    });
    const total = widths.reduce((s, w) => s + w, 0) + spaceW * Math.max(0, wordList.length - 1);
    let cursor = style.align === "CENTER" ? -total / 2 : style.align === "RIGHT" ? -total : 0;
    wordList.forEach((w, i) => {
      const ws = state.wordStates[i];
      const alpha = ws ? ws.opacity : 1;
      if (alpha > 0.004) {
        ctx.save();
        ctx.globalAlpha *= alpha;
        ctx.translate(cursor, ((ws ? ws.risePct : 0) / 100) * H);
        const hl = highlightFor(style, w.text);
        const wScale = (hl ? hl.scalePct : 100) / 100;
        ctx.scale(wScale, wScale);
        drawTextRun(w.text, primaryPx, hl ? hl.color : style.primaryColor, 1, 0);
        ctx.restore();
      }
      cursor += widths[i] + spaceW;
    });
    if (style.secondaryText) {
      drawTextRun(style.secondaryText, secondaryPx, style.secondaryColor, 1, 0);
    }
  } else if (mode === "typewriter" || mode === "charReveal") {
    const shown = full(style).slice(0, Math.min(state.visibleChars, full(style).length));
    const lines = shown.split("\n");
    lines.forEach((line, li) => {
      const isPrimary = full(style).indexOf("\n") < 0 || li === 0;
      drawTextRun(line, isPrimary ? primaryPx : secondaryPx, isPrimary ? style.primaryColor : style.secondaryColor, 1, letterSpacing);
    });
  } else {
    drawTextRun(style.primaryText, primaryPx, style.primaryColor, 1, letterSpacing);
    if (style.secondaryText) {
      const lines = style.primaryText.split("\n").length;
      ctx.save();
      ctx.translate(0, primaryPx * lines * 1.25);
      drawTextRun(style.secondaryText, secondaryPx, style.secondaryColor, 1, state.letterSpacingEm * secondaryPx);
      ctx.restore();
    }
  }

  ctx.restore();
}

/** Full text of a graphic clip (primary + newline + secondary). */
function full(style: NikkiGraphicStyle): string {
  return `${style.primaryText}${style.secondaryText ? `\n${style.secondaryText}` : ""}`;
}

/**
 * Draw every active graphic at a frame, compositing order = track order
 * (earlier tracks first). Returns false when nothing was drawn (caller can
 * skip the layer).
 */
export function drawGraphicsLayer(
  ctx: CanvasRenderingContext2D,
  seq: Sequence,
  frame: number,
  graphics: Array<{ clip: Clip; state: { style: NikkiGraphicStyle } & NikkiFrameState }>,
): boolean {
  if (graphics.length === 0) return false;
  ctx.clearRect(0, 0, seq.width, seq.height);
  for (const g of graphics) {
    if (!g.state.style) continue;
    drawGraphicFrame(ctx, g.state.style, g.state, { width: seq.width, height: seq.height });
  }
  return true;
}
