/**
 * M10 — measured project context (§3 Content Intelligence backbone).
 *
 * Gathers what the project ACTUALLY contains, from the REAL services:
 *  - timeline head (M2 persistence) + the shared staleness formula;
 *  - bounded overview via MY AI's existing context resolver (M8);
 *  - audio evidence from GANGZII inspections (measured silence spans, LUFS,
 *    channel balance, clipping) — the latest COMPLETED analysis is reused; if
 *    none exists one can be enqueued on the EXISTING durable worker and the
 *    caller waits a bounded time;
 *  - transcript evidence from RIISHE — reused from COMPLETED autocut-analysis
 *    results ONLY (that pipeline runs in its own API route; it is never
 *    duplicated here). No transcript → honest missing evidence;
 *  - captions from SRT subtitle assets + inline clip captions (parseSrt);
 *  - scenes from the Social Video Studio plan; publishing metadata from M9.
 *
 * Nothing is invented: whatever is unavailable is listed in missingEvidence.
 */
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import path from "path";
import { db } from "@/lib/db";
import { getTimelineHead } from "@/lib/editor/persistence";
import { resolveProjectContext } from "@/lib/my-ai/context/resolver";
import { MEDIA_ROOT } from "@/lib/media-storage";
import { parseSrt, type SrtCue } from "@/lib/srt";
import { jobManager } from "@/lib/job-runner";
import { JOB_TYPE_GANGZII_ANALYZE } from "@/lib/job-helpers";
import type { GangziiInspection } from "@/lib/gangzii/types";
import { contextVersionOf } from "./contracts";

const WAIT_SEC_DEFAULT = 240;
const TRANSCRIPT_MAX_CHARS = 4000;
const SEGMENTS_MAX = 40;

export interface MeasuredAudio {
  sourceAssetId: string;
  sourceName: string;
  inspection: {
    durationSec: number;
    silenceSpans: { start: number; end: number }[];
    silenceTotalSec: number;
    silenceFraction: number;
    integratedLufs: number | null;
    lraLu: number | null;
    levelsClassification: string;
    channelImbalanceDb: number | null;
    clippingSuspected: boolean;
    noiseFloorDbfs: number | null;
    shortTermMaxLufs: number | null;
  } | null;
  inspectionProcessId: string | null;
}

export interface MeasuredTranscript {
  jobId: string;
  available: boolean;
  text: string;
  segments: { start: number; end: number; text: string }[];
  languageDescription: string;
  primaryScript: string;
  speechSpansSec: { start: number; end: number }[];
}

export interface MeasuredCaptions {
  sourceKind: "srt-assets" | "clip-captions" | "none";
  cueCount: number;
  /** chars-per-second per cue — readability evidence (measured). */
  avgCps: number | null;
  maxCps: number | null;
  overThirteenCps: number;
  gapsOver3Sec: number;
}

export interface MeasuredContext {
  projectId: string;
  projectName: string;
  contextVersion: string;
  headVersion: number;
  durationSec: number | null;
  fps: number;
  clipCount: number;
  audioClipCount: number;
  videoClipCount: number;
  /** VIDEO-track clips by source asset (for reuse/monotony evidence). */
  videoClipAssets: { assetId: string; durationSec: number }[];
  /** AUDIO-track clips with timeline spans (for pause-trim proposals). */
  audioClipSpans: { id: string; trackId: string; startSec: number; endSec: number }[];
  lockedTrackCount: number;
  gaps: { trackId: string; startSec: number; endSec: number }[];
  overlaps: number;
  transitionCount: number;
  graphicClipCount: number;
  captionClipCount: number;
  audio: MeasuredAudio | null;
  transcript: MeasuredTranscript | null;
  captions: MeasuredCaptions | null;
  scenes: { number: number; durationSec: number; narration: string; onScreenText: string }[] | null;
  /** User-SUPPLIED audience (Studio brief) — never assumed/invented. */
  suppliedAudience: string | null;
  publishing: { platform: string; language: string; hasTitle: boolean; hasDescription: boolean; cta: string | null }[];
  missingEvidence: string[];
  evidenceSources: { engine: string; detail: string }[];
}

function fpsOf(seq: { fps: { num: number; den: number } }): number {
  const f = seq.fps.num / seq.fps.den;
  return Math.round(f * 1000) / 1000;
}

/** Pick the primary narration/audio source: the LONGEST owned AUDIO-kind asset
 *  actually placed on an AUDIO track; else any owned AUDIO asset of the
 *  project. Video-embedded audio is NOT auto-analyzed (GANGZII analyzes
 *  dedicated audio sources in this pipeline) — recorded as missing evidence. */
async function pickPrimaryAudio(userId: string, projectId: string, audioAssetIds: string[]): Promise<{ id: string; originalName: string } | null> {
  const ids = [...new Set(audioAssetIds)].filter(Boolean);
  if (ids.length > 0) {
    const assets = await db.mediaAsset.findMany({ where: { id: { in: ids }, userId, kind: "AUDIO" } });
    const usable = assets.filter((a) => a.storagePath && a.kind === "AUDIO");
    usable.sort((a, b) => (b.durationSec ?? 0) - (a.durationSec ?? 0));
    if (usable[0]) return { id: usable[0].id, originalName: usable[0].originalName };
  }
  const projectAudio = await db.mediaAsset.findMany({ where: { userId, projectId, kind: "AUDIO" } });
  projectAudio.sort((a, b) => (b.durationSec ?? 0) - (a.durationSec ?? 0));
  if (projectAudio[0]) return { id: projectAudio[0].id, originalName: projectAudio[0].originalName };
  return null;
}

async function latestGangziiInspection(userId: string, assetId: string): Promise<{ inspection: GangziiInspection; processId: string } | null> {
  const row = await db.gangziiProcess.findFirst({
    where: { userId, sourceAssetId: assetId, kind: "ANALYSIS", status: "COMPLETED", analysisJson: { not: null } },
    orderBy: { updatedAt: "desc" },
  });
  if (!row?.analysisJson) return null;
  try {
    return { inspection: JSON.parse(row.analysisJson) as GangziiInspection, processId: row.id };
  } catch {
    return null;
  }
}

/** Enqueue a GANGZII ANALYSIS on the EXISTING worker and wait (bounded). */
async function ensureGangziiInspection(userId: string, assetId: string, waitSec: number): Promise<{ inspection: GangziiInspection; processId: string } | null> {
  const existing = await latestGangziiInspection(userId, assetId);
  if (existing) return existing;
  const row = await db.gangziiProcess.create({
    data: { userId, sourceAssetId: assetId, kind: "ANALYSIS", status: "QUEUED", name: "Creative Director audio evidence" },
  });
  await jobManager.createJob(userId, JOB_TYPE_GANGZII_ANALYZE, { processId: row.id });
  const deadline = Date.now() + waitSec * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const fresh = await db.gangziiProcess.findUnique({ where: { id: row.id } });
    if (!fresh) return null;
    if (fresh.status === "COMPLETED") return latestGangziiInspection(userId, assetId);
    if (fresh.status === "FAILED" || fresh.status === "CANCELLED") return null;
  }
  return null;
}

async function loadRiisheTranscript(userId: string, assetId: string): Promise<{ data: RiisheResultShape; jobId: string } | null> {
  const jobs = await db.job.findMany({
    where: { userId, type: "autocut-analysis", status: "COMPLETED", paramsJson: { contains: `"mediaId":"${assetId}"` } },
    orderBy: { updatedAt: "desc" },
    take: 3,
  });
  const resultsDir = path.join(MEDIA_ROOT, "analysis-results");
  for (const job of jobs) {
    const file = path.join(resultsDir, `${job.id}.json`);
    if (!existsSync(file)) continue;
    try {
      const raw = await readFile(file, "utf8");
      return { data: JSON.parse(raw) as RiisheResultShape, jobId: job.id };
    } catch {
      continue;
    }
  }
  return null;
}

interface RiisheResultShape {
  speechSpans?: { start: number; end: number }[];
  transcript?: { available?: boolean; text?: string; segments?: { start?: number; end?: number; text?: string }[]; language?: { description?: string; primaryScript?: string } };
}

/** Caption evidence: SRT subtitle assets + inline clip captions. */
async function measureCaptions(userId: string, projectId: string, clipCaptions: (string | null)[]): Promise<{ captions: MeasuredCaptions | null; note: string | null }> {
  const srtAssets = await db.mediaAsset.findMany({ where: { userId, projectId, kind: "SUBTITLE" }, take: 4, orderBy: { createdAt: "desc" } });
  const cues: SrtCue[] = [];
  let sourceKind: MeasuredCaptions["sourceKind"] = "none";
  for (const asset of srtAssets) {
    if (!asset.storagePath || !existsSync(asset.storagePath)) continue;
    try {
      const content = await readFile(asset.storagePath, "utf8");
      const parsed = parseSrt(content);
      if (parsed.cues.length) {
        cues.push(...parsed.cues);
        sourceKind = "srt-assets";
      }
    } catch {
      /* unreadable SRT — counted as missing below */
    }
    if (cues.length > 1200) break;
  }
  if (cues.length === 0) {
    const inline = clipCaptions.filter((c): c is string => Boolean(c && c.trim()));
    if (inline.length > 0) {
      return {
        captions: { sourceKind: "clip-captions", cueCount: inline.length, avgCps: null, maxCps: null, overThirteenCps: 0, gapsOver3Sec: 0 },
        note: null,
      };
    }
    return { captions: null, note: "No captions found (no SRT assets, no inline caption clips) — caption quality could not be assessed." };
  }
  cues.sort((a, b) => a.start - b.start);
  const cps = cues.map((c) => {
    const dur = Math.max(0.2, c.end - c.start);
    return c.normalizedText.length / dur;
  });
  let gapsOver3Sec = 0;
  for (let i = 1; i < Math.min(cues.length, 800); i++) {
    if (cues[i].start - cues[i - 1].end > 3) gapsOver3Sec += 1;
  }
  return {
    captions: {
      sourceKind,
      cueCount: cues.length,
      avgCps: Math.round((cps.reduce((a, b) => a + b, 0) / cps.length) * 100) / 100,
      maxCps: Math.round(Math.max(...cps) * 100) / 100,
      overThirteenCps: cps.filter((v) => v > 13).length,
      gapsOver3Sec,
    },
    note: null,
  };
}

export interface ContextOptions {
  /** Enqueue + await a GANGZII inspection when none exists (bounded). */
  enqueueEvidence?: boolean;
  /** Bounded wait for enqueued evidence (seconds). */
  waitSec?: number;
}

/**
 * Build the measured context for a project. Throws ProjectNotFoundError for
 * unowned projects (from getTimelineHead).
 */
export async function buildMeasuredContext(userId: string, projectId: string, opts: ContextOptions = {}): Promise<MeasuredContext> {
  const missingEvidence: string[] = [];
  const evidenceSources: { engine: string; detail: string }[] = [];

  const head = await getTimelineHead(projectId, userId);
  const seq = head.sequence;
  const fps = fpsOf(seq);
  const maxEnd = seq.clips.reduce((m, c) => Math.max(m, c.timelineStartFrame + c.timelineDurationFrames), 0);
  const contextVersion = contextVersionOf(head.version, seq.clips.length, maxEnd);
  const durationSec = fps > 0 ? Math.round((maxEnd / fps) * 100) / 100 : null;

  const overview = await resolveProjectContext(projectId, userId);

  const audioAssetIds = seq.clips
    .filter((c) => seq.tracks.find((t) => t.id === c.trackId)?.kind === "AUDIO" && c.sourceAssetId)
    .map((c) => c.sourceAssetId)
    .filter((v): v is string => Boolean(v));
  const videoClipCount = seq.clips.filter((c) => seq.tracks.find((t) => t.id === c.trackId)?.kind === "VIDEO").length;
  const audioClipCount = seq.clips.filter((c) => seq.tracks.find((t) => t.id === c.trackId)?.kind === "AUDIO").length;
  const videoClipAssets = seq.clips
    .filter((c) => seq.tracks.find((t) => t.id === c.trackId)?.kind === "VIDEO" && c.sourceAssetId)
    .map((c) => ({ assetId: c.sourceAssetId as string, durationSec: Math.round((c.timelineDurationFrames / fps) * 100) / 100 }));
  const audioClipSpans = seq.clips
    .filter((c) => seq.tracks.find((t) => t.id === c.trackId)?.kind === "AUDIO")
    .map((c) => ({
      id: c.id,
      trackId: c.trackId,
      startSec: Math.round((c.timelineStartFrame / fps) * 100) / 100,
      endSec: Math.round(((c.timelineStartFrame + c.timelineDurationFrames) / fps) * 100) / 100,
    }));

  // ── audio evidence (GANGZII — measured) ──
  let audio: MeasuredAudio | null = null;
  const primary = await pickPrimaryAudio(userId, projectId, audioAssetIds);
  if (primary) {
    let inspection: { inspection: GangziiInspection; processId: string } | null = await latestGangziiInspection(userId, primary.id);
    const reused = Boolean(inspection);
    if (!inspection && opts.enqueueEvidence) {
      inspection = await ensureGangziiInspection(userId, primary.id, opts.waitSec ?? WAIT_SEC_DEFAULT);
    }
    if (inspection) {
      const ins = inspection.inspection;
      evidenceSources.push({ engine: "GANGZII", detail: `inspection ${inspection.processId}${reused ? " (reused)" : " (enqueued by this review)"}` });
      audio = {
        sourceAssetId: primary.id,
        sourceName: primary.originalName,
        inspection: {
          durationSec: ins.durationSec,
          silenceSpans: ins.silence.spans.slice(0, 200),
          silenceTotalSec: ins.silence.totalSec,
          silenceFraction: ins.silence.fraction,
          integratedLufs: ins.loudness.integratedLufs,
          lraLu: ins.loudness.lraLu,
          levelsClassification: ins.levels.classification,
          channelImbalanceDb: ins.channelImbalanceDb,
          clippingSuspected: ins.clipping.suspected,
          noiseFloorDbfs: ins.noiseFloorDbfs,
          shortTermMaxLufs: ins.loudness.shortTerm.length ? Math.max(...ins.loudness.shortTerm.map((s) => s.lufs)) : null,
        },
        inspectionProcessId: inspection.processId,
      };
    } else {
      missingEvidence.push(`No GANGZII audio analysis was available for "${primary.originalName}"${opts.enqueueEvidence ? " within the wait budget" : ""} — silence, loudness and balance findings are not measurable yet. Run an AUDIO analysis in the GANGZII panel for full evidence.`);
    }
  } else {
    missingEvidence.push("No dedicated AUDIO asset found on the timeline (or in the project) — audio measurements were not possible. Video-embedded audio is intentionally not auto-analyzed.");
  }

  // ── transcript evidence (RIISHE — reused results only) ──
  let transcript: MeasuredTranscript | null = null;
  if (primary) {
    const riishe = await loadRiisheTranscript(userId, primary.id);
    if (riishe && riishe.data.transcript?.available) {
      evidenceSources.push({ engine: "RIISHE", detail: `autocut-analysis result (job ${riishe.jobId}, reused)` });
      transcript = {
        jobId: riishe.jobId,
        available: true,
        text: (riishe.data.transcript.text ?? "").slice(0, TRANSCRIPT_MAX_CHARS),
        segments: (riishe.data.transcript.segments ?? [])
          .filter((s) => typeof s.start === "number" && typeof s.end === "number")
          .slice(0, SEGMENTS_MAX)
          .map((s) => ({ start: s.start as number, end: s.end as number, text: (s.text ?? "").slice(0, 300) })),
        languageDescription: riishe.data.transcript.language?.description ?? "unknown",
        primaryScript: riishe.data.transcript.language?.primaryScript ?? "unknown",
        speechSpansSec: (riishe.data.speechSpans ?? []).slice(0, 300),
      };
    } else if (riishe) {
      missingEvidence.push("A RIISHE analysis exists but produced no usable transcript (ASR unavailable or failed) — narrative text findings are limited.");
    } else {
      missingEvidence.push("No RIISHE transcript is available for the narration audio — run an Auto Cut analysis to unlock transcript-based findings (hook, repetitions, CTA).");
    }
  }

  // ── captions ──
  const clipCaptions = seq.clips.map((c) => c.captionText);
  const capResult = await measureCaptions(userId, projectId, clipCaptions);
  if (capResult.note) missingEvidence.push(capResult.note);
  if (capResult.captions && capResult.captions.sourceKind === "srt-assets") {
    evidenceSources.push({ engine: "RIISHE", detail: "SRT subtitle assets (cue timings measured)" });
  }
  const captionClipCount = clipCaptions.filter((c) => c && c.trim()).length;

  // ── scenes (Studio plan) ──
  const plan = await db.studioPlan.findFirst({
    where: { projectId, userId },
    orderBy: { updatedAt: "desc" },
    include: { scenes: { orderBy: { sceneNumber: "asc" } } },
  });
  const scenes = plan?.scenes.length
    ? plan.scenes.map((s) => ({ number: s.sceneNumber, durationSec: s.durationSec, narration: s.narration.slice(0, 300), onScreenText: s.onScreenText.slice(0, 120) }))
    : null;
  let suppliedAudience: string | null = null;
  if (plan?.briefJson) {
    try {
      const brief = JSON.parse(plan.briefJson) as { targetAudience?: string };
      if (typeof brief.targetAudience === "string" && brief.targetAudience.trim()) suppliedAudience = brief.targetAudience.slice(0, 200);
    } catch {
      /* unparseable brief — audience simply not supplied */
    }
  }
  if (!scenes) missingEvidence.push("No Social Video Studio plan exists — scene-level structure and scene-duration findings are unavailable.");

  // ── publishing metadata (M9) ──
  const metaRows = await db.publishMetadata.findMany({ where: { userId, projectId } });
  const publishing = metaRows.map((m) => {
    const approved = m.approvedJson ? (JSON.parse(m.approvedJson) as { title?: string; description?: string; callToAction?: string }) : null;
    return {
      platform: m.platform,
      language: m.language,
      hasTitle: Boolean(approved?.title),
      hasDescription: Boolean(approved?.description),
      cta: approved?.callToAction?.slice(0, 160) ?? null,
    };
  });
  if (publishing.length === 0) missingEvidence.push("No publishing metadata (M9) exists — title/CTA clarity dimensions rely on timeline content only.");

  const transitions = (seq as unknown as { transitions?: { id: string }[] }).transitions ?? [];
  const transitionTotal = transitions.length;

  return {
    projectId,
    projectName: overview.projectName,
    contextVersion,
    headVersion: head.version,
    durationSec,
    fps,
    clipCount: seq.clips.length,
    audioClipCount,
    videoClipCount,
    videoClipAssets,
    audioClipSpans,
    lockedTrackCount: seq.tracks.filter((t) => t.locked).length,
    gaps: overview.sequence.gaps.slice(0, 12).map((g) => ({ trackId: g.trackId, startSec: Math.round((g.startFrame / fps) * 100) / 100, endSec: Math.round((g.endFrame / fps) * 100) / 100 })),
    overlaps: overview.sequence.overlaps,
    transitionCount: transitionTotal,
    graphicClipCount: seq.clips.filter((c) => seq.tracks.find((t) => t.id === c.trackId)?.kind === "GRAPHIC" || seq.tracks.find((t) => t.id === c.trackId)?.kind === "OVERLAY").length,
    captionClipCount,
    audio,
    transcript,
    captions: capResult.captions,
    scenes,
    suppliedAudience,
    publishing,
    missingEvidence,
    evidenceSources,
  };
}

/** Max timeline end in seconds (for finding clamping). */
export function clampToDuration(startSec: number | null, endSec: number | null, durationSec: number | null): { startSec: number | null; endSec: number | null } {
  if (durationSec === null) return { startSec, endSec };
  return {
    startSec: startSec === null ? null : Math.min(startSec, durationSec),
    endSec: endSec === null ? null : Math.min(endSec, durationSec),
  };
}
