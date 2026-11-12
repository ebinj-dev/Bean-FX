import { db } from "../src/lib/db";
db.job.findMany({ where: { type: "autocut-analysis" }, orderBy: { createdAt: "desc" }, take: 3, select: { id: true, status: true, progress: true, stage: true, message: true, updatedAt: true } })
  .then(r => console.log(r.map(j => `${j.id} | ${j.status} | ${j.progress}% | ${j.stage} | ${j.message?.slice(0, 90)}`).join("\n")));
