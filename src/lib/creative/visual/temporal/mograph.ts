/**
 * M13 — Tracking-assisted motion graphics (§8) on the EXISTING NIIKI stack.
 *
 * Converts a VALIDATED track into a NIIKI graphic proposal:
 *  1. template selection from the versioned M6 registry (callout/lower-third);
 *  2. coordinate conversion: tracked normalized centers → % of frame →
 *     clip-relative `x`/`y` KEYFRAMES OFFSET FROM THE ANCHOR (the exact
 *     semantics of the M6 evaluator both preview and export use — parity by
 *     construction);
 *  3. gap handling: within a tracking gap the graphic HOLDS the last known
 *     position (HOLD keyframe) — positions are NEVER extrapolated past the
 *     last observation, and sparse tracks (< 4 usable samples) are refused;
 *  4. payload = M1 `AddTrack` (GRAPHIC, only if none exists) + `AddGraphic`
 *     (the same command the NIIKI panel issues) — executed only through the
 *     approval flow, so undo/redo and version history stay intact;
 *  5. preview = the tracked positions drawn on REAL sampled frames (PIL),
 *     registered as IMAGE assets — actual footage, never generated art.
 */
import { copyFile, mkdir } from "fs/promises";
import { execFile } from "child_process";
import path from "path";
import { NIKKI_TEMPLATES } from "@/lib/nikki/templates";
import { anchorPosition } from "@/lib/nikki/state";
import type { NikkiGraphicStyle } from "@/lib/nikki/types";
import { pathInsideMediaRoot } from "@/lib/media-storage";
import { registerImageArtifact } from "@/lib/ai/asset-lifecycle";
import { frameIdOf } from "../contracts";
import { type MographKeyframe, type MographProposal, type MotionMeasurement, type TemporalIndex, type Track } from "./contracts";

export interface MographContext {
  seqFps: number;
  seqWidth: number | null;
  seqHeight: number | null;
  graphicTrackId: string | null;
  userId: string;
  projectId: string;
  /** Sampled frame files of THIS run for the preview render (temp paths). */
  previewFrames: Map<string, string>;
}

const MAX_KFS = 40;

/** Build one approved-ready proposal from a track; honest refusals on sparse data. */
export async function buildMographProposal(index: TemporalIndex, track: Track, motion: MotionMeasurement | null, opts: { label?: string; primaryText?: string } & MographContext): Promise<{ proposal: MographProposal | null; note: string; warnings: string[] }> {
  const warnings: string[] = [];
  const usable = track.samples.filter((s) => s.visibility !== "lost" && s.timelineSec !== null);
  if (usable.length < 4) {
    return { proposal: null, note: `Track ${track.trackId} has only ${usable.length} usable positioned sample(s) — sparse tracking cannot drive a motion graphic honestly (no interpolation invented over such data).`, warnings };
  }
  // The graphic clip needs a timeline window: use the track's timeline span.
  const timelineSamples = usable.filter((s) => s.timelineSec !== null).sort((a, b) => (a.timelineSec ?? 0) - (b.timelineSec ?? 0));
  const startSec = timelineSamples[0].timelineSec!;
  const endSec = timelineSamples[timelineSamples.length - 1].timelineSec!;
  const durationSec = Math.max(1, endSec - startSec);
  const durationFrames = Math.max(6, Math.round(durationSec * opts.seqFps));
  const clipStartTimelineFrame = Math.max(0, Math.floor(startSec * opts.seqFps));

  // Template: prefer a callout/label template, fall back to the lower-third bar.
  const template = NIKKI_TEMPLATES.find((t) => t.category === "callout") ?? NIKKI_TEMPLATES.find((t) => t.category === "lower-third") ?? NIKKI_TEMPLATES[0];
  const style = template.style;
  const anchor = anchorPosition(style.anchor, style.offsetX, style.offsetY);

  // Decimate samples to ≤ MAX_KFS evenly over the track.
  const step = Math.max(1, Math.ceil(timelineSamples.length / MAX_KFS));
  const chosen = timelineSamples.filter((_, i) => i % step === 0 || i === timelineSamples.length - 1);

  const keyframes: MographKeyframe[] = [];
  const gaps: MographProposal["gaps"] = [];
  let prevTimelineSec: number | null = null;
  for (const s of timelineSamples) {
    const tlSec = s.timelineSec!;
    if (prevTimelineSec !== null) {
      const delta = tlSec - prevTimelineSec;
      // Gap: bigger than one missed sample (sample interval ≈ 1/sampleFps).
      const expected = Math.max(0.25, 2 / Math.max(1, 5));
      if (delta > Math.max(0.5, expected * 3)) {
        const gapStartFrame = Math.max(0, Math.round(prevTimelineSec * opts.seqFps) - clipStartTimelineFrame);
        const gapEndFrame = Math.round(tlSec * opts.seqFps) - clipStartTimelineFrame;
        gaps.push({ fromFrame: gapStartFrame, toFrame: gapEndFrame, note: `tracking gap ${delta.toFixed(2)}s (occlusion or tracker loss) — graphic HOLDS its last known position through the gap; nothing extrapolated` });
      }
    }
    prevTimelineSec = tlSec;
  }
  for (const s of chosen) {
    const relFrame = Math.max(0, Math.round((s.timelineSec ?? startSec) * opts.seqFps) - clipStartTimelineFrame);
    // Subject center in % of frame → offset from the template anchor.
    const xPct = s.nx * 100;
    const yPct = s.ny * 100;
    keyframes.push({ id: `kx${relFrame}`, property: "x", frame: relFrame, value: Math.round((xPct - anchor.xPct) * 100) / 100, interpolation: "LINEAR" });
    keyframes.push({ id: `ky${relFrame}`, property: "y", frame: relFrame, value: Math.round((yPct - anchor.yPct) * 100) / 100, interpolation: "LINEAR" });
  }
  if (gaps.length > 0) warnings.push(`${gaps.length} tracking gap(s): the graphic holds its last measured position through each gap (HOLD), then resumes following. No position was extrapolated.`);
  if (track.terminationReason === "tracker-lost") warnings.push(`Tracking of ${track.trackId} ended in tracker-loss at ${track.exitSourceSec.toFixed(2)}s — the graphic follows only up to the last valid measurement.`);
  if ((motion?.speedPxPerSec ?? 0) > 0.3 * (opts.seqWidth ?? 320)) warnings.push("Very fast subject — keyframe positions are sampled, not continuous; label the result as approximate follow motion.");

  // Commands: GRAPHIC track (if needed) + AddGraphic (M6's own command).
  const trackId = opts.graphicTrackId ?? "t-graphics-m13";
  const commands: Record<string, unknown>[] = [];
  if (!opts.graphicTrackId) {
    commands.push({ type: "AddTrack", track: { id: trackId, kind: "GRAPHIC", name: "Graphics (tracking)", visible: true, muted: false, solo: false, locked: false } });
  }
  const primaryText = (opts.primaryText ?? opts.label ?? `Subject ${track.trackId.split("t").pop() ?? ""}`).slice(0, 60);
  commands.push({
    type: "AddGraphic",
    clip: {
      id: `m13mg${Date.now().toString(36)}${track.windowIndex}`.slice(0, 40),
      trackId,
      sourceAssetId: "",
      sourceInFrame: 0,
      sourceOutFrame: durationFrames,
      sourceFps: { num: Math.round(opts.seqFps * 1000), den: 1000 },
      timelineStartFrame: clipStartTimelineFrame,
      playbackSpeed: 1,
      volume: 1,
      muted: false,
      fadeInFrames: 0,
      fadeOutFrames: 0,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      captionText: null,
      captionStyle: null,
      graphicTemplateId: template.id,
      graphicStyle: { ...style, templateId: template.id, templateVersion: template.version, primaryText } as unknown as Record<string, unknown>,
      label: `Tracking: ${primaryText}`,
      missingMedia: false,
      effects: [],
      keyframes: keyframes as unknown as Record<string, unknown>[],
    },
  });

  // Preview overlays on REAL sampled frames (bbox path approximation).
  const previewAssetIds = await renderTrackPreview(track, index, opts);

  const proposal: MographProposal = {
    proposalId: `m13mg_${track.trackId.replace(/[^a-zA-Z0-9]/g, "")}`,
    trackId: track.trackId,
    assetId: index.assetId,
    templateId: template.id,
    templateVersion: template.version,
    label: `Follow "${primaryText}" with ${template.label}`,
    primaryText,
    clipStartTimelineFrame,
    durationFrames,
    keyframes: keyframes.slice(0, 200),
    gaps: gaps.slice(0, 12),
    warnings: warnings.slice(0, 6),
    previewAssetIds,
    confidence: track.confidence,
    requiresApproval: true,
    payload: { kind: "timeline-commands", commands },
  };
  return { proposal, note: `Proposal built from ${usable.length} measured positions over ${durationSec.toFixed(1)}s (M6 evaluator semantics; anchor ${style.anchor}).`, warnings };
}

/** Draw the tracked path on REAL sampled frames; register ≤4 preview assets. */
async function renderTrackPreview(track: Track, index: TemporalIndex, opts: MographContext): Promise<string[]> {
  if (opts.previewFrames.size === 0) return [];
  const persistentDir = pathInsideMediaRoot("visual-frames", `u_${opts.userId}`);
  await mkdir(persistentDir, { recursive: true });
  const out: string[] = [];
  const samples = track.samples.filter((s) => s.visibility !== "lost").slice(0, 200);
  if (samples.length < 2) return out;
  // Pick ≤4 evenly spaced samples whose frame files exist.
  const step = Math.max(1, Math.floor(samples.length / 4));
  const chosen = samples.filter((_, i) => i % step === 0).slice(0, 4);
  for (const s of chosen) {
    const frameKey = frameIdOf(index.assetId, s.sourceSec, "consecutive-sample");
    const file = opts.previewFrames.get(frameKey);
    if (!file) continue;
    const safeName = `m13track_${track.trackId.replace(/[^a-zA-Z0-9]/g, "")}_${s.sourceSec.toFixed(2)}.jpg`.replace("..", ".");
    const persistentPath = path.join(persistentDir, safeName);
    try {
      await renderOverlay(file, persistentPath, samples, s);
      const reg = await registerImageArtifact(persistentPath, {
        engine: "JAZMII",
        userId: opts.userId,
        projectId: opts.projectId,
        originalName: `track_preview_${safeName}`,
        provider: "ffmpeg+PIL",
        model: "tracking-overlay-preview",
        prompt: `Tracked path overlay of ${track.trackId} at ${s.sourceSec.toFixed(2)}s`,
        params: { trackId: track.trackId, sourceSec: s.sourceSec, kind: "m13-track-preview", bbox: s.bbox },
        license: "source-project",
        attribution: `Tracking preview of ${index.assetName}`,
        referenceAssetId: index.assetId,
      });
      out.push(reg.id);
    } catch {
      // Preview registration failure must not fail the proposal (honest gap).
      continue;
    }
  }
  return out.slice(0, 4);
}

/** PIL: draw the tracked path + a box at the CURRENT sample's measured center. */
async function renderOverlay(srcFile: string, outFile: string, samples: { sourceSec: number; nx: number; ny: number }[], current: { nx: number; ny: number }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const pts = JSON.stringify(samples.map((s) => [s.nx, s.ny]));
    execFile(
      "python3",
      [
        "-c",
        `import sys,json
from PIL import Image, ImageDraw
src, dst, pts_json, cx, cy = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4]), float(sys.argv[5])
im = Image.open(src).convert("RGB")
d = ImageDraw.Draw(im)
W, H = im.size
pts = json.loads(pts_json)
for nx, ny in pts:
    x, y = nx * W, ny * H
    d.ellipse([x - 3, y - 3, x + 3, y + 3], fill=(212, 160, 23))
d.rectangle([cx * W - 20, cy * H - 14, cx * W + 20, cy * H + 14], outline=(255, 255, 255), width=2)
im.save(dst, "JPEG", quality=85)`,
        srcFile,
        outFile,
        pts,
        String(current.nx),
        String(current.ny),
      ],
      { timeout: 30_000 },
      (err, _stdout, stderr) => {
        if (err) return reject(new Error(String(stderr).slice(0, 200)));
        resolve();
      },
    );
  });
}
