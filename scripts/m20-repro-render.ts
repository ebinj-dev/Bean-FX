// Reproduce the stuck render directly to capture the real exception.
process.env.DATABASE_URL = "file:/home/z/my-project/db/custom.db";
const { runTimelineRenderJob } = await import("/home/z/my-project/src/lib/publish/timeline-render");
const job = { id: process.argv[2], userId: process.argv[3], paramsJson: process.argv[4] };
try {
  await runTimelineRenderJob(job);
  console.log("RENDER FUNCTION RETURNED NORMALLY");
} catch (e) {
  console.log("RENDER THREW:", e instanceof Error ? (e.stack || e.message) : String(e));
}
process.exit(0);
