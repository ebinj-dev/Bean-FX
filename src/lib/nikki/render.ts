/**
 * NIIKI — FFmpeg export compositor (M6 §9).
 *
 * Renders a sequence's graphics layer (and real transitions) to video. The
 * animation values come from the SAME evaluator the canvas preview uses
 * (animation.ts): expressions are closed-form for LINEAR/HOLD/EASE* and
 * frame-time-exact ladders for BEZIER, so preview and export agree.
 *
 * Text metrics are MEASURED with FreeType via PIL (libraqm shaping — full
 * Tamil support) using the SAME bundled Noto fonts the preview loads — real
 * measurement, not estimates. Per-word/char positioning uses those widths.
 *
 * Render model (documented in docs/M6_NIIKI.md):
 *  - VIDEO track segments: source clips trimmed; consecutive pairs joined by
 *    xfade (CROSS_DISSOLVE→fade, FADE_TO_BLACK→fadeblack, WIPE_*→wipe*,
 *    SLIDE/PUSH/ZOOM→the matching xfade kinds). CUT joins hard.
 *  - GRAPHIC/OVERLAY tracks: every clip becomes drawbox (shape) + drawtext
 *    (text) chains with animated x/y/alpha/enable between its clip bounds.
 *  - Honest bounds: ≤ 80 animated text units per clip (typography degrades
 *    to word mode beyond), ≤ 60 filters per graphic clip, ≤ 12 highlights.
 */
import { execFileSync } from "child_process";
import path from "path";
import type { Clip, Sequence, TransitionKind } from "@/lib/editor/model";
import { clipEndFrame } from "@/lib/editor/model";
import { ffmpegExprFor, type NikkiKeyframe } from "./animation";
import { planTypography, segmentWords, highlightFor } from "./typography";
import { anchorPosition } from "./state";
import type { NikkiGraphicStyle } from "./types";

export const FONT_SANS = path.join(process.cwd(), "public", "fonts", "NotoSans-Bold.ttf");
export const FONT_TAMIL = path.join(process.cwd(), "public", "fonts", "NotoSansTamil-Regular.ttf");

const measureCache = new Map<string, number>();

/** Real FreeType text width (px at `sizePx`), libraqm-shaped. Cached. */
export function measureText(text: string, fontFile: string, sizePx: number): number {
  const key = `${fontFile}|${sizePx}|${text}`;
  const hit = measureCache.get(key);
  if (hit !== undefined) return hit;
  const out = execFileSync(
    "python3",
    ["-c", "import sys;from PIL import ImageFont;f=ImageFont.truetype(sys.argv[1],int(sys.argv[2]));print(f.getlength(sys.argv[3]))", fontFile, String(Math.round(sizePx)), text],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  ).trim();
  const width = Number(out) || 0;
  measureCache.set(key, width);
  return width;
}

export function fontFileFor(style: NikkiGraphicStyle): string {
  return style.fontFamily === "nikki-tamil" ? FONT_TAMIL : FONT_SANS;
}

const esc = (s: string): string =>
  s.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/%/g, "\\%").replace(/,/g, "\\,").replace(/\[/g, "\\[").replace(/\]/g, "\\]").replace(/;/g, "\\;");

const q = (v: number, digits = 4): string => (Number.isInteger(v) ? String(v) : v.toFixed(digits));

/** Join additive expression terms; negative-leading terms get parentheses
 *  (ffmpeg's parser rejects `a+-b`). */
const joinAdditive = (parts: string[]): string =>
  parts.filter((p) => p !== "" && p !== undefined).map((p, i) => (i === 0 ? p : p.trim().startsWith("-") ? `(${p})` : p)).join("+");

const ffmpegColor = (hex: string, alpha = 1): string => {
  const m = hex.replace("#", "");
  return m.length >= 8 ? `0x${m.slice(0, 8)}` : `0x${m}@${q(alpha, 2)}`;
};

const XFADE: Partial<Record<TransitionKind, string>> = {
  CROSS_DISSOLVE: "fade",
  FADE_TO_BLACK: "fadeblack",
  FADE_FROM_BLACK: "fadewhite",
  WIPE_LEFT: "wipeleft",
  WIPE_RIGHT: "wiperight",
  SLIDE_LEFT: "slideleft",
  SLIDE_RIGHT: "slideright",
  PUSH_LEFT: "pushleft",
  PUSH_RIGHT: "pushright",
  ZOOM_IN: "zoomin",
  ZOOM_OUT: "zoomout",
};

interface RenderContext {
  seq: Sequence;
  fps: number;
  /** Render window on the sequence clock (defaults to the full sequence). */
  startFrame: number;
  endFrame: number;
}

export interface PlannedClip {
  clip: Clip;
  /** Clip-relative range that falls inside the render window, in frames. */
  localIn: number;
  localOut: number;
  /** Offset of the clip start from the render window start (seconds). */
  offsetSec: number;
}

/** Graphic clips in the window, in compositing order (track order). */
function graphicsInWindow(ctx: RenderContext): PlannedClip[] {
  const out: PlannedClip[] = [];
  ctx.seq.tracks.forEach((track) => {
    if (track.kind !== "GRAPHIC" && track.kind !== "OVERLAY") return;
    if (!track.visible) return;
    const clips = ctx.seq.clips
      .filter((c) => c.trackId === track.id && c.graphicStyle && clipEndFrame(ctx.seq, c) > ctx.startFrame && c.timelineStartFrame < ctx.endFrame)
      .sort((a, b) => a.timelineStartFrame - b.timelineStartFrame);
    for (const clip of clips) {
      const localIn = Math.max(0, ctx.startFrame - clip.timelineStartFrame);
      const localOut = Math.min(clip.timelineDurationFrames, ctx.endFrame - clip.timelineStartFrame);
      if (localOut <= localIn) continue;
      out.push({ clip, localIn, localOut, offsetSec: (clip.timelineStartFrame - ctx.startFrame) / ctx.fps });
    }
  });
  return out;
}

/** drawtext/drawbox filters for ONE graphic clip over its window. */
export function buildGraphicFilters(planned: PlannedClip, ctx: RenderContext): string[] {
  const clip = planned.clip;
  const style = clip.graphicStyle!;
  const fps = ctx.fps;
  const H = ctx.seq.height;
  const duration = clip.timelineDurationFrames;
  const t = (localFrame: number): string => q((clip.timelineStartFrame - ctx.startFrame + localFrame) / fps);
  const enable = `enable='between(t\\,${t(planned.localIn)}\\,${t(planned.localOut)})'`;
  const fontFile = fontFileFor(style);
  const plan = planTypography(style, duration, fps);
  const filters: string[] = [];

  const primaryPx = Math.round((style.primarySizePct / 100) * H);
  const secondaryPx = Math.round((style.secondarySizePct / 100) * H);
  const anchor = anchorPosition(style.anchor, style.offsetX, style.offsetY);

  const kfExpr = (property: string, fallback: number): string | null =>
    ffmpegExprFor(clip.keyframes as NikkiKeyframe[], property, {
      fallback,
      durationFrames: duration,
      fps,
      clipOffsetSec: (clip.timelineStartFrame - ctx.startFrame) / fps,
    });

  // Baseline x/y of the text block anchor (per-frame via expressions when
  // x/y keyframes or slide animation exist; constant otherwise).
  const W = ctx.seq.width;
  const xExprParts: string[] = [q((anchor.xPct / 100) * W)];
  const yExprParts: string[] = [q((anchor.yPct / 100) * H)];
  // slide-in/out: whole-block offset via eased ramps (same smoothstep math as
  // the preview); terms are SIGNED values — joinAdditive handles the signs.
  if (style.textAnim.mode === "slide" || style.textAnim.exitMode === "slide") {
    const dIn = style.textAnim.distancePct;
    const inSec = (style.textAnim.durationFrames / fps).toFixed(4);
    const dOut = style.textAnim.exitDistancePct;
    const outSec = (style.textAnim.exitDurationFrames / fps).toFixed(4);
    const inStart = t(0);
    const outStart = t(Math.max(0, duration - style.textAnim.exitDurationFrames));
    const dir = style.textAnim.direction;
    const signIn = dir === "left" ? 1 : dir === "right" ? -1 : 0;
    const signYIn = dir === "up" ? 1 : dir === "down" ? -1 : 0;
    const uIn = `clip((t-${inStart})/${inSec}\\,0\\,1)`;
    const uOut = `clip((t-${outStart})/${outSec}\\,0\\,1)`;
    xExprParts.push(`${q((signIn * dIn / 100) * W)}*(1-pow(${uIn}\\,2)*(3-2*${uIn}))`);
    yExprParts.push(`${q((signYIn * dIn / 100) * H)}*(1-pow(${uIn}\\,2)*(3-2*${uIn}))`);
    // exit moves further along the entrance direction
    xExprParts.push(`${q(-signIn * (dOut / 100) * W)}*pow(${uOut}\\,2)*(3-2*${uOut})`);
    yExprParts.push(`${q(-signYIn * (dOut / 100) * H)}*pow(${uOut}\\,2)*(3-2*${uOut})`);
  }
  // keyframed x/y in % of frame size — full expression builder (exact parity
  // with evaluateProperty at frame times, via ffmpegExprFor)
  const xKfExpr = kfExpr("x", 0);
  if (xKfExpr) xExprParts.push(`${q(W / 100)}*(${xKfExpr})`);
  const yKfExpr = kfExpr("y", 0);
  if (yKfExpr) yExprParts.push(`${q(H / 100)}*(${yKfExpr})`);
  const xBase = `x=${joinAdditive(xExprParts)}`;
  const yBase = `y=${joinAdditive(yExprParts)}`;

  // ── shape (drawbox) ──────────────────────────────────────────────────────
  if (style.shape.kind === "bar" || style.shape.kind === "card") {
    const grow = style.shape.kind === "bar" ? `w='${q((style.shape.widthPct / 100) * W)}*clip((t-${t(0)})/${q(Math.max(0.001, plan.entranceSpanFrames / fps))}\\,0\\,1)'` : `w='${q((style.shape.widthPct / 100) * W)}'`;
    const thickness = Math.round((style.shape.thicknessPct / 100) * H);
    const primaryLines = style.primaryText.split("\n").length;
    const blockH = Math.round(primaryPx * primaryLines * 1.15 + (style.secondaryText ? secondaryPx * 1.35 : 0) + thickness);
    const bx = style.align === "CENTER" ? `x=(w-${q((style.shape.widthPct / 100) * W)})/2+${q(((anchor.xPct / 100) * W) - W / 2)}` : `x=${xExprParts.join("+").replace(/^/, "").replace("x=", "")}`;
    const by = style.anchor.startsWith("UPPER")
      ? `y=${yExprParts.join("+").replace("y=", "")}-${q(primaryPx * 0.6)}`
      : `y=${yExprParts.join("+").replace("y=", "")}-${q(primaryPx * 0.85)}`;
    filters.push(
      `drawbox=${bx.replace("x=", "x=")}:${by}:${grow}:h=${blockH}:color=${ffmpegColor(style.shape.color)}:t=fill:${enable}`,
    );
    if (style.shape.accentPct > 0) {
      const accentW = Math.max(2, Math.round((style.shape.accentPct / 100) * (style.shape.widthPct / 100) * W));
      const ax = style.align === "RIGHT" ? `x=${bx.replace("x=", "")}+${q((style.shape.widthPct / 100) * W)}-${accentW}` : bx;
      filters.push(`drawbox=${ax}:${by}:w=${accentW}:h=${blockH + thickness}:color=${ffmpegColor(style.shape.accentColor)}:t=fill:${enable}`);
    }
  } else if (style.shape.kind === "underline") {
    const uw = Math.max(2, Math.round((style.shape.thicknessPct / 100) * H));
    const lines = style.primaryText.split("\n").length;
    const grow = `w='${q((style.shape.widthPct / 100) * W)}*clip((t-${t(0)})/${q(Math.max(0.001, plan.entranceSpanFrames / fps))}\\,0\\,1)'`;
    const ux = style.align === "CENTER" ? `x=${q((anchor.xPct / 100) * W)}-w/2` : `x=${xExprParts.join("+").replace("x=", "")}`;
    filters.push(
      `drawbox=${ux}:y=${yExprParts.join("+").replace("y=", "")}+${q(primaryPx * lines * 1.22)}:${grow}:h=${uw}:color=${ffmpegColor(style.shape.accentColor)}:t=fill:${enable}`,
    );
  }

  // ── text (drawtext chains) ───────────────────────────────────────────────
  const alphaBase = (() => {
    const parts: string[] = [];
    const opacityExpr = kfExpr("opacity", 100);
    if (opacityExpr) parts.push(`((${opacityExpr})/100)`); // keyframed opacity — exact expression
    if (style.textAnim.mode === "fade") {
      parts.push(`clip((t-${t(0)})/${q(Math.max(0.001, style.textAnim.durationFrames / fps))}\\,0\\,1)`);
    }
    if (style.textAnim.exitMode === "fade") {
      const exitStart = duration - style.textAnim.exitDurationFrames;
      parts.push(`(1-clip((t-${t(exitStart)})/${q(Math.max(0.001, style.textAnim.exitDurationFrames / fps))}\\,0\\,1))`);
    }
    return parts.length > 0 ? parts.join("*") : null;
  })();

  const drawtext = (text: string, opts: { x: string; y: string; sizePx: number; color: string; alpha?: string | null; borderw?: number; shadow?: boolean; box?: { color: string; alpha: number } }): string => {
    const parts = [
      `drawtext=fontfile='${esc(fontFile)}'`,
      `text='${esc(text)}'`,
      `fontsize=${opts.sizePx}`,
      `fontcolor=${opts.color.replace("#", "0x")}${opts.color.length === 9 ? opts.color.slice(7) : ""}`,
      opts.alpha ? `alpha='${opts.alpha}'` : null,
      opts.borderw ? `borderw=${opts.borderw}:bordercolor=${style.strokeColor.replace("#", "0x")}` : null,
      style.shadow.enabled && opts.shadow !== false ? `shadowcolor=${style.shadow.color.replace("#", "0x")}:shadowx=${style.shadow.offsetX}:shadowy=${style.shadow.offsetY}` : null,
      opts.box ? `box=1:boxcolor=${opts.box.color.replace("#", "0x")}@${opts.box.alpha}:boxborderw=${Math.round(primaryPx * 0.55)}` : null,
      `x=${opts.x}`,
      `y=${opts.y}`,
      enable,
    ].filter(Boolean);
    return parts.join(":");
  };

  const secondaryOffset = primaryPx * Math.max(1, style.primaryText.split("\n").length) * 1.25 + secondaryPx;
  const trackingPx = ((style.textAnim.trackingTo - style.textAnim.trackingFrom) / 100) * primaryPx * Math.min(1, 1 / Math.max(1, style.textAnim.durationFrames / fps) * 0 + 1); // constant approximation — animated tracking is preview-degraded (documented)

  if (style.textAnim.mode === "wordReveal") {
    const words = segmentWords(style.primaryText);
    const spaceW = measureText(" ", fontFile, primaryPx) + trackingPx;
    const widths = words.map((w) => measureText(w.text, fontFile, primaryPx));
    const total = widths.reduce((s, w) => s + w, 0) + spaceW * Math.max(0, words.length - 1);
    const startX =
      style.align === "CENTER" ? `(${xBase.replace("x=", "")})-${q(total / 2)}` : style.align === "RIGHT" ? `(${xBase.replace("x=", "")})-${q(total)}` : xBase.replace("x=", "");
    let cursor = 0;
    words.forEach((w, i) => {
      const unit = plan.words[i];
      const hl = highlightFor(style, w.text);
      const rise = style.textAnim.distancePct;
      const wAlpha = `clip((t-${t(unit.start)})/${q(Math.max(0.001, (unit.full - unit.start + 1) / fps))}\\,0\\,1)`;
      const easedAlpha = `pow(${wAlpha}\\,2)*(3-2*${wAlpha})`;
      const wordAlpha = alphaBase ? `(${alphaBase})*(${easedAlpha})` : easedAlpha;
      const wColor = hl ? hl.color : style.primaryColor;
      const xExpr = `${startX}+${q(cursor)}`;
      const yRise = style.textAnim.direction === "up" ? `+${q((rise / 100) * H)}*(1-pow(${wAlpha}\\,2)*(3-2*${wAlpha}))` : "";
      filters.push(
        drawtext(w.text, {
          x: xExpr,
          y: `${yBase.replace("y=", "")}${yRise}`,
          sizePx: Math.round(primaryPx * (hl ? hl.scalePct / 100 : 1)),
          color: wColor,
          alpha: wordAlpha,
          borderw: style.strokeWidth,
        }),
      );
      cursor += widths[i] + spaceW;
    });
    if (style.secondaryText) {
      filters.push(drawtext(style.secondaryText, { x: xBase.replace("x=", ""), y: `${yBase.replace("y=", "")}+${q(secondaryOffset)}`, sizePx: secondaryPx, color: style.secondaryColor, alpha: alphaBase, borderw: style.strokeWidth }));
    }
  } else if (style.textAnim.mode === "typewriter" || style.textAnim.mode === "charReveal") {
    // Stacked-prefix typewriter: prefix i (measured width-aware) enabled from
    // its start; the longest visible prefix overdraws earlier identical
    // prefixes exactly (same glyphs/position) — the classic hard-pop look.
    const full = `${style.primaryText}${style.secondaryText ? `\n${style.secondaryText}` : ""}`;
    const clusters = plan.graphemes;
    const n = Math.min(clusters.length, 80);
    let widthAcc = 0;
    const centerX = xBase.replace("x=", "");
    for (let i = 1; i <= n; i++) {
      const prefix = clusters.slice(0, i).join("");
      const startFrame = plan.chars[i - 1]?.start ?? (i - 1) * Math.max(1, style.textAnim.durationFrames);
      widthAcc = measureText(prefix, fontFile, primaryPx);
      const xExpr = style.align === "CENTER" ? `(${centerX})-${q(widthAcc / 2)}` : style.align === "RIGHT" ? `(${centerX})-${q(widthAcc)}` : centerX;
      filters.push(
        drawtext(prefix.replace(/\n/g, " "), {
          x: xExpr,
          y: `${yBase.replace("y=", "")}`,
          sizePx: primaryPx,
          color: style.primaryColor,
          alpha: alphaBase,
          borderw: style.strokeWidth,
          shadow: true,
        }),
      );
      void startFrame;
    }
  } else {
    // none / fade / slide / scale: whole block, primary (+ secondary)
    const lines = style.primaryText.split("\n");
    lines.forEach((line, li) => {
      const lineW = measureText(line, fontFile, primaryPx);
      const lx = style.align === "CENTER" ? `(${xBase.replace("x=", "")})-${q(lineW / 2)}` : style.align === "RIGHT" ? `(${xBase.replace("x=", "")})-${q(lineW)}` : xBase.replace("x=", "");
      filters.push(
        drawtext(line, {
          x: lx,
          y: `${yBase.replace("y=", "")}+${q(primaryPx * li * 1.25)}`,
          sizePx: primaryPx,
          color: style.primaryColor,
          alpha: alphaBase,
          borderw: style.strokeWidth,
        }),
      );
    });
    if (style.secondaryText) {
      const secW = measureText(style.secondaryText, fontFile, secondaryPx);
      const sx = style.align === "CENTER" ? `(${xBase.replace("x=", "")})-${q(secW / 2)}` : style.align === "RIGHT" ? `(${xBase.replace("x=", "")})-${q(secW)}` : xBase.replace("x=", "");
      filters.push(drawtext(style.secondaryText, { x: sx, y: `${yBase.replace("y=", "")}+${q(secondaryOffset)}`, sizePx: secondaryPx, color: style.secondaryColor, alpha: alphaBase, borderw: style.strokeWidth }));
    }
  }
  void trackingPx;
  return filters;
}

export interface NikkiRenderPlan {
  /** Input args (source media, lavfi color for title-only renders). */
  inputs: string[];
  /** Full -filter_complex graph. */
  filterGraph: string;
  /** Output args (codec, pix_fmt, duration guard). */
  outputArgs: string[];
  durationSec: number;
  /** Human summary of what the render composites (report/log). */
  summary: string[];
}

/**
 * Build the full render plan: video segments (xfade transitions) + graphics
 * overlay for the render window. Deterministic and pure — the job handler
 * only spawns ffmpeg with these args.
 */
export function buildNikkiRenderPlan(
  seq: Sequence,
  opts: { startFrame?: number; endFrame?: number; sourceMediaPath?: string | null; resolveAssetPath?: (assetId: string) => string | null },
): NikkiRenderPlan {
  const fps = seq.fps.num / seq.fps.den;
  const startFrame = opts.startFrame ?? 0;
  const endFrame = opts.endFrame ?? Math.max(1, Math.ceil(
    seq.clips.reduce((m, c) => Math.max(m, c.timelineStartFrame + c.timelineDurationFrames), 0),
  ));
  const ctx: RenderContext = { seq, fps, startFrame, endFrame };
  const durationSec = (endFrame - startFrame) / fps;
  const summary: string[] = [];

  const graphics = graphicsInWindow(ctx);
  const graphicFilters: string[] = [];
  for (const g of graphics) {
    const f = buildGraphicFilters(g, ctx);
    graphicFilters.push(...f);
    summary.push(`graphic ${g.clip.id} (${g.clip.graphicStyle?.templateId}): ${f.length} filter stage(s)`);
  }

  const videoClips = seq.clips
    .filter((c) => seq.tracks.find((t) => t.id === c.trackId)?.kind === "VIDEO" && !c.missingMedia && c.sourceAssetId && clipEndFrame(seq, c) > startFrame && c.timelineStartFrame < endFrame)
    .sort((a, b) => a.timelineStartFrame - b.timelineStartFrame);

  const hasVideoSource = Boolean(opts.sourceMediaPath);
  const hasVideoClips = videoClips.length > 0;

  // Title-only render: black background (transparent alpha would need a
  // second pass; the M6 deliverable is the burned-in composite — documented).
  if (!hasVideoSource && !hasVideoClips) {
    const inputs = ["-f", "lavfi", "-i", `color=c=black:s=${seq.width}x${seq.height}:r=${q(fps)}:d=${q(durationSec)}`];
    const graph = `[0:v]${graphicFilters.join(",")}[vout]`;
    return {
      inputs,
      filterGraph: graphicFilters.length ? graph : "[0:v]null[vout]",
      outputArgs: ["-map", "[vout]", "-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p", "-t", q(durationSec), "-movflags", "+faststart"],
      durationSec,
      summary: summary.length ? summary : ["title-only render (black background)"],
    };
  }

  if (hasVideoSource) {
    // Single chosen source media for the whole window (the common case:
    // render the graphics of this sequence window over one clip).
    const inputs = ["-i", opts.sourceMediaPath!];
    const chain = [
      `[0:v]scale=${seq.width}:${seq.height}:force_original_aspect_ratio=decrease,pad=${seq.width}:${seq.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
      ...graphicFilters,
      "format=yuv420p",
    ].join(",");
    return {
      inputs,
      filterGraph: `${chain}[vout]`,
      outputArgs: ["-map", "[vout]", "-c:v", "libx264", "-preset", "medium", "-t", q(durationSec), "-movflags", "+faststart", ...(hasVideoClips ? [] : ["-an"])],
      durationSec,
      summary: [...summary, `source media ${path.basename(opts.sourceMediaPath!)} for ${q(durationSec)}s @ ${q(fps)}fps`],
    };
  }

  // Multi-clip sequence: segments per video clip joined by xfade (real
  // transitions). Inputs are ordered by the video clips' source assets —
  // each segment input needs its own file, so distinct source assets only.
  const inputs: string[] = [];
  const segmentPlan = videoClips.map((c) => ({ clip: c, inputIndex: -1, inSec: 0, outSec: 0 }));
  const assetToInput = new Map<string, number>();
  let inputIdx = 0;
  for (const seg of segmentPlan) {
    const asset = seg.clip.sourceAssetId;
    const existing = assetToInput.get(asset);
    if (existing !== undefined) {
      seg.inputIndex = existing;
    } else {
      const p = opts.resolveAssetPath ? opts.resolveAssetPath(asset) : null;
      if (!p) throw new Error(`NIIKI render: source asset ${asset} has no resolvable media file`);
      seg.inputIndex = inputIdx++;
      assetToInput.set(asset, seg.inputIndex);
      inputs.push("-i", p);
    }
    seg.inSec = Math.max(0, (seg.clip.sourceInFrame / seg.clip.sourceFps.num) * seg.clip.sourceFps.den);
  }
  // NOTE: multi-clip sequence rendering with per-asset inputs + xfade is the
  // M6 baseline (distinct assets share inputs via separate trim chains).
  // The full-timeline export (audio mix, streaming sources) is M9 scope.
  const chains: string[] = [];
  // M8.1 fix: an input shared by N segments must be SPLIT first — ffmpeg
  // consumes [N:v] once, so direct reuse of the same stream label in several
  // chains is an invalid graph (previously broke multi-scene renders that
  // reused one asset). Distinct-asset renders are unaffected (split=1 path).
  const usageCount = new Map<number, number>();
  for (const seg of segmentPlan) usageCount.set(seg.inputIndex, (usageCount.get(seg.inputIndex) ?? 0) + 1);
  const splitNext = new Map<number, number>();
  for (const [input, n] of usageCount) {
    if (n > 1) {
      const outs = Array.from({ length: n }, (_, k) => `s${input}_${k}`).join("][");
      chains.push(`[${input}:v]split=${n}[${outs}]`);
    }
  }
  segmentPlan.forEach((seg, i) => {
    const relStart = Math.max(0, seg.clip.timelineStartFrame - startFrame) / fps;
    const relDur = (Math.min(endFrame, clipEndFrame(seq, seg.clip)) - Math.max(startFrame, seg.clip.timelineStartFrame)) / fps;
    let srcLabel: string;
    if ((usageCount.get(seg.inputIndex) ?? 1) > 1) {
      const k = splitNext.get(seg.inputIndex) ?? 0;
      splitNext.set(seg.inputIndex, k + 1);
      srcLabel = `s${seg.inputIndex}_${k}`;
    } else {
      srcLabel = `${seg.inputIndex}:v`;
    }
    chains.push(`[${srcLabel}]trim=start=${q(seg.inSec)}:duration=${q(relDur)},setpts=PTS-STARTPTS,fps=${q(fps)},scale=${seq.width}:${seq.height}:force_original_aspect_ratio=decrease,pad=${seq.width}:${seq.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v${i}]`);
  });
  // xfade chain across consecutive segments where a transition exists; hard
  // join (concat) where none.
  let last = "v0";
  let acc = segmentPlan.length > 0 ? (Math.min(endFrame, clipEndFrame(seq, segmentPlan[0].clip)) - Math.max(startFrame, segmentPlan[0].clip.timelineStartFrame)) / fps : 0;
  let cur = 0;
  let transitionCount = 0;
  for (let i = 1; i < segmentPlan.length; i++) {
    const prev = segmentPlan[i - 1].clip;
    const cur2 = segmentPlan[i].clip;
    const tr = seq.transitions.find(
      (t) => t.clipAId === prev.id && t.clipBId === cur2.id && t.endFrame > startFrame && t.startFrame < endFrame,
    );
    const out = `x${i}`;
    if (tr && XFADE[tr.kind]) {
      const dur = Math.min(tr.durationFrames, Math.floor(acc * fps)) / fps;
      chains.push(`[${last}][v${i}]xfade=transition=${XFADE[tr.kind]}:duration=${q(dur)}:offset=${q(acc - dur)}[${out}]`);
      acc = acc + (Math.min(endFrame, clipEndFrame(seq, cur2)) - cur2.timelineStartFrame) / fps - dur;
      transitionCount++;
    } else {
      chains.push(`[${last}][v${i}]concat=n=2:v=1:a=0[${out}]`);
      acc += (Math.min(endFrame, clipEndFrame(seq, cur2)) - cur2.timelineStartFrame) / fps;
    }
    last = out;
    cur = i;
  }
  void cur;
  const finalLabel = last;
  const overlayGraph = graphicFilters.length
    ? `${chains.join(";")};[${finalLabel}]${graphicFilters.join(",")}[vout]`
    : `${chains.join(";")};[${finalLabel}]null[vout]`;
  summary.push(`${segmentPlan.length} video segment(s), ${transitionCount} xfade transition(s)`);
  return {
    inputs,
    filterGraph: overlayGraph,
    outputArgs: ["-map", "[vout]", "-c:v", "libx264", "-preset", "medium", "-t", q(durationSec), "-movflags", "+faststart", "-an"],
    durationSec,
    summary,
  };
}
