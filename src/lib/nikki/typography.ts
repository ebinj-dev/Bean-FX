/**
 * NIIKI — kinetic typography (M6).
 *
 * Deterministic text animation planning over Unicode-correct segments:
 * grapheme clusters via Intl.Segmenter (Tamil combining marks and complex
 * scripts stay intact — characters are never split mid-cluster), words via
 * whitespace with zero-width joiner awareness.
 *
 * Everything here is a pure function of (text, spec, durationFrames, fps):
 * preview and renderer plan the SAME windows, so a word-by-word caption looks
 * identical in the program monitor and in the exported file.
 *
 * RIISHE caption timing is untouched: caption clips keep their own resolver
 * (activeCaptionAt); NIIKI typography only applies to GRAPHIC clips.
 */
import type { NikkiGraphicStyle, NikkiTextUnit, NikkiFrameState } from "./types";

/** Unicode grapheme clusters — Tamil clusters (base + combining marks + ZWJ)
 *  are single units; emoji/ZWJ sequences too. */
export function segmentGraphemes(text: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const seg = new Intl.Segmenter("und", { granularity: "grapheme" });
    return Array.from(seg.segment(text), (s) => s.segment);
  }
  // Honest fallback (very old runtimes): code points, not graphemes —
  // combining marks would split. Node 20+/browsers all ship Segmenter.
  return Array.from(text);
}

/** Words with their char offsets (whitespace-split, preserves punctuation). */
export function segmentWords(text: string): { text: string; startChar: number }[] {
  const words: { text: string; startChar: number }[] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/u.test(text[i])) i++;
    if (i >= text.length) break;
    const start = i;
    while (i < text.length && !/\s/u.test(text[i])) i++;
    words.push({ text: text.slice(start, i), startChar: start });
  }
  return words;
}

export interface TypographyPlan {
  /** Grapheme clusters of the full text (primary + "\n" + secondary). */
  graphemes: string[];
  /** Per-word reveal windows (clip-relative frames), empty when not wordReveal. */
  words: NikkiTextUnit[];
  /** Character count visible at a given frame (typewriter/charReveal). */
  charsVisibleAt: (frame: number) => number;
  /** Per-character opacity windows (charReveal), bounded count. */
  chars: NikkiTextUnit[];
  /** Total entrance span in frames (first unit start → last unit full). */
  entranceSpanFrames: number;
}

const MAX_ANIMATED_CHARS = 80; // honest bound: beyond this, char modes degrade to word mode

/**
 * Plan the text animation windows for a graphic clip.
 * Deterministic: same inputs → same plan on preview and export.
 */
export function planTypography(style: NikkiGraphicStyle, durationFrames: number, fps: number): TypographyPlan {
  const anim = style.textAnim;
  const full = `${style.primaryText}${style.secondaryText ? `\n${style.secondaryText}` : ""}`;
  const graphemes = segmentGraphemes(full);

  // Effective mode: char-count cap protects the render from unbounded filters.
  let mode = anim.mode;
  if ((mode === "charReveal" || mode === "typewriter") && graphemes.length > MAX_ANIMATED_CHARS) {
    mode = "wordReveal";
  }

  const unitDuration = Math.max(1, anim.durationFrames);
  const stagger = Math.max(0, anim.staggerFrames);

  const words: NikkiTextUnit[] = [];
  const chars: NikkiTextUnit[] = [];
  let charsVisibleAt: (frame: number) => number = () => graphemes.length;

  if (mode === "wordReveal") {
    const wordList = segmentWords(full);
    wordList.forEach((w, i) => {
      const start = i * stagger;
      words.push({ text: w.text, start, full: start + unitDuration - 1 });
    });
  } else if (mode === "charReveal") {
    graphemes.forEach((g, i) => {
      const start = i * stagger;
      chars.push({ text: g, start, full: start + unitDuration - 1 });
    });
    charsVisibleAt = (frame) => {
      if (mode === "charReveal") {
        let n = 0;
        for (const c of chars) if (frame >= c.start) n++;
        return Math.min(n, graphemes.length);
      }
      return graphemes.length;
    };
  } else if (mode === "typewriter") {
    // One grapheme per fps/fpsTick — typewriter speed = unitDuration per char,
    // no stagger: char n appears at n * unitDuration.
    graphemes.forEach((g, i) => {
      chars.push({ text: g, start: i * unitDuration, full: i * unitDuration });
    });
    charsVisibleAt = (frame) => {
      let n = 0;
      for (const c of chars) if (frame >= c.start) n++;
      return Math.min(n, graphemes.length);
    };
  }

  const units = mode === "wordReveal" ? words : chars;
  const entranceSpanFrames =
    mode === "none" || mode === "fade" || mode === "slide" || mode === "scale"
      ? unitDuration
      : units.length > 0
        ? units[units.length - 1].full + 1
        : unitDuration;

  return { graphemes, words, chars, charsVisibleAt, entranceSpanFrames };
}

/** Opacity of one unit at a frame (0→1 over its entrance window; the unit is
 *  fully visible AT frame `full`). */
export function unitOpacity(unit: NikkiTextUnit, frame: number, durationFrames: number): number {
  if (frame < unit.start) return 0;
  const local = frame - unit.start;
  const span = Math.max(1, unit.full - unit.start);
  if (local >= span) return 1;
  // EASE (smoothstep) — matches the export path's drawtext alpha expression.
  const u = local / span;
  return u * u * (3 - 2 * u);
}

/** Rise offset (in % of frame height) for a rising word/char at a frame. */
export function unitRisePct(unit: NikkiTextUnit, frame: number, distancePct: number): number {
  if (frame < unit.start) return distancePct;
  const span = Math.max(1, unit.full - unit.start);
  const local = frame - unit.start;
  if (local >= span) return 0;
  const u = local / span;
  const eased = u * u * (3 - 2 * u);
  return distancePct * (1 - eased);
}

/** Whole-graphic entrance/exit opacity (fade/slide/scale modes). */
export function wholeOpacity(style: NikkiGraphicStyle, frame: number, durationFrames: number): number {
  const anim = style.textAnim;
  let opacity = 1;
  if (anim.mode === "fade") {
    const u = Math.min(1, frame / Math.max(1, anim.durationFrames));
    opacity = Math.min(opacity, u);
  }
  if (anim.exitMode === "fade") {
    const exitStart = durationFrames - Math.max(1, anim.exitDurationFrames);
    if (frame >= exitStart) {
      const u = 1 - (frame - exitStart) / Math.max(1, durationFrames - exitStart);
      opacity = Math.min(opacity, Math.max(0, u));
    }
  }
  return Math.max(0, Math.min(1, opacity));
}

/** Slide offset (as % offsets added to the anchor position) at a frame. */
export function wholeSlidePct(style: NikkiGraphicStyle, frame: number, durationFrames: number): { dx: number; dy: number } {
  const anim = style.textAnim;
  let dx = 0;
  let dy = 0;
  const dist = anim.distancePct;
  if (anim.mode === "slide") {
    const u = Math.min(1, Math.max(0, frame / Math.max(1, anim.durationFrames)));
    const eased = u * u * (3 - 2 * u);
    const remaining = dist * (1 - eased);
    if (anim.direction === "left") dx = remaining;
    if (anim.direction === "right") dx = -remaining;
    if (anim.direction === "up") dy = remaining;
    if (anim.direction === "down") dy = -remaining;
  }
  if (anim.exitMode === "slide") {
    const exitStart = durationFrames - Math.max(1, anim.exitDurationFrames);
    if (frame >= exitStart) {
      const u = Math.min(1, Math.max(0, (frame - exitStart) / Math.max(1, durationFrames - exitStart)));
      const eased = u * u * (3 - 2 * u);
      const moved = anim.exitDistancePct * eased;
      if (anim.direction === "left") dx -= moved;
      if (anim.direction === "right") dx += moved;
      if (anim.direction === "up") dy -= moved;
      if (anim.direction === "down") dy += moved;
    }
  }
  return { dx, dy };
}

/** Whole-graphic scale (slide/scale modes) as a multiplier. */
export function wholeScale(style: NikkiGraphicStyle, frame: number, durationFrames: number): number {
  const anim = style.textAnim;
  if (anim.mode !== "scale" && anim.exitMode !== "scale") return 1;
  let scale = 1;
  if (anim.mode === "scale") {
    const u = Math.min(1, Math.max(0, frame / Math.max(1, anim.durationFrames)));
    scale = Math.min(scale, 0.8 + 0.2 * (u * u * (3 - 2 * u)));
  }
  if (anim.exitMode === "scale") {
    const exitStart = durationFrames - Math.max(1, anim.exitDurationFrames);
    if (frame >= exitStart) {
      const u = Math.min(1, Math.max(0, (frame - exitStart) / Math.max(1, durationFrames - exitStart)));
      scale = Math.min(scale, 1 - 0.25 * u);
    }
  }
  return Math.max(0.01, scale);
}

/** Highlight match for a word (exact, case-sensitive after trim — editable). */
export function highlightFor(style: NikkiGraphicStyle, word: string): { color: string; scalePct: number } | null {
  const w = word.trim();
  for (const h of style.highlights) {
    if (h.word === w) return { color: h.color, scalePct: h.scalePct };
  }
  return null;
}

/** Default resolved state (no keyframes, no animation) — used as fallbacks. */
export function baseFrameState(): NikkiFrameState {
  return {
    xPct: 0, yPct: 0, scalePct: 100, scaleX: 1, scaleY: 1,
    rotation: 0, opacity: 1, blur: 0, letterSpacingEm: 0,
    visibleChars: Number.MAX_SAFE_INTEGER,
    wordStates: [], shapeOpacity: 1, shapeProgress: 1,
  };
}
