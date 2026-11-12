import { db } from "../src/lib/db";
db.exportFile.findFirst({ orderBy: { createdAt: "desc" }, select: { id: true, storagePath: true, durationSec: true, sizeBytes: true } })
  .then(r => console.log(`${r.id}|${r.storagePath}|${r.durationSec}|${r.sizeBytes}`));
