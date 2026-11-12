import { db } from "../src/lib/db";
import { promises as fs } from "fs";
import path from "path";
import { MEDIA_ROOT } from "../src/lib/media-storage";

(async () => {
  const media = await db.mediaAsset.findUnique({
    where: { id: "cmw34iwuc0004r69aubxgyyvl" },
    select: { id: true, userId: true, originalName: true },
  });
  if (!media) throw new Error("media not found");
  const user = await db.user.findUnique({ where: { id: media.userId }, select: { email: true } });
  console.log(`owner: ${user?.email}`);

  // Copy the raw-recording SRT reference into storage under a .srt name so the
  // storage layer's SUBTITLE classification applies.
  const src = "/home/z/my-project/upload/not edited.txt";
  const destDir = path.join(MEDIA_ROOT, "uploads");
  await fs.mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, "not-edited-reference.srt");
  await fs.copyFile(src, dest);
  const stat = await fs.stat(dest);

  const existing = await db.mediaAsset.findFirst({ where: { originalName: "not edited.txt (SRT reference)" } });
  if (existing) {
    console.log(`srt-asset-exists|${existing.id}`);
    process.exit(0);
  }
  const asset = await db.mediaAsset.create({
    data: {
      userId: media.userId,
      kind: "SUBTITLE",
      originalName: "not edited.txt (SRT reference)",
      storagePath: dest,
      mimeType: "application/x-subrip",
      sizeBytes: stat.size,
    },
  });
  console.log(`srt-asset-created|${asset.id}`);
  process.exit(0);
})();
