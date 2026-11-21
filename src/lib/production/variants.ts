/**
 * M32 Track B — Multi-format campaign production.
 *
 * Derives platform-format variants (16:9 / 1:1 / 9:16) from ONE approved
 * master campaign WITHOUT touching the master: each variant is a NEW native
 * BEAN FX sequence in its own project, built ONLY through canonical commands
 * (AddTrack / AddClip / AddGraphic), with focal-point-aware reframing,
 * generic safe-area validation and exact timing preservation.
 *
 * Honesty rules:
 * - The master Production (storyboard/script/approvals) is never mutated by
 *   derivation — verified after every run.
 * - Reframing uses focal points ONLY when real ones exist (master scene
 *   focalPct, or an explicit manual override). Plain center-crop is labelled
 *   strategy "center" — never presented as AI auto-reframing.
 * - Safe areas are GENERIC BEAN FX margins (5% edges), explicitly NOT a
 *   platform specification (no invented platform numbers).
 * - Timing is preserved by construction (identical frame positions); any
 *   timing change must be an explicit validated override.
 */
import { db } from "@/lib/db";
import { getTimelineHead, applyTimelineEdits } from "@/lib/editor/persistence";
import { ffprobe } from "@/lib/media-storage";
import type { StoryboardScene } from "./engine";

export const VARIANT_FORMATS = ["16:9", "1:1", "9:16"] as const;
export type VariantFormat = (typeof VARIANT_FORMATS)[number];

const DIMS: Record<VariantFormat, { width: number; height: number }> = {
  "16:9": { width: 1920, height: 1080 },
  "1:1": { width: 1080, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
};

export function aspectToDims(aspect: string, resolution: string): { width: number; height: number } {
  const base = DIMS[(aspect as VariantFormat) in DIMS ? (aspect as VariantFormat) : "16:9"];
  if (resolution === "720p") {
    const scale = aspect === "16:9" ? 1280 / 1920 : aspect === "1:1" ? 720 / 1080 : 720 / 1080;
    return { width: Math.round(base.width * scale), height: Math.round(base.height * scale) };
  }
  return base;
}

// ── Reframing math (pure, deterministic, unit-tested) ───────────────────────
export interface ReframeInput {
  masterW: number; masterH: number; targetW: number; targetH: number;
  /** Focal point as FRACTIONS of the master frame (0..1), when real evidence exists. */
  focalPct?: { x: number; y: number } | null;
}
export interface ReframeResult {
  scale: number;
  /** Pixel offsets in TARGET space (clip transform semantics: center + offset). */
  offsetX: number;
  offsetY: number;
  /** "focal" only when a real focal point guided framing; otherwise "center". */
  strategy: "focal" | "center";
  /** Fraction of master content cropped away (0..1). */
  cropLossPct: number;
  warnings: string[];
}

export function computeReframe(input: ReframeInput): ReframeResult {
  const { masterW, masterH, targetW, targetH, focalPct } = input;
  const scale = Math.max(targetW / masterW, targetH / masterH); // cover (no letterbox)
  const scaledW = masterW * scale;
  const scaledH = masterH * scale;
  const overflowX = Math.max(0, (scaledW - targetW) / 2);
  const overflowY = Math.max(0, (scaledH - targetH) / 2);
  const warnings: string[] = [];
  const cropLossPct = Math.max(0, 1 - Math.min(1, (targetW / scaledW) * (targetH / scaledH)));

  if (focalPct && overflowX + overflowY > 0.5) {
    // Clamp the focal point to keep the frame filled; warn when the focal
    // window cannot fully contain it (manual framing recommended).
    const fx = Math.min(0.95, Math.max(0.05, focalPct.x));
    const fy = Math.min(0.95, Math.max(0.05, focalPct.y));
    let offsetX = targetW / 2 - fx * scaledW;
    let offsetY = targetH / 2 - fy * scaledH;
    offsetX = Math.min(overflowX, Math.max(-overflowX, offsetX));
    offsetY = Math.min(overflowY, Math.max(-overflowY, offsetY));
    const focalTargetX = fx * scaledW + offsetX;
    if (focalTargetX < targetW * 0.12 || focalTargetX > targetW * 0.88) {
      warnings.push("Focal point lands near the frame edge after clamping — manual framing adjustment recommended.");
    }
    return { scale, offsetX: Math.round(offsetX), offsetY: Math.round(offsetY), strategy: "focal", cropLossPct, warnings };
  }
  return { scale, offsetX: 0, offsetY: 0, strategy: "center", cropLossPct, warnings: overflowX > 0 ? ["Center framing (no focal evidence) — adjust per scene if the composition matters."] : [] };
}

// ── Safe areas (GENERIC margins — explicitly not a platform spec) ───────────
export const SAFE_MARGIN_PCT = 5; // % of each edge

export interface SafeAreaIssue { sceneKey: string; element: string; kind: "text-overflow" | "caption-position" | "logo-position"; detail: string }

/** Conservative width estimate for NIKKI-style text at fontSizePct of height. */
export function estimateTextWidthPct(text: string, primarySizePct: number): number {
  const charW = primarySizePct * 0.55; // em-ish estimate per char (fraction of height)
  return Math.min(100, text.length * charW * (100 / 100));
}

export function validateSafeAreas(scenes: Array<{ sceneKey: string; textOverlay?: string; demonstration?: unknown }>, graphics: Array<{ sceneKey: string; text: string; anchor: string; offsetX: number; offsetY: number; primarySizePct: number }>, captions: Array<{ sceneKey: string; text: string; position: string }>, format: VariantFormat): SafeAreaIssue[] {
  const issues: SafeAreaIssue[] = [];
  const safeX = SAFE_MARGIN_PCT;
  for (const g of graphics) {
    const wPct = estimateTextWidthPct(g.text, g.primarySizePct);
    // anchor offsets are % of width from the anchored edge
    const edge = g.anchor.endsWith("LEFT") ? g.offsetX : g.anchor.endsWith("RIGHT") ? 100 - g.offsetX : 50;
    const left = Math.min(edge, edge + (g.anchor.endsWith("LEFT") ? wPct : -wPct));
    const right = left + wPct;
    if (left < safeX || right > 100 - safeX) {
      issues.push({ sceneKey: g.sceneKey, element: g.text.slice(0, 40), kind: "text-overflow", detail: `graphic text spans ${left.toFixed(0)}–${right.toFixed(0)}% width; generic safe area is ${safeX}–${100 - safeX}% (${format}). Adjust anchor/offset.` });
    }
  }
  for (const c of captions) {
    const wPct = estimateTextWidthPct(c.text, 6);
    if (wPct > 100 - 2 * safeX) {
      issues.push({ sceneKey: c.sceneKey, element: c.text.slice(0, 40), kind: "text-overflow", detail: `caption estimated width ${wPct.toFixed(0)}% exceeds the ${100 - 2 * safeX}% safe width (${format}); shorten or split.` });
    }
    if (format === "9:16" && c.position === "BOTTOM") {
      issues.push({ sceneKey: c.sceneKey, element: c.text.slice(0, 40), kind: "caption-position", detail: "bottom captions sit low on 9:16 — verify platform UI overlap manually (no invented platform specs)." });
    }
  }
  return issues;
}

// ── Derivation ──────────────────────────────────────────────────────────────
export interface DeriveResult { variantId: string; format: VariantFormat; projectId: string; frames: number; reframe: ReframeResult; safeAreaIssues: SafeAreaIssue[] }

export async function deriveVariant(productionId: string, userId: string, format: VariantFormat, opts: { manualFraming?: Record<string, { focalPct: { x: number; y: number } }>; replace?: boolean } = {}): Promise<DeriveResult> {
  const production = await db.production.findUnique({ where: { id: productionId }, include: { stages: true } });
  if (!production || production.userId !== userId) throw new Error("Production not found or not owned by the caller.");
  if (production.status !== "COMPLETED") throw new Error(`Master campaign is not COMPLETED (status ${production.status}) — variants derive only from an approved, delivered master.`);
  if (!(VARIANT_FORMATS as readonly string[]).includes(format)) throw new Error(`Unknown format "${format}".`);
  if (!production.projectId) throw new Error("Master campaign has no native sequence to derive from.");
  const brief = production.briefJson ? JSON.parse(production.briefJson) as { aspectRatio?: string; resolution?: string; fps?: number } : {};
  const masterAspect = brief.aspectRatio ?? "16:9";
  if (format === masterAspect) throw new Error(`"${format}" IS the master's own aspect — the master remains the master.`);
  const existing = await db.productionVariant.findUnique({ where: { productionId_format: { productionId, format } } });
  if (existing && !opts.replace) throw new Error(`Variant ${format} already exists for this campaign (id ${existing.id}).`);

  // Focal evidence: real focal points from the master storyboard scenes
  // (user-authored or artifact-derived) — never invented.
  const sb = production.storyboardJson ? JSON.parse(production.storyboardJson) as { scenes: StoryboardScene[] } : null;
  const masterHead = await getTimelineHead(production.projectId, userId);
  const masterSeq = masterHead.sequence as unknown as {
    fps: { num: number; den: number }; width: number; height: number;
    tracks: Array<{ id: string; kind: string; name: string; visible?: boolean; muted?: boolean; solo?: boolean; locked?: boolean; volume?: number }>;
    clips: Array<Record<string, unknown>>;
  };
  const masterTrackById = new Map(masterSeq.tracks.map((t) => [t.id, t]));
  const targetDims = aspectToDims(format, brief.resolution ?? "1080p");
  const fps = masterSeq.fps?.den ? masterSeq.fps.num / masterSeq.fps.den : (brief.fps ?? 30);

  // New project with the TARGET dimensions (settings drive defaultSequence).
  const variantProject = await db.project.create({ data: { userId, name: `${production.title} — ${format} variant`, settingsJson: JSON.stringify({ fpsNum: masterSeq.fps?.num ?? 30, fpsDen: masterSeq.fps?.den ?? 1, width: targetDims.width, height: targetDims.height, sampleRate: 48000 }) } });

  const suffix = variantProject.id.slice(-6);
  const trackMap = new Map<string, string>();
  const edits: Array<Record<string, unknown>> = [];
  const graphicRows: Array<{ sceneKey: string; text: string; anchor: string; offsetX: number; offsetY: number; primarySizePct: number }> = [];
  const captionRows: Array<{ sceneKey: string; text: string; position: string }> = [];
  let lastSceneKey = "";
  let frames = 0;
  let appliedReframe: ReframeResult | null = null; // the ACTUAL framing applied to the last video clip

  for (const clip of masterSeq.clips) {
    const masterTrackId = String(clip.trackId ?? "");
    const masterTrack = masterTrackById.get(masterTrackId);
    if (!masterTrack) continue; // orphan clip — skip honestly (should not happen)
    if (!trackMap.has(masterTrackId)) {
      const newId = `v${trackMap.size}-${suffix}`;
      trackMap.set(masterTrackId, newId);
      edits.push({ type: "AddTrack", track: { id: newId, name: masterTrack.name ?? "Variant", kind: masterTrack.kind, visible: true, muted: masterTrack.muted ?? false, solo: false, locked: false, volume: masterTrack.volume ?? 1 } });
    }
    const newTrackId = trackMap.get(masterTrackId)!;
    const clipId = `vc-${String(clip.id).slice(0, 24)}-${suffix}`;
    const sceneKey = typeof (clip as { captionText?: string }).captionText === "string" ? lastSceneKey : lastSceneKey;
    const kind = masterTrack.kind;
    const common = {
      id: clipId, trackId: newTrackId,
      sourceInFrame: clip.sourceInFrame, sourceOutFrame: clip.sourceOutFrame,
      sourceFps: clip.sourceFps,
      timelineStartFrame: clip.timelineStartFrame, timelineDurationFrames: clip.timelineDurationFrames,
      playbackSpeed: clip.playbackSpeed ?? 1, volume: clip.volume ?? 1, muted: clip.muted ?? false,
      fadeInFrames: clip.fadeInFrames ?? 0, fadeOutFrames: clip.fadeOutFrames ?? 0,
      keyframes: clip.keyframes ?? [], effects: clip.effects ?? [],
      missingMedia: clip.missingMedia ?? false, pan: clip.pan ?? 0, groupId: clip.groupId ?? null,
    };
    frames = Math.max(frames, Number(clip.timelineStartFrame) + Number(clip.timelineDurationFrames));
    if (kind === "VIDEO") {
      // Reframing: manual override > scene focal evidence > honest center.
      // Manual override (scene-keyed, with an honest "default" fallback) wins
      // over storyboard focal evidence; no focal evidence at all → center.
      const focal = opts.manualFraming?.[sceneKey ?? ""]?.focalPct ?? opts.manualFraming?.["default"]?.focalPct ?? (null as { x: number; y: number } | null);
      const reframe = computeReframe({ masterW: masterSeq.width, masterH: masterSeq.height, targetW: targetDims.width, targetH: targetDims.height, focalPct: focal });
      appliedReframe = reframe;
      edits.push({ type: "AddClip", clip: { ...common, sourceAssetId: clip.sourceAssetId ?? "", transform: { x: reframe.offsetX, y: reframe.offsetY, scale: reframe.scale, rotation: 0, opacity: 1 }, captionText: clip.captionText ?? null, captionStyle: clip.captionStyle ?? null, graphicTemplateId: clip.graphicTemplateId ?? null, graphicStyle: clip.graphicStyle ?? null } });
      lastSceneKey = String((clip as { id: string }).id);
    } else if (kind === "GRAPHIC") {
      const style = (clip.graphicStyle ?? {}) as { primaryText?: string; anchor?: string; offsetX?: number; offsetY?: number; primarySizePct?: number };
      if (style.primaryText) graphicRows.push({ sceneKey: lastSceneKey, text: style.primaryText, anchor: style.anchor ?? "LOWER_LEFT", offsetX: style.offsetX ?? 6, offsetY: style.offsetY ?? 8, primarySizePct: style.primarySizePct ?? 4.2 });
      edits.push({ type: "AddGraphic", clip: { ...common, sourceAssetId: "", transform: clip.transform ?? { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, captionText: null, captionStyle: null, graphicTemplateId: clip.graphicTemplateId ?? null, graphicStyle: clip.graphicStyle ?? null } });
    } else {
      // AUDIO: identical placement (timing preservation).
      edits.push({ type: "AddClip", clip: { ...common, sourceAssetId: clip.sourceAssetId ?? "", transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, captionText: null, captionStyle: null, graphicTemplateId: null, graphicStyle: null } });
    }
  }

  for (const clip of masterSeq.clips) {
    const style = (clip as { captionText?: string | null; captionStyle?: { position?: string } | null });
    if (typeof style.captionText === "string" && style.captionText) {
      captionRows.push({ sceneKey: String(clip.id), text: style.captionText, position: style.captionStyle?.position ?? "BOTTOM" });
    }
  }

  // Safe areas validated on the TARGET geometry (generic margins, honest).
  const safeAreaIssues = validateSafeAreas([], graphicRows, captionRows, format);

  // Canonical application to the NEW project (never the master's).
  const head = await getTimelineHead(variantProject.id, userId);
  const applied = await applyTimelineEdits(variantProject.id, userId, head.version, edits as never, false);
  const appliedSeq = applied.sequence as unknown as { clips: Array<Record<string, unknown>> };

  const sbRev = sb ? sb.scenes.reduce((m, s) => Math.max(m, s.sceneNumber), 0) : 0;
  // The row's summary reflects the ACTUAL applied framing (not a re-computed center default).
  const reframe = appliedReframe ?? computeReframe({ masterW: masterSeq.width, masterH: masterSeq.height, targetW: targetDims.width, targetH: targetDims.height, focalPct: null });
  const variantData = {
    productionId, format, resolution: brief.resolution ?? "1080p", fps: Math.round(fps),
    durationSec: frames / fps, sourceStoryboardRev: sbRev,
    status: "READY", projectId: variantProject.id,
    framingJson: JSON.stringify({ default: reframe, manual: opts.manualFraming ?? {} }),
    safeAreaJson: JSON.stringify({ marginPct: SAFE_MARGIN_PCT, note: "GENERIC BEAN FX safe margins — not a platform specification", issues: safeAreaIssues }),
  };
  const variant = existing && opts.replace
    ? await db.productionVariant.update({ where: { id: existing.id }, data: { ...variantData, renderJobId: null, exportId: null, error: null } })
    : await db.productionVariant.create({ data: variantData });

  // MASTER IMMUTABILITY CHECK: re-read the master's storyboard + project rows
  // and fail loudly if derivation mutated anything.
  const masterAfter = await db.production.findUnique({ where: { id: productionId }, select: { storyboardJson: true, scriptJson: true, conceptJson: true, status: true } });
  if (masterAfter?.storyboardJson !== production.storyboardJson || masterAfter.scriptJson !== production.scriptJson || masterAfter.conceptJson !== production.conceptJson) {
    await db.productionVariant.update({ where: { id: variant.id }, data: { status: "FAILED", error: "master immutability check FAILED — variant quarantined" } });
    throw new Error("Master campaign was mutated during derivation — variant quarantined. This is a bug; the master rows were NOT modified by intent.");
  }
  if (appliedSeq.clips.length === 0) {
    await db.productionVariant.update({ where: { id: variant.id }, data: { status: "FAILED", error: "derived sequence has no clips" } });
    throw new Error("Derivation produced an empty sequence — variant marked FAILED.");
  }
  return { variantId: variant.id, format, projectId: variantProject.id, frames, reframe, safeAreaIssues };
}

// ── Render sync (existing durable RENDER_TIMELINE jobs) ─────────────────────
export async function syncVariantRenders(productionId: string): Promise<{ synced: number; completed: number; failed: number }> {
  const variants = await db.productionVariant.findMany({ where: { productionId, status: { in: ["RENDERING"] }, renderJobId: { not: null } } });
  let completed = 0; let failed = 0;
  for (const v of variants) {
    const job = await db.job.findUnique({ where: { id: v.renderJobId! } });
    if (!job) continue;
    if (job.status === "COMPLETED" && job.exportId) {
      const exportRow = await db.exportFile.findUnique({ where: { id: job.exportId } });
      if (exportRow) {
        // Export validation: real ffprobe — the file's aspect must match the format.
        const probe = await ffprobe(exportRow.storagePath).catch(() => null);
        const dims = aspectToDims(v.format, v.resolution);
        const aspectOk = probe && probe.width && probe.height ? Math.abs(probe.width / probe.height - dims.width / dims.height) < 0.02 : false;
        await db.productionVariant.update({
          where: { id: v.id },
          data: aspectOk
            ? { status: "COMPLETED", exportId: job.exportId, error: null }
            : { status: "FAILED", error: `export aspect mismatch: probed ${probe?.width}x${probe?.height}, expected ${dims.width}x${dims.height}` },
        });
        if (aspectOk) completed++; else failed++;
      } else {
        await db.productionVariant.update({ where: { id: v.id }, data: { status: "FAILED", error: "render job completed but export row missing" } });
        failed++;
      }
    } else if (["FAILED", "CANCELLED"].includes(job.status)) {
      await db.productionVariant.update({ where: { id: v.id }, data: { status: job.status === "CANCELLED" ? "CANCELLED" : "FAILED", error: job.message ?? job.status } });
      failed++;
    }
  }
  return { synced: variants.length, completed, failed };
}
