/**
 * M11 — Automatic embedded audio analysis (§3).
 *
 * Resolves M10's limitation where video-embedded audio was never inspected.
 * Strategy, in reuse order:
 *  1. The primary audio evidence source is the best owned media WITH an audio
 *     stream: dedicated AUDIO assets first, then VIDEO assets (ffprobe
 *     detects embedded streams). GANGZII's inspection decodes the FIRST
 *     audio stream of ANY container (probeAudioStream selects a:0), so the
 *     common case needs NO extraction at all — the M5 analyze path runs
 *     directly on the video file and the source is never modified.
 *  2. Dedup: an equivalent COMPLETED inspection (same asset + stream tag +
 *     same asset fingerprint) is REUSED — no duplicate audio extraction or
 *     re-analysis.
 *  3. Multi-stream videos: every audio stream is OBSERVED (ffprobe);
 *     stream 0 is analyzed via GANGZII; additional streams are extracted
 *     (`-map 0:a:N` into a derived AUDIO asset registered through the
 *     existing asset lifecycle) and analyzed through the same M5 path.
 *  4. No audio / corrupt streams become honest observations, never guesses.
 *
 * Findings are associated with timeline clips through the source→timeline
 * mapping (multimodal.ts) so silence found in the FILE maps back to the
 * timeline positions where the video clips play.
 */
import { execFile } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { db } from "@/lib/db";
import { getTimelineHead } from "@/lib/editor/persistence";
import { jobManager } from "@/lib/job-runner";
import { JOB_TYPE_GANGZII_ANALYZE } from "@/lib/job-helpers";
import type { GangziiInspection } from "@/lib/gangzii/types";
import { assetFingerprint, probeMediaStreams, type AudioStreamInfo, type MediaStreamReport } from "./multimodal";

export interface EmbeddedAudioTarget {
  assetId: string;
  originalName: string;
  kind: "AUDIO" | "VIDEO";
  storagePath: string;
  streamIndex: number;
  viaDerivedAssetId?: string;
}

/** Find the best analysis target: dedicated AUDIO first, then video w/ audio. */
export async function resolvePrimaryAudioSource(userId: string, projectId: string): Promise<{ assetId: string; originalName: string; kind: "AUDIO" | "VIDEO" } | null> {
  const audio = await db.mediaAsset.findMany({ where: { userId, projectId, kind: "AUDIO" }, orderBy: { durationSec: "desc" } });
  if (audio[0]) return { assetId: audio[0].id, originalName: audio[0].originalName, kind: "AUDIO" };
  const videos = await db.mediaAsset.findMany({ where: { userId, projectId, kind: "VIDEO" }, take: 12, orderBy: { createdAt: "desc" } });
  for (const v of videos) {
    if (!v.storagePath || v.sizeBytes <= 0) continue;
    const report = await probeMediaStreams(v.storagePath);
    if (report.audioStreams.length > 0) return { assetId: v.id, originalName: v.originalName, kind: "VIDEO" };
  }
  return null;
}

/** Dedup key: a COMPLETED GANGZII analysis of this asset tagged with the stream + fingerprint. */
async function findReusableInspection(userId: string, assetId: string, streamIndex: number, fingerprint: string): Promise<{ inspection: GangziiInspection; processId: string } | null> {
  const rows = await db.gangziiProcess.findMany({
    where: { userId, sourceAssetId: assetId, kind: "ANALYSIS", status: "COMPLETED", analysisJson: { not: null } },
    orderBy: { updatedAt: "desc" },
    take: 6,
  });
  for (const row of rows) {
    try {
      const inspection = JSON.parse(row.analysisJson!) as GangziiInspection;
      const provenance = row.name ?? "";
      // Inspections created by M11 carry "stream=N fp=<fingerprint>"; M5
      // user-triggered inspections are reused for stream 0 regardless of
      // fingerprint (the source file itself is immutable).
      if (provenance.includes(`stream=${streamIndex}`)) {
        if (streamIndex === 0 || provenance.includes(`fp=${fingerprint}`)) {
          return { inspection, processId: row.id };
        }
      } else if (streamIndex === 0) {
        return { inspection, processId: row.id };
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function runGangziiOn(userId: string, assetId: string, streamIndex: number, fingerprint: string, waitSec: number, derivedAssetId?: string): Promise<{ inspection: GangziiInspection; processId: string } | null> {
  // For derived audio assets, the GangziiProcess points at the DERIVED asset
  // row (its own file) — otherwise at the original (never modified).
  const targetAssetId = derivedAssetId ?? assetId;
  const reusable = await findReusableInspection(userId, targetAssetId, streamIndex, fingerprint);
  if (reusable) return reusable;
  const row = await db.gangziiProcess.create({
    data: {
      userId,
      sourceAssetId: targetAssetId,
      kind: "ANALYSIS",
      status: "QUEUED",
      name: `m11-embedded-audio stream=${streamIndex} fp=${fingerprint}`.slice(0, 120),
    },
  });
  await jobManager.createJob(userId, JOB_TYPE_GANGZII_ANALYZE, { processId: row.id });
  const deadline = Date.now() + waitSec * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const fresh = await db.gangziiProcess.findUnique({ where: { id: row.id } });
    if (!fresh) return null;
    if (fresh.status === "COMPLETED") {
      const proc = await db.gangziiProcess.findUnique({ where: { id: row.id } });
      if (proc?.analysisJson) {
        try {
          return { inspection: JSON.parse(proc.analysisJson) as GangziiInspection, processId: row.id };
        } catch {
          return null;
        }
      }
      return null;
    }
    if (fresh.status === "FAILED" || fresh.status === "CANCELLED") return null;
  }
  return null;
}

/** Extract ONE audio stream to a derived, registered AUDIO asset (never mutates the source). */
export async function extractDerivedAudio(userId: string, projectId: string, videoAssetId: string, streamIndex: number): Promise<{ assetId: string; storagePath: string } | null> {
  const video = await db.mediaAsset.findFirst({ where: { id: videoAssetId, userId } });
  if (!video?.storagePath) return null;
  const fingerprint = assetFingerprint(video);
  // Dedup: reuse an equivalent derived asset when it already exists.
  const existing = await db.mediaAsset.findFirst({
    where: { userId, projectId, kind: "AUDIO", notes: { contains: `"parentAssetId":"${videoAssetId}"` } },
    orderBy: { createdAt: "desc" },
  });
  if (existing?.storagePath) {
    try {
      const provenance = JSON.parse(existing.notes ?? "{}") as { streamIndex?: number; fingerprint?: string };
      if (provenance.streamIndex === streamIndex && provenance.fingerprint === fingerprint) return { assetId: existing.id, storagePath: existing.storagePath };
    } catch {
      /* fall through to re-extract */
    }
  }
  const tempDir = mkdtempSync(path.join(tmpdir(), "beanfx-m11-audio-"));
  const outPath = path.join(tempDir, `stream-${streamIndex}.wav`);
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        "ffmpeg",
        ["-y", "-hide_banner", "-loglevel", "error", "-i", video.storagePath, "-map", `0:a:${streamIndex}`, "-vn", "-c:a", "pcm_s16le", outPath],
        { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
        (err, _so, se) => (err ? reject(new Error(`ffmpeg stream extraction failed: ${String(se).slice(-200) || err.message}`)) : resolve()),
      );
    });
    // Register through the EXISTING asset lifecycle (kind AUDIO, provenance notes).
    const stat = await import("fs").then((fs) => fs.promises.stat(outPath));
    const asset = await db.mediaAsset.create({
      data: {
        userId,
        projectId,
        originalName: `${video.originalName} · audio stream ${streamIndex} (derived)`.slice(0, 180),
        storagePath: outPath,
        kind: "AUDIO",
        mimeType: "audio/wav",
        sizeBytes: stat.size,
        durationSec: video.durationSec,
        sampleRate: 48000,
        channels: 1,
        notes: JSON.stringify({ derived: true, parentAssetId: videoAssetId, streamIndex, fingerprint, createdBy: "m11-embedded-audio", note: "Derived extract for analysis; the source video was not modified." }).slice(0, 900),
      },
    });
    return { assetId: asset.id, storagePath: outPath };
  } catch (err) {
    rmSync(tempDir, { recursive: true, force: true });
    throw err instanceof Error ? err : new Error("extraction failed");
  }
}

export interface EmbeddedAudioResult {
  primary: { assetId: string; originalName: string; kind: "AUDIO" | "VIDEO"; viaDerivedAssetId?: string } | null;
  streams: AudioStreamInfo[];
  streamReports: Record<number, MediaStreamReport>;
  inspection: GangziiInspection | null;
  inspectionProcessId: string | null;
  observationsNote: string[];
  /** Derived assets created this run (for cleanup bookkeeping in tests). */
  derivedAssetIds: string[];
}

/**
 * Ensure embedded-audio evidence for a project: detect streams, reuse or run
 * GANGZII on the primary source, and (for multi-stream video) record the
 * remaining streams honestly. Bounded by waitSec; returns what it got.
 */
export async function ensureEmbeddedAudioEvidence(userId: string, projectId: string, opts: { waitSec?: number } = {}): Promise<EmbeddedAudioResult> {
  const waitSec = opts.waitSec ?? 240;
  const notes: string[] = [];
  const derivedAssetIds: string[] = [];

  const primary = await resolvePrimaryAudioSource(userId, projectId);
  if (!primary) {
    return { primary: null, streams: [], streamReports: {}, inspection: null, inspectionProcessId: null, observationsNote: ["No media with an audio stream found in the project (no dedicated AUDIO assets, no video with embedded audio)."], derivedAssetIds };
  }

  const asset = await db.mediaAsset.findFirst({ where: { id: primary.assetId, userId } });
  if (!asset?.storagePath) {
    return { primary, streams: [], streamReports: {}, inspection: null, inspectionProcessId: null, observationsNote: ["Primary audio source file is not accessible on storage."], derivedAssetIds };
  }
  const fingerprint = assetFingerprint(asset);
  const report = await probeMediaStreams(asset.storagePath);
  if (report.error) {
    return { primary, streams: [], streamReports: {}, inspection: null, inspectionProcessId: null, observationsNote: [`ffprobe failed on "${asset.originalName}": ${report.error}`], derivedAssetIds };
  }
  if (report.audioStreams.length === 0) {
    return { primary, streams: [], streamReports: {}, inspection: null, inspectionProcessId: null, observationsNote: [`"${asset.originalName}" has NO audio stream — audio findings honestly unavailable.`], derivedAssetIds };
  }

  let inspection: GangziiInspection | null = null;
  let inspectionProcessId: string | null = null;
  let viaDerivedAssetId: string | undefined;

  if (primary.kind === "AUDIO") {
    const r = await runGangziiOn(userId, asset.id, 0, fingerprint, waitSec);
    inspection = r?.inspection ?? null;
    inspectionProcessId = r?.processId ?? null;
    if (!inspection) notes.push(`GANGZII analysis did not complete for "${asset.originalName}" within the wait budget — audio findings unavailable this run.`);
  } else {
    // VIDEO with embedded audio: inspect stream 0 via a DERIVED extract so the
    // analysis artifact is a real audio file (and additional streams are
    // supported uniformly). The source video is never touched.
    try {
      const derived = await extractDerivedAudio(userId, projectId, asset.id, 0);
      if (!derived) throw new Error("derived audio asset could not be registered");
      derivedAssetIds.push(derived.assetId);
      viaDerivedAssetId = derived.assetId;
      const r = await runGangziiOn(userId, asset.id, 0, fingerprint, waitSec, derived.assetId);
      inspection = r?.inspection ?? null;
      inspectionProcessId = r?.processId ?? null;
      if (!inspection) notes.push(`Embedded audio (stream 0) of "${asset.originalName}" could not be analyzed within the wait budget — decode or analysis failed; the stream remains recorded as detected.`);
    } catch (err) {
      notes.push(`Embedded audio extraction failed for "${asset.originalName}" stream 0: ${(err as Error).message.slice(0, 160)}`);
    }
  }

  // Additional streams: observed + analyzed (bounded: max 2 extra streams per run).
  if (report.audioStreams.length > 1) {
    for (const stream of report.audioStreams.slice(1, 3)) {
      notes.push(`Additional audio stream #${stream.index} (${stream.codec ?? "unknown codec"}, ${stream.channels ?? "?"} ch) detected in "${asset.originalName}" — recorded; analysis covers stream 0 this run.`);
      try {
        const derived = await extractDerivedAudio(userId, projectId, asset.id, stream.index);
        if (!derived) throw new Error("derived audio asset could not be registered");
        derivedAssetIds.push(derived.assetId);
        await runGangziiOn(userId, asset.id, stream.index, fingerprint, Math.min(waitSec, 120), derived.assetId);
      } catch (err) {
        notes.push(`Audio stream #${stream.index} could not be extracted/analyzed: ${(err as Error).message.slice(0, 160)}`);
      }
    }
  }

  return {
    primary: { ...primary, viaDerivedAssetId },
    streams: report.audioStreams,
    streamReports: { [report.audioStreams[0].index]: report },
    inspection,
    inspectionProcessId,
    observationsNote: notes,
    derivedAssetIds,
  };
}

/** Map file-clock silence spans onto the timeline through clip placements. */
export async function mapSilenceToTimeline(userId: string, projectId: string, assetId: string, silenceSpans: { start: number; end: number }[], fps: number): Promise<{ start: number; end: number; clipIds: string[] }[]> {
  const head = await getTimelineHead(projectId, userId);
  const seq = head.sequence;
  const asset = await db.mediaAsset.findFirst({ where: { id: assetId, userId } });
  // Embedded audio travels with VIDEO-track clips; dedicated audio with
  // AUDIO-track clips. Map through whichever carries this source asset.
  const wantedKind = asset?.kind === "VIDEO" ? "VIDEO" : "AUDIO";
  const tracks = new Set(seq.tracks.filter((t) => t.kind === wantedKind).map((t) => t.id));
  const clips = seq.clips.filter((c) => tracks.has(c.trackId) && c.sourceAssetId === assetId);
  const { sourceToTimelineSec } = await import("./multimodal");
  const out: { start: number; end: number; clipIds: string[] }[] = [];
  for (const span of silenceSpans) {
    const positions = new Set<number>();
    const clipIds: string[] = [];
    for (const clip of clips) {
      const mapped = sourceToTimelineSec(clip, fps, span.start, span.end);
      if (mapped.timelineEndSec - mapped.timelineStartSec > 0.05) {
        positions.add(mapped.timelineStartSec);
        positions.add(mapped.timelineEndSec);
        clipIds.push(clip.id);
      }
    }
    if (positions.size >= 2) {
      const sorted = [...positions].sort((a, b) => a - b);
      out.push({ start: sorted[0], end: sorted[sorted.length - 1], clipIds: [...new Set(clipIds)] });
    } else {
      // Clip not on the timeline (asset imported but unused) — file clock only.
      out.push({ start: span.start, end: span.end, clipIds: [] });
    }
  }
  return out;
}
