/**
 * Social Video Studio — scene-to-timeline assembly (M8.1 §10).
 *
 * Converts an APPROVED production plan into a genuine editable BEAN FX
 * timeline using ONLY the M1 command engine + M2 versioned persistence:
 *  - integer-frame timing (rational fps from the platform profile)
 *  - visual clips (IMAGE stills sized to the scene; VIDEO trimmed into range)
 *  - narration clips on an AUDIO track (real TTS assets, provenance kept)
 *  - caption clips timed by RIISHE's real ASR on the narration audio
 *    (segment timing measured; word timing estimated by M4's documented
 *    speech-energy heuristic — disclosed, never claimed as provider word data)
 *  - transitions between scenes via the existing AddTransition command
 *  - locked tracks are respected (scene placement fails loudly, never
 *    silently rewrites another track)
 * Every scene stays individually editable (clips labeled scene#N). The
 * original media is never modified. ASSEMBLY IS APPROVAL-GATED and records
 * the produced clip ids per scene (assemblyJson).
 */
import { db } from "@/lib/db";
import { getTimelineHead, applyTimelineEdits } from "@/lib/editor/persistence";
import type { Sequence } from "@/lib/editor/model";
import { transcribeWithAsr } from "@/lib/autocut-analysis";
import { PLATFORM_PROFILES, type StudioBrief } from "./brief";

interface AssembledScene {
  sceneNumber: number;
  clipIds: { visual: string; narration: string | null; captions: string[] };
  startFrame: number;
  durationFrames: number;
}

export interface AssemblyReport {
  planId: string;
  projectId: string;
  version: number;
  scenes: AssembledScene[];
  notes: string[];
  captionsMode: "asr-segments" | "scene-level";
}

const FPS = (b: StudioBrief) => PLATFORM_PROFILES[b.platform].fps;

function frames(sec: number, fps: { num: number; den: number }): number {
  return Math.max(1, Math.round((sec * fps.num) / fps.den));
}

/** Caption style tuned per language (Tamil-safe font family via NIIKI). */
function captionStyleFor(language: "en" | "ta"): Record<string, unknown> {
  return language === "ta"
    ? { fontFamily: "nikki-tamil", fontSize: 46, color: "#FFFFFF", position: "BOTTOM" }
    : { fontFamily: "nikki-sans", fontSize: 46, color: "#FFFFFF", position: "BOTTOM" };
}

export async function assembleStudioTimeline(userId: string, planId: string): Promise<AssemblyReport> {
  const planRow = await db.studioPlan.findFirst({ where: { id: planId, userId } });
  if (!planRow) throw new Error("Plan not found or not owned.");
  if (planRow.status !== "SCENES_READY") throw new Error(`Plan must be SCENES_READY to assemble (current: ${planRow.status}).`);
  if (!planRow.projectId) throw new Error("Plan has no linked project.");
  const brief = JSON.parse(planRow.briefJson) as StudioBrief;
  const scenes = await db.studioScene.findMany({ where: { planId, userId }, orderBy: { sceneNumber: "asc" } });
  if (scenes.length === 0) throw new Error("Plan has no scenes.");

  const head = await getTimelineHead(planRow.projectId, userId);
  const seq = head.sequence;
  const fps = FPS(brief);
  const notes: string[] = [];

  // Track selection: locked tracks are RESPECTED — pick the first unlocked of
  // each kind; if none, the assembly fails loudly (never writes over locks).
  const videoTrack = seq.tracks.find((t) => t.kind === "VIDEO" && !t.locked);
  const audioTrack = seq.tracks.find((t) => t.kind === "AUDIO" && !t.locked);
  const captionTrack = seq.tracks.find((t) => t.kind === "CAPTION" && !t.locked);
  if (!videoTrack) throw new Error("No unlocked VIDEO track available — unlock a track to assemble.");
  if (!audioTrack) throw new Error("No unlocked AUDIO track available for narration.");
  if (!captionTrack && brief.captionsEnabled) notes.push("No unlocked CAPTION track — captions were skipped (they can be added later via NIIKI).");

  const clipByScene = new Map<number, string>();
  const commands: Record<string, unknown>[] = [];
  const assembled: AssembledScene[] = [];
  let cursor = 0;
  let captionsMode: AssemblyReport["captionsMode"] = "scene-level";
  // Transition handling: the M1 engine requires the two clips to OVERLAP —
  // clip A ends at the transition end, clip B starts at the transition start.
  // So the next scene starts `overlap` frames before the previous one ends.
  let pendingTransition: { kind: string; prevEnd: number; prevStart: number; prevClipId: string } | null = null;

  if (scenes.some((s) => s.assetKind === "IMAGE")) {
    notes.push("Some scenes use IMAGE stills — the current M6 FFmpeg render treats stills as single-frame inputs (no loop): for full export support, generate JAZMII footage or upload video for those scenes. The stills remain valid editable clips.");
  }

  for (const scene of scenes) {
    let startFrame = cursor;
    const sceneFrames = frames(scene.durationSec, fps);
    let transitionForThisScene: { kind: string; prevEnd: number } | null = null;
    if (pendingTransition) {
      const overlap = Math.max(2, frames(0.4, fps));
      startFrame = Math.max(0, pendingTransition.prevEnd - overlap);
      transitionForThisScene = { kind: pendingTransition.kind, prevEnd: pendingTransition.prevEnd };
      pendingTransition = null;
    }
    const clipId = `studio-s${scene.sceneNumber}-visual`;
    if (!scene.assetId) {
      // §4: regenerate only missing assets — assembly refuses to fake visuals.
      throw new Error(`Scene ${scene.sceneNumber} has no visual asset. Generate (JAZMII/LAXII) or assign one, then assemble.`);
    }
    const asset = await db.mediaAsset.findFirst({ where: { id: scene.assetId, userId } });
    if (!asset) throw new Error(`Scene ${scene.sceneNumber}: asset missing or not owned.`);
    const visualDur = asset.kind === "IMAGE" ? sceneFrames : Math.min(sceneFrames, frames(asset.durationSec ?? scene.durationSec, fps));
    commands.push({
      type: "AddClip",
      clip: {
        id: clipId,
        trackId: videoTrack.id,
        sourceAssetId: asset.id,
        sourceInFrame: 0,
        sourceOutFrame: visualDur,
        sourceFps: { num: Math.round((asset.fps ?? fps.num / fps.den) * 1000), den: 1000 },
        timelineStartFrame: startFrame,
        timelineDurationFrames: visualDur,
        playbackSpeed: 1,
        volume: asset.kind === "IMAGE" ? 0 : 1,
        muted: asset.kind === "IMAGE",
        fadeInFrames: scene.sceneNumber === 1 ? frames(0.4, fps) : 0,
        fadeOutFrames: scene.sceneNumber === scenes.length ? frames(0.4, fps) : 0,
        transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
        captionText: null,
        captionStyle: null,
        graphicTemplateId: null,
        graphicStyle: null,
        label: `scene ${scene.sceneNumber} · ${asset.kind.toLowerCase()}`,
        missingMedia: false,
        effects: [],
        keyframes: [],
      },
    });
    clipByScene.set(scene.sceneNumber, clipId);

    // The transition is pushed AFTER this scene's visual clip exists — the
    // engine validates commands sequentially against the running sequence.
    if (transitionForThisScene) {
      commands.push({
        type: "AddTransition",
        transitionId: `studio-tr-${scene.sceneNumber - 1}`,
        trackId: videoTrack.id,
        kind: transitionForThisScene.kind,
        startFrame,
        durationFrames: Math.max(2, transitionForThisScene.prevEnd - startFrame),
        params: {},
      });
    }

    // Narration (real TTS asset) on the AUDIO track.
    let narrationClipId: string | null = null;
    if (scene.narrationAssetId) {
      const narr = await db.mediaAsset.findFirst({ where: { id: scene.narrationAssetId, userId } });
      if (narr) {
        narrationClipId = `studio-s${scene.sceneNumber}-voice`;
        commands.push({
          type: "AddClip",
          clip: {
            id: narrationClipId,
            trackId: audioTrack.id,
            sourceAssetId: narr.id,
            sourceInFrame: 0,
            sourceOutFrame: frames(narr.durationSec ?? scene.durationSec, fps),
            sourceFps: { num: 1000, den: 1000 },
            timelineStartFrame: startFrame,
            timelineDurationFrames: frames(narr.durationSec ?? scene.durationSec, fps),
            playbackSpeed: 1,
            volume: 1,
            muted: false,
            fadeInFrames: 0,
            fadeOutFrames: frames(0.15, fps),
            transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
            captionText: null,
            captionStyle: null,
            graphicTemplateId: null,
            graphicStyle: null,
            label: `scene ${scene.sceneNumber} · narration`,
            missingMedia: false,
            effects: [],
            keyframes: [],
          },
        });
      }
    }

    // Captions: RIISHE ASR on the narration audio → real segment timing.
    const captionIds: string[] = [];
    if (captionTrack && brief.captionsEnabled) {
      if (scene.narrationAssetId && narrationClipId) {
        const narr = await db.mediaAsset.findFirst({ where: { id: scene.narrationAssetId, userId } });
        if (narr) {
          try {
            const asr = await transcribeWithAsr(narr.storagePath, narr.durationSec ?? scene.durationSec);
            // Real ASR chunk windows (start/end measured). Word-level timing
            // inside a chunk is ESTIMATED by M4's speech-energy heuristic —
            // disclosed, never claimed as provider word data.
            const segments = asr.chunkTexts.filter((c) => c.text.trim().length > 0);
            if (segments.length > 0) {
              captionsMode = "asr-segments";
              for (const seg of segments.slice(0, 30)) {
                const cf = Math.max(2, frames(Math.max(0.08, seg.end - seg.start), fps));
                const at = startFrame + frames(seg.start, fps);
                const cid = `studio-s${scene.sceneNumber}-cap${captionIds.length}`;
                captionIds.push(cid);
                commands.push(captionClip(cid, captionTrack.id, at, cf, seg.text.slice(0, 400), captionStyleFor(brief.language), fps));
              }
              notes.push(`Scene ${scene.sceneNumber}: captions timed by RIISHE ASR (${segments.length} segments; chunk windows measured, word timing estimated from speech energy per M4's documented heuristic — the provider returns no word timestamps).`);
            }
          } catch {
            notes.push(`Scene ${scene.sceneNumber}: RIISHE transcription unavailable for the narration audio; scene-level caption used.`);
          }
        }
      }
      if (captionIds.length === 0 && scene.captionText.trim()) {
        const cid = `studio-s${scene.sceneNumber}-cap0`;
        captionIds.push(cid);
        commands.push(captionClip(cid, captionTrack.id, startFrame, sceneFrames, scene.captionText.slice(0, 400), captionStyleFor(brief.language), fps));
      }
    }

    // Remember the outgoing transition for the NEXT scene's placement.
    pendingTransition = scene.sceneNumber < scenes.length && scene.transition !== "CUT"
      ? { kind: scene.transition, prevEnd: startFrame + sceneFrames, prevStart: startFrame, prevClipId: clipId }
      : null;

    assembled.push({ sceneNumber: scene.sceneNumber, clipIds: { visual: clipId, narration: narrationClipId, captions: captionIds }, startFrame, durationFrames: sceneFrames });
    cursor = startFrame + sceneFrames;
  }

  // Apply in ≤500-command batches (M2 limit) with fresh versions per batch.
  let version = head.version;
  for (let i = 0; i < commands.length; i += 500) {
    const batch = commands.slice(i, i + 500);
    const result = await applyTimelineEdits(planRow.projectId, userId, version, batch, false);
    version = result.version;
  }

  await db.studioPlan.update({
    where: { id: planId },
    data: {
      status: "ASSEMBLED",
      assemblyJson: JSON.stringify({ version, scenes: assembled, notes, captionsMode, assembledAt: new Date().toISOString() }),
    },
  });
  return { planId, projectId: planRow.projectId, version, scenes: assembled, notes, captionsMode };
}

function captionClip(id: string, trackId: string, at: number, dur: number, text: string, style: Record<string, unknown>, fps: { num: number; den: number }): Record<string, unknown> {
  return {
    type: "AddCaption",
    clip: {
      id,
      trackId,
      sourceAssetId: "",
      sourceInFrame: 0,
      sourceOutFrame: dur,
      // Synthetic clips: source fps == timeline fps so the model's duration
      // mapping (source frames × timelineFps/sourceFps) stays 1:1.
      sourceFps: { num: Math.round(fps.num * 1000), den: 1000 },
      timelineStartFrame: at,
      timelineDurationFrames: dur,
      playbackSpeed: 1,
      volume: 0,
      muted: true,
      fadeInFrames: 0,
      fadeOutFrames: 0,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      captionText: text,
      captionStyle: style,
      graphicTemplateId: null,
      graphicStyle: null,
      label: `caption · ${id.split("-").slice(1, 2).join("")}`,
      // Captions are synthetic text clips — the model's documented use of
      // missingMedia (no source media required; M1 engine accepts these).
      missingMedia: true,
      effects: [],
      keyframes: [],
    },
  };
}

void ((_s: Sequence) => undefined);
