/**
 * M19 §14 — admin service health: DB reachable, queue depth, storage root
 * writable. NOT a public endpoint (admin-only). The PUBLIC health surface is
 * GET /api/healthz (minimal, no internals).
 */
import { execSync } from "child_process";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin, AuthError } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireAdmin();
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
  const started = Date.now();
  await db.user.findFirst({ select: { id: true } });
  const dbMs = Date.now() - started;

  // M31 §9 — operational diagnostics (additive; admin-only; no path/secret
  // leaks: binaries are probed by existence, providers by CONFIGURED/ABSENT).
  const [failed, processing, queued, stale, lastJob, tmpBytes] = await Promise.all([
    db.job.count({ where: { status: "FAILED" } }),
    db.job.count({ where: { status: "PROCESSING" } }),
    db.job.count({ where: { status: "QUEUED" } }),
    db.job.count({ where: { status: "PROCESSING", lastHeartbeatAt: { lt: new Date(Date.now() - 10 * 60_000) } } }),
    db.job.findFirst({ where: { status: "COMPLETED" }, orderBy: { updatedAt: "desc" }, select: { updatedAt: true } }),
    db.$queryRawUnsafe<{ bytes: bigint | null }[]>(`SELECT COALESCE(SUM(sizeBytes),0) AS bytes FROM ExportFile`).then((r) => Number(r[0]?.bytes ?? 0)),
  ]);

  const probeBin = (cmd: string): { ok: boolean; version: string } => {
    try {
      const out = execSync(`${cmd} -version 2>&1 | head -1`, { encoding: "utf8", timeout: 5000 }).trim();
      return { ok: true, version: out.split(" ").slice(0, 3).join(" ") };
    } catch {
      return { ok: false, version: "absent" };
    }
  };
  const encoders = (() => {
    try {
      const out = execSync("ffmpeg -hide_banner -encoders 2>/dev/null", { encoding: "utf8", timeout: 5000 });
      return { libx264: /libx264/.test(out), libx265: /libx265/.test(out), aac: / libaac| aac /.test(out) };
    } catch {
      return { libx264: false, libx265: false, aac: false };
    }
  })();

  return NextResponse.json({
    db: { ok: true, latencyMs: dbMs },
    worker: {
      queueDepth: queued,
      processing,
      failed,
      staleLeases: stale,
      lastCompletedAt: lastJob?.updatedAt ?? null,
    },
    media: {
      ffmpeg: probeBin("ffmpeg"),
      ffprobe: probeBin("ffprobe"),
      encoders,
      storageBytes: tmpBytes,
    },
    integrations: {
      // Honest presence checks only — never values.
      aiProvider: { configured: Boolean(process.env.ZAI_API_KEY || process.env.Z_AI_API_KEY), provider: "z-ai-web-dev-sdk" },
      email: { configured: Boolean(process.env.SMTP_URL || process.env.SMTP_HOST), fallback: "copyable invite URL" },
    },
    time: new Date().toISOString(),
  });
}
