/**
 * M9 — Thumbnail Studio (§3), LAXII-powered.
 *
 * Thumbnail generation runs through the EXISTING provider-independent LAXII
 * image gateway (laxiiProvider — same registry JAZMII/LAXII jobs use), with
 * full provenance preserved via registerGeneratedAsset. The generated base
 * image is NEVER overwritten: alternatives are new MediaAssets, the title
 * overlay is applied to a NEW composited asset, and every selection is
 * recorded on the ThumbnailDraft row.
 *
 * Capabilities (honest): the z-ai image provider supports text-to-image and
 * image-to-image (reference) at fixed sizes — NOT per-layer editing. The
 * title overlay here is a text layer composited server-side onto the base
 * image (PIL + raqm — real Tamil shaping), which IS what ships; nothing more
 * is claimed.
 */
import { execFile } from "child_process";
import path from "path";
import { z } from "zod";
import { db } from "@/lib/db";
import { pathInsideMediaRoot, sniffContainer, sniffMatchesClass } from "@/lib/media-storage";
import { ProviderError } from "@/lib/jazmii/types";
import { laxiiProvider } from "@/lib/laxii/providers";
import { getExportProfile } from "./profiles";
import { mkdir } from "fs/promises";

// ── layout schema (the editable overlay the user controls) ──────────────────
export const ThumbnailLayoutSchema = z.object({
  title: z.string().max(80),
  /** Auto-detects Tamil script; "nikki-tamil" forces the Tamil face. */
  font: z.enum(["auto", "nikki-sans", "nikki-tamil"]).default("auto"),
  position: z.enum(["top", "center", "bottom"]).default("bottom"),
  align: z.enum(["left", "center", "right"]).default("left"),
  /** Relative font size vs canvas height (0.05–0.16). */
  fontScale: z.number().min(0.05).max(0.16).default(0.09),
  textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#ffffff"),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#d4a017"),
  backdrop: z.enum(["none", "band", "box"]).default("band"),
  /** Backdrop opacity 0–1 (band/box only). */
  backdropOpacity: z.number().min(0).max(1).default(0.55),
  shadow: z.boolean().default(true),
});
export type ThumbnailLayout = z.infer<typeof ThumbnailLayoutSchema>;

/** Thumbnail dimensions per platform (cover-photo geometry of the profile). */
export function thumbnailDimsForProfile(profileId: string): { width: number; height: number } {
  const profile = getExportProfile(profileId);
  if (profile) {
    // YouTube landscape cover photo is 16:9 at 1280x720; vertical covers keep the profile canvas.
    if (profile.id === "youtube_landscape" || profile.id === "custom_landscape") return { width: 1280, height: 720 };
    return { width: profile.width, height: profile.height };
  }
  throw new ProviderError("UNSUPPORTED", `Unknown export profile "${profileId}" — no thumbnail geometry exists for it.`);
}

/** Closest LAXII-supported generation size for a target aspect. */
export function closestLaxiiSize(targetW: number, targetH: number): string {
  const provider = laxiiProvider(null);
  const supported = provider.capabilities.sizes;
  const target = targetW / targetH;
  let best: string = supported[0];
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const s of supported) {
    const [w, h] = s.split("x").map(Number);
    const diff = Math.abs(w / h - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = s;
    }
  }
  return best;
}

/** True when the text contains Tamil script characters. */
export function isTamilText(text: string): boolean {
  return /[\u0b80-\u0bff]/.test(text);
}

const OVERLAY_PY = `
import json, sys
from PIL import Image, ImageDraw, ImageFont, ImageOps

base_path, out_path, tw, th, layout_json = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
layout = json.loads(layout_json)

im = Image.open(base_path).convert("RGB")
im = ImageOps.fit(im, (tw, th), method=Image.LANCZOS, centering=(0.5, 0.42))
overlay = Image.new("RGBA", im.size, (0, 0, 0, 0))
d = ImageDraw.Draw(overlay)

font_path = layout["fontPath"]
title = layout["title"]
size = max(14, int(th * float(layout["fontScale"])))
font = ImageFont.truetype(font_path, size)

margin = int(tw * 0.06)
max_text_w = tw - 2 * margin
words = title.split(" ")
lines, cur = [], ""
for word in words:
    trial = (cur + " " + word).strip()
    if d.textlength(trial, font=font) <= max_text_w or not cur:
        cur = trial
    else:
        lines.append(cur)
        cur = word
if cur:
    lines.append(cur)
line_h = size * 1.25
block_h = line_h * len(lines)

text_color = layout["textColor"]
accent = layout["accentColor"]
align = layout["align"]
if layout["position"] == "top":
    y0 = int(th * 0.08)
elif layout["position"] == "center":
    y0 = int((th - block_h) / 2)
else:
    y0 = int(th * 0.92 - block_h)

if layout["backdrop"] != "none":
    band_pad = int(size * 0.45)
    band_x0 = margin - band_pad
    band_x1 = tw - margin + band_pad
    if layout["backdrop"] == "band":
        d.rectangle([band_x0, y0 - band_pad, band_x1, y0 + block_h + band_pad], fill=(0, 0, 0, int(255 * float(layout["backdropOpacity"]))))
    else:
        d.rounded_rectangle([band_x0, y0 - band_pad, band_x1, y0 + block_h + band_pad], radius=int(size * 0.35), fill=(0, 0, 0, int(255 * float(layout["backdropOpacity"]))))

for i, line in enumerate(lines):
    w = d.textlength(line, font=font)
    if align == "center":
        x = (tw - w) / 2
    elif align == "right":
        x = tw - margin - w
    else:
        x = margin
    y = y0 + i * line_h
    if layout["shadow"]:
        d.text((x + max(2, size // 14), y + max(2, size // 14)), line, font=font, fill=(0, 0, 0, 220), stroke_width=max(1, size // 24), stroke_fill=(0, 0, 0, 220))
    d.text((x, y), line, font=font, fill=text_color, stroke_width=max(1, size // 28), stroke_fill=text_color)

d.rectangle([0, 0, int(tw * 0.012), th], fill=accent)

out = Image.alpha_composite(im.convert("RGBA"), overlay).convert("RGB")
out.save(out_path, "JPEG", quality=92)
print(out.size[0], out.size[1])
`;

export interface CompositedThumbnail {
  outPath: string;
  width: number;
  height: number;
}

/**
 * Composite the editable title overlay onto a base image at exact thumbnail
 * dimensions (server-side; fixed python code, no user shell text — the layout
 * travels as parsed JSON). Raises ProviderError on any failure; the caller
 * registers the output through the standard asset lifecycle.
 */
export async function composeThumbnailOverlay(
  basePath: string,
  layout: ThumbnailLayout,
  targetW: number,
  targetH: number,
  outPath: string,
): Promise<CompositedThumbnail> {
  await mkdir(path.dirname(outPath), { recursive: true });
  const fontPath = layout.font === "nikki-tamil" || (layout.font === "auto" && isTamilText(layout.title))
    ? path.join(process.cwd(), "public", "fonts", "NotoSansTamil-Regular.ttf")
    : path.join(process.cwd(), "public", "fonts", "NotoSans-Bold.ttf");
  const payload = JSON.stringify({
    title: layout.title,
    fontPath,
    fontScale: layout.fontScale,
    position: layout.position,
    align: layout.align,
    textColor: layout.textColor,
    accentColor: layout.accentColor,
    backdrop: layout.backdrop,
    backdropOpacity: layout.backdropOpacity,
    shadow: layout.shadow,
  });
  return new Promise((resolve, reject) => {
    execFile(
      "python3",
      ["-c", OVERLAY_PY, basePath, outPath, String(targetW), String(targetH), payload],
      { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          const msg = String(err.message ?? "").slice(0, 300);
          reject(new ProviderError("PROVIDER_FAILURE", `Thumbnail overlay compositing failed: ${msg}`));
          return;
        }
        const [w, h] = stdout.trim().split(/\s+/).map(Number);
        if (!w || !h) {
          reject(new ProviderError("INVALID_RESPONSE", "Thumbnail compositing produced no size report."));
          return;
        }
        resolve({ outPath, width: w, height: h });
      },
    );
  });
}

/** Validate that a file really is an image of the expected size (content sniff + PIL-free decode). */
export async function assertImageFile(filePath: string, expectW?: number, expectH?: number): Promise<void> {
  const { readFile } = await import("fs/promises");
  const head = (await readFile(filePath)).subarray(0, 512);
  const sniff = sniffContainer(head);
  if (!sniffMatchesClass(sniff, "IMAGE")) {
    throw new ProviderError("INVALID_RESPONSE", `Expected an image, sniffed ${sniff.family}.`);
  }
  if (expectW && expectH) {
    const info = await new Promise<{ width: number; height: number }>((resolve, reject) => {
      execFile("python3", ["-c", "import sys;from PIL import Image;im=Image.open(sys.argv[1]);print(im.width, im.height)", filePath], { timeout: 30_000 }, (e, out) => {
        if (e) return reject(new ProviderError("INVALID_RESPONSE", "Image failed PIL decode."));
        const [w, h] = out.trim().split(/\s+/).map(Number);
        resolve({ width: w, height: h });
      });
    });
    if (info.width !== expectW || info.height !== expectH) {
      throw new ProviderError("INVALID_RESPONSE", `Image is ${info.width}x${info.height}; expected ${expectW}x${expectH}.`);
    }
  }
}

/** Directory for thumbnail derivatives (registered assets live under MEDIA_ROOT). */
export function thumbnailWorkDir(userId: string): string {
  return pathInsideMediaRoot("publish-thumbnails", `u_${userId}`);
}

/** Fetch the project context used for the LAXII prompt (text only). */
export async function thumbnailPromptContext(userId: string, projectId: string): Promise<{ topic: string; scriptExcerpt: string; sceneCount: number }> {
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project || project.userId !== userId) throw new ProviderError("PROVIDER_FAILURE", "Project not found or not owned by the caller.");
  const plan = await db.studioPlan.findFirst({
    where: { projectId, userId },
    orderBy: { updatedAt: "desc" },
    include: { scenes: { orderBy: { sceneNumber: "asc" } } },
  });
  const topic = plan?.briefJson ? (safeTopic(plan.briefJson) ?? project.name) : project.name;
  const script = plan?.planJson ? safeScript(plan.planJson) : null;
  return {
    topic,
    scriptExcerpt: (script ?? plan?.scenes.map((s) => s.onScreenText || s.narration).join(" ") ?? project.description ?? "").slice(0, 600),
    sceneCount: plan?.scenes.length ?? 0,
  };
}

function safeTopic(raw: string): string | null {
  try {
    const v = JSON.parse(raw) as { topic?: string };
    return typeof v?.topic === "string" ? v.topic : null;
  } catch {
    return null;
  }
}

function safeScript(raw: string): string | null {
  try {
    const v = JSON.parse(raw) as { fullScript?: string };
    return typeof v?.fullScript === "string" ? v.fullScript : null;
  } catch {
    return null;
  }
}
