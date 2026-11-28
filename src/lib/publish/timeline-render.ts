/**
 * BEAN FX — M16 timeline renderer (Phase F).
 *
 * THE missing M15 capability: render the edited multitrack sequence to a
 * real video file as a durable RENDER_TIMELINE job on the existing worker.
 * Builds ONE ffmpeg filter graph from the canonical sequence:
 *   - every visual clip: source trim → speed → scale/pad to sequence dims →
 *     effect chain (lib/editor/filters.ts — SAME module as preview) → fades;
 *   - overlays composite in track order (later track wins — model rule);
 *   - captions: drawtext windows; graphics: NIIKI buildGraphicFilters;
 *   - audio: per-clip atrim + speed + adelay + volume + afade → amix over a
 *     silence bed (amix needs ≥1 input); video clips' own audio included
 *     unless muted, matching the preview resolver.
 *
 * Output validated with ffprobe BEFORE registering an ExportFile. Original
 * media never modified. Missing media is skipped and disclosed via the job
 * stage/params — never faked.
 */
import { mkdir, stat, unlink, writeFile } from "fs/promises";
import path from "path";
import { db } from "@/lib/db";
import { pathInsideMediaRoot, assertDiskSpace, MEDIA_ROOT } from "@/lib/media-storage";
import { clipEndFrame, type Clip, type Sequence } from "@/lib/editor/model";
import { sequenceEndFrame } from "@/lib/editor/preview";
import { ffmpegEffectChain, ffmpegEffectChainAnimated, segmentSplitFrames } from "@/lib/editor/filters";
import { ffmpegVolumeArgs } from "@/lib/editor/audio";
import { clipHasTransform, overlayPositionExprs, segmentTransformFilters, transformAt, transformBoundaryFrames, transformNeedsSegments } from "@/lib/editor/transform";
import { buildGraphicFilters } from "@/lib/nikki/render";
import { jobManager } from "@/lib/job-runner";
import { probeMediaDeep } from "@/lib/media-analysis";

const FALLBACK_FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";

function q(s: number): string {
  return Number.isInteger(s) ? String(s) : s.toFixed(3);
}

function escDrawtext(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\u2019").replace(/%/g, "\\%");
}

interface RenderClipPlan {
  clip: Clip;
  trackIndex: number;
  winStartFrame: number;
  winEndFrame: number;
}

/** M47.2-A — shape shared by the asset-level map and the plan-occurrence map. */
export interface RenderInputEntry {
  index: number;
  isImage: boolean;
  hasAudio: boolean;
}

/**
 * M47.2-A (M46.1 hotfix) — STABLE PLAN-OCCURRENCE IDENTITY.
 *
 * buildTimelineGraph RE-COLLECTS plans from the sequence (fresh objects every
 * call), so the previous reference-keyed `Map<RenderClipPlan, …>` missed every
 * lookup in the normal render path and fell back to an asset map the caller
 * never populated — every visual/audio plan was silently filtered out and the
 * render produced a valid H.264/AAC container full of black frames and
 * silence. The identity below is derived from plan CONTENT (clip id + track +
 * exact window), so the caller's allocation and the graph builder's lookup
 * agree regardless of object identity.
 */
function planOccurrenceKey(plan: RenderClipPlan): string {
  return `${plan.clip.id}|${plan.trackIndex}|${plan.winStartFrame}|${plan.winEndFrame}`;
}
export { planOccurrenceKey };

/**
 * M47.2-A — ONE deterministic input-allocation routine used by BOTH the
 * normal (≤240 s) and the long-form windowed render paths: one ffmpeg input
 * per plan occurrence (images get their own -loop/-t window, so a reused
 * image always spans its own clip's duration), keyed by planOccurrenceKey.
 * `usedByAsset` mirrors the first occurrence per asset id so the graph's
 * asset-level checks (hasAudio gating, missing-asset accounting) keep working
 * for callers that populate only the asset-level map. Same plans in → same
 * allocation out; nothing depends on object-reference equality.
 */
export function allocateRenderInputs(
  plans: RenderClipPlan[],
  assetById: Map<string, { id: string; kind: string; storagePath: string }>,
  hasAudioById: Map<string, boolean>,
  fps: number,
): { inputArgs: string[]; inputByPlanKey: Map<string, RenderInputEntry>; usedByAsset: Map<string, RenderInputEntry> } {
  const inputArgs: string[] = [];
  const inputByPlanKey = new Map<string, RenderInputEntry>();
  const usedByAsset = new Map<string, RenderInputEntry>();
  let nextIndex = 0;
  for (const plan of plans) {
    const id = plan.clip.sourceAssetId;
    if (!id) continue;
    const key = planOccurrenceKey(plan);
    if (inputByPlanKey.has(key)) continue;
    const asset = assetById.get(id);
    if (!asset) continue; // pre-flight in the caller fails before this can matter
    const isImage = asset.kind === "IMAGE";
    const entry: RenderInputEntry = { index: nextIndex, isImage, hasAudio: hasAudioById.get(id) ?? false };
    inputByPlanKey.set(key, entry);
    if (!usedByAsset.has(id)) usedByAsset.set(id, entry);
    if (isImage) {
      const win = plan.winEndFrame - plan.winStartFrame;
      inputArgs.push("-loop", "1", "-framerate", String(fps), "-t", q(Math.max(1, win) / fps), "-i", asset.storagePath);
    } else {
      inputArgs.push("-i", asset.storagePath);
    }
    nextIndex += 1;
  }
  return { inputArgs, inputByPlanKey, usedByAsset };
}

function collectVisualPlans(seq: Sequence, startFrame: number, endFrame: number): RenderClipPlan[] {
  const plans: RenderClipPlan[] = [];
  seq.tracks.forEach((track, trackIndex) => {
    if ((track.kind !== "VIDEO" && track.kind !== "OVERLAY") || !track.visible) return;
    for (const clip of seq.clips) {
      if (clip.trackId !== track.id) continue;
      const cEnd = clipEndFrame(seq, clip);
      if (cEnd <= startFrame || clip.timelineStartFrame >= endFrame) continue;
      plans.push({ clip, trackIndex, winStartFrame: Math.max(clip.timelineStartFrame, startFrame), winEndFrame: Math.min(cEnd, endFrame) });
    }
  });
  return plans.sort((a, b) => a.trackIndex - b.trackIndex);
}

function collectAudioPlans(seq: Sequence, startFrame: number, endFrame: number): RenderClipPlan[] {
  const solo = seq.tracks.some((t) => t.solo);
  const plans: RenderClipPlan[] = [];
  for (const clip of seq.clips) {
    const track = seq.tracks.find((t) => t.id === clip.trackId);
    if (!track) continue;
    if ((track.kind !== "AUDIO" && track.kind !== "VIDEO") || track.muted || clip.muted) continue;
    if (solo && !track.solo) continue;
    if (clip.missingMedia || !clip.sourceAssetId) continue;
    const cEnd = clipEndFrame(seq, clip);
    if (cEnd <= startFrame || clip.timelineStartFrame >= endFrame) continue;
    plans.push({ clip, trackIndex: seq.tracks.findIndex((t) => t.id === clip.trackId), winStartFrame: Math.max(clip.timelineStartFrame, startFrame), winEndFrame: Math.min(cEnd, endFrame) });
  }
  return plans;
}

/** Source-media seconds for a given window-start frame inside the clip. */
function srcStartSec(plan: RenderClipPlan, seq: Sequence): number {
  return clipRelSrcSec(plan, seq, Math.max(0, plan.winStartFrame - plan.clip.timelineStartFrame));
}

/**
 * M48-H1 — source seconds for the AUDIO stream of a plan window. The audio
 * stream follows the clip's independent audio range when one exists (J/L
 * cuts, manual A/V sync): the mapping is the video mapping plus the range
 * offset (audioIn − videoIn)/sourceFps, so split windows, playback speed and
 * rational timebases all behave exactly as the video path does.
 */
function audioSrcStartSec(plan: RenderClipPlan, seq: Sequence): number {
  const { clip } = plan;
  const aIn = clip.audioSourceInFrame ?? clip.sourceInFrame;
  const offsetSec = (aIn - clip.sourceInFrame) / (clip.sourceFps.num / clip.sourceFps.den);
  return clipRelSrcSec(plan, seq, Math.max(0, plan.winStartFrame - clip.timelineStartFrame)) + offsetSec;
}

/** M48-H1 — last audible source second of the clip's audio stream. */
function audioSrcEndSec(plan: RenderClipPlan): number {
  const { clip } = plan;
  const aOut = clip.audioSourceOutFrame ?? clip.sourceOutFrame;
  return aOut / (clip.sourceFps.num / clip.sourceFps.den);
}

/** Source seconds for a clip-relative TIMELINE frame (M27 keyframe splits). */
function clipRelSrcSec(plan: RenderClipPlan, seq: Sequence, clipRelFrame: number): number {
  const { clip } = plan;
  const srcOffset = Math.round((clipRelFrame * clip.playbackSpeed * clip.sourceFps.num * seq.fps.den) / (clip.sourceFps.den * seq.fps.num));
  return (clip.sourceInFrame + srcOffset) / (clip.sourceFps.num / clip.sourceFps.den);
}

/** M37 — segment-split decision for ONE plan inside ONE window (the exact
 *  boundary set the split path will use). Single source of truth shared by
 *  emitVisualSegment and the run loop, which must know whether a clip took
 *  the split path — that changes the overlay-position geometry contract
 *  (re-fitted segments are pre-centered; unsplit segments need the centering
 *  compensation term in the position expression). */
function computeSegmentSplits(plan: RenderClipPlan, clipRelWinStart: number, winDurFrames: number): number[] {
  const animated = plan.clip.effects.some((e) => e.enabled && e.animatedParams.length > 0);
  const effectSplits = animated ? segmentSplitFrames(plan.clip.effects, plan.clip.timelineDurationFrames) : [];
  const tBoundaries = clipHasTransform(plan.clip) && transformNeedsSegments(plan.clip) ? transformBoundaryFrames(plan.clip, plan.clip.timelineDurationFrames) : [];
  return [...new Set([...effectSplits, ...tBoundaries])].filter((f) => f > clipRelWinStart && f < clipRelWinStart + winDurFrames);
}

/**
 * M27 P2 — emit ONE clip's video segment. Animated clips with non-expr
 * keyframed params (colorbalance/gblur/unsharp families) are SPLIT at their
 * keyframe frames into per-segment constant chains (real processing, real
 * concat — no fabricated animation); expr-capable params (eq family,
 * vignette) animate exactly via eval=frame t-expressions with no split.
 * M37 — clip transforms (position/scale/rotation/opacity) ride the same
 * machinery: geometry filters per segment, sampled splits for animated
 * scale/opacity, exact expressions where the filter supports them.
 */
function emitVisualSegment(
  parts: string[],
  plan: RenderClipPlan,
  seq: Sequence,
  inputIndex: number,
  isImage: boolean,
  outLabel: string,
  uid: string,
  renderStartFrame: number,
  /** M37: when any clip in the run is transformed, every run segment carries
   *  alpha (yuva420p) so the per-clip positioned overlays and the xfade stay
   *  format-consistent. */
  forceAlphaFormat = false,
  /** M46H — actual input pad to read from (asplit output when shared). */
  inputPad?: string,
): void {
  const fps = seq.fps.num / seq.fps.den;
  const fpsR = { num: seq.fps.num, den: seq.fps.den };
  const fit = { width: seq.width, height: seq.height };
  const clipRelWinStart = Math.max(0, plan.winStartFrame - plan.clip.timelineStartFrame);
  const winDurFrames = plan.winEndFrame - plan.winStartFrame;
  // M37: transform keyframes join the split set when scale/opacity is
  // animated (piecewise-constant export); x/y/rotation alone animate exactly.
  const hasTransform = clipHasTransform(plan.clip);
  const animated = plan.clip.effects.some((e) => e.enabled && e.animatedParams.length > 0);
  const splits = computeSegmentSplits(plan, clipRelWinStart, winDurFrames);
  if (splits.length === 0) {
    // Static OR expr-only animation: one segment, exact t-expressions.
    const seg = buildSegmentBase(plan, seq, isImage);
    const chain = animated
      ? ffmpegEffectChainAnimated(plan.clip.effects, clipRelWinStart, fpsR, fit)
      : ffmpegEffectChain(plan.clip.effects, fit);
    if (chain) seg.push(chain);
    // M37: clip transform geometry — rotate → scale → opacity (the same order
    // the preview's CSS transform applies). Animated rotation alone stays
    // exact (per-frame rotate expression); scale/opacity animation forces
    // the sampled split path instead.
    if (hasTransform) {
      seg.push(
        ...segmentTransformFilters(plan.clip, seq, clipRelWinStart, {
          exactRotation: !transformNeedsSegments(plan.clip),
          tOffsetSec: (plan.clip.timelineStartFrame - renderStartFrame) / fps,
        }),
      );
    }
    if (forceAlphaFormat && !seg.some((f) => f.startsWith("format=yuva420p"))) {
      seg.push("format=yuva420p");
      seg.push("setsar=1"); // M41: yuva420p re-derives SAR from source metadata — normalize AFTER it
    }
    // M27 fix: shift PTS so the segment's t equals its TRUE position in the
    // render window (enable windows and tpad-free overlays line up).
    const offsetSec = (plan.winStartFrame - renderStartFrame) / fps;
    if (offsetSec > 0) seg.push(`setpts=PTS+${q(offsetSec)}/TB`);
    parts.push(`[${inputPad ?? `${inputIndex}:v`}]${seg.join(",")}${outLabel}`);
    return;
  }
  // Piecewise-constant path: split the input once, trim+chain each sub-range,
  // concat. Clip fades apply AFTER the concat (they span the whole clip).
  const bounds = [clipRelWinStart, ...splits, clipRelWinStart + winDurFrames];
  const branches = bounds.slice(0, -1).map((_, i) => `[bs${uid}${i}]`).join("");
  parts.push(`[${inputPad ?? `${inputIndex}:v`}]split=${bounds.length - 1}${branches}`);
  const subLabels: string[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const b0 = bounds[i];
    const b1 = bounds[i + 1];
    const sub: string[] = [];
    const durSec = (b1 - b0) / fps;
    if (!isImage) {
      const srcStart = clipRelSrcSec(plan, seq, b0);
      sub.push(`trim=start=${q(srcStart)}:duration=${q(durSec * plan.clip.playbackSpeed)},setpts=PTS-STARTPTS`);
      if (plan.clip.playbackSpeed !== 1) sub.push(`setpts=PTS*${q(1 / plan.clip.playbackSpeed)}`);
      sub.push(`scale=${seq.width}:${seq.height}:force_original_aspect_ratio=decrease,pad=${seq.width}:${seq.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}`);
    } else {
      sub.push(`scale=${seq.width}:${seq.height}:force_original_aspect_ratio=decrease,pad=${seq.width}:${seq.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`);
    }
    const chain = ffmpegEffectChainAnimated(plan.clip.effects, b0, fpsR, fit);
    if (chain) sub.push(chain);
    // M37: transform constants sampled at this segment's boundary (stepped
    // export of animated scale/rotation/opacity — exact at keyframes), then a
    // re-fit back to the sequence dims: a transform scale changes the segment
    // size, and concat requires uniform inputs. Smaller → transparent pad
    // (alpha preserved — content stays center-aligned exactly like the CSS
    // scale-around-center); larger → center crop (the frame clips overflow,
    // same as the preview). The canvas overlay then positions the W×H stream
    // by the raw offset only (no centering compensation — see
    // overlayPositionExprs' refitToSequence flag).
    if (hasTransform) {
      sub.push(...segmentTransformFilters(plan.clip, seq, b0, { exactRotation: false, tOffsetSec: 0 }));
      const s = transformAt(plan.clip, plan.clip.timelineStartFrame + b0).scale;
      if (Math.abs(s - 1) > 1e-9) {
        if (s < 1) {
          if (!sub.some((f) => f.startsWith("format=yuva420p"))) {
          sub.push("format=yuva420p");
          sub.push("setsar=1"); // M41: see above — SAR must be normalized before the concat
        }
        sub.push(`pad=${seq.width}:${seq.height}:(ow-iw)/2:(oh-ih)/2:color=black@0`);
        } else {
          sub.push(`crop=${seq.width}:${seq.height}:(iw-${seq.width})/2:(ih-${seq.height})/2`);
        }
      }
    }
    if (forceAlphaFormat && !sub.some((f) => f.startsWith("format=yuva420p"))) {
      sub.push("format=yuva420p");
      sub.push("setsar=1"); // M41: concat inputs must carry uniform SAR — normalize AFTER the format change
    }
    const lab = `[sub${uid}${i}]`;
    subLabels.push(lab);
    parts.push(`${`[bs${uid}${i}]`}${sub.join(",")}${lab}`);
  }
  parts.push(`${subLabels.join("")}concat=n=${subLabels.length}:v=1:a=0[cat${uid}]`);
  // Clip-level fades on the reassembled stream (fade st relative to the clip
  // window inside THIS segment — the segment starts at the clip's window).
  const fade: string[] = [];
  if (plan.clip.fadeInFrames > 0) fade.push(`fade=in:st=0:d=${q(plan.clip.fadeInFrames / fps)}`);
  if (plan.clip.fadeOutFrames > 0) fade.push(`fade=out:st=${q((winDurFrames - plan.clip.fadeOutFrames) / fps)}:d=${q(plan.clip.fadeOutFrames / fps)}`);
  const offsetSec = (plan.winStartFrame - renderStartFrame) / fps;
  const shift = offsetSec > 0 ? `setpts=PTS+${q(offsetSec)}/TB` : "null";
  parts.push(`[cat${uid}]${[...fade, shift].join(",")}${outLabel}`);
}

/** Base filters of a segment WITHOUT the effect chain (M27 split path). */
function buildSegmentBase(plan: RenderClipPlan, seq: Sequence, isImage: boolean): string[] {
  const fps = seq.fps.num / seq.fps.den;
  const durSec = (plan.winEndFrame - plan.winStartFrame) / fps;
  const filters: string[] = [];
  if (isImage) {
    filters.push(`scale=${seq.width}:${seq.height}:force_original_aspect_ratio=decrease,pad=${seq.width}:${seq.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`);
  } else {
    filters.push(`trim=start=${q(srcStartSec(plan, seq))}:duration=${q(durSec * plan.clip.playbackSpeed)},setpts=PTS-STARTPTS`);
    if (plan.clip.playbackSpeed !== 1) filters.push(`setpts=PTS*${q(1 / plan.clip.playbackSpeed)}`);
    filters.push(`scale=${seq.width}:${seq.height}:force_original_aspect_ratio=decrease,pad=${seq.width}:${seq.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}`);
  }
  return filters;
}

/** Filter fragment for one visual clip segment (trim→speed→fit→effects→fade). */
function visualSegmentFilters(plan: RenderClipPlan, seq: Sequence, isImage: boolean): string[] {
  const fps = seq.fps.num / seq.fps.den;
  const durSec = (plan.winEndFrame - plan.winStartFrame) / fps;
  const filters: string[] = [];
  if (isImage) {
    // Image input is `-loop 1 -t <dur>` — just fit it.
    filters.push(`scale=${seq.width}:${seq.height}:force_original_aspect_ratio=decrease,pad=${seq.width}:${seq.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`);
  } else {
    filters.push(`trim=start=${q(srcStartSec(plan, seq))}:duration=${q(durSec * plan.clip.playbackSpeed)},setpts=PTS-STARTPTS`);
    if (plan.clip.playbackSpeed !== 1) filters.push(`setpts=PTS*${q(1 / plan.clip.playbackSpeed)}`);
    filters.push(`scale=${seq.width}:${seq.height}:force_original_aspect_ratio=decrease,pad=${seq.width}:${seq.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}`);
  }
  // M27 P2: the effect chain is emitted by emitVisualSegment (static chain or
  // animated sub-segments) — this builder keeps only base geometry.
  if (plan.clip.fadeInFrames > 0) filters.push(`fade=in:st=0:d=${q(plan.clip.fadeInFrames / fps)}`);
  if (plan.clip.fadeOutFrames > 0) filters.push(`fade=out:st=${q(durSec - plan.clip.fadeOutFrames / fps)}:d=${q(plan.clip.fadeOutFrames / fps)}`);
  return filters;
}

/** TransitionKind → ffmpeg xfade transition name; null = not exportable.
 *  M37 parity: ZOOM_IN exports as the real `zoomin` xfade (verified present
 *  on this ffmpeg build); FADE_FROM_BLACK maps to `fadeblack` (xfade has no
 *  one-sided through-black between two clips — fadeblack IS the through-black
 *  style, so both TO and FROM black render the through-black transition and
 *  neither silently degrades to a plain dissolve). ZOOM_OUT remains
 *  unexportable (no `zoomout` xfade exists) — it is skipped and disclosed
 *  via the transition report, never faked. */
const XFADE_KINDS: Record<string, string | null> = {
  CUT: null,
  CROSS_DISSOLVE: "fade",
  FADE_TO_BLACK: "fadeblack",
  FADE_FROM_BLACK: "fadeblack",
  WIPE_LEFT: "wipeleft",
  WIPE_RIGHT: "wiperight",
  SLIDE_LEFT: "slideleft",
  SLIDE_RIGHT: "slideright",
  PUSH_LEFT: "pushleft",
  PUSH_RIGHT: "pushright",
  ZOOM_IN: "zoomin",
  ZOOM_OUT: null,
};

export interface TransitionPlanReport {
  applied: string[];
  skipped: { id: string; reason: string }[];
}

/**
 * M17 §6 — transitions in the EXPORT path. Adjacent same-track pairs with a
 * transition spanning the boundary render through ffmpeg xfade (real frames
 * from BOTH clips; no synthesized media). Refusals are counted and disclosed.
 */
function planTrackTransitions(seq: Sequence, trackId: string, plans: RenderClipPlan[], report: TransitionPlanReport) {
  // For each adjacent pair in this track, find a covering transition.
  const pairs: { a: RenderClipPlan; b: RenderClipPlan; transition: (typeof seq.transitions)[number] | null }[] = [];
  for (let i = 1; i < plans.length; i++) {
    const a = plans[i - 1];
    const b = plans[i];
    const aEnd = a.clip.timelineStartFrame + a.clip.timelineDurationFrames;
    const adjacent = aEnd === b.clip.timelineStartFrame;
    let transition: (typeof seq.transitions)[number] | null = null;
    if (adjacent) {
      transition =
        seq.transitions.find(
          (t) => t.clipAId === a.clip.id && t.clipBId === b.clip.id && t.trackId === trackId && t.endFrame > aEnd - 1 && t.startFrame < b.clip.timelineStartFrame + 1,
        ) ?? null;
      if (transition) {
        const kindName = XFADE_KINDS[transition.kind];
        const dur = transition.endFrame - transition.startFrame;
        if (kindName === undefined) {
          report.skipped.push({ id: transition.id, reason: `unknown kind ${transition.kind}` });
          transition = null;
        } else if (kindName === null) {
          transition = null; // CUT or unsupported kind — straight boundary
        } else if (dur < 1 || dur > Math.min(a.clip.timelineDurationFrames, b.clip.timelineDurationFrames)) {
          report.skipped.push({ id: transition.id, reason: `duration ${dur}f exceeds the shorter clip's window` });
          transition = null;
        } else {
          report.applied.push(`${transition.kind} ${dur}f @${transition.startFrame} (${a.clip.id}→${b.clip.id})`);
        }
      }
    }
    pairs.push({ a, b, transition });
  }
  return pairs;
}

export function buildTimelineGraph(seq: Sequence, startFrame: number, endFrame: number, assetInputs: Map<string, RenderInputEntry>, report?: TransitionPlanReport, opts?: { audioOnly?: boolean }, planInputs?: Map<string, RenderInputEntry>) {
  // M47.2-A (M46.1 hotfix) — resolve an input by STABLE plan-occurrence key
  // first (the caller allocates one input per occurrence), then by asset id
  // (the legacy per-asset map). An unresolved input is an INVARIANT violation:
  // it must fail loudly here rather than silently producing black/silent media.
  const inputFor = (plan: RenderClipPlan): RenderInputEntry => {
    const entry = planInputs?.get(planOccurrenceKey(plan)) ?? assetInputs.get(plan.clip.sourceAssetId!);
    if (!entry) {
      throw new Error(`Render graph invariant violated: clip ${plan.clip.id} (track ${plan.trackIndex}, frames ${plan.winStartFrame}–${plan.winEndFrame}) has no allocated ffmpeg input for asset ${plan.clip.sourceAssetId ?? "none"}.`);
    }
    return entry;
  };
  // M38 fix: audio-only formats build a TRUE audio-only graph. ffmpeg 7.1.5
  // (measured — this bug shipped in M37 and was caught by the M38 live batch
  // suite) REJECTS filter-graph binding when any filter output is
  // unconnected, so building the video composite and mapping only [mixout]
  // fails at bind time on real audio-only renders. Skipping the video chains
  // entirely is also strictly cheaper: no base canvas, no segments, no
  // overlays are ever computed for WAV/MP3 exports.
  const audioOnly = opts?.audioOnly === true;
  const fps = seq.fps.num / seq.fps.den;
  const totalSec = (endFrame - startFrame) / fps;
  const parts: string[] = [];
  // M47.2-A — plan admission is now consistent with inputFor: a plan is
  // renderable when EITHER the asset-level map or the plan-occurrence map
  // resolves it. Missing assets are caught loudly by the caller's pre-flight;
  // here the filters only gate hasAudio capability (a video-only source has
  // no audio plan — correct media behavior, not a black-frame bug).
  const resolves = (plan: RenderClipPlan): boolean => assetInputs.has(plan.clip.sourceAssetId!) || (planInputs?.has(planOccurrenceKey(plan)) ?? false);
  const hasAudioFor = (plan: RenderClipPlan): boolean => assetInputs.get(plan.clip.sourceAssetId!)?.hasAudio === true || planInputs?.get(planOccurrenceKey(plan))?.hasAudio === true;
  const visualPlans = collectVisualPlans(seq, startFrame, endFrame).filter(resolves);
  const audioPlans = collectAudioPlans(seq, startFrame, endFrame).filter(hasAudioFor);

  // Silence bed — stable base audio so amix always has ≥1 input.
  parts.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${q(totalSec)},asetpts=PTS-STARTPTS[silence]`);

  // Video composite (M27 rework): a FULL-WINDOW black base is the primary of
  // every overlay, so the composite always spans the render window no matter
  // how clips are laid out. Segments now carry window-relative PTS, so
  // enable=between(t,…) windows match real stream time. Clips joined by a
  // validated transition are xfade-merged into a "run" first (real frames
  // from both inputs); every run/solo clip then overlays the base with its
  // exact enable window — top-down track order preserved.
  // (M38: the whole video composite — segments, captions, graphics — is
  // emitted only for video formats; interior indentation unchanged.)
  let videoLabel = "[base]";
  if (!audioOnly) {
  parts.push(`color=c=black:s=${seq.width}x${seq.height}:r=${fps}:d=${q(totalSec)},setsar=1[base]`);
  {
    let segCounter = 0;
    let compCounter = 0;
    let bgCounter = 0;
    const trackIds = [...new Set(visualPlans.map((p) => p.trackIndex))];
    for (const trackIndex of trackIds) {
      const trackPlans = visualPlans.filter((p) => p.trackIndex === trackIndex);
      const trackId = seq.tracks[trackIndex]?.id ?? "";
      const pairs = planTrackTransitions(seq, trackId, trackPlans, report ?? { applied: [], skipped: [] });
      // Group into runs: consecutive clips joined by a validated transition.
      const runs: Array<{ plans: typeof trackPlans; transitions: Array<(typeof seq.transitions)[number] | null> }> = [];
      for (let i = 0; i < trackPlans.length; i++) {
        const prevTransition = i > 0 ? pairs[i - 1]?.transition ?? null : null;
        if (prevTransition && runs.length > 0) {
          runs[runs.length - 1].plans.push(trackPlans[i]);
          runs[runs.length - 1].transitions.push(prevTransition);
        } else {
          runs.push({ plans: [trackPlans[i]], transitions: [] });
        }
      }
      for (const run of runs) {
        // M37: a run containing ANY transformed clip renders ALL its clips
        // through per-clip transparent canvases (alpha-consistent xfade
        // inputs, exact per-clip position/opacity — measured graph design).
        const runTransformed = run.plans.some((p) => clipHasTransform(p.clip));
        const labels: string[] = [];
        // M46H — video inputs may also feed several clips (one source across
        // scenes). asplit each repeated input once, then reference the split
        // pads per segment (ffmpeg forbids reusing an input pad label).
        const vSplitCounts = new Map<number, number>();
        for (const plan of run.plans) {
          const input = inputFor(plan);
          vSplitCounts.set(input.index, (vSplitCounts.get(input.index) ?? 0) + 1);
        }
        const vSplitCursor = new Map<number, number>();
        for (const [idx, n] of vSplitCounts) {
          if (n > 1) {
            const outs = Array.from({ length: n }, (_, k) => `vin${idx}_${k}`).join("][");
            parts.push(`[${idx}:v]asplit=${n}[${outs}]`);
          }
        }
        for (let i = 0; i < run.plans.length; i++) {
          const plan = run.plans[i];
          const input = inputFor(plan);
          const vk = vSplitCursor.get(input.index) ?? 0;
          vSplitCursor.set(input.index, vk + 1);
          const vInLabel = (vSplitCounts.get(input.index) ?? 1) > 1 ? `vin${input.index}_${vk}` : `${input.index}:v`;
          const label = `[tseg${segCounter}]`;
          emitVisualSegment(parts, plan, seq, input.index, input.isImage, label, `s${segCounter}`, startFrame, runTransformed, vInLabel);
          segCounter += 1;
          let streamLabel = label;
          if (runTransformed) {
            // Position THIS clip on its own transparent canvas (window-
            // relative clock — the canvas starts at t=0 of the render window
            // and spans to the clip's window end; timestamps align by value).
            const bg = `[tbg${bgCounter}]`;
            const dSec = (plan.winEndFrame - startFrame) / fps;
            parts.push(`color=c=black@0.0:s=${seq.width}x${seq.height}:r=${fps}:d=${q(Math.max(1 / fps, dSec))},setsar=1${bg}`);
            // Split-path clips are re-fitted (pre-centered) — their position
            // expression carries NO scale-centering compensation.
            const tookSplitPath = computeSegmentSplits(plan, Math.max(0, plan.winStartFrame - plan.clip.timelineStartFrame), plan.winEndFrame - plan.winStartFrame).length > 0;
            const pos = overlayPositionExprs(plan.clip, seq, fps, (plan.clip.timelineStartFrame - startFrame) / fps, tookSplitPath && clipHasTransform(plan.clip));
            const out = `[tpos${bgCounter}]`;
            const xy = pos.x ? `x='${pos.x}':` : "";
            const yy = pos.y ? `y='${pos.y}':` : "";
            parts.push(`${bg}${label}overlay=${xy}${yy}eof_action=pass${out}`);
            bgCounter += 1;
            streamLabel = out;
          }
          labels.push(streamLabel);
        }
        let runLabel = labels[0];
        for (let i = 1; i < labels.length; i++) {
          const transition = run.transitions[i - 1]!;
          const out = `[trun${compCounter}_${i}]`;
          // xfade offsets are relative to the FIRST input's t=0 — the run's
          // window-relative start of the first clip.
          const offsetSec = (transition.startFrame - run.plans[0].winStartFrame) / fps;
          const durSec = (transition.endFrame - transition.startFrame) / fps;
          parts.push(`${runLabel}${labels[i]}xfade=transition=${XFADE_KINDS[transition.kind]}:duration=${q(durSec)}:offset=${q(Math.max(0, offsetSec))}${out}`);
          runLabel = out;
        }
        // Overlay the run onto the composite with its exact enable window.
        const winStartSec = (run.plans[0].winStartFrame - startFrame) / fps;
        const winEndSec = (run.plans[run.plans.length - 1].winEndFrame - startFrame) / fps;
        const out = `[tcomp${compCounter}]`;
        parts.push(`${videoLabel}${runLabel}overlay=eof_action=pass:enable='between(t\\,${q(Math.max(0, winStartSec))}\\,${q(winEndSec)})'${out}`);
        videoLabel = out;
        compCounter += 1;
      }
    }
  }

  // Captions: drawtext windows on the composite.
  const captionClips = seq.clips.filter((c) => {
    const track = seq.tracks.find((t) => t.id === c.trackId);
    return track?.kind === "CAPTION" && track.visible && Boolean(c.captionText) && clipEndFrame(seq, c) > startFrame && c.timelineStartFrame < endFrame;
  });
  for (const cap of captionClips) {
    const st = Math.max(0, (cap.timelineStartFrame - startFrame) / fps);
    const en = (Math.min(clipEndFrame(seq, cap), endFrame) - startFrame) / fps;
    const style = cap.captionStyle;
    const yPos = style?.position === "TOP" ? "h*0.08" : style?.position === "CENTER" ? "(h-text_h)/2" : "h*0.86";
    // M37: caption clip transform position offsets (composition px). Scale/
    // rotation/opacity are not modeled for drawtext text yet — the preview
    // caption box reflects position only, so the two paths agree.
    const tx = cap.transform.x;
    const ty = cap.transform.y;
    const xExpr = Math.abs(tx) > 1e-9 ? `(w-text_w)/2+${q(tx)}` : "(w-text_w)/2";
    const yExpr = Math.abs(ty) > 1e-9 ? `${yPos}+${q(ty)}` : yPos;
    parts.push(
      `${videoLabel}drawtext=fontfile=${FALLBACK_FONT}:text='${escDrawtext(cap.captionText!)}':fontsize=${style?.fontSize ?? 48}:fontcolor=${(style?.color ?? "#FFFFFF").replace("#", "0x")}:x=${xExpr}:y=${yExpr}:enable='between(t\\,${q(st)}\\,${q(en)})'${videoLabel}`,
    );
  }

  // Graphics: NIIKI filters over the composite (their windows are absolute).
  for (const g of seq.clips) {
    const track = seq.tracks.find((t) => t.id === g.trackId);
    if (!track || !(track.kind === "GRAPHIC" || track.kind === "OVERLAY") || !track.visible || !g.graphicStyle) continue;
    const cEnd = clipEndFrame(seq, g);
    if (cEnd <= startFrame || g.timelineStartFrame >= endFrame) continue;
    const localIn = Math.max(0, startFrame - g.timelineStartFrame);
    const localOut = Math.min(g.timelineDurationFrames, endFrame - g.timelineStartFrame);
    if (localOut <= localIn) continue;
    const filters = buildGraphicFilters({ clip: g, localIn, localOut, offsetSec: (g.timelineStartFrame - startFrame) / fps }, { seq, fps, startFrame, endFrame });
    for (const f of filters) parts.push(`${videoLabel}${f}${videoLabel}`);
  }
  }

  // Audio: silence bed + every audible segment → amix (no normalize: the
  // clip gains ARE the mix, matching the preview's linear sum).
  const audioLabels: string[] = ["[silence]"];
  // M46H — one input stream may feed SEVERAL clips (one source covering three
  // scenes is normal). ffmpeg forbids reusing an input pad label, so asplit
  // each multi-use input once and reference the split outputs per plan.
  const splitCounts = new Map<number, number>();
  const inputIndexOf = (plan: RenderClipPlan) => inputFor(plan).index;
  for (const plan of audioPlans) splitCounts.set(inputIndexOf(plan), (splitCounts.get(inputIndexOf(plan)) ?? 0) + 1);
  const splitCursor = new Map<number, number>();
  for (const [idx, n] of splitCounts) {
    if (n > 1) {
      const outs = Array.from({ length: n }, (_, k) => `ain${idx}_${k}`).join("][");
      parts.push(`[${idx}:a]asplit=${n}[${outs}]`);
    }
  }
  for (let i = 0; i < audioPlans.length; i++) {
    const plan = audioPlans[i];
    const inIdx = inputIndexOf(plan);
    const k = splitCursor.get(inIdx) ?? 0;
    splitCursor.set(inIdx, k + 1);
    const audioInLabel = (splitCounts.get(inIdx) ?? 1) > 1 ? `ain${inIdx}_${k}` : `${inIdx}:a`;
    const input = inputFor(plan);
    const offsetSec = (plan.winStartFrame - startFrame) / fps;
    const durSec = (plan.winEndFrame - plan.winStartFrame) / fps;
    const gain = Math.min(4, Math.max(0, plan.clip.volume));
    // M48-H1 — the audio stream reads the clip's independent audio range.
    // The audible length is the window duration (× speed) clamped to what the
    // audio range actually covers from this window's start: a J/L-cut audio
    // range that ends early simply goes silent for the remainder (the silence
    // bed covers it) — the video window is never stretched or shifted.
    const audioStartSec = audioSrcStartSec(plan, seq);
    const audioRemainingSec = audioSrcEndSec(plan) - audioStartSec;
    const wantedSec = durSec * plan.clip.playbackSpeed;
    if (audioRemainingSec <= 0) {
      // The audio range ended before this window — nothing to mix (real
      // silence, not a fabricated tone).
      continue;
    }
    const audioDurSec = Math.min(wantedSec, audioRemainingSec);
    const seg: string[] = [`atrim=start=${q(audioStartSec)}:duration=${q(audioDurSec)},asetpts=PTS-STARTPTS`];
    if (plan.clip.playbackSpeed !== 1) {
      let speed = plan.clip.playbackSpeed;
      while (speed > 2) {
        seg.push("atempo=2");
        speed /= 2;
      }
      while (speed < 0.5) {
        seg.push("atempo=0.5");
        speed *= 2;
      }
      seg.push(`atempo=${q(speed)}`);
    }
    // M18 fix: apply the volume expression BEFORE adelay so its eval=frame
    // timeline is segment-local (clip-local seconds) — matching the preview
    // evaluator. After adelay the PTS shift would break the automation map.
    const volArgs = ffmpegVolumeArgs(plan.clip, seq.fps);
    const track = seq.tracks.find((t) => t.id === plan.clip.trackId);
    const solo = seq.tracks.some((t) => t.solo);
    const trackGain = track && !track.muted && (!solo || track.solo) ? Math.min(4, Math.max(0, track.volume ?? 1)) : 0;
    const pan = Math.min(1, Math.max(-1, plan.clip.pan ?? 0));
    if (volArgs) {
      // Automation expression × track fader (both frame-evaluable: fold the
      // fader into the expression head so the map stays segment-local).
      seg.push(`volume='${volArgs.expr}*${q(trackGain)}':eval=frame`);
    } else {
      seg.push(`volume=${q(gain * trackGain)}`);
    }
    if (pan !== 0) {
      // Equal-power pan: left = cos((pan+1)*π/4), right = sin((pan+1)*π/4).
      const l = Math.cos(((pan + 1) * Math.PI) / 4);
      const r = Math.sin(((pan + 1) * Math.PI) / 4);
      seg.push(`pan=stereo|c0=c0*${q(l)}+c1*0|c1=c1*${q(r)}+c0*0`);
    }
    seg.push(`adelay=${Math.max(0, Math.round(offsetSec * 1000))}:all=1`);
    if (plan.clip.fadeInFrames > 0) seg.push(`afade=in:st=0:d=${q(plan.clip.fadeInFrames / fps)}`);
    if (plan.clip.fadeOutFrames > 0) seg.push(`afade=out:st=${q(audioDurSec - plan.clip.fadeOutFrames / fps)}:d=${q(plan.clip.fadeOutFrames / fps)}`);
    parts.push(`[${audioInLabel}]${seg.join(",")}[a${i}]`);
    audioLabels.push(`[a${i}]`);
  }
  parts.push(`${audioLabels.join("")}amix=inputs=${audioLabels.length}:normalize=0:duration=longest[mixout]`);

  return {
    filterComplex: parts.join(";"),
    videoLabel,
    videoPlanCount: audioOnly ? 0 : visualPlans.length,
    audioPlanCount: audioPlans.length,
    skippedMissing: collectVisualPlans(seq, startFrame, endFrame).filter((p) => !resolves(p)).length,
  };
}

// ── M37: output formats ───────────────────────────────────────────────────────
// The timeline renderer previously hardcoded MP4/H.264/AAC. The formats below
// are additive and back-compatible: "mp4" (default) is byte-identical to the
// old behavior; "mov" reuses the same H.264/AAC encoding inside Apple's
// container (the ffmpeg mov muxer — +faststart applies to both); "wav" and
// "mp3" are AUDIO-ONLY exports of the exact same mix graph (the video chains
// exist in the graph but ffmpeg executes only chains that feed mapped
// outputs, so unmapped video is never computed — no second renderer, no
// second job queue; the same durable RENDER_TIMELINE job path is reused).

export type RenderOutputFormat = "mp4" | "mov" | "wav" | "mp3";
export const RENDER_OUTPUT_FORMATS: readonly RenderOutputFormat[] = ["mp4", "mov", "wav", "mp3"];

export interface RenderOutputSpec {
  /** File extension and ExportFile.format value. */
  extension: string;
  /** Audio-only exports map ONLY [mixout] and skip the video conformance gates. */
  audioOnly: boolean;
  /** Encoder arguments shared by the single-pass and windowed paths. */
  encoderArgs: string[];
}

export function renderOutputSpec(format: RenderOutputFormat): RenderOutputSpec {
  switch (format) {
    case "mov":
      return {
        extension: "mov",
        audioOnly: false,
        encoderArgs: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-threads", "2", "-x264-params", "rc-lookahead=10:ref=2", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
      };
    case "wav":
      return { extension: "wav", audioOnly: true, encoderArgs: ["-vn", "-c:a", "pcm_s16le"] };
    case "mp3":
      return { extension: "mp3", audioOnly: true, encoderArgs: ["-vn", "-c:a", "libmp3lame", "-b:a", "320k"] };
    case "mp4":
    default:
      return {
        extension: "mp4",
        audioOnly: false,
        encoderArgs: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-threads", "2", "-x264-params", "rc-lookahead=10:ref=2", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
      };
  }
}

export async function runTimelineRenderJob(job: { id: string; userId: string; paramsJson: string | null }): Promise<void> {
  const params = (job.paramsJson ? JSON.parse(job.paramsJson) : {}) as { projectId?: string; startFrame?: number; endFrame?: number; reviewRevisionId?: string; format?: string };
  const formatRaw = typeof params.format === "string" ? params.format.toLowerCase() : "mp4";
  const format: RenderOutputFormat = (RENDER_OUTPUT_FORMATS as readonly string[]).includes(formatRaw) ? (formatRaw as RenderOutputFormat) : "mp4";
  const spec = renderOutputSpec(format);
  const projectId = params.projectId ?? "";
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project) throw new Error("Project not found for this user.");
  if (project.userId !== job.userId) {
    // M30: collaborators (workspace ADMIN/EDITOR, per-project EDITOR shares)
    // may render shared projects — the same server-side matrix as the routes.
    const { getProjectAccess, canEdit } = await import("@/lib/collab");
    const access = await getProjectAccess(job.userId, project);
    if (!canEdit(access)) throw new Error("Project not found for this user.");
  }
  const latest = await db.timelineVersion.findFirst({ where: { projectId }, orderBy: { versionNumber: "desc" } });
  if (!latest) throw new Error("The project has no sequence to render yet.");
  const seq = JSON.parse(latest.sequenceJson) as Sequence;
  // Default window: the whole sequence (sequence end, NOT a sentinel — an
  // unbounded default once produced a 33-million-second render).
  const startFrame = Math.max(0, params.startFrame ?? 0);
  const endFrame = Math.min(params.endFrame ?? sequenceEndFrame(seq), sequenceEndFrame(seq), 4 * 3600 * Math.round(seq.fps.num / seq.fps.den));
  const fps = seq.fps.num / seq.fps.den;
  const totalSec = (endFrame - startFrame) / fps;
  if (totalSec <= 0) throw new Error("Render window is empty — the sequence has no clips.");
  // M28: refuse to start a render on a nearly full volume — ENOSPC mid-render
  // would truncate the output and waste the whole encode.
  await assertDiskSpace(MEDIA_ROOT);

  // Distinct referenced assets → resolved rows (owned by the caller).
  const referencedAssetIds = [...new Set(seq.clips.map((c) => c.sourceAssetId).filter(Boolean))] as string[];
  const assets = await db.mediaAsset.findMany({ where: { id: { in: referencedAssetIds }, userId: job.userId } });
  const assetById = new Map(assets.map((a) => [a.id, a]));
  // M47.2-A — INVARIANT 1: every referenced asset must resolve to an owned
  // row BEFORE ffmpeg runs. Skipping used to yield a valid container full of
  // black frames and silence; now the render fails and names the offenders.
  const missingAssetIds = referencedAssetIds.filter((id) => !assetById.has(id));
  if (missingAssetIds.length > 0) {
    const samples = seq.clips
      .filter((c) => c.sourceAssetId && missingAssetIds.includes(c.sourceAssetId))
      .slice(0, 5)
      .map((c) => `clip ${c.id} → asset ${c.sourceAssetId}`);
    throw new Error(`Render aborted — ${missingAssetIds.length} referenced asset(s) could not be resolved for this user (e.g. ${samples.join("; ")}). Nothing was rendered: relink or fix the missing media instead of publishing black output.`);
  }
  // M47.2-A — INVARIANT 2: the source FILE must exist on disk. A present row
  // with a vanished file is an invalid input — fail clearly, never black.
  for (const id of referencedAssetIds) {
    const asset = assetById.get(id)!;
    let exists = false;
    try {
      exists = (await stat(asset.storagePath)).isFile();
    } catch {
      exists = false;
    }
    if (!exists) throw new Error(`Render aborted — the source file for asset ${id} is missing on disk (${asset.storagePath}). Nothing was rendered; relink the media and retry.`);
  }
  // One real ffprobe per distinct asset decides whether an audio stream can
  // be referenced in the graph (video files may be video-only).
  const hasAudioById = new Map<string, boolean>();
  for (const id of referencedAssetIds) {
    try {
      const probe = await probeMediaDeep(assetById.get(id)!.storagePath);
      hasAudioById.set(id, probe.hasAudio);
    } catch {
      hasAudioById.set(id, false);
    }
  }
  // M47.2-A — the SAME allocation routine as the long-form path: one ffmpeg
  // input per plan occurrence, keyed by stable plan identity, with the
  // asset-level mirror for the graph's hasAudio/missing checks. (The M46H
  // reference-keyed map silently missed every lookup here because the graph
  // builder re-collects plans — the root cause of the black/silence output.)
  const allPlans = [...collectVisualPlans(seq, startFrame, endFrame), ...collectAudioPlans(seq, startFrame, endFrame)];
  const { inputArgs, inputByPlanKey, usedByAsset: used } = allocateRenderInputs(allPlans, assetById, hasAudioById, fps);

  const transitionReport: TransitionPlanReport = { applied: [], skipped: [] };
  const outPath = pathInsideMediaRoot("timeline-renders", `u_${job.userId}`, `seq_${projectId}_${Date.now().toString(36)}.${spec.extension}`);
  await mkdir(path.dirname(outPath), { recursive: true });

  // M20 §3: LONG-FORM WINDOWED DURABLE RENDERING. One giant filter_complex
  // holds a frame buffer per segment — the 600s validation OOM-killed ffmpeg
  // at ~2.5GB RSS on a 4GB host (dmesg evidence). Windows render sequentially
  // (bounded graph each), then a stream-copy concat stitches them losslessly
  // (identical encoder settings, frame-aligned boundaries). M20 hardening:
  // each window passes ONLY the assets its own plans reference (bounded
  // demuxers → bounded RSS), and window segments are removed after the
  // concat settles (success or failure) — no temp-file leak.
  const LONG_FORM_THRESHOLD_SEC = 240;
  const WINDOW_SEC = 60;
  const totalWindows = Math.ceil(totalSec / WINDOW_SEC);
  // M37: audio-only exports never window — the mix graph is light and the
  // concat demuxer path for wav needs no lossless-stitching machinery.
  if (!spec.audioOnly && totalSec > LONG_FORM_THRESHOLD_SEC) {
    const segPaths: string[] = [];
    let listPath: string | null = null;
    const cleanupTemp = async () => {
      for (const p of segPaths) await unlink(p).catch(() => undefined);
      if (listPath) await unlink(listPath).catch(() => undefined);
    };
    let windowStartFrame = startFrame;
    for (let w = 0; w < totalWindows; w++) {
      let windowEndFrame = Math.min(endFrame, windowStartFrame + Math.round(WINDOW_SEC * fps));
      if (windowEndFrame <= windowStartFrame) break;
      // Keep boundaries out of any transition's range (an xfade split across
      // windows would render two half-transitions).
      for (const t of seq.transitions) {
        if (t.startFrame < windowEndFrame && t.endFrame > windowStartFrame && t.endFrame > windowEndFrame) {
          windowEndFrame = Math.min(endFrame, t.endFrame + Math.round(fps));
        }
      }
      const winSec = (windowEndFrame - windowStartFrame) / fps;
      if (winSec <= 0) break;
      // M47.2-A — the SAME allocation routine as the normal path (one input
      // per plan occurrence, stable content keys, asset-level mirror). Image
      // inputs now carry their own clip's -t window instead of the first
      // plan's, so a reused image can never fall short mid-clip.
      const wPlans = [...collectVisualPlans(seq, windowStartFrame, windowEndFrame), ...collectAudioPlans(seq, windowStartFrame, windowEndFrame)];
      const { inputArgs: winInputArgs, inputByPlanKey: wInputByPlanKey, usedByAsset: wUsed } = allocateRenderInputs(wPlans, assetById, hasAudioById, fps);
      const wReport = w === 0 ? transitionReport : { applied: [], skipped: [] };
      const wGraph = buildTimelineGraph(seq, windowStartFrame, windowEndFrame, wUsed, wReport, undefined, wInputByPlanKey);
      const segPath = pathInsideMediaRoot("timeline-renders", `u_${job.userId}`, `seg_${projectId}_${w}_${Date.now().toString(36)}.${spec.extension}`);
      segPaths.push(segPath);
      const winArgs = [
        "-y", "-loglevel", "error",
        ...winInputArgs,
        "-filter_complex", wGraph.filterComplex,
        "-map", wGraph.videoLabel, "-map", "[mixout]",
        // M37: the encoder caps moved into renderOutputSpec (shared with the
        // single-pass path — identical settings, so stream-copy concat holds).
        ...spec.encoderArgs,
        "-t", q(winSec),
        segPath,
      ];
      await jobManager.setProgress(job.id, Math.min(90, 5 + Math.round(((w + 1) / totalWindows) * 80)), `Rendering window ${w + 1}/${totalWindows} (long-form)`);
      await jobManager.runFfmpeg(job.id, winArgs, {
        totalDurationSec: winSec,
        stageLabel: `Rendering timeline window ${w + 1}/${totalWindows} (FFmpeg)`,
        onDone: async () => undefined,
      });
      // runFfmpeg reports terminal failures via the job row; abort the loop.
      const jobRow = await db.job.findUnique({ where: { id: job.id }, select: { status: true } });
      if (jobRow?.status === "FAILED" || jobRow?.status === "CANCELLED") {
        await cleanupTemp();
        return;
      }
      windowStartFrame = windowEndFrame;
    }
    // Stream-copy concat — no re-encode, no A/V realignment. M20 §3: window
    // segments and the concat list are temp files — removed when the concat
    // settles (success or failure); only the registered output survives.
    listPath = pathInsideMediaRoot("timeline-renders", `u_${job.userId}`, `list_${projectId}_${Date.now().toString(36)}.txt`);
    await writeFile(listPath, segPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
    await jobManager.setProgress(job.id, 92, "Concatenating rendered windows");
    await jobManager.runFfmpeg(job.id, [
      "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listPath,
      "-c", "copy", "-movflags", "+faststart", outPath,
    ], {
      totalDurationSec: totalSec,
      stageLabel: "Concatenating long-form windows (FFmpeg)",
      onDone: async () => undefined,
      onSettled: cleanupTemp,
    });
    // Register the assembled output (validation happens below via the shared path).
    const probe = await probeMediaDeep(outPath);
    // M37: video conformance gates apply to video formats only.
    if (!spec.audioOnly && !probe.hasVideo) throw new Error("Rendered file has no video stream — rejected.");
    // M28: conformance gates before publication — a successful ffmpeg exit
    // alone is not evidence of a valid output. Duration must track the window
    // (tolerance max(0.5s, 2%) for container rounding); dimensions must equal
    // the sequence fit exactly (the pad/scale chain targets them).
    if (probe.durationSec !== null && Math.abs(probe.durationSec - totalSec) > Math.max(0.5, totalSec * 0.02)) {
      throw new Error(`Rendered duration ${probe.durationSec.toFixed(2)}s does not match the requested window ${totalSec.toFixed(2)}s — output rejected, retry the render.`);
    }
    if (!spec.audioOnly && probe.width && probe.height && (probe.width !== seq.width || probe.height !== seq.height)) {
      throw new Error(`Rendered dimensions ${probe.width}×${probe.height} do not match the sequence fit ${seq.width}×${seq.height} — output rejected.`);
    }
    const st = await stat(outPath);
    const exportRow = await db.exportFile.create({
      data: {
        userId: job.userId,
        kind: "TIMELINE_RENDER",
        format: format,
        filename: path.basename(outPath),
        storagePath: outPath,
        sizeBytes: st.size,
        durationSec: probe.durationSec ?? totalSec,
        mediaId: null,
        paramsJson: JSON.stringify({
          projectId,
          startFrame,
          endFrame,
          width: seq.width,
          height: seq.height,
          fps: `${seq.fps.num}/${seq.fps.den}`,
          windowed: true,
          windows: segPaths.length,
          format,
          transitions: { applied: transitionReport.applied, skipped: transitionReport.skipped },
        }),
      },
    });
    // M20 §3 idempotent completion: the handler must mark the durable job
    // COMPLETED itself — nothing else does. Without this the job stayed
    // PROCESSING (heartbeats stopped), the stale-claim sweep requeued it, and
    // the render restarted until retries were exhausted ("interrupted").
    await jobManager.complete(job.id, exportRow.id, "Timeline render complete (long-form windowed).");
    return;
  }

  const graph = buildTimelineGraph(seq, startFrame, endFrame, used, transitionReport, { audioOnly: spec.audioOnly }, inputByPlanKey);
  // M47.2-A — INVARIANT 3 (defense in depth): if any intended visual plan
  // still resolves to no input, abort BEFORE ffmpeg runs. The pre-flight
  // checks above should make this unreachable; if it ever fires, the render
  // fails loudly instead of publishing a black, silent container.
  if (graph.skippedMissing > 0) {
    throw new Error(`Render aborted — ${graph.skippedMissing} visual clip(s) could not be resolved to actual media inputs. Nothing was rendered; fix or relink the timeline's missing media.`);
  }
  // M37: audio-only formats map ONLY the mix. (M38 fix: the graph is now
  // genuinely audio-only — ffmpeg rejects ANY unconnected filter output at
  // bind time, so the unmapped video composite broke WAV/MP3 renders.)
  const mapArgs = spec.audioOnly ? ["-map", "[mixout]"] : ["-map", graph.videoLabel, "-map", "[mixout]"];
  const args = [
    "-y", "-loglevel", "error",
    ...inputArgs,
    "-filter_complex", graph.filterComplex,
    ...mapArgs,
    ...spec.encoderArgs,
    "-t", q(totalSec),
    outPath,
  ];

  await jobManager.setProgress(job.id, 5, `Rendering ${graph.videoPlanCount} visual / ${graph.audioPlanCount} audio segment(s)`);
  await jobManager.runFfmpeg(job.id, args, {
    totalDurationSec: totalSec,
    stageLabel: "Rendering timeline (FFmpeg)",
    onDone: async () => {
      // Validate the REAL output before registering it.
      const probe = await probeMediaDeep(outPath);
      if (!spec.audioOnly && !probe.hasVideo) throw new Error("Rendered file has no video stream — rejected.");
      if (spec.audioOnly && !probe.hasAudio) throw new Error("Rendered audio file has no audio stream — rejected.");
      const st = await stat(outPath);
      const exportRow = await db.exportFile.create({
        data: {
          userId: job.userId,
          kind: "TIMELINE_RENDER",
          format: format,
          filename: path.basename(outPath),
          storagePath: outPath,
          sizeBytes: st.size,
          durationSec: probe.durationSec ?? totalSec,
          mediaId: null,
          paramsJson: JSON.stringify({
            projectId,
            startFrame,
            endFrame,
            width: seq.width,
            height: seq.height,
            fps: seq.fps,
            format,
            segments: { video: graph.videoPlanCount, audio: graph.audioPlanCount, skippedMissing: graph.skippedMissing },
            transitions: { applied: transitionReport.applied, skipped: transitionReport.skipped },
          }),
        },
      });

    // M30: review revisions ride the REAL render pipeline — when this job
    // was started for a review revision, flip it to READY_FOR_REVIEW with
    // the validated export attached (never a mock output).
    if (params.reviewRevisionId) {
      await db.reviewRevision.update({
        where: { id: params.reviewRevisionId },
        data: {
          status: "READY_FOR_REVIEW",
          previewExportId: exportRow.id,
          previewDurationSec: probe.durationSec ?? totalSec,
        },
      }).catch(() => undefined);
      const rev = await db.reviewRevision.findUnique({
        where: { id: params.reviewRevisionId },
        select: { projectId: true, sessionNo: true, title: true, createdById: true, assignments: { select: { reviewerUserId: true } } },
      });
      if (rev) {
        const { notify, notifyMany } = await import("@/lib/notify");
        await notify({ userId: rev.createdById, type: "revision.ready", projectId: rev.projectId, payload: { revisionId: params.reviewRevisionId, sessionNo: rev.sessionNo, title: rev.title }, dedupKey: `revision.ready:${params.reviewRevisionId}` }).catch(() => undefined);
        await notifyMany(rev.assignments.map((a) => a.reviewerUserId).filter((x): x is string => Boolean(x)), {
          type: "review.requested", projectId: rev.projectId,
          payload: { revisionId: params.reviewRevisionId, sessionNo: rev.sessionNo, title: rev.title },
          dedupKey: `review.requested:${params.reviewRevisionId}`,
        }).catch(() => undefined);
      }
    }
      // M20 §3 idempotent completion (same rationale as the windowed path).
      await jobManager.complete(job.id, exportRow.id, "Timeline render complete.");
    },
  });
}
