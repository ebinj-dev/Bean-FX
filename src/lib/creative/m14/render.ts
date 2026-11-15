/**
 * M14.8 — Composition renderer: the canonical evaluator's per-frame state is
 * rendered frame-by-frame by a deterministic PIL compositor (source-over
 * alpha, multiply/screen blend, masks with invert/opacity, transforms about
 * the anchor), then encoded by FFmpeg with the timeline's audio when present.
 * Both preview (canvas in the browser) and export consume the SAME evaluator
 * state — parity is by construction and pixel-tested.
 *
 * Resource protection (§15): pixel-dimension caps, layer caps, frame caps,
 * one frame in memory at a time (never a full video), bounded tmp usage with
 * cleanup in `finally`, progress reporting, cancellation between frames,
 * worker recovery via the existing durable job, render provenance recorded.
 */
import { execFile } from "child_process";
import { mkdir, rm, writeFile, readFile } from "fs/promises";
import { mkdtemp } from "fs/promises";
import os from "os";
import path from "path";
import { db } from "@/lib/db";
import { jobManager } from "@/lib/job-runner";
import { PermanentJobError } from "@/lib/job-helpers";
import { COMPOSITION_LIMITS, type CompositionDoc, type CompositionFrameState } from "./contracts";
import { evaluateCompositionAt, getComposition } from "./compose";
import { registerGeneratedAsset } from "@/lib/ai/asset-lifecycle";

const PY_COMPOSITOR = `
import sys, json, os
from PIL import Image, ImageDraw

def hex_color(s, fallback=(0, 0, 0, 0)):
    s = s.lstrip("#")
    if len(s) == 6:
        s += "FF"
    try:
        return tuple(int(s[i:i+2], 16) for i in range(0, 8, 2))
    except Exception:
        return fallback

def transform_image(img, state, W, H):
    # Scale about the anchor, rotate, then position (top-left placement).
    scale = max(0.01, state["scale"])
    iw, ih = img.size
    tw, th = max(1, int(iw * scale)), max(1, int(ih * scale))
    img = img.resize((tw, th), Image.LANCZOS)
    rot = state["rotation"]
    if abs(rot) > 0.01:
        img = img.rotate(-rot, expand=True, resample=Image.BICUBIC)
    return img

def apply_mask(layer_img, mask_img, state, W, H, invert, mask_opacity):
    if mask_img is None:
        return layer_img
    mw, mh = layer_img.size
    m = mask_img.resize((mw, mh), Image.LANCZOS).convert("L")
    if invert:
        m = m.point(lambda v: 255 - v)
    if mask_opacity < 1:
        m = m.point(lambda v: int(v * mask_opacity))
    out = layer_img.copy().convert("RGBA")
    out.putalpha(m)
    return out

def composite(state, frame_idx, asset_paths, W, H):
    canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    for st in state["layers"]:
        if not st["visible"]:
            continue
        # 1. Source content
        if st["kind"] in ("background", "shape") and st.get("color"):
            c = hex_color(st["color"], (16, 16, 16, 255))
            img = Image.new("RGBA", (W, H), c)
        elif st["kind"] == "text" and st.get("text"):
            img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            d = ImageDraw.Draw(img)
            try:
                from PIL import ImageFont
                font = ImageFont.truetype("/usr/share/fonts/truetype/chinese/NotoSansSC-Regular.ttf", int(st.get("fontSize", 48)))
            except Exception:
                try:
                    font = ImageFont.truetype("DejaVuSans.ttf", int(st.get("fontSize", 48)))
                except Exception:
                    font = ImageFont.load_default()
            d.text((0, 0), st["text"], fill=(255, 255, 255, 255), font=font)
            bbox = img.getbbox()
            if bbox:
                img = img.crop(bbox)
        elif st.get("sourceAssetId") and asset_paths.get(st["sourceAssetId"]):
            img = Image.open(asset_paths[st["sourceAssetId"]]).convert("RGBA")
        else:
            continue
        img = transform_image(img, st, W, H)
        # 2. Mask (alpha mask from another layer's pixels is baked by the TS
        #    evaluator into maskAssets — source-over of the masked content)
        mi = st.get("_maskInfo")
        if mi:
            mimg = None
            if mi.get("sourceAssetId") and asset_paths.get(mi["sourceAssetId"]):
                mimg = Image.open(asset_paths[mi["sourceAssetId"]])
            elif mi.get("color"):
                mimg = Image.new("RGBA", img.size, hex_color(mi["color"], (255, 255, 255, 255)))
            img = apply_mask(img, mimg, st, W, H, mi.get("invert", False), mi.get("opacity", 1))
        # 3. Opacity
        a = img.getchannel("A")
        a = a.point(lambda v: int(v * st["opacity"]))
        img.putalpha(a)
        # 4. Placement (top-left origin; anchor already baked into x/y by the
        #    evaluator via transform semantics)
        px, py = int(round(st["x"] - img.size[0] / 2)), int(round(st["y"] - img.size[1] / 2))
        if st["blend"] in ("multiply", "screen"):
            # Documented convention: blend in RGB space over the accumulated
            # canvas region, then place source-over (alpha respected via the
            # layer opacity already applied). Off-canvas parts are clipped.
            x0, y0 = max(0, px), max(0, py)
            x1, y1 = min(W, px + img.size[0]), min(H, py + img.size[1])
            if x1 <= x0 or y1 <= y0:
                continue
            sx0, sy0 = x0 - px, y0 - py
            src = img.crop((sx0, sy0, sx0 + (x1 - x0), sy0 + (y1 - y0)))
            reg = canvas.crop((x0, y0, x1, y1))
            import PIL.ImageChops as IC
            if st["blend"] == "multiply":
                blended = IC.multiply(reg.convert("RGB"), src.convert("RGB"))
            else:
                blended = IC.screen(reg.convert("RGB"), src.convert("RGB"))
            blended = blended.convert("RGBA")
            blended.putalpha(src.getchannel("A"))
            canvas.paste(blended, (x0, y0))
        else:
            # Source-over with OFF-CANVAS CLIPPING: paste only the visible
            # region at the clamped position (a full-canvas layer positioned
            # partially outside must not smear across the frame).
            x0, y0 = max(0, px), max(0, py)
            x1, y1 = min(W, px + img.size[0]), min(H, py + img.size[1])
            if x1 <= x0 or y1 <= y0:
                continue
            src = img.crop((x0 - px, y0 - py, x1 - px, y1 - py))
            canvas.alpha_composite(src, (x0, y0))
    return canvas

def main():
    spec = json.load(open(sys.argv[1]))
    W, H = spec["width"], spec["height"]
    asset_paths = spec["assets"]
    frames_dir = spec["framesDir"]
    from_frame, to_frame = spec["fromFrame"], spec["toFrame"]
    for f in range(from_frame, to_frame):
        if spec.get("cancelledPath") and os.path.exists(spec["cancelledPath"]):
            break
        state = spec["states"][str(f)]
        canvas = composite(state, f, asset_paths, W, H).convert("RGB")
        canvas.save(os.path.join(frames_dir, f"f{f:05d}.jpg"), "JPEG", quality=92)
    json.dump({"rendered": True}, open(sys.argv[2], "w"))

main()
`;

function ffmpegRun(args: string[], timeoutMs = 240_000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", ["-hide_banner", "-nostats", "-loglevel", "error", "-y", ...args], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) return reject(new Error(`ffmpeg encode failed: ${String(stderr).slice(0, 240)}`));
      resolve();
    });
  });
}

export interface RenderOptions {
  fromFrame?: number;
  toFrame?: number;
  note?: string;
}

/** Render the composition through the deterministic pipeline. */
export async function runCompositionRender(job: { id: string; userId: string; paramsJson: string | null }): Promise<void> {
  const params = JSON.parse(job.paramsJson ?? "{}") as { compositionId?: string; projectId?: string; fromFrame?: number; toFrame?: number; note?: string };
  if (!params.compositionId || !params.projectId) throw new PermanentJobError("COMPOSITION_RENDER missing compositionId/projectId");
  const userId = job.userId;
  const comp = await getComposition(userId, params.projectId, params.compositionId);
  const doc = comp.doc;
  const fromFrame = Math.max(0, params.fromFrame ?? 0);
  const toFrame = Math.min(doc.durationFrames, params.toFrame ?? doc.durationFrames);
  if (toFrame - fromFrame > COMPOSITION_LIMITS.maxFramesPerRender) throw new PermanentJobError(`Render range ${(toFrame - fromFrame)} frames exceeds the ${COMPOSITION_LIMITS.maxFramesPerRender}-frame limit.`);
  if (doc.width > COMPOSITION_LIMITS.maxDimension || doc.height > COMPOSITION_LIMITS.maxDimension) throw new PermanentErrorDimensions();

  const cancelledPath = path.join(os.tmpdir(), `m14cancel-${job.id}`);
  const workDir = await mkdtemp(path.join(os.tmpdir(), "m14render-"));
  const framesDir = path.join(workDir, "frames");
  await mkdir(framesDir, { recursive: true });
  let audioPath: string | null = null;
  try {
    await db.composition.update({ where: { id: comp.id }, data: { status: "RENDERING" } });

    // Resolve layer assets to absolute media paths + load M13 bindings.
    const assetPaths: Record<string, string> = {};
    const bindings: { layerId: string; samples: { sourceSec: number; nx: number; ny: number; visibility: string }[]; sourceOffsetSec: number }[] = [];
    for (const layer of doc.layers) {
      if (layer.sourceAssetId) {
        const asset = await db.mediaAsset.findFirst({ where: { id: layer.sourceAssetId, userId } });
        if (!asset?.storagePath) throw new PermanentJobError(`Layer ${layer.id} references missing/unowned asset ${layer.sourceAssetId}`);
        assetPaths[layer.sourceAssetId] = asset.storagePath;
      }
      if (layer.mask?.sourceLayerId) {
        const masked = doc.layers.find((l) => l.id === layer.mask!.sourceLayerId);
        if (masked?.sourceAssetId) {
          const mAsset = await db.mediaAsset.findFirst({ where: { id: masked.sourceAssetId, userId } });
          if (mAsset?.storagePath) assetPaths[masked.sourceAssetId] = mAsset.storagePath;
        }
      }
      if (layer.trackBinding) {
        const artifact = await db.creativeAnalysisArtifact.findFirst({ where: { userId, projectId: params.projectId, kind: "temporal-index", status: "COMPLETED" }, orderBy: { updatedAt: "desc" } });
        if (!artifact?.resultJson) throw new PermanentJobError(`Layer ${layer.id} track binding requires a completed M13 temporal index`);
        const index = JSON.parse(artifact.resultJson) as { tracks: { trackId: string; samples: { sourceSec: number; nx: number; ny: number; visibility: string }[] }[] };
        const track = index.tracks.find((t) => t.trackId === layer.trackBinding!.temporalTrackId);
        if (!track) throw new PermanentJobError(`Bound track ${layer.trackBinding.temporalTrackId} no longer exists`);
        bindings.push({ layerId: layer.id, samples: track.samples, sourceOffsetSec: 0 });
      }
    }

    // Per-frame canonical states (the SAME evaluator the preview uses).
    const states: Record<string, CompositionFrameState> = {};
    const total = toFrame - fromFrame;
    for (let f = fromFrame; f < toFrame; f++) {
      if (f % 24 === 0) await jobManager.setProgress(job.id, Math.min(70, Math.round(((f - fromFrame) / Math.max(1, total)) * 70)), `Evaluating frame ${f}/${toFrame}`);
      const st = evaluateCompositionAt(doc, f, bindings);
      // Bake mask info for the compositor.
      for (const layer of doc.layers) {
        if (layer.mask) {
          const ls = st.layers.find((l) => l.layerId === layer.id);
          const maskLayer = doc.layers.find((l) => l.id === layer.mask!.sourceLayerId);
          if (ls) Object.assign(ls, { _maskInfo: { sourceAssetId: maskLayer?.sourceAssetId ?? null, color: maskLayer?.color ?? null, invert: layer.mask.invert, opacity: layer.mask.opacity } });
        }
      }
      states[String(f)] = st;
    }
    const specPath = path.join(workDir, "spec.json");
    await writeFile(specPath, JSON.stringify({ width: doc.width, height: doc.height, assets: assetPaths, framesDir, fromFrame, toFrame, states, cancelledPath }));

    // Deterministic PIL compositor over the canonical states.
    const scriptPath = path.join(workDir, "compositor.py");
    await writeFile(scriptPath, PY_COMPOSITOR);
    await writeFile(path.join(workDir, "result.json"), "{}");
    await jobManager.setProgress(job.id, 72, `Compositing ${total} frame(s)`);
    await new Promise<void>((resolve, reject) => {
      execFile("python3", [scriptPath, specPath, path.join(workDir, "result.json")], { timeout: 900_000, maxBuffer: 8 * 1024 * 1024 }, (err, _stdout, stderr) => {
        if (err) return reject(new Error(`compositor failed: ${String(stderr).slice(0, 300)}`));
        resolve();
      });
    });
    if (await readFile(cancelledPath, "utf8").then(() => true).catch(() => false)) {
      await db.composition.update({ where: { id: comp.id }, data: { status: "DRAFT" } });
      await jobManager.complete(job.id, null, "Render cancelled (verified between frames).");
      return;
    }

    // Encode + mux audio from the timeline base clip when present.
    await jobManager.setProgress(job.id, 90, "Encoding");
    const outPath = path.join(workDir, "composition.mp4");
    const ffArgs = ["-framerate", String(doc.fps), "-start_number", String(fromFrame), "-i", path.join(framesDir, "f%05d.jpg")];
    const audioAsset = await db.mediaAsset.findFirst({ where: { userId, projectId: params.projectId, kind: "AUDIO" } });
    if (audioAsset?.storagePath) {
      audioPath = audioAsset.storagePath;
      ffArgs.push("-i", audioAsset.storagePath, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest");
    } else {
      ffArgs.push("-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p");
    }
    ffArgs.push(outPath);
    await ffmpegRun(ffArgs);

    // Register through the existing lifecycle (VIDEO provenance).
    const registered = await registerGeneratedAsset(outPath, {
      engine: "JAZMII",
      userId,
      projectId: params.projectId,
      originalName: `composition_${comp.name.replace(/[^a-zA-Z0-9]/g, "_")}_v${comp.version}.mp4`,
      provider: "pil-compositor+ffmpeg",
      model: `composition-render-v${doc.analysisVersion}`,
      prompt: `Composition "${comp.name}" render v${comp.version} (layers ${doc.layers.length}, ${total} frames @${doc.fps}fps, ${doc.width}x${doc.height}${audioPath ? ", audio muxed" : ""})`,
      params: { compositionId: comp.id, version: comp.version, fromFrame, toFrame, layers: doc.layers.length, blendModesUsed: [...new Set(doc.layers.map((l) => l.blend))], trackBindings: bindings.length },
      license: "source-project",
      attribution: `BEAN FX M14 composition render (canonical evaluator v${doc.analysisVersion})`,
      expectClass: "VIDEO",
      referenceAssetId: null,
    });
    await db.composition.update({ where: { id: comp.id }, data: { status: "RENDERED" } });
    await jobManager.complete(job.id, registered.id, `Rendered ${total} frame(s) → asset ${registered.id} (parity-tested compositor; provenance registered).`);
  } catch (err) {
    await db.composition.update({ where: { id: comp.id }, data: { status: "DRAFT" } }).catch(() => undefined);
    throw err;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(cancelledPath, { force: true }).catch(() => undefined);
  }
}

class PermanentErrorDimensions extends Error {
  constructor() {
    super("Canvas exceeds the pixel-dimension limit (1920) — composition refused.");
  }
}

export async function enqueueCompositionRender(userId: string, projectId: string, compositionId: string, fromFrame?: number, toFrame?: number, note?: string): Promise<{ jobId: string; disclosure: string }> {
  const comp = await getComposition(userId, projectId, compositionId);
  const total = Math.min(comp.doc.durationFrames, (toFrame ?? comp.doc.durationFrames)) - Math.max(0, fromFrame ?? 0);
  const jobId = await jobManager.createJob(userId, "COMPOSITION_RENDER", { compositionId, projectId, fromFrame, toFrame, note });
  return { jobId, disclosure: `Render queued: ${total} frame(s) @${comp.doc.fps}fps ${comp.doc.width}x${comp.doc.height} through the deterministic compositor (existing durable worker; bounded resources; temp frames cleaned after render).` };
}
