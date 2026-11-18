/**
 * M12 — Scene intelligence & visual indexing (§4).
 *
 * Groups REAL extracted frames into scene-level records bounded by the
 * JAZMII deterministic cut detector, with:
 *  - BOTH clocks on every placement (source range + mapped timeline range);
 *  - deterministic aHash similarity + repeated-shot grouping (a scene
 *    boundary NEVER claims semantic content — understanding is
 *    "heuristic-only" unless a real vision provider inspected its frames);
 *  - representative frames REGISTERED as IMAGE assets (persistent dir, M7
 *    keyframe provenance convention) so the UI can show actual thumbnails.
 */
import { copyFile, mkdir } from "fs/promises";
import path from "path";
import { pathInsideMediaRoot } from "@/lib/media-storage";
import { registerImageArtifact } from "@/lib/ai/asset-lifecycle";
import { sourceToTimelineSec } from "../multimodal";
import { hammingHex } from "./frames";
import { sceneIdOf, VISUAL_ANALYSIS_VERSION, type VisualIndex, type VisualScene, type VisualSettings, type VisualFrame } from "./contracts";

export interface SceneSourceClip {
  clipId: string;
  sourceInFrame: number;
  sourceOutFrame: number;
  sourceFpsNum: number;
  sourceFpsDen: number;
  playbackSpeed: number;
  timelineStartFrame: number;
}

export interface SceneBuildContext {
  seqFps: number;
  clips: SceneSourceClip[];
}

function timelinePlacementsForRange(sceneStart: number, sceneEnd: number, ctx: SceneBuildContext): VisualScene["timelinePlacements"] {
  const placements: VisualScene["timelinePlacements"] = [];
  for (const c of ctx.clips) {
    const srcFps = c.sourceFpsNum / c.sourceFpsDen;
    const srcStart = c.sourceInFrame / srcFps;
    const srcEnd = c.sourceOutFrame / srcFps;
    const overlapStart = Math.max(sceneStart, srcStart);
    const overlapEnd = Math.min(sceneEnd, srcEnd);
    if (overlapEnd - overlapStart < 0.1) continue;
    const t0 = sourceToTimelineSec(
      { sourceInFrame: c.sourceInFrame, sourceOutFrame: c.sourceOutFrame, sourceFps: { num: c.sourceFpsNum, den: c.sourceFpsDen }, playbackSpeed: c.playbackSpeed, timelineStartFrame: c.timelineStartFrame } as Parameters<typeof sourceToTimelineSec>[0],
      ctx.seqFps,
      overlapStart,
      overlapStart,
    );
    const t1 = sourceToTimelineSec(
      { sourceInFrame: c.sourceInFrame, sourceOutFrame: c.sourceOutFrame, sourceFps: { num: c.sourceFpsNum, den: c.sourceFpsDen }, playbackSpeed: c.playbackSpeed, timelineStartFrame: c.timelineStartFrame } as Parameters<typeof sourceToTimelineSec>[0],
      ctx.seqFps,
      overlapEnd,
      overlapEnd,
    );
    placements.push({ clipId: c.clipId, timelineStartSec: Math.round(t0.timelineStartSec * 100) / 100, timelineEndSec: Math.round(t1.timelineStartSec * 100) / 100 });
    if (placements.length >= 8) break;
  }
  return placements;
}

/** Union-find over similarity edges → repeated-shot groups (≥2 members). */
function repeatGroups(scenes: VisualScene[], hashOf: Map<string, string>, distanceLimit: number): void {
  const parent = scenes.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (let i = 0; i < scenes.length; i++) {
    for (const jid of scenes[i].similarSceneIds) {
      const j = scenes.findIndex((s) => s.sceneId === jid);
      if (j > i) {
        const a = find(i);
        const b = find(j);
        if (a !== b) parent[b] = a;
      }
    }
  }
  const members = new Map<number, number[]>();
  scenes.forEach((_, i) => {
    const r = find(i);
    members.set(r, [...(members.get(r) ?? []), i]);
  });
  let groupId = 1;
  for (const [, idxs] of members) {
    const withReps = idxs.filter((i) => scenes[i].representativeFrameId && (hashOf.get(scenes[i].sceneId) ?? "") !== "");
    if (withReps.length >= 2 && hammingHex(hashOf.get(scenes[withReps[0]].sceneId) ?? "", hashOf.get(scenes[withReps[1]].sceneId) ?? "") <= distanceLimit) {
      for (const i of idxs) scenes[i].repeatGroup = groupId;
      groupId += 1;
    }
  }
}

/**
 * Build the scene-level index from extracted/analyzed frames + deterministic
 * scene cuts (SOURCE-media seconds, from the JAZMII analyzer).
 */
export function buildScenes(frames: VisualFrame[], assetId: string, durationSec: number, sceneCuts: number[], settings: VisualSettings, ctx: SceneBuildContext): VisualScene[] {
  // Cut boundaries → scene source ranges. sceneCuts holds start seconds > 0.
  const bounds = [0, ...sceneCuts.filter((c) => c > 0 && c < durationSec).map((c) => Math.round(c * 100) / 100), durationSec];
  const scenes: VisualScene[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const start = bounds[i];
    const end = bounds[i + 1];
    if (end - start < 0.2) continue;
    const inScene = frames.filter((f) => f.sourceSec >= start && f.sourceSec < end && (f.status === "extracted" || f.status === "analyzed"));
    const analyzed = inScene.filter((f) => f.status === "analyzed" && f.analysis);
    // Representative: an analyzed frame, else any kept frame; when every frame
    // of the scene was deduplicated, fall back to the kept frame it duplicates
    // (hash-identical content — honest heuristic provenance).
    let rep: VisualFrame | null = analyzed[0] ?? inScene[0] ?? null;
    if (!rep) {
      const dupFrame = frames.find((f) => f.sourceSec >= start && f.sourceSec < end && f.dupOf);
      rep = dupFrame ? (frames.find((f) => f.frameId === dupFrame.dupOf) ?? null) : null;
    }
    const objects = [...new Set(analyzed.flatMap((f) => f.analysis?.objects ?? []))].slice(0, 16);
    const activities = [...new Set(analyzed.flatMap((f) => f.analysis?.activities ?? []))].slice(0, 8);
    scenes.push({
      sceneId: sceneIdOf(assetId, i),
      assetId,
      index: i,
      sourceStartSec: start,
      sourceEndSec: end,
      timelinePlacements: timelinePlacementsForRange(start, end, ctx),
      representativeFrameId: rep?.frameId ?? null,
      representativeAssetId: null,
      frameIds: inScene.map((f) => f.frameId).slice(0, 16),
      description: analyzed.find((f) => f.analysis)?.analysis?.description ?? null,
      objects,
      activities,
      category: null,
      similarSceneIds: [],
      repeatGroup: null,
      confidence: analyzed.length > 0 ? Math.min(0.9, 0.5 + 0.1 * analyzed.length) : null,
      provider: analyzed[0]?.provider ?? null,
      model: analyzed[0]?.model ?? null,
      understanding: analyzed.length > 0 ? "semantic" : "heuristic-only",
    });
  }
  // Similarity from representative frame hashes (deterministic, transient map).
  const hashOf = new Map<string, string>(scenes.map((s) => [s.sceneId, frames.find((f) => f.frameId === s.representativeFrameId)?.ahash ?? ""]));
  for (const s of scenes) {
    const own = hashOf.get(s.sceneId) ?? "";
    if (!own) continue;
    for (const other of scenes) {
      if (other.sceneId === s.sceneId) continue;
      const their = hashOf.get(other.sceneId) ?? "";
      if (!their) continue;
      if (hammingHex(own, their) <= settings.repeatShotHashDistance) {
        s.similarSceneIds.push(other.sceneId);
        if (s.similarSceneIds.length >= 8) break;
      }
    }
  }
  repeatGroups(scenes, hashOf, settings.repeatShotHashDistance);
  return scenes;
}

/**
 * Register representative frames as IMAGE assets (persistent per-user dir —
 * NOT the temp run dir, which the job cleans). Returns sceneId→assetId.
 */
export async function registerRepresentativeFrames(scenes: VisualScene[], frames: VisualFrame[], files: Map<string, string>, opts: { userId: string; projectId: string | null; assetId: string; assetName: string; analysisVersion: string; maxFrames?: number; seqFps: number }): Promise<Map<string, string>> {
  const persistentDir = pathInsideMediaRoot("visual-frames", `u_${opts.userId}`);
  await mkdir(persistentDir, { recursive: true });
  const out = new Map<string, string>();
  let registered = 0;
  const cap = opts.maxFrames ?? 24;
  for (const scene of scenes) {
    if (registered >= cap) break;
    if (!scene.representativeFrameId || scene.representativeAssetId) continue;
    const frame = frames.find((f) => f.frameId === scene.representativeFrameId);
    const file = frame ? files.get(frame.frameId) : undefined;
    if (!frame || !file) continue;
    const safeName = `${scene.sceneId.replace(/[^a-zA-Z0-9:_-]/g, "_")}.jpg`;
    const persistentPath = path.join(persistentDir, safeName);
    await copyFile(file, persistentPath);
    try {
      const reg = await registerImageArtifact(persistentPath, {
        engine: "JAZMII",
        userId: opts.userId,
        projectId: opts.projectId,
        originalName: `visual_frame_${scene.sceneId}.jpg`,
        provider: frame.provider ?? "ffmpeg",
        model: frame.model ?? "frame-extraction",
        prompt: `Representative frame of ${opts.assetName} at ${frame.sourceSec.toFixed(2)}s (scene ${scene.index})`,
        params: {
          sourceAssetId: opts.assetId,
          sourceSec: frame.sourceSec,
          timelineSec: frame.timelineSec,
          clipId: frame.clipId,
          extractionMethod: frame.extractionMethod,
          analysisVersion: opts.analysisVersion,
          kind: "m12-visual-representative",
        },
        license: "source-project",
        attribution: `Representative frame of ${opts.assetName} @ ${frame.sourceSec.toFixed(2)}s`,
        referenceAssetId: opts.assetId,
      });
      scene.representativeAssetId = reg.id;
      out.set(scene.sceneId, reg.id);
      registered += 1;
    } catch (err) {
      // Registration failure must not fail the index — the scene keeps its
      // frame reference and the UI shows no thumbnail (honest gap).
      scene.representativeAssetId = null;
      void err;
    }
  }
  return out;
}

/** Assemble the full index object for one asset (post-analysis). */
export function assembleIndex(opts: { assetId: string; assetName: string; durationSec: number | null; width: number | null; height: number | null; fps: number | null; settings: VisualSettings; frames: VisualFrame[]; scenes: VisualScene[]; consentVisual: boolean; notes: string[] }): VisualIndex {
  return {
    analysisVersion: VISUAL_ANALYSIS_VERSION,
    assetId: opts.assetId,
    assetName: opts.assetName.slice(0, 200),
    durationSec: opts.durationSec,
    width: opts.width,
    height: opts.height,
    fps: opts.fps,
    settings: opts.settings,
    frames: opts.frames.slice(0, 120),
    scenes: opts.scenes.slice(0, 80),
    measurement: {
      framesExtracted: opts.frames.filter((f) => f.status === "extracted" || f.status === "analyzed").length,
      framesDeduped: opts.frames.filter((f) => f.status === "skipped-duplicate").length,
      framesAnalyzed: opts.frames.filter((f) => f.status === "analyzed").length,
      sceneCount: opts.scenes.length,
      consentVisual: opts.consentVisual,
    },
    notes: opts.notes.slice(0, 12),
  };
}
