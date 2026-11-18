import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { db as prisma } from "@/lib/db";
import { MEDIA_ROOT, ensureMediaRoot } from "@/lib/media-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Honest health check (§8): reports what was actually verified, not a blanket
 * OK. 503 with the failing component when anything is down — the platform
 * boot script and humans can tell "app up" from "app up AND database alive".
 */
export async function GET() {
  const checks: Record<string, { ok: boolean; detail: string; ms: number }> = {};
  let allOk = true;

  // 1. Database round-trip (the real availability question).
  const t0 = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = { ok: true, detail: "SELECT 1 succeeded", ms: Date.now() - t0 };
  } catch (err) {
    allOk = false;
    checks.database = { ok: false, detail: err instanceof Error ? err.message : String(err), ms: Date.now() - t0 };
  }

  // 2. Storage root exists and is writable (uploads would fail otherwise).
  const t1 = Date.now();
  try {
    await ensureMediaRoot();
    const probe = path.join(MEDIA_ROOT, "tmp", `.health-${Date.now()}`);
    await fs.writeFile(probe, "ok");
    await fs.unlink(probe);
    checks.storage = { ok: true, detail: `writable at ${MEDIA_ROOT}`, ms: Date.now() - t1 };
  } catch (err) {
    allOk = false;
    checks.storage = { ok: false, detail: err instanceof Error ? err.message : String(err), ms: Date.now() - t1 };
  }

  // 3. Free disk space (the documented historical boot blocker on this platform).
  try {
    const stat = await fs.statfs(MEDIA_ROOT);
    const freeBytes = Number(stat.bavail) * Number(stat.bsize);
    checks.disk = { ok: freeBytes > 1_000_000_000, detail: `${(freeBytes / 1e9).toFixed(2)} GB free`, ms: 0 };
    if (freeBytes <= 1_000_000_000) allOk = false;
  } catch (err) {
    // statfs unavailable — report but don't fail health on it
    checks.disk = { ok: true, detail: `unavailable: ${err instanceof Error ? err.message : String(err)}`, ms: 0 };
  }

  return NextResponse.json(
    { status: allOk ? "ok" : "degraded", checks, uptimeSec: Math.round(process.uptime()) },
    { status: allOk ? 200 : 503 }
  );
}
