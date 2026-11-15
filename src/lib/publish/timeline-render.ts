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
import { mkdir, stat } from "fs/promises";
import path from "path";
import { db } from "@/lib/db";
import { pathInsideMediaRoot } from "@/lib/media-storage";
import { clipEndFrame, type Clip, type Sequence } from "@/lib/editor/model";
import { sequenceEndFrame } from "@/lib/editor/preview";
import { ffmpegEffectChain } from "@/lib/editor/filters";
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
  const { clip } = plan;
  const offsetFrames = Math.max(0, plan.winStartFrame - clip.timelineStartFrame);
  const srcOffset = Math.round((offsetFrames * clip.playbackSpeed * clip.sourceFps.num * seq.fps.den) / (clip.sourceFps.den * seq.fps.num));
  return (clip.sourceInFrame + srcOffset) / (clip.sourceFps.num / clip.sourceFps.den);
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
  const chain = ffmpegEffectChain(plan.clip.effects);
  if (chain) filters.push(chain);
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

  // Video composite: per-track chains (xfade for validated transitions,
  // enable-window overlays otherwise), overlaid in track order — matching
  // the preview resolver's top-down track rule.
  let videoLabel = "[base]";
  if (visualPlans.length === 0) {
    parts.push(`color=c=black:s=${seq.width}x${seq.height}:d=${q(totalSec)},setsar=1[base]`);
    videoLabel = "[base]";
  } else {
    const trackIds = [...new Set(visualPlans.map((p) => p.trackIndex))];
    let segCounter = 0;
    let chainCounter = 0;
    let baseChain: string | null = null;
    for (const trackIndex of trackIds) {
      const trackPlans = visualPlans.filter((p) => p.trackIndex === trackIndex);
      const trackId = seq.tracks[trackIndex]?.id ?? "";
      const pairs = planTrackTransitions(seq, trackId, trackPlans, report ?? { applied: [], skipped: [] });
      // Chain the first segment.
      const first = trackPlans[0];
      const inFirst = assetInputs.get(first.clip.sourceAssetId)!;
      const firstLabel = `[tseg${segCounter}]`;
      parts.push(`[${inFirst.index}:v]${visualSegmentFilters(first, seq, inFirst.isImage).join(",")}${firstLabel}`);
      segCounter += 1;
      let chain = firstLabel;
      for (let i = 1; i < trackPlans.length; i++) {
        const plan = trackPlans[i];
        const input = assetInputs.get(plan.clip.sourceAssetId)!;
        const segLabel = `[tseg${segCounter}]`;
        parts.push(`[${input.index}:v]${visualSegmentFilters(plan, seq, input.isImage).join(",")}${segLabel}`);
        segCounter += 1;
        const out = `[tchain${chainCounter}]`;
        const transition = pairs[i - 1]?.transition ?? null;
        if (transition) {
          // xfade consumes REAL frames from both segments (no synthesized media).
          const offsetSec = (transition.startFrame - first.clip.timelineStartFrame) / fps;
          const durSec = (transition.endFrame - transition.startFrame) / fps;
          parts.push(`${chain}${segLabel}xfade=transition=${XFADE_KINDS[transition.kind]}:duration=${q(durSec)}:offset=${q(Math.max(0, offsetSec))}${out}`);
        } else {
          const offsetSec = plan.winStartFrame / fps;
          const endSec = plan.winEndFrame / fps;
          parts.push(`${chain}${segLabel}overlay=eof_action=pass:enable='between(t\\,${q(offsetSec)}\\,${q(endSec)})'${out}`);
        }
        chainCounter += 1;
        chain = out;
      }
      // Overlay this track's chain onto the running composite (track order).
      if (baseChain === null) {
        baseChain = chain;
        videoLabel = chain;
      } else {
        const out = `[tcomp${chainCounter}]`;
        parts.push(`${baseChain}${chain}overlay=eof_action=pass${out}`);
        baseChain = out;
        videoLabel = out;
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
    const offsetSec = plan.winStartFrame / fps;
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
    seg.push(`adelay=${Math.max(0, Math.round(offsetSec * 1000))}:all=1`);
    const volArgs = ffmpegVolumeArgs(plan.clip, seq.fps);
    if (volArgs) seg.push(`volume=${volArgs.expr}:eval=frame`);
    else seg.push(`volume=${q(gain)}`);
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
  const graph = buildTimelineGraph(seq, startFrame, endFrame, used, transitionReport);
  const outPath = pathInsideMediaRoot("timeline-renders", `u_${job.userId}`, `seq_${projectId}_${Date.now().toString(36)}.mp4`);
  await mkdir(path.dirname(outPath), { recursive: true });

  const args = [
    "-y", "-loglevel", "error",
    ...inputArgs,
    "-filter_complex", graph.filterComplex,
    "-map", graph.videoLabel, "-map", "[mixout]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
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
      await db.exportFile.create({
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
    },
  });
}
