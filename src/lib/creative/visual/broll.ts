/**
 * M12 — Intelligent B-roll recommendations (§7).
 *
 * Grounded in REAL evidence only:
 *  - narration segments with measured missing/weak visual coverage (§6
 *    matches) or model-observed unrelated visuals;
 *  - EXISTING footage: owned, project-scoped assets NOT currently placed on
 *    the timeline (or specific analyzed scenes of indexed assets) — proposed
 *    as validated M1 `AddClip` commands, executable through the approval flow;
 *  - GENERATED suggestions: engine-action payloads routing to the EXISTING
 *    LAXII/JAZMII durable jobs (never auto-inserted — generation output needs
 *    its own explicit insert approval);
 *  - no fabricated availability: no external stock footage is claimed, and
 *    semantic "matches" are only claimed where real frame analysis exists.
 */
import { db } from "@/lib/db";
import type { Recommendation } from "../contracts";
import type { NarrationMatch, VisualIndex } from "./contracts";

export interface BrollOptions {
  fps: number;
  videoTrackId: string | null;
  /** Source asset ids already placed on the timeline (reuse check). */
  placedAssetIds: Set<string>;
  maxRecommendations?: number;
}

export interface BrollResult {
  recommendations: Recommendation[];
  notes: string[];
}

interface WeakSeg {
  match: NarrationMatch;
  reason: string;
}

function clipId(prefix: string, i: number): string {
  return `${prefix}${Date.now().toString(36)}${i}`.slice(0, 40);
}

export async function buildBrollRecommendations(userId: string, projectId: string, matches: NarrationMatch[], index: VisualIndex | null, opts: BrollOptions): Promise<BrollResult> {
  const notes: string[] = [];
  const out: Recommendation[] = [];
  const maxRecs = opts.maxRecommendations ?? 6;

  // Weak segments: measured coverage gaps or provider-assessed unrelated visuals.
  const weak: WeakSeg[] = [];
  for (const m of matches) {
    if (m.coverage === "none") weak.push({ match: m, reason: `no timeline video covers the speech (${m.timelineStartSec?.toFixed(1) ?? "?"}–${m.timelineEndSec?.toFixed(1) ?? "?"}s)` });
    else if (m.coverage === "partial") weak.push({ match: m, reason: `timeline video covers only part of the speech span` });
    else if (m.relevance === "unrelated") weak.push({ match: m, reason: `analyzed frames show unrelated content (provider assessment, ai-interpretation)` });
  }
  if (weak.length === 0) return { recommendations: out, notes };
  notes.push(`${weak.length} narration segment(s) with missing/weak visual support identified.`);

  // Owned, project-scoped, unplaced footage (existing-media path).
  const assets = await db.mediaAsset.findMany({ where: { userId, projectId, kind: { in: ["IMAGE", "VIDEO"] } }, orderBy: { createdAt: "desc" }, take: 40 });
  const unplaced = assets.filter((a) => !opts.placedAssetIds.has(a.id));
  const indexedAssetId = index?.assetId ?? null;
  let recNo = 0;

  for (const w of weak) {
    if (out.length >= maxRecs) break;
    const seg = w.match;
    const segLenSec = seg.timelineStartSec !== null && seg.timelineEndSec !== null ? Math.max(1, Math.min(seg.timelineEndSec - seg.timelineStartSec, 8)) : 3;
    const startFrame = seg.timelineStartSec !== null ? Math.max(0, Math.floor(seg.timelineStartSec * opts.fps)) : 0;
    const tl = seg.timelineStartSec !== null ? `${seg.timelineStartSec.toFixed(1)}s` : "unmapped";

    // 1) An indexed scene of the SAME asset elsewhere = reuse an unused scene.
    if (indexedAssetId && index && seg.matchedSceneIds.length === 0) {
      const candidateScene = index.scenes.find((s) => !s.timelinePlacements.some((p) => seg.timelineStartSec !== null && p.timelineStartSec < (seg.timelineEndSec ?? 0) && p.timelineEndSec > (seg.timelineStartSec ?? 0)) && s.sourceEndSec - s.sourceStartSec >= segLenSec);
      if (candidateScene && opts.videoTrackId && seg.timelineStartSec !== null) {
        const fpsSrc = index.fps ?? opts.fps;
        const inF = Math.floor(candidateScene.sourceStartSec * fpsSrc);
        const outF = Math.floor((candidateScene.sourceStartSec + segLenSec) * fpsSrc);
        recNo += 1;
        out.push({
          recNo,
          kind: "executable",
          engine: "JAZMII",
          title: `B-roll: reuse unused scene ${candidateScene.index} of the indexed footage`,
          detail: `Narration at ${tl} has ${w.reason}. An unplaced scene (source ${candidateScene.sourceStartSec.toFixed(1)}–${(candidateScene.sourceStartSec + segLenSec).toFixed(1)}s) from the same asset can cover it.${candidateScene.description ? ` Scene content (analyzed): ${candidateScene.description.slice(0, 220)}` : ""}`,
          target: { clipId: null, trackId: opts.videoTrackId, startSec: seg.timelineStartSec, endSec: (seg.timelineStartSec ?? 0) + segLenSec },
          payload: {
            kind: "timeline-commands",
            commands: [
              {
                type: "AddClip",
                clip: {
                  id: clipId("broll", recNo),
                  trackId: opts.videoTrackId,
                  sourceAssetId: indexedAssetId,
                  sourceInFrame: inF,
                  sourceOutFrame: outF,
                  sourceFps: { num: Math.round(fpsSrc * 1000), den: 1000 },
                  timelineStartFrame: startFrame,
                },
              },
            ],
          },
          preview: { note: `AddClip ${segLenSec.toFixed(1)}s at ${tl} on ${opts.videoTrackId} — validated again at approval time.`, sceneId: candidateScene.sceneId },
          requiresApproval: true,
          rationale: `Measured coverage gap (${w.reason}); candidate scene from the M12 visual index${candidateScene.description ? " with analyzed content" : " (heuristic-only scene — content NOT semantically verified)"}.`,
        });
        continue;
      }
    }

    // 2) Owned unplaced assets (existing footage — provenance-verified, not semantically verified).
    const candidate = unplaced.find((a) => (a.kind === "IMAGE" ? (a.width ?? 0) >= 640 : (a.durationSec ?? 0) >= Math.min(segLenSec, 3)));
    if (candidate && opts.videoTrackId && seg.timelineStartSec !== null) {
      const isImage = candidate.kind === "IMAGE";
      const fpsSrc = candidate.fps ?? opts.fps;
      const durFrames = isImage ? Math.round(segLenSec * fpsSrc) : Math.round(Math.min(candidate.durationSec ?? segLenSec, segLenSec) * fpsSrc);
      recNo += 1;
      out.push({
        recNo,
        kind: "executable",
        engine: isImage ? "LAXII" : "JAZMII",
        title: `B-roll: place owned ${isImage ? "still" : "clip"} "${candidate.originalName.slice(0, 60)}"`,
        detail: `Narration at ${tl} has ${w.reason}. An owned, currently unplaced ${isImage ? "image" : "video"} asset is available (${(isImage ? "still" : `${(candidate.durationSec ?? 0).toFixed(1)}s`)}).`,
        target: { clipId: null, trackId: opts.videoTrackId, startSec: seg.timelineStartSec, endSec: (seg.timelineStartSec ?? 0) + segLenSec },
        payload: {
          kind: "timeline-commands",
          commands: [
            {
              type: "AddClip",
              clip: {
                id: clipId("broll", recNo),
                trackId: opts.videoTrackId,
                sourceAssetId: candidate.id,
                sourceInFrame: 0,
                sourceOutFrame: Math.max(1, durFrames),
                sourceFps: { num: Math.round(fpsSrc * 1000), den: 1000 },
                timelineStartFrame: startFrame,
              },
            },
          ],
        },
        preview: { note: `AddClip ${segLenSec.toFixed(1)}s at ${tl} — validated again at approval time.`, assetId: candidate.id },
        requiresApproval: true,
        rationale: `Owned unplaced asset (provenance: ${candidate.provider ?? "upload"}). Content was NOT semantically verified against the narration${candidate.createdBy ? ` — generated via ${candidate.createdBy}` : ""}; review the thumbnail before approving.`,
      });
      // Do not propose the same asset for every weak segment.
      unplaced.splice(unplaced.indexOf(candidate), 1);
      continue;
    }

    // 3) Generation suggestions (existing durable jobs — never auto-inserted).
    const prompt = `Supporting b-roll for narration: "${seg.text.slice(0, 220)}"`;
    if (seg.timelineStartSec !== null) {
      recNo += 1;
      out.push({
        recNo,
        kind: "executable",
        engine: "LAXII",
        title: `B-roll: generate a supporting still (LAXII)`,
        detail: `Narration at ${tl} has ${w.reason}. No owned unplaced footage fits. Generate a 1920x1080 still matching the narration; AFTER generation completes it is inserted only via your explicit insert action (M1 AddClip, undo-safe).`,
        target: { clipId: null, trackId: opts.videoTrackId, startSec: seg.timelineStartSec, endSec: (seg.timelineStartSec ?? 0) + segLenSec },
        payload: { kind: "engine-action", engine: "LAXII", action: "laxii-broll-image", params: { projectId, prompt, size: "1920x1080", count: 1 } },
        preview: { note: "Routes to the EXISTING LAXII generation job. Insertion is a separate explicit action after you inspect the output.", prompt },
        requiresApproval: true,
        rationale: `Measured coverage gap with no existing footage match; generation via the configured provider (metered, approval-gated).`,
      });
    } else {
      recNo += 1;
      out.push({
        recNo,
        kind: "informational",
        engine: "MYAI",
        title: "Missing visual coverage (no placement proposed)",
        detail: `Narration segment "${seg.text.slice(0, 120)}" has ${w.reason}, but the speech could not be mapped to the timeline — no placement proposal can be validated. Consider importing or generating footage and placing it manually.`,
        target: null,
        payload: { kind: "informational", note: `Missing footage: ${seg.text.slice(0, 200)}` },
        preview: null,
        requiresApproval: false,
        rationale: w.reason,
      });
    }
  }
  return { recommendations: out, notes };
}
