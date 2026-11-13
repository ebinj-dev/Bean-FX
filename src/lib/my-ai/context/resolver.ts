/**
 * MY AI — project context resolver (M8 §5).
 *
 * Builds a BOUNDED, text-only view of the project for planning: the planner
 * prompt receives summaries and counts, never full media payloads — private
 * media never leaves the deployment (only the user's prompt + this structured
 * summary goes to the LLM, and only when the user sends a message).
 *
 * Everything here reads REAL state: getTimelineHead (M2 persistence), MediaAsset
 * rows incl. JAZMII/LAXII provenance, CutDecision (RIISHE), GangziiProcess
 * (GANGZII), recent versions (history). Engine result rows that are absent
 * are reported as absent — no invented context.
 */
import { db } from "@/lib/db";
import { clipEndFrame } from "@/lib/editor/model";
import { getTimelineHead, listTimelineVersions } from "@/lib/editor/persistence";
import { computeUserUsage, USER_QUOTA_BYTES } from "@/lib/media-storage";


export interface ProjectContext {
  projectId: string;
  projectName: string;
  sequence: {
    fps: number;
    width: number;
    height: number;
    durationFrames: number;
    durationSec: number;
    trackCount: number;
    tracks: { id: string; kind: string; name: string; locked: boolean; muted: boolean; visible: boolean; clipCount: number }[];
    clipCount: number;
    /** Bounded clip list (first N per engine-relevant fields). */
    clips: {
      id: string;
      trackKind: string;
      startFrame: number;
      durationFrames: number;
      label: string | null;
      caption: string | null;
      hasKeyframes: boolean;
      hasEffects: boolean;
      assetKind: string | null;
    }[];
    gaps: { trackId: string; startFrame: number; endFrame: number }[];
    overlaps: number;
    playheadNote?: string;
  };
  media: {
    total: number;
    byKind: Record<string, number>;
    generated: { engine: string; count: number }[];
    samples: { id: string; name: string; kind: string; durationSec: number | null; createdBy: string | null; provider: string | null }[];
  };
  engineResults: {
    riishe: { cutDecisions: number; captionsPresent: boolean };
    gangzii: { processes: number; latestStatus: string | null };
    niiki: { graphicClips: number; transitionCount: number };
    jazmii: { outputs: number };
    laxii: { outputs: number };
  };
  history: {
    versions: { versionNumber: number; isAutosave: boolean; createdAt: string }[];
    recentPlans: { id: string; status: string; summary: string; createdAt: string }[];
    undoRedoNote: string;
  };
  storage: { usedBytes: number; quotaBytes: number };
  boundedNote: string;
}

const MAX_CLIPS = 40;
const MAX_GAPS = 12;
const MAX_VERSIONS = 10;
const MAX_SAMPLE_ASSETS = 12;

/**
 * Resolve the full bounded context for a project. Throws ProjectNotFoundError
 * (from persistence) when the caller does not own the project.
 */
export async function resolveProjectContext(projectId: string, userId: string): Promise<ProjectContext> {
  const project = await db.project.findFirst({ where: { id: projectId, userId } });
  if (!project) throw new Error("Project not found or not owned by the caller.");

  const head = await getTimelineHead(projectId, userId);
  const seq = head.sequence; // already parsed by persistence (typed Sequence)

  // Track/clip/gap analysis (integer frames throughout).
  const clips = seq.clips.slice(0, MAX_CLIPS).map((c) => {
    return {
      id: c.id,
      trackKind: seq.tracks.find((t) => t.id === c.trackId)?.kind ?? "?",
      startFrame: c.timelineStartFrame,
      durationFrames: c.timelineDurationFrames,
      label: c.label ?? null,
      caption: c.captionText ?? null,
      hasKeyframes: (c.keyframes?.length ?? 0) > 0,
      hasEffects: (c.effects?.length ?? 0) > 0,
      assetKind: null,
    };
  });
  const durationFrames = seq.clips.reduce((m, c) => Math.max(m, clipEndFrame(seq, c)), 0);
  const fps = seq.fps.num / seq.fps.den;
  const gaps: ProjectContext["sequence"]["gaps"] = [];
  let overlaps = 0;
  for (const track of seq.tracks) {
    const tClips = seq.clips.filter((c) => c.trackId === track.id).sort((a, b) => a.timelineStartFrame - b.timelineStartFrame);
    for (let i = 0; i < tClips.length; i++) {
      const end = clipEndFrame(seq, tClips[i]);
      const nextStart = i + 1 < tClips.length ? tClips[i + 1].timelineStartFrame : durationFrames;
      if (nextStart > end && nextStart - end >= Math.round(fps)) {
        gaps.push({ trackId: track.id, startFrame: end, endFrame: nextStart });
        if (gaps.length >= MAX_GAPS) break;
      }
      if (i + 1 < tClips.length && tClips[i + 1].timelineStartFrame < end) overlaps += 1;
    }
    if (gaps.length >= MAX_GAPS) break;
  }

  // Media + provenance.
  const assets = await db.mediaAsset.findMany({
    where: { userId, OR: [{ projectId }, { projectId: null }] },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: { id: true, originalName: true, kind: true, durationSec: true, createdBy: true, provider: true },
  });
  const byKind: Record<string, number> = {};
  for (const a of assets) byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;
  const genCounts: Record<string, number> = {};
  for (const a of assets) if (a.createdBy === "JAZMII" || a.createdBy === "LAXII") genCounts[a.createdBy] = (genCounts[a.createdBy] ?? 0) + 1;

  // Engine results (real rows only).
  const [cutDecisions, gangzii, versions, plans, usage] = await Promise.all([
    db.cutDecision.count({ where: { userId } }),
    db.gangziiProcess.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 1, select: { status: true } }),
    listTimelineVersions(projectId, userId, MAX_VERSIONS),
    db.aIPlan.findMany({ where: { userId, projectId }, orderBy: { updatedAt: "desc" }, take: 5, select: { id: true, status: true, requestSummary: true, createdAt: true } }),
    computeUserUsage(userId),
  ]);
  const captionClips = seq.clips.filter((c) => (c.captionText ?? "").trim().length > 0).length;
  const graphicClips = seq.clips.filter((c) => c.graphicTemplateId).length;

  return {
    projectId,
    projectName: project.name,
    sequence: {
      fps: Number(fps.toFixed(3)),
      width: seq.width,
      height: seq.height,
      durationFrames,
      durationSec: Number((durationFrames / fps).toFixed(2)),
      trackCount: seq.tracks.length,
      tracks: seq.tracks.map((t) => ({ id: t.id, kind: t.kind, name: t.name, locked: t.locked, muted: t.muted, visible: t.visible, clipCount: seq.clips.filter((c) => c.trackId === t.id).length })),
      clipCount: seq.clips.length,
      clips,
      gaps,
      overlaps,
    },
    media: {
      total: assets.length,
      byKind,
      generated: Object.entries(genCounts).map(([engine, count]) => ({ engine, count })),
      samples: assets.slice(0, MAX_SAMPLE_ASSETS).map((a) => ({ id: a.id, name: a.originalName, kind: a.kind, durationSec: a.durationSec, createdBy: a.createdBy, provider: a.provider })),
    },
    engineResults: {
      riishe: { cutDecisions, captionsPresent: captionClips > 0 },
      gangzii: { processes: await db.gangziiProcess.count({ where: { userId } }), latestStatus: gangzii[0]?.status ?? null },
      niiki: { graphicClips, transitionCount: seq.transitions.length },
      jazmii: { outputs: genCounts["JAZMII"] ?? 0 },
      laxii: { outputs: genCounts["LAXII"] ?? 0 },
    },
    history: {
      versions: versions.map((v) => ({ versionNumber: v.version, isAutosave: v.isAutosave, createdAt: v.createdAt })),
      recentPlans: plans.map((p) => ({ id: p.id, status: p.status, summary: p.requestSummary.slice(0, 120), createdAt: p.createdAt.toISOString() })),
      undoRedoNote: "Undo/redo state lives in the editor session; plans record the timeline version they validated against.",
    },
    storage: { usedBytes: usage.usedBytes, quotaBytes: USER_QUOTA_BYTES },
    boundedNote: `Bounded context: ${clips.length}/${seq.clips.length} clips, ${assets.slice(0, MAX_SAMPLE_ASSETS).length}/${assets.length} assets sampled, ${gaps.length} gaps listed. Full media never leaves the deployment.`,
  };
}
