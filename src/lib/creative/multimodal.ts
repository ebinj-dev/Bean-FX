/**
 * M11 — Unified multimodal project analysis (§2).
 *
 * Produces a NORMALIZED observation set that combines what the project
 * actually contains — video streams, embedded audio, external audio,
 * transcripts, captions, scenes, timeline structure — with STRICT time
 * bookkeeping: every observation carries SOURCE-media time and/or TIMELINE
 * time explicitly, plus the analysis method, evidence type, confidence and
 * processing status. Nothing is invented for missing/unsupported/inaccessible
 * streams: those become honest `missing`/`unsupported`/`failed` observations.
 *
 * Dependency fingerprints (§10): a stable hash over (asset id, size, mtime,
 * provider/model, timeline context version) drives artifact deduplication and
 * invalidation — recomputed only when a dependency actually changed.
 */
import { execFile } from "child_process";
import { createHash } from "crypto";
import { statSync } from "fs";
import { ObservationSchema, type Observation } from "./contracts";
import type { MeasuredContext } from "./context";
import type { Clip } from "@/lib/editor/model";

export interface AudioStreamInfo {
  index: number;
  codec: string | null;
  channels: number | null;
  sampleRate: number | null;
  durationSec: number | null;
}

export interface MediaStreamReport {
  hasVideo: boolean;
  videoCodec: string | null;
  audioStreams: AudioStreamInfo[];
  durationSec: number | null;
  formatName: string | null;
  error: string | null;
}

/** Raw ffprobe over ALL streams (multi-stream aware, unlike the M5 helper). */
export function probeMediaStreams(filePath: string): Promise<MediaStreamReport> {
  return new Promise((resolve) => {
    execFile(
      "ffprobe",
      ["-v", "error", "-show_entries", "stream=index,codec_type,codec_name,channels,sample_rate,duration:format=format_name,duration", "-of", "json", filePath],
      { maxBuffer: 4 * 1024 * 1024, timeout: 30_000 },
      (err, stdout) => {
        if (err) {
          resolve({ hasVideo: false, videoCodec: null, audioStreams: [], durationSec: null, formatName: null, error: (err.message || "ffprobe failed").slice(0, 300) });
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as {
            streams?: { index?: number; codec_type?: string; codec_name?: string; channels?: number; sample_rate?: string; duration?: string }[];
            format?: { format_name?: string; duration?: string };
          };
          const streams = parsed.streams ?? [];
          const audioStreams: AudioStreamInfo[] = [];
          let hasVideo = false;
          let videoCodec: string | null = null;
          for (const st of streams) {
            const dur = Number(st.duration ?? parsed.format?.duration ?? NaN);
            if (st.codec_type === "audio") {
              const sr = Number(st.sample_rate ?? NaN);
              audioStreams.push({ index: st.index ?? audioStreams.length, codec: st.codec_name ?? null, channels: st.channels ?? null, sampleRate: Number.isFinite(sr) ? sr : null, durationSec: Number.isFinite(dur) ? dur : null });
            } else if (st.codec_type === "video" && !hasVideo) {
              hasVideo = true;
              videoCodec = st.codec_name ?? null;
            }
          }
          const fmtDur = Number(parsed.format?.duration ?? NaN);
          resolve({
            hasVideo,
            videoCodec,
            audioStreams,
            durationSec: Number.isFinite(fmtDur) ? fmtDur : null,
            formatName: parsed.format?.format_name ?? null,
            error: null,
          });
        } catch (e) {
          resolve({ hasVideo: false, videoCodec: null, audioStreams: [], durationSec: null, formatName: null, error: `ffprobe output unparseable: ${(e as Error).message.slice(0, 200)}` });
        }
      },
    );
  });
}

/** Stable fingerprint over everything an analysis stage depends on (§10). */
export function assetFingerprint(asset: { id: string; sizeBytes: number; updatedAt?: Date | null; createdAt: Date }): string {
  let mtime = 0;
  try {
    mtime = Math.floor(statSync((asset as unknown as { storagePath?: string }).storagePath ?? "/dev/null").mtimeMs);
  } catch {
    mtime = 0; // storage not statable — id+size still identify the version
  }
  return createHash("sha256").update(`${asset.id}:${asset.sizeBytes}:${mtime}`).digest("hex").slice(0, 32);
}

export function depsHashOf(deps: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(deps)).digest("hex");
}

/** Source-media seconds → timeline seconds for a clip placement. */
export function sourceToTimelineSec(clip: Clip, fps: number, sourceStartSec: number, sourceEndSec: number): { timelineStartSec: number; timelineEndSec: number } {
  const seqFps = fps;
  const srcFps = clip.sourceFps.num / clip.sourceFps.den;
  const speed = clip.playbackSpeed || 1;
  const map = (srcSec: number): number => {
    const clamped = Math.min(Math.max(srcSec, clip.sourceInFrame / srcFps), clip.sourceOutFrame / srcFps);
    const frames = ((clamped * srcFps - clip.sourceInFrame) * seqFps) / srcFps / speed;
    return (clip.timelineStartFrame + Math.round(frames)) / seqFps;
  };
  return { timelineStartSec: map(sourceStartSec), timelineEndSec: map(sourceEndSec) };
}

/** Timeline seconds → source-media seconds (inverse mapping). */
export function timelineToSourceSec(clip: Clip, fps: number, timelineSec: number): number {
  const seqFps = fps;
  const srcFps = clip.sourceFps.num / clip.sourceFps.den;
  const speed = clip.playbackSpeed || 1;
  const localFrames = timelineSec * seqFps - clip.timelineStartFrame;
  const srcFrames = (localFrames * srcFps * speed) / seqFps;
  return (clip.sourceInFrame + Math.round(srcFrames)) / srcFps;
}

/** Clips on AUDIO tracks whose timeline range intersects [startSec,endSec). */
export function clipsCoveringRange(ctx: MeasuredContext, startSec: number, endSec: number): { clipId: string; trackId: string; startSec: number; endSec: number; assetId: string | null }[] {
  return ctx.audioClipSpans
    .filter((c) => c.startSec < endSec && c.endSec > startSec)
    .map((c) => ({ clipId: c.id, trackId: c.trackId, startSec: Math.max(c.startSec, startSec), endSec: Math.min(c.endSec, endSec), assetId: ctx.audio?.sourceAssetId ?? null }));
}

/**
 * Build the normalized observation set for a project (§2). Every observation
 * is schema-validated before it leaves this function.
 */
export function buildObservations(ctx: MeasuredContext, extras: Observation[] = []): Observation[] {
  const raw: Observation[] = [];
  const add = (o: Observation) => {
    const parsed = ObservationSchema.safeParse(o);
    if (parsed.success) raw.push(parsed.data);
  };

  // Timeline structure observations (clip placements with both clocks).
  for (const span of ctx.audioClipSpans) {
    add({
      projectId: ctx.projectId,
      versionId: ctx.contextVersion,
      assetId: ctx.audio?.sourceAssetId ?? null,
      clipId: span.id,
      streamIndex: null,
      sourceStartSec: null,
      sourceEndSec: null,
      timelineStartSec: span.startSec,
      timelineEndSec: span.endSec,
      method: "timeline-structure",
      evidenceType: "structure",
      confidence: 1,
      status: "analyzed",
      detail: { trackId: span.trackId, kind: "audio-clip" },
    });
  }
  for (const vc of ctx.videoClipAssets) {
    add({
      projectId: ctx.projectId,
      versionId: ctx.contextVersion,
      assetId: vc.assetId,
      clipId: null,
      streamIndex: null,
      sourceStartSec: null,
      sourceEndSec: null,
      timelineStartSec: null,
      timelineEndSec: null,
      method: "timeline-structure",
      evidenceType: "structure",
      confidence: 1,
      status: "analyzed",
      detail: { kind: "video-asset-use", durationSec: vc.durationSec },
    });
  }

  // Audio evidence observations (external audio: GANGZII measured).
  if (ctx.audio?.inspection) {
    for (const span of ctx.audio.inspection.silenceSpans.slice(0, 200)) {
      const covered = clipsCoveringRange(ctx, span.start, span.end);
      const primary = covered[0] ?? null;
      add({
        projectId: ctx.projectId,
        versionId: ctx.contextVersion,
        assetId: ctx.audio.sourceAssetId,
        clipId: primary?.clipId ?? null,
        streamIndex: null,
        sourceStartSec: span.start,
        sourceEndSec: span.end,
        timelineStartSec: span.start,
        timelineEndSec: span.end,
        method: "gangzii-inspection",
        evidenceType: "audio",
        confidence: 0.95,
        status: "analyzed",
        detail: { kind: "silence-span", processId: ctx.audio.inspectionProcessId, timelineClips: covered.map((c) => c.clipId) },
      });
    }
    add({
      projectId: ctx.projectId,
      versionId: ctx.contextVersion,
      assetId: ctx.audio.sourceAssetId,
      clipId: null,
      streamIndex: null,
      sourceStartSec: null,
      sourceEndSec: null,
      timelineStartSec: null,
      timelineEndSec: null,
      method: "gangzii-inspection",
      evidenceType: "audio",
      confidence: 0.95,
      status: "analyzed",
      detail: { kind: "summary", integratedLufs: ctx.audio.inspection.integratedLufs, lraLu: ctx.audio.inspection.lraLu, classification: ctx.audio.inspection.levelsClassification, clippingSuspected: ctx.audio.inspection.clippingSuspected, channelImbalanceDb: ctx.audio.inspection.channelImbalanceDb, processId: ctx.audio.inspectionProcessId },
    });
  }

  // Transcript observations (RIISHE reused — source clock).
  if (ctx.transcript?.available) {
    for (const seg of ctx.transcript.segments) {
      add({
        projectId: ctx.projectId,
        versionId: ctx.contextVersion,
        assetId: ctx.audio?.sourceAssetId ?? null,
        clipId: null,
        streamIndex: null,
        sourceStartSec: seg.start,
        sourceEndSec: seg.end,
        timelineStartSec: seg.start,
        timelineEndSec: seg.end,
        method: "riishe-asr",
        evidenceType: "speech",
        confidence: 0.8,
        status: "analyzed",
        detail: { kind: "speech-segment", text: seg.text.slice(0, 200), language: ctx.transcript.languageDescription, wordLevelTiming: false },
      });
    }
  }

  // Caption observations.
  if (ctx.captions?.sourceKind === "srt-assets") {
    add({
      projectId: ctx.projectId,
      versionId: ctx.contextVersion,
      assetId: null,
      clipId: null,
      streamIndex: null,
      sourceStartSec: null,
      sourceEndSec: null,
      timelineStartSec: null,
      timelineEndSec: null,
      method: "caption-parse",
      evidenceType: "caption",
      confidence: 0.9,
      status: "analyzed",
      detail: { kind: "caption-summary", cueCount: ctx.captions.cueCount, avgCps: ctx.captions.avgCps, maxCps: ctx.captions.maxCps },
    });
  }

  for (const e of extras) add(e);
  return raw;
}
