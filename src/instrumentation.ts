/**
 * Next.js instrumentation hook (stable API): runs once when the server
 * boots — dev (`next dev`) and production (`next start` on the standalone
 * build). This is where the M3 media worker's durable claim loop starts, so
 * queued MEDIA_PROBE / MEDIA_PROXY jobs are processed even when the enqueue
 * happened in a different route module (or a process restart recovered them).
 *
 * The nodejs guard keeps the Edge runtime untouched; the autostart env check
 * inside media-worker lets tests drive the loop deterministically instead.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("@/lib/media-worker");
  }
}
