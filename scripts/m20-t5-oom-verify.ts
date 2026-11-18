/**
 * M20 §3 T5 — OOM-killed stale job is FAILED by the recovery sweep, NOT requeued.
 * Standalone acceptance run (same assertions as the suite's T5; run 6 already
 * has T1/T2/T3/T4/T6/T7 passing — this validates the last test without
 * re-rendering 60/300/600s timelines).
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({ datasources: { db: { url: "file:/home/z/my-project/db/custom.db" } } });
async function q(sql: string): Promise<Record<string, unknown>[]> {
  return (await prisma.$queryRawUnsafe(sql)) as Record<string, unknown>[];
}
async function exec(sql: string): Promise<void> {
  await prisma.$executeRawUnsafe(sql);
}
const STAMP = Date.now().toString(36);
const JOB_ID = `oom${STAMP}`;
const OOM_MSG =
  "The encoder process was killed by the system (signal SIGKILL) — most likely out of memory while rendering this timeline.";

async function main() {
  const rows = await q(`SELECT id FROM "User" ORDER BY "createdAt" LIMIT 1`);
  const realUid = rows.length ? String(Object.values(rows[0])[0]) : "";
  if (!realUid) throw new Error("No User rows — cannot satisfy FK for the simulated job");
  console.log("realUid:", realUid.slice(-10));

  await exec(
    `INSERT INTO "Job" ("id","userId","type","status","progress","stage","message","attempts","maxAttempts","lastHeartbeatAt","createdAt","updatedAt") ` +
      `VALUES ('${JOB_ID}','${realUid}','RENDER_TIMELINE','PROCESSING',10,'Rendering timeline window 2/10 (FFmpeg)','${OOM_MSG}',1,1,(CAST(strftime('%s','now') AS INTEGER) - 300) * 1000,CAST(strftime('%s','now') AS INTEGER) * 1000,CAST(strftime('%s','now') AS INTEGER) * 1000)`,
  );
  console.log("simulated stale OOM job inserted:", JOB_ID, "attempts=1/1 heartbeat=-300s");

  // The sweep runs on a period (~20-40s); wait long enough for it to observe
  // the stale claim (CLAIM_STALE_MS=90s < 300s staleness) and act on it.
  await new Promise((r) => setTimeout(r, 45000));

  const after = await q(`SELECT "status", "message" FROM "Job" WHERE "id"='${JOB_ID}'`);
  const status = after.length ? String(Object.values(after[0])[0]) : "(missing)";
  const message = after.length ? String(Object.values(after[0])[1]) : "";
  console.log("after sweep -> status:", status);
  console.log("message:", message.slice(0, 120));

  let pass = status === "FAILED";
  // Also prove it was NOT requeued: attempts must still be 1 and no PROCESSING revival.
  const attempts = await q(`SELECT "attempts" FROM "Job" WHERE "id"='${JOB_ID}'`);
  if (attempts.length && Number(Object.values(attempts[0])[0]) !== 1) pass = false;
  console.log("attempts (must stay 1):", attempts.length ? String(Object.values(attempts[0])[0]) : "?");

  console.log(pass ? "T5 ACCEPTANCE: PASS — OOM job FAILED by sweep, not requeued" : "T5 ACCEPTANCE: FAIL");
  await exec(`DELETE FROM "Job" WHERE "id"='${JOB_ID}'`);
  console.log("simulated row cleaned up");
  await prisma.$disconnect();
  process.exit(pass ? 0 : 1);
}
main().catch((e) => {
  console.error("ERROR:", (e as Error).message.slice(0, 200));
  process.exit(2);
});
