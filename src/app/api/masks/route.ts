/**
 * M32 Track C — mask API: manual import (honest path), versioned processing
 * operations, real compositing (frame + video), previews. Automatic
 * segmentation is reported CONFIGURATION REQUIRED — never faked.
 */
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { AUTO_SEGMENTATION_STATUS, importManualMask, processMask, compositeFrame, compositeVideo, maskPreviewPng, type MaskOp } from "@/lib/production/masks";
import { ProviderError } from "@/lib/jazmii/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const url = new URL(req.url);
  const sourceAssetId = url.searchParams.get("sourceAssetId");
  const masks = await db.mediaMask.findMany({
    where: { userId: user.id, ...(sourceAssetId ? { sourceAssetId } : {}) },
    orderBy: { createdAt: "desc" }, take: 50,
  });
  const latest = url.searchParams.get("preview") ? masks[0] : null;
  return NextResponse.json({
    autoSegmentation: AUTO_SEGMENTATION_STATUS,
    masks: masks.map((m) => ({
      id: m.id, sourceAssetId: m.sourceAssetId, width: m.width, height: m.height,
      method: m.method, version: m.version, parentId: m.parentId,
      validationStatus: m.validationStatus, validation: m.validationJson ? JSON.parse(m.validationJson) : null,
      coordSpace: m.coordSpace, fps: m.fps, frameIndex: m.frameIndex, notes: m.notes,
      previewDataUrl: (latest && latest.id === m.id ? null : null),
    })),
  });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const body = await req.json().catch(() => null);
  const action = typeof body?.action === "string" ? body.action : "";

  try {
    if (action === "import") {
      // Manual path: an uploaded mask file registered as a MediaAsset first
      // (ordinary upload path), then validated + scaled to the source geometry.
      const mediaAssetId = typeof body.mediaAssetId === "string" ? body.mediaAssetId : "";
      const asset = await db.mediaAsset.findUnique({ where: { id: mediaAssetId } });
      if (!asset || asset.userId !== user.id) return NextResponse.json({ error: "Mask image not found or not owned by the caller." }, { status: 404 });
      if (!asset.mimeType.startsWith("image/")) return NextResponse.json({ error: "Mask must be an image (8-bit alpha/binary PNG)." }, { status: 400 });
      const result = await importManualMask(user.id, {
        sourceAssetId: body.sourceAssetId,
        file: asset.storagePath,
        frameIndex: typeof body.frameIndex === "number" ? body.frameIndex : undefined,
        fps: typeof body.fps === "number" ? body.fps : undefined,
        notes: typeof body.notes === "string" ? body.notes.slice(0, 300) : undefined,
      });
      return NextResponse.json({ ok: true, ...result }, { status: result.validation.ok ? 201 : 422 });
    }
    if (action === "process") {
      const maskId = typeof body.maskId === "string" ? body.maskId : "";
      const opRaw = typeof body.op === "string" ? body.op : "";
      const op = (["invert", "feather", "refine", "scale"].includes(opRaw) ? opRaw : "") as MaskOp;
      if (!op) {
        return NextResponse.json({ error: "op must be invert|feather|refine|scale." }, { status: 400 });
      }
      const result = await processMask(user.id, maskId, op, { radiusPx: body.radiusPx, targetW: body.targetW, targetH: body.targetH });
      return NextResponse.json({ ok: true, ...result });
    }
    if (action === "composite-frame") {
      const bg = await db.mediaAsset.findUnique({ where: { id: String(body.backgroundAssetId ?? "") } });
      const src = await db.mediaAsset.findUnique({ where: { id: String(body.sourceAssetId ?? "") } });
      if (!bg || bg.userId !== user.id || !bg.storagePath) return NextResponse.json({ error: "Background image not found or not owned." }, { status: 404 });
      if (!src || src.userId !== user.id || !src.storagePath) return NextResponse.json({ error: "Source image not found or not owned." }, { status: 404 });
      const result = await compositeFrame(user.id, String(body.maskId ?? ""), bg.storagePath, src.storagePath);
      return NextResponse.json({ ok: true, ...result });
    }
    if (action === "composite-video") {
      const result = await compositeVideo(user.id, String(body.maskId ?? ""), String(body.sourceAssetId ?? ""), String(body.backgroundAssetId ?? ""));
      return NextResponse.json({ ok: true, ...result });
    }
    if (action === "relink") {
      // M33 Track B §B4: a meaningful relink action — point a mask (whose
      // source media was deleted/moved) at a NEW owned source asset. The old
      // association is recorded in notes; nothing is silently substituted.
      const mask = await db.mediaMask.findUnique({ where: { id: String(body.maskId ?? "") } });
      if (!mask || mask.userId !== user.id) return NextResponse.json({ error: "Mask not found." }, { status: 404 });
      const newSource = await db.mediaAsset.findUnique({ where: { id: String(body.newSourceAssetId ?? "") } });
      if (!newSource || newSource.userId !== user.id) return NextResponse.json({ error: "New source media not found or not owned by the caller." }, { status: 404 });
      if (newSource.kind !== "VIDEO" && newSource.kind !== "IMAGE") return NextResponse.json({ error: "Relink target must be video or image media." }, { status: 400 });
      const updated = await db.mediaMask.update({
        where: { id: mask.id },
        data: { sourceAssetId: newSource.id, notes: `${mask.notes ?? ""} · relinked from ${mask.sourceAssetId} → ${newSource.id}`.slice(0, 300) },
      });
      return NextResponse.json({ ok: true, maskId: updated.id, sourceAssetId: updated.sourceAssetId });
    }
    if (action === "preview") {
      const mask = await db.mediaMask.findUnique({ where: { id: String(body.maskId ?? "") } });
      if (!mask || mask.userId !== user.id) return NextResponse.json({ error: "Mask not found." }, { status: 404 });
      const dataUrl = await maskPreviewPng(mask.storagePath);
      return NextResponse.json({ ok: true, dataUrl });
    }
    return NextResponse.json({ error: "action must be import|process|composite-frame|composite-video|preview." }, { status: 400 });
  } catch (err) {
    // Honest failures: size mismatches, corrupt masks, ffmpeg errors — precise reason.
    return NextResponse.json({ error: err instanceof ProviderError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err) }, { status: 409 });
  }
}
