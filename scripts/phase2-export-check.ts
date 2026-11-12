import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const jobs = await db.job.findMany({ orderBy: { updatedAt: "desc" }, take: 2, select: { type: true, status: true, message: true, updatedAt: true } });
console.log(JSON.stringify(jobs, null, 1));
const ex = await db.exportFile.findMany({ orderBy: { createdAt: "desc" }, take: 1, select: { filename: true, createdAt: true } });
console.log("EXPORT:", JSON.stringify(ex));
process.exit(0);
