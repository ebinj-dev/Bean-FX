import { db } from "../src/lib/db";

db.job.findMany({
  orderBy: { createdAt: "desc" },
  take: 4,
  select: { id: true, type: true, status: true, progress: true, message: true, createdAt: true },
})
  .then((jobs) => {
    for (const j of jobs) console.log(`${j.type}|${j.status}|${j.progress}|${(j.message ?? "").slice(0, 160)}`);
    process.exit(0);
  });
