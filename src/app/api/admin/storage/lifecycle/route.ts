/**
 * BEAN FX — M38: administrative storage-lifecycle surface (dry-run-first GC).
 *
 * POST runs the lifecycle manager: mode defaults to "dry-run" (read-only
 * report); "execute" performs the bounded, re-verified deletion and writes an
 * audit record. GET returns truthful storage usage by class.
 *
 * Authorization: requireAdmin (the repository's only admin convention) —
 * there is deliberately NO public or user-scoped cleanup endpoint. Reports
 * carry paths RELATIVE to the media root only; absolute filesystem paths are
 * never exposed.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin, AuthError } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { analyzeLifecycle, executeLifecycle, storageUsage, GC_CATEGORIES, type LifecycleCategory } from "@/lib/storage/lifecycle";

export const runtime = "nodejs";

const LifecycleSchema = z.object({
  mode: z.enum(["dry-run", "execute"]).default("dry-run"),
  categories: z.array(z.enum(GC_CATEGORIES as unknown as [LifecycleCategory, ...LifecycleCategory[]])).max(GC_CATEGORIES.length).optional(),
  minAgeHours: z.number().min(1).max(24 * 30).optional(),
  maxFiles: z.number().int().min(1).max(5000).optional(),
  maxBytes: z.number().int().min(1024).max(64 * 1024 * 1024 * 1024).optional(),
});

function authError(e: unknown): NextResponse | null {
  if (e instanceof AuthError) {
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
  return null;
}

export async function POST(req: NextRequest) {
  try {
    await requireAdmin();
  } catch (e) {
    const guarded = authError(e);
    if (guarded) return guarded;
    throw e;
  }
  const parsed = LifecycleSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: `Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}` }, { status: 400 });
  const { mode, categories, minAgeHours, maxFiles, maxBytes } = parsed.data;

  // Analysis is identical in both modes and mutates nothing.
  const analysis = await analyzeLifecycle({ categories, minAgeHours, maxFiles, maxBytes });
  if (mode === "dry-run") {
    return NextResponse.json({ mode: "dry-run", report: analysis });
  }

  // Explicit execution — bounded, re-verified per candidate, audited.
  const result = await executeLifecycle(analysis, { maxFiles, maxBytes });
  await audit("storage.lifecycle.execute", {
    detail: JSON.stringify({
      eligible: result.eligibleFiles,
      deleted: result.deletedFiles,
      failed: result.failedFiles,
      reclaimedBytes: result.reclaimedBytes,
      limits: result.limits,
      categories,
    }),
  });
  return NextResponse.json({ mode: "execute", report: result });
}

export async function GET() {
  try {
    await requireAdmin();
  } catch (e) {
    const guarded = authError(e);
    if (guarded) return guarded;
    throw e;
  }
  const usage = await storageUsage();
  return NextResponse.json({ usage });
}
