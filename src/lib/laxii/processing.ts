/**
 * LAXII — image processing (M7 §7C): PIL-backed, non-destructive.
 *
 * All operations read an asset and WRITE A NEW FILE (originals are never
 * modified). Ops: aspect adaptation (resize+cover-crop to preset), thumbnail
 * generation, preview generation, safe conversion (JPEG→PNG only when a
 * real alpha channel is needed — the provider has none, documented).
 */
import { execFile } from "child_process";
import path from "path";

export interface ImageDims {
  width: number;
  height: number;
}

export function targetDims(aspect: string, base: ImageDims): ImageDims {
  switch (aspect) {
    case "16:9": return fitTo(base, 16 / 9);
    case "9:16": return fitTo(base, 9 / 16);
    case "1:1": return fitTo(base, 1);
    case "4:5": return fitTo(base, 4 / 5);
    default: return base;
  }
}

function fitTo(base: ImageDims, ratio: number): ImageDims {
  // Keep the long edge near the source resolution for quality.
  const long = Math.max(base.width, base.height);
  if (ratio >= 1) return { width: Math.round(long / 4) * 4, height: Math.round(long / ratio / 4) * 4 };
  return { width: Math.round(long * ratio / 4) * 4, height: Math.round(long / 4) * 4 };
}

/** Run one PIL op script — deterministic, timeout-bounded. */
function runPil(script: string, args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("python3", ["-I", "-c", script, ...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`PIL op failed: ${String(stderr).slice(0, 300)}`));
      resolve(stdout.trim());
    });
  });
}

const DIMS_SCRIPT = "import sys;from PIL import Image;im=Image.open(sys.argv[1]);print(im.width, im.height, im.format, im.mode)";

export async function inspectImage(file: string): Promise<{ width: number; height: number; format: string; mode: string }> {
  const out = await runPil(DIMS_SCRIPT, [file]);
  const [w, h, f, m] = out.split(/\s+/);
  return { width: Number(w), height: Number(h), format: f, mode: m };
}

/** Aspect adaptation → NEW file (cover-crop, never touches the original). */
export async function adaptAspect(src: string, aspect: string, dst: string): Promise<ImageDims> {
  const dims = targetDims(aspect, await inspectImage(src).then((i) => ({ width: i.width, height: i.height })));
  const script = [
    "import sys",
    "from PIL import Image",
    "src, dst, tw, th = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])",
    "im = Image.open(src)",
    "w, h = im.size",
    "target = tw / th",
    "r = w / h",
    "if r > target:",
    "    nw = int(h * target)",
    "    box = ((w - nw) // 2, 0, (w - nw) // 2 + nw, h)",
    "else:",
    "    nh = int(w / target)",
    "    box = (0, (h - nh) // 2, w, (h - nh) // 2 + nh)",
    "im.crop(box).resize((tw, th), Image.LANCZOS).save(dst, quality=92)",
  ].join("\n");
  await runPil(script, [src, dst, String(dims.width), String(dims.height)]);
  return dims;
}

/** Thumbnail / preview generation → NEW file. */
export async function makeThumbnail(src: string, dst: string, maxEdge = 480): Promise<ImageDims> {
  await runPil(
    "import sys;from PIL import Image;src,dst,m=sys.argv[1],sys.argv[2],int(sys.argv[3]);im=Image.open(src);im.thumbnail((m,m),Image.LANCZOS);im.save(dst,quality=88)",
    [src, dst, String(maxEdge)],
  );
  const dims = await inspectImage(dst);
  return { width: dims.width, height: dims.height };
}
