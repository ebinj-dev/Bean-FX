import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient({ datasources: { db: { url: "file:/home/z/my-project/db/custom.db" } } });
const OOM_MSG = "The encoder process was killed by the system (signal SIGKILL) — most likely out of memory while rendering this timeline.";
async function main() {
  const uidRows = (await prisma.$queryRawUnsafe(`SELECT id FROM "User" LIMIT 1`)) as Record<string, unknown>[];
  const uid = String(Object.values(uidRows[0])[0]);
  const now = Date.now();
  const A = `oomfmt_a_${now.toString(36)}`, B = `oomfmt_b_${now.toString(36)}`;
  // A: TEXT heartbeat (what the suite's INSERT writes via datetime('now',...))
  await prisma.$executeRawUnsafe(`INSERT INTO "Job" ("id","userId","type","status","progress","stage","message","attempts","maxAttempts","lastHeartbeatAt","createdAt","updatedAt") VALUES ('${A}','${uid}','RENDER_TIMELINE','PROCESSING',10,'Rendering window 2/10','${OOM_MSG}',1,1,datetime('now','-300 seconds'),datetime('now'),datetime('now'))`);
  // B: INTEGER ms heartbeat (what Prisma itself writes)
  await prisma.job.create({ data: { id: B, userId: uid, type: "RENDER_TIMELINE", status: "PROCESSING", progress: 10, stage: "Rendering window 2/10", message: OOM_MSG, attempts: 1, maxAttempts: 1, lastHeartbeatAt: new Date(now - 300_000), createdAt: new Date(), updatedAt: new Date() } });
  console.log("inserted A(text-heartbeat) B(int-heartbeat), both stale 300s");
  await new Promise((r) => setTimeout(r, 15000));
  const rows = (await prisma.$queryRawUnsafe(`SELECT "id","status","lastHeartbeatAt",typeof("lastHeartbeatAt") AS t FROM "Job" WHERE "id" IN ('${A}','${B}')`)) as Record<string, unknown>[];
  for (const r of rows) console.log(r.id.slice(0, 14), "status=" + String(r.status), "hb=" + String(r.lastHeartbeatAt).slice(0, 24), "type=" + String(r.t));
  await prisma.$executeRawUnsafe(`DELETE FROM "Job" WHERE "id" IN ('${A}','${B}')`);
  console.log("probe rows cleaned");
  await prisma.$disconnect();
}
main().catch((e) => { console.error("ERR:", (e as Error).message.slice(0, 160)); process.exit(2); });
