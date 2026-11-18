import { db } from "../src/lib/db";
import { randomBytes } from "crypto";

// Mint a session for the OWNER of a given media asset so tooling can call the
// real API as that user (same pattern as mint-session.ts — one additive row).
(async () => {
  const mediaId = process.argv[2];
  if (!mediaId) throw new Error("usage: bun scripts/mint-owner-session.ts <mediaId>");
  const asset = await db.mediaAsset.findUnique({ where: { id: mediaId }, select: { userId: true } });
  if (!asset) throw new Error("media not found");
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000);
  await db.session.create({ data: { token, userId: asset.userId, expiresAt } });
  console.log(`SESSION_TOKEN=${token}`);
  process.exit(0);
})();
