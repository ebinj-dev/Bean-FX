/**
 * Preview-frame inspection (M8 §9E) — authenticated single-frame retrieval.
 *
 * Renders ONE frame from a project's current timeline through REAL FFmpeg
 * processing of the topmost VIDEO-track source at that frame: source seek →
 * scale to sequence resolution → flip/gray/blur filters where the effect is
 * set. This is a single-source inspection frame — the full compositor
 * (overlays, transitions mid-flight, graphics) is the browser monitor; the
 * response says exactly that. Frames are cached by content key under
 * MEDIA_ROOT/tmp/preview-frames/ and served only to the owning user.
 * No frame is sent to any external provider by this module — ever.
 */
import { execFile } from "child_process";
import { mkdir, readFile, stat } from "fs/promises";
import path from "path";
import { db } from "@/lib/db";
import { getTimelineHead } from "@/lib/editor/persistence";
import { MEDIA_ROOT, pathInsideMediaRoot } from "@/lib/media-storage";
import { clipEndFrame } from "@/lib/editor/model";

const MAX_W = 1280;
const CACHE_DIR = pathInsideMediaRoot("tmp", "preview-frames");

export interface PreviewFrameResult {
  frame: number;
  sourceClipId: string | null;
  mediaId: string | null;
  /** JPEG bytes + content type for the response. */
  data: Buffer;
  width: number;
  height: number;
  note: string;
  cached: boolean;
}

interface SourceClipInfo {
  clipId: string;
  mediaId: string;
  storagePath: string;
  sourceInFrame: number;
  playbackSpeed: number;
  localFrame: number;
  effects: Array<{ type: string; params: Record<string, unknown> }>;
}

/** Find the topmost VIDEO-track clip covering `frame` (real sequence data). */
async function sourceAtFrame(projectId: string, userId: string, frame: number): Promise<SourceClipInfo | null> {
  const head = await getTimelineHead(projectId, userId);
  const seq = head.sequence;
  const videoTracks = seq.tracks.filter((t) => t.kind === "VIDEO" && t.visible && !t.locked);
  const covered = seq.clips
    .filter((c) => videoTracks.some((t) => t.id === c.trackId))
    .filter((c) => !c.missingMedia && frame >= c.timelineStartFrame && frame < clipEndFrame(seq, c))
    .sort((a, b) => {
      const ta = videoTracks.findIndex((t) => t.id === a.trackId);
      const tb = videoTracks.findIndex((t) => t.id === b.trackId);
      return tb - ta; // later track in the list renders on top
    });
  const clip = covered[0];
  if (!clip) return null;
  const asset = await db.mediaAsset.findUnique({ where: { id: clip.sourceAssetId } });
  if (!asset || asset.userId !== userId) return null;
  const speed = clip.playbackSpeed > 0 ? clip.playbackSpeed : 1;
  const localFrame = (frame - clip.timelineStartFrame) * speed + clip.sourceInFrame;
  return {
    clipId: clip.id,
    mediaId: asset.id,
    storagePath: asset.storagePath,
    sourceInFrame: clip.sourceInFrame,
    playbackSpeed: speed,
    localFrame,
    effects: clip.effects ?? [],
  };
}

/** Build the FFmpeg filter chain from REAL clip state (honest subset). */
function filtersFor(info: SourceClipInfo, height: number): string {
  const parts: string[] = [`scale=-2:${height}:flags=lanczos`];
  for (const e of info.effects) {
    if (!e || e.type === undefined) continue;
    if (e.type === "grayscale") parts.push("hue=s=0");
    if (e.type === "flipH") parts.push("hflip");
    if (e.type === "flipV") parts.push("vflip");
    if (e.type === "blur") {
      const radius = Math.max(1, Math.min(20, Number(e.params?.radius ?? 4)));
      parts.push(`gblur=sigma=${radius}`);
    }
    // opacity/volume are playback-avg or multi-layer concepts — not applied
    // to a single-source inspection frame (documented honestly).
  }
  return parts.join(",");
}

export async function renderPreviewFrame(projectId: string, userId: string, frame: number, maxWidth = 960): Promise<PreviewFrameResult> {
  const info = await sourceAtFrame(projectId, userId, frame);
  if (!info) {
    throw Object.assign(new Error("No visible video clip covers this frame (or the asset is missing/not owned)."), { code: "NO_FRAME" });
  }
  const head = await getTimelineHead(projectId, userId);
  const seq = head.sequence;
  const height = Math.min(seq.height, Math.round((MAX_W * seq.height) / seq.width));
  const widthCap = maxWidth > MAX_W ? MAX_W : Math.max(160, Math.min(MAX_W, maxWidth));
  const key = [info.mediaId, info.localFrame.toFixed(3), filtersFor(info, height), widthCap].join("_").replace(/[^a-z0-9_.-]/gi, "");
  const cachedPath = path.join(CACHE_DIR, `${key}.jpg`);
  await mkdir(CACHE_DIR, { recursive: true });
  try {
    const cached = await stat(cachedPath);
    if (cached.size > 0) {
      return {
        frame,
        sourceClipId: info.clipId,
        mediaId: info.mediaId,
        data: await readFile(cachedPath),
        width: widthCap,
        height,
        note: "Single-source inspection frame from the topmost video-track clip (cached). Full composition preview is the editor monitor.",
        cached: true,
      };
    }
  } catch {
    /* cache miss */
  }

  const sec = Math.max(0, info.localFrame / (seq.fps.num / seq.fps.den));
  const out = await new Promise<Buffer>((resolve, reject) => {
    execFile(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-y", "-ss", sec.toFixed(3), "-i", info.storagePath, "-frames:v", "1", "-vf", `${filtersFor(info, height)},scale='min(${widthCap},iw)':-2`, "-q:v", "4", cachedPath],
      { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
      async (err) => {
        if (err) return reject(new Error(`preview frame render failed: ${String(err.message).slice(0, 160)}`));
        try {
          resolve(await readFile(cachedPath));
        } catch (e) {
          reject(e instanceof Error ? e : new Error("cache read failed"));
        }
      },
    );
  });
  void MEDIA_ROOT;
  return {
    frame,
    sourceClipId: info.clipId,
    mediaId: info.mediaId,
    data: out,
    width: widthCap,
    height,
    note: "Single-source inspection frame from the topmost video-track clip. Full composition preview is the editor monitor. Frames never leave this deployment unless YOU send them to a provider.",
    cached: false,
  };
}
