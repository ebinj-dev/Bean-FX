import { db } from "../src/lib/db";
db.job.findUnique({ where: { id: "cmw35oyuc0007r63sl8rit2ul" }, select: { id: true, status: true, progress: true, stage: true, message: true, updatedAt: true, createdAt: true } })
  .then(j => console.log(JSON.stringify(j)));
