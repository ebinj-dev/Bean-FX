import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { jobManager } from "@/lib/job-runner";
import { MEDIA_ROOT, removeFileQuiet } from "@/lib/media-storage";
import {
  getOwnedMedia,
  unauthorized,
  notFound,
  badRequest,
  createExportRecord,
} from "@/lib/process-helpers";
import { getCurrentUser } from "@/lib/auth";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 800;

const schema = z.object({
  mediaId: z.string(),
  method: z.enum(["blur", "delogo", "crop"]),
  region: z.object({
    // Normalized 0..1 coordinates relative to source frame.
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().min(0).max(1),
    h: z.number().min(0).max(1),
  }),
});

/**
 * Watermark removal with three honest, technically valid techniques:
 *  - blur:       strong box-blur confined to the region (visible smudge, content unrecoverable)
 *  - delogo:     ffmpeg delogo — interpolates surrounding pixels (good for small static logos)
 *  - crop:       cuts the region out entirely (changes framing; only valid for edge regions)
 * None of these can magically reconstruct occluded pixels. The UI states this.
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const { mediaId, method, region } = parsed.data;

  const media = await getOwnedMedia(mediaId, user);
  if (!media) return notFound();
  if (!media.hasVideo) return badRequest("Watermark removal requires a video stream.");
  if (!media.width || !media.height) return badRequest("Media dimensions are unknown — cannot process.");

  // Convert normalized region to pixel space, clamped to frame, even numbers.
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
  const px = Math.round(clamp(region.x, 1) * media.width);
  const py = Math.round(clamp(region.y, 1) * media.height);
  let pw = Math.round(clamp(region.w, 1) * media.width);
  let ph = Math.round(clamp(region.h, 1) * media.height);
  pw = Math.min(pw, media.width - px);
  ph = Math.min(ph, media.height - py);
  if (pw < 4 || ph < 4) return badRequest("Selected region is too small to process.");
  const evenW = pw - (pw % 2);
  const evenH = ph - (ph % 2);

  let filter: string;
  let note: string;
  if (method === "blur") {
    // boxblur requires radius <= min(w,h)/2 of the cropped region — scale it
    // down for small regions instead of letting ffmpeg reject the job.
    const maxRadius = Math.max(1, Math.floor(Math.min(evenW, evenH) / 2) - 1);
    const rLuma = Math.min(16, maxRadius);
    const rChroma = Math.min(8, maxRadius);
    filter = `[0:v]crop=${evenW}:${evenH}:${px}:${py},boxblur=luma_radius=${rLuma}:luma_power=2:chroma_radius=${rChroma}[fg];[0:v][fg]overlay=${px}:${py}[vout]`;
    note = "Blur method: the region is strongly blurred. The watermark is obscured, not reconstructed.";
  } else if (method === "delogo") {
    // delogo requires the rectangle to stay strictly inside the frame (x,y >= 1).
    const dx = Math.max(1, px);
    const dy = Math.max(1, py);
    const dw = Math.max(4, Math.min(evenW - (dx - px), media.width - dx - 1));
    const dh = Math.max(4, Math.min(evenH - (dy - py), media.height - dy - 1));
    if (dx + dw > media.width - 1 || dy + dh > media.height - 1) {
      return badRequest("Region touches the frame edge — use blur or crop instead for this position.");
    }
    filter = `[0:v]delogo=x=${dx}:y=${dy}:w=${dw}:h=${dh}[vout]`;
    note = "Delogo method: pixels are interpolated from surrounding content. Quality depends on region size and background detail.";
  } else {
    const touchesTop = py <= 2;
    const touchesBottom = py + ph >= media.height - 2;
    const touchesLeft = px <= 2;
    const touchesRight = px + pw >= media.width - 2;
    if (!touchesTop && !touchesBottom && !touchesLeft && !touchesRight) {
      return badRequest(
        "Crop is only valid when the region touches the frame edge (top/bottom/left/right band). Choose another method or adjust the region."
      );
    }
    // Crop one axis: prefer the vertical band for top/bottom regions.
    let cropW: number, cropH: number, cropX: number, cropY: number;
    if (touchesTop && ph < media.height) {
      cropW = media.width; cropH = media.height - evenH; cropX = 0; cropY = evenH;
    } else if (touchesBottom && ph < media.height) {
      cropW = media.width; cropH = media.height - evenH; cropX = 0; cropY = 0;
    } else if (touchesLeft && pw < media.width) {
      cropW = media.width - evenW; cropH = media.height; cropX = evenW; cropY = 0;
    } else {
      cropW = media.width - evenW; cropH = media.height; cropX = 0; cropY = 0;
    }
    filter = `[0:v]crop=${cropW}:${cropH}:${cropX}:${cropY}[vout]`;
    note = `Crop method: the band containing the watermark is removed. Output is ${cropW}x${cropH} — framing changes.`;
  }

  const outPath = path.join(MEDIA_ROOT, "tmp", `wm_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
  const args = [
    "-i", media.storagePath,
    "-filter_complex", filter,
    "-map", "[vout]",
    "-map", "0:a?",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "19",
    "-c:a", "aac", "-b:a", "160k",
    "-movflags", "+faststart",
  ];

  const jobId = await jobManager.createJob(user.id, "WATERMARK", { mediaId, method, region, note });
  jobManager.setProgress(jobId, 1, "Removing watermark").catch(() => undefined);

  jobManager.runFfmpeg(jobId, [...args, outPath], {
    totalDurationSec: media.durationSec,
    stageLabel: "Removing watermark",
    onDone: async () => {
      const { record } = await createExportRecord(user.id, media.id, "VIDEO", "mp4", outPath, {
        method,
        regionPx: { x: px, y: py, w: evenW, h: evenH },
        note,
      });
      await jobManager.complete(jobId, record.id, `Watermark processed: ${record.filename}`);
    },
    onSettled: async () => {
      // No-op after a successful rename in createExportRecord; removes the
      // partial output when ffmpeg failed or the job was cancelled.
      await removeFileQuiet(outPath);
    },
  });

  return NextResponse.json({ jobId, methodNote: note });
}
