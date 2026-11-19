import { NextRequest, NextResponse } from "next/server";
import { existsSync } from "fs";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { matchRelinkCandidates, type RelinkTarget } from "@/lib/project-archive";

/**
 * M29 P5 — bulk relinking. GET: every dead asset reference in the project
 * (clips whose sourceAssetId does not resolve), the affected clips, and the
 * user's library with deterministic match suggestions (checksum → name+meta →
 * manual). APPLY happens through the EXISTING timeline endpoint with the new
 * `RelinkAssets` command — one atomic, reversible history entry; no partial
 * application; placement and in/out points are untouched.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { id } = await ctx.params;

  const project = await db.project.findUnique({ where: { id } });
  if (!project || project.userId !== user.id) return NextResponse.json({ error: "Project not found." }, { status: 404 });
  const latest = await db.timelineVersion.findFirst({ where: { projectId: id }, orderBy: { versionNumber: "desc" } });
  if (!latest) return NextResponse.json({ missing: [], library: [], sequence: null });
  const seq = JSON.parse(latest.sequenceJson) as {
    fps: { num: number; den: number };
    clips: { id: string; sourceAssetId: string | null; timelineDurationFrames: number; missingMedia: boolean }[];
  };
  const seqFps = seq.fps.num / seq.fps.den;

  const referenced = [...new Set(seq.clips.map((c) => c.sourceAssetId).filter((x): x is string => Boolean(x)))];
  const assets = await db.mediaAsset.findMany({ where: { id: { in: referenced }, userId: user.id } });
  const present = new Set(assets.map((a) => a.id));

  const missingByAsset = new Map<string, { clipId: string; expectedDurationSec: number }[]>();
  for (const clip of seq.clips) {
    if (!clip.sourceAssetId || present.has(clip.sourceAssetId)) continue;
    const arr = missingByAsset.get(clip.sourceAssetId) ?? [];
    arr.push({ clipId: clip.id, expectedDurationSec: clip.timelineDurationFrames / seqFps });
    missingByAsset.set(clip.sourceAssetId, arr);
  }

  const library = await db.mediaAsset.findMany({
    where: { userId: user.id },
    select: { id: true, originalName: true, kind: true, sizeBytes: true, sha256: true, durationSec: true, width: true, height: true, fps: true, channels: true },
    orderBy: { createdAt: "desc" },
    take: 300,
  });

  const missing = [...missingByAsset.entries()].map(([deadAssetId, clips]) => {
    // Dead rows are gone — the clip expectation is the honest metadata signal.
    const target: RelinkTarget = {
      deadAssetId, originalName: null, sizeBytes: null, sha256: null,
      durationSec: clips[0]?.expectedDurationSec ?? null, width: null, height: null,
      fps: null, channels: null, kind: null,
    };
    const suggestions = matchRelinkCandidates(target, library)
      .filter((c) => c.quality !== "INVALID")
      .slice(0, 8)
      .map((c) => ({ ...c, asset: library.find((l) => l.id === c.candidateAssetId) }));
    return { deadAssetId, affectedClips: clips, suggestions };
  });

  return NextResponse.json({
    missing,
    library,
    staleProxies: assets.filter((a) => a.proxyStatus === "READY" && (!a.proxyPath || !existsSync(a.proxyPath))).map((a) => a.id),
    baseVersion: latest.versionNumber,
  });
}
