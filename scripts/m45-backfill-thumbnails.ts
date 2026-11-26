/**
 * M45 — one-shot backfill: queue MEDIA_PROBE jobs for every existing READY
 * asset so the new poster-thumbnail pipeline covers pre-M45 media. Uses the
 * SAME durable job pipeline (no side-door processing).
 * Run: bun run scripts/m45-backfill-thumbnails.ts
 */
import { db } from "../src/lib/db";
import { posterPathFor } from "../src/lib/media-storage";
import { stat } from "fs/promises";

async function main(): Promise<void> {
  const assets = await db.mediaAsset.findMany({
    where: { kind: { in: ["VIDEO", "IMAGE"] }, probeStatus: "READY" },
    select: { id: true, userId: true, originalName: true },
  });
  const queued: string[] = [];
  for (const a of assets) {
    const exists = await stat(posterPathFor(a.id)).then(() => true).catch(() => false);
    if (exists) continue;
    await db.job.create({
      data: {
        userId: a.userId,
        type: "MEDIA_PROBE",
        status: "QUEUED",
        stage: "Queued",
        paramsJson: JSON.stringify({ mediaId: a.id }),
      },
    });
    queued.push(`${a.id} (${a.originalName})`);
  }
  console.log(`backfill: ${queued.length} probe job(s) queued`);
  for (const q of queued) console.log("  -", q);
  await db.$disconnect();
}

void main();
