import { NextRequest, NextResponse } from "next/server";
import { existsSync } from "fs";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { computeUserUsage } from "@/lib/media-storage";

/**
 * M29 P6 — asset integrity & storage status (read-only, no deletions).
 * Reports: referenced-media health (missing / stale proxy / VFR / duplicate
 * content groups), unreferenced library assets (safe-cleanup candidates —
 * NEVER auto-deleted), and quota usage.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { id } = await ctx.params;

  const project = await db.project.findUnique({ where: { id } });
  if (!project || project.userId !== user.id) return NextResponse.json({ error: "Project not found." }, { status: 404 });
  const latest = await db.timelineVersion.findFirst({ where: { projectId: id }, orderBy: { versionNumber: "desc" } });
  const seq = latest ? (JSON.parse(latest.sequenceJson) as { clips: { sourceAssetId: string | null }[] }) : { clips: [] };

  const referenced = [...new Set(seq.clips.map((c) => c.sourceAssetId).filter((x): x is string => Boolean(x)))];
  const all = await db.mediaAsset.findMany({ where: { userId: user.id } });
  const byId = new Map(all.map((a) => [a.id, a]));

  const referencedStatus = referenced.map((assetId) => {
    const a = byId.get(assetId);
    if (!a) return { assetId, status: "MISSING" as const };
    const proxyReady = a.proxyStatus === "READY" && a.proxyPath && existsSync(a.proxyPath);
    return {
      assetId,
      status: "READY" as const,
      originalName: a.originalName,
      probeStatus: a.probeStatus,
      probeError: a.probeError,
      proxyStatus: a.proxyStatus,
      proxyStale: a.proxyStatus === "READY" && !proxyReady,
      isVfr: a.isVfr,
      sizeBytes: a.sizeBytes,
    };
  });

  // Duplicate content groups (by checksum) — information only.
  const byHash = new Map<string, string[]>();
  for (const a of all) if (a.sha256) byHash.set(a.sha256, [...(byHash.get(a.sha256) ?? []), a.id]);
  const duplicateGroups = [...byHash.entries()].filter(([, ids]) => ids.length > 1).map(([sha, ids]) => ({ sha256: sha.slice(0, 12) + "…", assetIds: ids }));

  const referencedSet = new Set(referenced);
  const unreferenced = all.filter((a) => !referencedSet.has(a.id)).map((a) => ({ id: a.id, originalName: a.originalName, kind: a.kind, sizeBytes: a.sizeBytes, sha256: a.sha256 }));

  const usage = await computeUserUsage(user.id);
  return NextResponse.json({ referenced: referencedStatus, duplicateGroups, unreferenced, usage, note: "Unreferenced assets are candidates only — deletion is always explicit and user-confirmed." });
}
