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

/** Source seconds for a clip-relative TIMELINE frame (M27 keyframe splits). */
function clipRelSrcSec(plan: RenderClipPlan, seq: Sequence, clipRelFrame: number): number {
  const { clip } = plan;
  const srcOffset = Math.round((clipRelFrame * clip.playbackSpeed * clip.sourceFps.num * seq.fps.den) / (clip.sourceFps.den * seq.fps.num));
  return (clip.sourceInFrame + srcOffset) / (clip.sourceFps.num / clip.sourceFps.den);
}

/**
 * M27 P2 — emit ONE clip's video segment. Animated clips with non-expr
 * keyframed params (colorbalance/gblur/unsharp families) are SPLIT at their
 * keyframe frames into per-segment constant chains (real processing, real
 * concat — no fabricated animation); expr-capable params (eq family,
 * vignette) animate exactly via eval=frame t-expressions with no split.
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
): void {
  const fps = seq.fps.num / seq.fps.den;
  const fpsR = { num: seq.fps.num, den: seq.fps.den };
  const fit = { width: seq.width, height: seq.height };
  const clipRelWinStart = Math.max(0, plan.winStartFrame - plan.clip.timelineStartFrame);
  const winDurFrames = plan.winEndFrame - plan.winStartFrame;
  const animated = plan.clip.effects.some((e) => e.enabled && e.animatedParams.length > 0);
  const splits = animated ? segmentSplitFrames(plan.clip.effects, plan.clip.timelineDurationFrames).filter((f) => f > clipRelWinStart && f < clipRelWinStart + winDurFrames) : [];
  if (splits.length === 0) {
    // Static OR expr-only animation: one segment, exact t-expressions.
    const seg = buildSegmentBase(plan, seq, isImage);
    const chain = animated
      ? ffmpegEffectChainAnimated(plan.clip.effects, clipRelWinStart, fpsR, fit)
      : ffmpegEffectChain(plan.clip.effects, fit);
    if (chain) seg.push(chain);
    // M27 fix: shift PTS so the segment's t equals its TRUE position in the
    // render window (enable windows and tpad-free overlays line up).
    const offsetSec = (plan.winStartFrame - renderStartFrame) / fps;
    if (offsetSec > 0) seg.push(`setpts=PTS+${q(offsetSec)}/TB`);
    parts.push(`[${inputIndex}:v]${seg.join(",")}${outLabel}`);
    return;
  }
  // Piecewise-constant path: split the input once, trim+chain each sub-range,
  // concat. Clip fades apply AFTER the concat (they span the whole clip).
  const bounds = [clipRelWinStart, ...splits, clipRelWinStart + winDurFrames];
  const branches = bounds.slice(0, -1).map((_, i) => `[bs${uid}${i}]`).join("");
  parts.push(`[${inputIndex}:v]split=${bounds.length - 1}${branches}`);
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

/** TransitionKind → ffmpeg xfade transition name; null = not exportable. */
const XFADE_KINDS: Record<string, string | null> = {
  CUT: null,
  CROSS_DISSOLVE: "fade",
  FADE_TO_BLACK: "fadeblack",
  FADE_FROM_BLACK: "fade",
  WIPE_LEFT: "wipeleft",
  WIPE_RIGHT: "wiperight",
  SLIDE_LEFT: "slideleft",
  SLIDE_RIGHT: "slideright",
  PUSH_LEFT: "pushleft",
  PUSH_RIGHT: "pushright",
  ZOOM_IN: null,
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

export function buildTimelineGraph(seq: Sequence, startFrame: number, endFrame: number, assetInputs: Map<string, { index: number; isImage: boolean; hasAudio: boolean }>, report?: TransitionPlanReport) {
  const fps = seq.fps.num / seq.fps.den;
  const totalSec = (endFrame - startFrame) / fps;
  const parts: string[] = [];
  const visualPlans = collectVisualPlans(seq, startFrame, endFrame).filter((p) => assetInputs.has(p.clip.sourceAssetId));
  const audioPlans = collectAudioPlans(seq, startFrame, endFrame).filter((p) => assetInputs.get(p.clip.sourceAssetId)?.hasAudio);

  // Silence bed — stable base audio so amix always has ≥1 input.
  parts.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${q(totalSec)},asetpts=PTS-STARTPTS[silence]`);

  // Video composite (M27 rework): a FULL-WINDOW black base is the primary of
  // every overlay, so the composite always spans the render window no matter
  // how clips are laid out. Segments now carry window-relative PTS, so
  // enable=between(t,…) windows match real stream time. Clips joined by a
  // validated transition are xfade-merged into a "run" first (real frames
  // from both inputs); every run/solo clip then overlays the base with its
  // exact enable window — top-down track order preserved.
  parts.push(`color=c=black:s=${seq.width}x${seq.height}:r=${fps}:d=${q(totalSec)},setsar=1[base]`);
  let videoLabel = "[base]";
  {
    let segCounter = 0;
    let compCounter = 0;
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
        const labels: string[] = [];
        for (let i = 0; i < run.plans.length; i++) {
          const plan = run.plans[i];
          const input = assetInputs.get(plan.clip.sourceAssetId)!;
          const label = `[tseg${segCounter}]`;
          emitVisualSegment(parts, plan, seq, input.index, input.isImage, label, `s${segCounter}`, startFrame);
          segCounter += 1;
          labels.push(label);
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
    parts.push(
      `${videoLabel}drawtext=fontfile=${FALLBACK_FONT}:text='${escDrawtext(cap.captionText!)}':fontsize=${style?.fontSize ?? 48}:fontcolor=${(style?.color ?? "#FFFFFF").replace("#", "0x")}:x=(w-text_w)/2:y=${yPos}:enable='between(t\\,${q(st)}\\,${q(en)})'${videoLabel}`,
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

  // Audio: silence bed + every audible segment → amix (no normalize: the
  // clip gains ARE the mix, matching the preview's linear sum).
  const audioLabels: string[] = ["[silence]"];
  for (let i = 0; i < audioPlans.length; i++) {
    const plan = audioPlans[i];
    const input = assetInputs.get(plan.clip.sourceAssetId)!;
    const offsetSec = (plan.winStartFrame - startFrame) / fps;
    const durSec = (plan.winEndFrame - plan.winStartFrame) / fps;
    const gain = Math.min(4, Math.max(0, plan.clip.volume));
    const seg: string[] = [`atrim=start=${q(srcStartSec(plan, seq))}:duration=${q(durSec * plan.clip.playbackSpeed)},asetpts=PTS-STARTPTS`];
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
    if (plan.clip.fadeOutFrames > 0) seg.push(`afade=out:st=${q(durSec - plan.clip.fadeOutFrames / fps)}:d=${q(plan.clip.fadeOutFrames / fps)}`);
    parts.push(`[${input.index}:a]${seg.join(",")}[a${i}]`);
    audioLabels.push(`[a${i}]`);
  }
  parts.push(`${audioLabels.join("")}amix=inputs=${audioLabels.length}:normalize=0:duration=longest[mixout]`);

  return {
    filterComplex: parts.join(";"),
    videoLabel,
    videoPlanCount: visualPlans.length,
    audioPlanCount: audioPlans.length,
    skippedMissing: collectVisualPlans(seq, startFrame, endFrame).filter((p) => !assetInputs.has(p.clip.sourceAssetId)).length,
  };
}

export async function runTimelineRenderJob(job: { id: string; userId: string; paramsJson: string | null }): Promise<void> {
  const params = (job.paramsJson ? JSON.parse(job.paramsJson) : {}) as { projectId?: string; startFrame?: number; endFrame?: number };
  const projectId = params.projectId ?? "";
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project || project.userId !== job.userId) throw new Error("Project not found for this user.");
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

  // Distinct assets → ffmpeg inputs.
  const used = new Map<string, { index: number; isImage: boolean; hasAudio: boolean }>();
  const inputArgs: string[] = [];
  let nextIndex = 0;
  const assets = await db.mediaAsset.findMany({ where: { id: { in: [...new Set(seq.clips.map((c) => c.sourceAssetId).filter(Boolean))] }, userId: job.userId } });
  const assetById = new Map(assets.map((a) => [a.id, a]));
  // One real ffprobe per distinct asset decides whether an audio stream can
  // be referenced in the graph (video files may be video-only).
  const hasAudioById = new Map<string, boolean>();
  for (const id of [...new Set(seq.clips.map((c) => c.sourceAssetId).filter(Boolean))]) {
    const asset = assetById.get(id);
    if (!asset) continue;
    try {
      const probe = await probeMediaDeep(asset.storagePath);
      hasAudioById.set(id, probe.hasAudio);
    } catch {
      hasAudioById.set(id, false);
    }
  }
  for (const plan of [...collectVisualPlans(seq, startFrame, endFrame), ...collectAudioPlans(seq, startFrame, endFrame)]) {
    const id = plan.clip.sourceAssetId;
    if (!id || used.has(id)) continue;
    const asset = assetById.get(id);
    if (!asset) continue;
    const isImage = asset.kind === "IMAGE";
    used.set(id, { index: nextIndex, isImage, hasAudio: hasAudioById.get(id) ?? false });
    if (isImage) {
      const win = plan.winEndFrame - plan.winStartFrame;
      inputArgs.push("-loop", "1", "-framerate", String(fps), "-t", q(win / fps), "-i", asset.storagePath);
    } else {
      inputArgs.push("-i", asset.storagePath);
    }
    nextIndex += 1;
  }

  const transitionReport: TransitionPlanReport = { applied: [], skipped: [] };
  const outPath = pathInsideMediaRoot("timeline-renders", `u_${job.userId}`, `seq_${projectId}_${Date.now().toString(36)}.mp4`);
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
  if (totalSec > LONG_FORM_THRESHOLD_SEC) {
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
      // M20 §3: bound this window's ffmpeg inputs to the assets its plans
      // actually reference. Deterministic two-pass: collect the same plans
      // the graph builder will collect, gather distinct assets from them.
      const wPlans = [...collectVisualPlans(seq, windowStartFrame, windowEndFrame), ...collectAudioPlans(seq, windowStartFrame, windowEndFrame)];
      const wAssetIds = [...new Set(wPlans.map((p) => p.clip.sourceAssetId).filter(Boolean))] as string[];
      const used = new Map<string, { index: number; isImage: boolean; hasAudio: boolean }>();
      const winInputArgs: string[] = [];
      let winIndex = 0;
      for (const id of wAssetIds) {
        const asset = assetById.get(id);
        if (!asset) continue;
        const plan = wPlans.find((p) => p.clip.sourceAssetId === id);
        const isImage = asset.kind === "IMAGE";
        used.set(id, { index: winIndex, isImage, hasAudio: hasAudioById.get(id) ?? false });
        if (isImage) {
          const win = (plan?.winEndFrame ?? windowEndFrame) - (plan?.winStartFrame ?? windowStartFrame);
          winInputArgs.push("-loop", "1", "-framerate", String(fps), "-t", q(Math.max(1, win) / fps), "-i", asset.storagePath);
        } else {
          winInputArgs.push("-i", asset.storagePath);
        }
        winIndex += 1;
      }
      const wReport = w === 0 ? transitionReport : { applied: [], skipped: [] };
      const wGraph = buildTimelineGraph(seq, windowStartFrame, windowEndFrame, used, wReport);
      const segPath = pathInsideMediaRoot("timeline-renders", `u_${job.userId}`, `seg_${projectId}_${w}_${Date.now().toString(36)}.mp4`);
      segPaths.push(segPath);
      const winArgs = [
        "-y", "-loglevel", "error",
        ...winInputArgs,
        "-filter_complex", wGraph.filterComplex,
        "-map", wGraph.videoLabel, "-map", "[mixout]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
        // M20 §3: bounded-memory encode on small hosts — cap x264 threads and
        // lookahead so a window's RSS stays well under the OOM line even when
        // the host also runs the app server (observed: default thread/lookahead
        // auto-sizing pushed the 4GB container into global OOM).
        "-threads", "2", "-x264-params", "rc-lookahead=10:ref=2",
        "-c:a", "aac", "-b:a", "192k",
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
    if (!probe.hasVideo) throw new Error("Rendered file has no video stream — rejected.");
    // M28: conformance gates before publication — a successful ffmpeg exit
    // alone is not evidence of a valid output. Duration must track the window
    // (tolerance max(0.5s, 2%) for container rounding); dimensions must equal
    // the sequence fit exactly (the pad/scale chain targets them).
    if (probe.durationSec !== null && Math.abs(probe.durationSec - totalSec) > Math.max(0.5, totalSec * 0.02)) {
      throw new Error(`Rendered duration ${probe.durationSec.toFixed(2)}s does not match the requested window ${totalSec.toFixed(2)}s — output rejected, retry the render.`);
    }
    if (probe.width && probe.height && (probe.width !== seq.width || probe.height !== seq.height)) {
      throw new Error(`Rendered dimensions ${probe.width}×${probe.height} do not match the sequence fit ${seq.width}×${seq.height} — output rejected.`);
    }
    const st = await stat(outPath);
    const exportRow = await db.exportFile.create({
      data: {
        userId: job.userId,
        kind: "TIMELINE_RENDER",
        format: "mp4",
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

  const graph = buildTimelineGraph(seq, startFrame, endFrame, used, transitionReport);
  const args = [
    "-y", "-loglevel", "error",
    ...inputArgs,
    "-filter_complex", graph.filterComplex,
    "-map", graph.videoLabel, "-map", "[mixout]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    // M20 §3: same bounded-memory encode caps as the long-form windows.
    "-threads", "2", "-x264-params", "rc-lookahead=10:ref=2",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
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
      if (!probe.hasVideo) throw new Error("Rendered file has no video stream — rejected.");
      const st = await stat(outPath);
      const exportRow = await db.exportFile.create({
        data: {
          userId: job.userId,
          kind: "TIMELINE_RENDER",
          format: "mp4",
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
            segments: { video: graph.videoPlanCount, audio: graph.audioPlanCount, skippedMissing: graph.skippedMissing },
            transitions: { applied: transitionReport.applied, skipped: transitionReport.skipped },
          }),
        },
      });
      // M20 §3 idempotent completion (same rationale as the windowed path).
      await jobManager.complete(job.id, exportRow.id, "Timeline render complete.");
    },
  });
}
