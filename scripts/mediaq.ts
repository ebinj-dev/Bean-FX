import { db } from "../src/lib/db";
db.mediaAsset
  .findMany({
    orderBy: { createdAt: "desc" },
    take: 8,
    select: { id: true, originalName: true, kind: true, durationSec: true },
  })
  .then((assets) => {
    for (const a of assets) console.log(`${a.kind}|${a.id}|${a.originalName}|${a.durationSec}`);
    process.exit(0);
  });
