// Phase 2A audit: read-only DB inspection (counts + project inventory). No writes.
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const [users, sessions, projects, media, jobs, exports, words] = await Promise.all([
    db.user.count(),
    db.session.count(),
    db.project.count(),
    db.mediaAsset.count(),
    db.job.count(),
    db.exportFile.count(),
    db.wordsToRemove.count(),
  ]);
  console.log(JSON.stringify({ users, sessions, projects, mediaAssets: media, jobs, exportFiles: exports, wordsToRemove: words }));

  const proj = await db.project.findMany({
    select: { id: true, name: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  console.log("PROJECTS:", JSON.stringify(proj, null, 1));

  const assets = await db.mediaAsset.findMany({
    select: { id: true, originalName: true, storagePath: true, kind: true, mimeType: true, audioCodec: true, sampleRate: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 8,
  });
  console.log("MEDIA_ASSETS:", JSON.stringify(assets, null, 1));

  const recentJobs = await db.job.findMany({
    select: { id: true, type: true, status: true, progress: true, stage: true, message: true, exportId: true, createdAt: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
    take: 8,
  });
  console.log("RECENT_JOBS:", JSON.stringify(recentJobs, null, 1));
}

main()
  .then(() => db.$disconnect())
  .catch((e) => {
    console.error("DB_ERROR:", e.message);
    process.exit(1);
  });
