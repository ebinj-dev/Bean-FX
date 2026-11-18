/**
 * NIIKI — resolved graphic state (M6). The pure bridge between the timeline
 * model and BOTH renderers: given a graphic clip, the sequence fps and an
 * absolute timeline frame, produce the NikkiFrameState the canvas preview
 * draws and the FFmpeg export path mirrors.
 *
 * Determinism: integer-frame evaluation only; identical inputs → identical
 * state (verified by the parity test on rendered pixels).
 */
import { clipEndFrame, type Clip, type Sequence } from "@/lib/editor/model";
import { evaluateProperty, type NikkiKeyframe } from "./animation";
import {
  baseFrameState,
  planTypography,
  unitOpacity,
  unitRisePct,
  wholeOpacity,
  wholeScale,
  wholeSlidePct,
  segmentWords,
  highlightFor,
} from "./typography";
import type { NikkiAnchor, NikkiFrameState } from "./types";

const KF_FALLBACK: Record<string, number> = {
  x: 0, y: 0, scale: 100, scaleX: 100, scaleY: 100,
  opacity: 100, rotation: 0, blur: 0, letterSpacing: 0, volume: 1,
};

/** Anchor → base position (% of frame width/height for the block's anchor point). */
export function anchorPosition(anchor: NikkiAnchor, offsetX: number, offsetY: number): { xPct: number; yPct: number } {
  const pos: Record<NikkiAnchor, [number, number]> = {
    LOWER_LEFT: [offsetX, 100 - offsetY],
    LOWER_CENTER: [50, 100 - offsetY],
    LOWER_RIGHT: [100 - offsetX, 100 - offsetY],
    UPPER_LEFT: [offsetX, offsetY],
    UPPER_CENTER: [50, offsetY],
    UPPER_RIGHT: [100 - offsetX, offsetY],
    CENTER: [50, 50],
    TITLE_SAFE: [50, 40],
  };
  const [x, y] = pos[anchor];
  return { xPct: x, yPct: y };
}

/**
 * Resolve the graphic state at an absolute timeline frame.
 * Keyframe properties operate in % units (x/y offsets from the anchor in %
 * of frame size, scale in %, opacity 0..100, blur in px at 1080p scale,
 * letterSpacing in 1/100 em) and compose with the template's animation spec.
 */
export function graphicStateAt(clip: Clip, seq: Sequence, timelineFrame: number): NikkiFrameState & { style: Clip["graphicStyle"] } {
  const style = clip.graphicStyle;
  const state = baseFrameState();
  if (!style) return { ...state, style: null } as never;

  const localFrame = Math.max(0, Math.min(clip.timelineDurationFrames - 1, timelineFrame - clip.timelineStartFrame));
  const kfs = clip.keyframes as NikkiKeyframe[];
  const evalKf = (property: string, fallback: number): number =>
    evaluateProperty(kfs, property, localFrame, { fallback, durationFrames: clip.timelineDurationFrames });

  // Keyframe-driven properties (percent space).
  const anchor = anchorPosition(style.anchor, style.offsetX, style.offsetY);
  const slide = wholeSlidePct(style, localFrame, clip.timelineDurationFrames);
  const baseScale = wholeScale(style, localFrame, clip.timelineDurationFrames);

  const plan = planTypography(style, clip.timelineDurationFrames, seq.fps.num / seq.fps.den);

  // Word states (wordReveal) with highlights.
  const wordStates: NikkiFrameState["wordStates"] = [];
  if (style.textAnim.mode === "wordReveal") {
    const full = `${style.primaryText}${style.secondaryText ? `\n${style.secondaryText}` : ""}`;
    const wordList = segmentWords(full);
    const dist = style.textAnim.distancePct;
    wordList.forEach((w, i) => {
      const unit = plan.words[i];
      if (!unit) return;
      wordStates.push({
        index: i,
        opacity: unitOpacity(unit, localFrame, clip.timelineDurationFrames),
        risePct: unitRisePct(unit, localFrame, dist),
        ...(highlightFor(style, w.text) ? {} : {}),
      });
    });
  }

  const visibleChars = plan.charsVisibleAt(localFrame);
  // Shape reveal follows the whole-graphic entrance (bar grows with the text).
  const entranceProgress =
    style.textAnim.mode === "none" ? 1 : Math.min(1, localFrame / Math.max(1, plan.entranceSpanFrames));

  const resolved: NikkiFrameState = {
    xPct: anchor.xPct + slide.dx + evalKf("x", 0),
    yPct: anchor.yPct + slide.dy + evalKf("y", 0),
    scalePct: evalKf("scale", 100) * baseScale,
    scaleX: evalKf("scaleX", 100) / 100,
    scaleY: evalKf("scaleY", 100) / 100,
    rotation: evalKf("rotation", 0),
    opacity: Math.max(0, Math.min(1, (evalKf("opacity", 100) / 100) * wholeOpacity(style, localFrame, clip.timelineDurationFrames))),
    blur: Math.max(0, evalKf("blur", 0)),
    letterSpacingEm: evalKf("letterSpacing", 0) / 100 + (style.textAnim.trackingTo - style.textAnim.trackingFrom) / 100 * Math.min(1, localFrame / Math.max(1, style.textAnim.durationFrames)),
    visibleChars,
    wordStates,
    shapeOpacity: Math.max(0, Math.min(1, (evalKf("opacity", 100) / 100) * wholeOpacity(style, localFrame, clip.timelineDurationFrames))),
    shapeProgress: entranceProgress,
  };
  return { ...resolved, style };
}

/** All graphics visible at a timeline frame, in compositing order (track order
 *  bottom→top: earlier tracks composite first, later tracks draw on top).
 *  Clips without a graphicStyle (legacy placeholders) are skipped honestly. */
export function activeGraphicsAt(seq: Sequence, frame: number): Array<{ clip: Clip; state: NikkiFrameState & { style: NonNullable<Clip["graphicStyle"]> }; trackIndex: number }> {
  const out: Array<{ clip: Clip; state: NikkiFrameState & { style: NonNullable<Clip["graphicStyle"]> }; trackIndex: number }> = [];
  seq.tracks.forEach((track, trackIndex) => {
    if (track.kind !== "GRAPHIC" && track.kind !== "OVERLAY" && track.kind !== "CAPTION") return;
    if (!track.visible) return;
    for (const clip of seq.clips) {
      if (clip.trackId !== track.id) continue;
      if (frame < clip.timelineStartFrame || frame >= clipEndFrame(seq, clip)) continue;
      if (track.kind === "CAPTION") continue; // captions keep the existing resolver/overlay
      if (!clip.graphicStyle) continue; // legacy placeholder — nothing to draw
      out.push({ clip, state: graphicStateAt(clip, seq, frame) as NikkiFrameState & { style: NonNullable<Clip["graphicStyle"]> }, trackIndex });
    }
  });
  return out;
}
