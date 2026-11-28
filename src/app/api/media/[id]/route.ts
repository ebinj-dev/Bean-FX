import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { deleteMediaFileIfLastReference } from "@/lib/media-storage";
import { interpretSourceColor } from "@/lib/color/color-management";

async function getOwnedAsset(id: string, userId: string) {
  const asset = await db.mediaAsset.findUnique({ where: { id } });
  if (!asset || asset.userId !== userId) return null;
  return asset;
}

/**
 * M3 — full asset detail for the owner. The editor's import flow polls this
 * while a fresh upload is being analyzed by the background worker.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { id } = await ctx.params;
  const asset = await getOwnedAsset(id, user.id);
  if (!asset) return NextResponse.json({ error: "Media not found." }, { status: 404 });

  return NextResponse.json({
    media: {
      id: asset.id,
      originalName: asset.originalName,
      kind: asset.kind,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      durationSec: asset.durationSec,
      width: asset.width,
      height: asset.height,
      fps: asset.fps,
      videoCodec: asset.videoCodec,
      audioCodec: asset.audioCodec,
      sampleRate: asset.sampleRate,
      channels: asset.channels,
      probeStatus: asset.probeStatus,
      probeError: asset.probeError,
      probeMetaJson: asset.probeMetaJson,
      // M48-I4 — honest SDR color interpretation of the PROBED metadata
      // (missing fields are defaulted and flagged, never silently assumed).
      colorInterpretation: (() => {
        try {
          const meta = asset.probeMetaJson ? (JSON.parse(asset.probeMetaJson) as { streams?: Array<{ color_space?: string; color_transfer?: string; color_primaries?: string; color_range?: string; pix_fmt?: string }> }) : null;
          const v = meta?.streams?.find((st) => st.color_range !== undefined || st.color_space !== undefined || st.pix_fmt?.startsWith("yuv"));
          return interpretSourceColor({ color: { space: v?.color_space ?? null, transfer: v?.color_transfer ?? null, primaries: v?.color_primaries ?? null, range: v?.color_range ?? null, pixFmt: v?.pix_fmt ?? null } });
        } catch {
          return null;
        }
      })(),
      isVfr: asset.isVfr,
      rotation: asset.rotation,
      aspectRatio: asset.aspectRatio,
      timeBase: asset.timeBase,
      formatName: asset.formatName,
      bitRate: asset.bitRate,
      proxyStatus: asset.proxyStatus,
      proxyError: asset.proxyError,
      proxySizeBytes: asset.proxySizeBytes,
      proxyDurationSec: asset.proxyDurationSec,
      role: asset.role,
      notes: asset.notes,
      createdAt: asset.createdAt.toISOString(),
    },
  });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { id } = await ctx.params;
  const asset = await getOwnedAsset(id, user.id);
  if (!asset) return NextResponse.json({ error: "Media not found." }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const data: { role?: string | null; notes?: string | null } = {};
  if ("role" in body) data.role = body.role === "BROLL" ? "BROLL" : null;
  if ("notes" in body) data.notes = String(body.notes ?? "").slice(0, 500) || null;

  const updated = await db.mediaAsset.update({ where: { id }, data });
  return NextResponse.json({ ok: true, role: updated.role, notes: updated.notes });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { id } = await ctx.params;
  const asset = await getOwnedAsset(id, user.id);
  if (!asset) return NextResponse.json({ error: "Media not found." }, { status: 404 });

  const exportsUsing = await db.exportFile.count({ where: { mediaId: id } });
  await db.mediaAsset.delete({ where: { id } });
  // Deduplicated uploads share one content-addressed file — only the last
  // reference deletes the bytes. The proxy file is refcounted the same way
  // (dedup copies inherit the original's proxyPath).
  const fileRemoved = await deleteMediaFileIfLastReference(asset.storagePath, asset.id);
  if (asset.proxyPath) {
    await deleteMediaFileIfLastReference(asset.proxyPath, asset.id);
  }

  return NextResponse.json({
    ok: true,
    fileRemoved,
    note: exportsUsing > 0 ? "Media deleted. Existing exports were kept." : undefined,
  });
}
