/**
 * M32 Track B — campaign variant API. Derivation from an APPROVED master
 * (immutable), per-variant framing overrides (re-derive into a fresh native
 * project), safe-area reports, batch render via the existing durable jobs.
 */
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { VARIANT_FORMATS, deriveVariant, syncVariantRenders, type VariantFormat } from "@/lib/production/variants";
import { enqueueMediaJob, JOB_TYPE_RENDER_TIMELINE } from "@/lib/job-helpers";
import { getTimelineHead } from "@/lib/editor/persistence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { id } = await ctx.params;
  const production = await db.production.findUnique({ where: { id } });
  if (!production || production.userId !== user.id) return NextResponse.json({ error: "Production not found." }, { status: 404 });
  await syncVariantRenders(id);
  const variants = await db.productionVariant.findMany({ where: { productionId: id }, orderBy: { createdAt: "asc" } });
  return NextResponse.json({
    master: { id: production.id, title: production.title, status: production.status, aspectRatio: production.briefJson ? (JSON.parse(production.briefJson) as { aspectRatio?: string }).aspectRatio ?? "16:9" : "16:9", immutable: true },
    formats: VARIANT_FORMATS,
    variants: variants.map((v) => ({
      id: v.id, format: v.format, status: v.status, resolution: v.resolution, fps: v.fps,
      durationSec: v.durationSec, projectId: v.projectId, framing: v.framingJson ? JSON.parse(v.framingJson) : null,
      safeArea: v.safeAreaJson ? JSON.parse(v.safeAreaJson) : null, renderJobId: v.renderJobId, exportId: v.exportId, error: v.error,
    })),
  });
}

/** Derive one or more formats (default: every format except the master's). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { id } = await ctx.params;
  const production = await db.production.findUnique({ where: { id } });
  if (!production || production.userId !== user.id) return NextResponse.json({ error: "Production not found." }, { status: 404 });
  const body = await req.json().catch(() => null);

  if (body?.action === "render") {
    // Batch render: every READY variant gets a REAL RENDER_TIMELINE job on the
    // existing durable queue. The master campaign is untouched.
    const formats: string[] = Array.isArray(body.formats) && body.formats.length > 0 ? body.formats : [];
    const variants = await db.productionVariant.findMany({ where: { productionId: id, status: { in: ["READY", "FAILED", "CANCELLED"] } } });
    const targets = formats.length ? variants.filter((v) => formats.includes(v.format)) : variants;
    if (targets.length === 0) return NextResponse.json({ error: "No READY variants to render — derive them first." }, { status: 400 });
    const results: Array<{ format: string; jobId?: string; error?: string }> = [];
    for (const v of targets) {
      if (!v.projectId) { results.push({ format: v.format, error: "variant has no project" }); continue; }
      try {
        const head = await getTimelineHead(v.projectId, user.id);
        const seq = head.sequence as unknown as { clips?: Array<{ timelineStartFrame: number; timelineDurationFrames: number }> };
        const clips = seq.clips ?? [];
        const endFrame = clips.reduce((m, c) => Math.max(m, c.timelineStartFrame + c.timelineDurationFrames), 0);
        if (endFrame <= 0) { results.push({ format: v.format, error: "empty timeline" }); continue; }
        const jobId = await enqueueMediaJob(user.id, JOB_TYPE_RENDER_TIMELINE, { projectId: v.projectId, startFrame: 0, endFrame });
        await db.productionVariant.update({ where: { id: v.id }, data: { status: "RENDERING", renderJobId: jobId, error: null } });
        results.push({ format: v.format, jobId });
      } catch (err) {
        results.push({ format: v.format, error: String(err).slice(0, 200) });
      }
    }
    return NextResponse.json({ ok: true, results }, { status: 202 });
  }

  const masterAspect = production.briefJson ? (JSON.parse(production.briefJson) as { aspectRatio?: string }).aspectRatio ?? "16:9" : "16:9";
  const requested: string[] = Array.isArray(body?.formats) && body.formats.length > 0 ? body.formats : VARIANT_FORMATS.filter((f) => f !== masterAspect);
  const manualFraming = (body?.manualFraming ?? {}) as Record<string, { focalPct: { x: number; y: number } }>;
  const results: Array<{ format: string; variantId?: string; projectId?: string; reframe?: unknown; safeAreaIssues?: unknown[]; error?: string }> = [];
  for (const f of requested) {
    if (!(VARIANT_FORMATS as readonly string[]).includes(f)) { results.push({ format: f, error: "unknown format" }); continue; }
    try {
      const r = await deriveVariant(id, user.id, f as VariantFormat, { manualFraming });
      results.push({ format: f, variantId: r.variantId, projectId: r.projectId, reframe: r.reframe, safeAreaIssues: r.safeAreaIssues });
    } catch (err) {
      results.push({ format: f, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return NextResponse.json({ ok: results.every((r) => !r.error), results }, { status: results.every((r) => !r.error) ? 201 : 207 });
}

/**
 * Framing override: stores the manual focal point and RE-DERIVES the variant
 * into a FRESH native project (canonical commands only; the previous project
 * is renamed as superseded history; the master is untouched).
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { id } = await ctx.params;
  const production = await db.production.findUnique({ where: { id } });
  if (!production || production.userId !== user.id) return NextResponse.json({ error: "Production not found." }, { status: 404 });
  const body = await req.json().catch(() => null);
  const variantId = typeof body?.variantId === "string" ? body.variantId : "";
  const variant = await db.productionVariant.findUnique({ where: { id: variantId } });
  if (!variant || variant.productionId !== id) return NextResponse.json({ error: "Variant not found." }, { status: 404 });
  const focal = body?.focalPct;
  if (!focal || typeof focal.x !== "number" || typeof focal.y !== "number" || focal.x < 0 || focal.x > 1 || focal.y < 0 || focal.y > 1) {
    return NextResponse.json({ error: "focalPct must be {x: 0..1, y: 0..1} (fractions of the master frame)." }, { status: 400 });
  }
  const prev = variant.framingJson ? JSON.parse(variant.framingJson) as { manual?: Record<string, { focalPct: { x: number; y: number } }> } : {};
  const manual = { ...(prev.manual ?? {}), [String(body.sceneKey ?? "default")]: { focalPct: focal } };
  try {
    const r = await deriveVariant(id, user.id, variant.format as VariantFormat, { manualFraming: manual, replace: true });
    return NextResponse.json({ ok: true, variantId: variant.id, projectId: r.projectId, reframe: r.reframe, safeAreaIssues: r.safeAreaIssues });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
  }
}
