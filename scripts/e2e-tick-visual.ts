/**
 * E2E helper: tick the real media worker once (so the durable job completes
 * without a long-running worker process), or read a creative review status.
 * Usage: bun scripts/e2e-tick-visual.ts            → tick once
 *       bun scripts/e2e-tick-visual.ts --status <reviewId> → print status
 */
process.env.NODE_ENV = "production";
const args = process.argv.slice(2);

const { db } = await import("../src/lib/db");

if (args[0] === "--status") {
  const review = await db.creativeReview.findUnique({ where: { id: args[1] } });
  console.log(review?.status ?? "UNKNOWN");
  process.exit(0);
}

const { tickWorkerOnce } = await import("../src/lib/media-worker");
await tickWorkerOnce();
process.exit(0);
