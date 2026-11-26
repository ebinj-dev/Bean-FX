/**
 * M31 — production assets: attach user media (rights = USER_CONFIRMED),
 * approve/reject planned assets. Provider GENERATION assets cannot be created
 * without a configured provider AND an approved budget — the gate lives here
 * and in the engine cost module.
 */
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { logEvent, recordDecision, providerStatus } from "@/lib/production/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const { id } = await ctx.params;
  const production = await db.production.findUnique({ where: { id } });
  if (!production || production.userId !== user.id) return NextResponse.json({ error: "Production not found." }, { status: 404 });
  const body = await req.json().catch(() => null);
  const action = typeof body?.action === "string" ? body.action : "";

  if (action === "attach") {
    const assetId = typeof body.assetRowId === "string" ? body.assetRowId : "";
    const mediaAssetId = typeof body.mediaAssetId === "string" ? body.mediaAssetId : "";
    const row = await db.productionAsset.findUnique({ where: { id: assetId } });
    if (!row || row.productionId !== id) return NextResponse.json({ error: "Asset row not found." }, { status: 404 });
    const media = await db.mediaAsset.findUnique({ where: { id: mediaAssetId } });
    if (!media || media.userId !== user.id) return NextResponse.json({ error: "Media asset not found or not owned by the caller." }, { status: 404 });
    // M46H §1 — an asset from ANOTHER project must never silently become this
    // production's material: reject on project mismatch (unbound assets that
    // the user owns are still attachable — the explicit attach IS the binding).
    if (media.projectId && production.projectId && media.projectId !== production.projectId) {
      return NextResponse.json({ error: "That media belongs to a different project — attach it inside its own project." }, { status: 409 });
    }
    await db.productionAsset.update({ where: { id: row.id }, data: { mediaAssetId, status: "READY", licenseState: "USER_CONFIRMED", costUnknown: false, costCents: 0, provenanceJson: JSON.stringify({ attachedAt: new Date().toISOString(), source: "user-media", originalName: media.originalName }) } });
    await logEvent(id, "asset.attached", undefined, { assetRowId: row.id, mediaAssetId });
    return NextResponse.json({ ok: true });
  }

  if (action === "decide") {
    const assetId = typeof body.assetRowId === "string" ? body.assetRowId : "";
    const decision = typeof body.decision === "string" ? body.decision : "";
    const row = await db.productionAsset.findUnique({ where: { id: assetId } });
    if (!row || row.productionId !== id) return NextResponse.json({ error: "Asset row not found." }, { status: 404 });
    if (!["APPROVED", "REJECTED"].includes(decision)) return NextResponse.json({ error: "decision must be APPROVED|REJECTED." }, { status: 400 });
    if (row.licenseState === "RESTRICTED" && decision === "APPROVED") {
      return NextResponse.json({ error: "This asset is flagged RESTRICTED — it cannot be approved for delivery. Replace it or record verified rights." }, { status: 409 });
    }
    await db.productionAsset.update({ where: { id: row.id }, data: { status: decision } });
    await recordDecision(id, `asset.${decision.toLowerCase()}`, { assetRowId: row.id, category: row.category, sceneKey: row.sceneKey });
    await logEvent(id, "asset.decided", undefined, { assetRowId: row.id, decision });
    return NextResponse.json({ ok: true });
  }

  if (action === "plan-generation") {
    // Explicit request for provider-generated assets: gated + honest.
    const provider = providerStatus();
    if (!provider.configured) return NextResponse.json({ error: provider.reason, code: "CONFIGURATION_REQUIRED" }, { status: 409 });
    if (production.approvedBudgetCents === null) return NextResponse.json({ error: "No approved budget set — set a budget before requesting paid generation.", code: "BUDGET_REQUIRED" }, { status: 409 });
    const category = ["image", "video", "narration", "music"].includes(body.category) ? body.category : null;
    if (!category) return NextResponse.json({ error: "category must be image|video|narration|music." }, { status: 400 });
    const row = await db.productionAsset.create({
      data: {
        productionId: id, sceneKey: typeof body.sceneKey === "string" ? body.sceneKey : null,
        category, description: String(body.description ?? "").slice(0, 500),
        sourceType: "GENERATION", provider: "z-ai-web-dev-sdk", licenseState: "VERIFIED",
        status: "PENDING", costUnknown: true,
        provenanceJson: JSON.stringify({ requestedAt: new Date().toISOString(), approval: "budget-set; per-call approval recorded in decisions" }),
      },
    });
    await recordDecision(id, "generation.requested", { assetRowId: row.id, category, costUnknown: true });
    await logEvent(id, "asset.generation_planned", undefined, { assetRowId: row.id, category });
    return NextResponse.json({ ok: true, asset: { id: row.id } }, { status: 201 });
  }

  if (action === "route-generation") {
    // SHOWCASE Phase 5: route a GENERATION asset to the REAL configured
    // provider via the 10-step protocol (probe → capabilities → cost UNKNOWN →
    // explicit approval → real job → validated output).
    const { ShowcaseGenerationRequestSchema, routeGeneration, providerAvailability } = await import("@/lib/production/showcase/generation-router");
    const parsed = ShowcaseGenerationRequestSchema.safeParse({
      assetId: body.assetRowId,
      kind: body.kind,
      prompt: body.prompt,
      referenceMediaId: body.referenceMediaId ?? null,
      size: body.size ?? "1920x1080",
      durationSec: body.durationSec ?? "5",
      quality: body.quality ?? "speed",
      approved: body.approved === true,
    });
    if (!parsed.success) return NextResponse.json({ error: `Invalid generation request: ${parsed.error.issues.map((i) => i.message).join("; ")}` }, { status: 400 });
    const row = await db.productionAsset.findUnique({ where: { id: parsed.data.assetId } });
    if (!row || row.productionId !== id) return NextResponse.json({ error: "Asset row not found." }, { status: 404 });
    if (row.sourceType !== "GENERATION") return NextResponse.json({ error: "Only GENERATION assets route to providers." }, { status: 400 });
    // Capability preview when approval is absent (honest gate, no paid call).
    if (!parsed.data.approved) {
      const availability = await providerAvailability();
      return NextResponse.json({
        ok: true, previewOnly: true, availability,
        note: "This generation calls a metered provider with UNKNOWN cost. Re-POST with approved:true (and an approved budget) to submit the real job.",
      }, { status: 200 });
    }
    try {
      const routed = await routeGeneration(user.id, parsed.data);
      await recordDecision(id, "generation.approved", { assetRowId: routed.assetId, jobId: routed.jobId, provider: routed.provider, costUnknown: true, protocolPath: routed.path });
      return NextResponse.json({ ok: true, ...routed }, { status: 202 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: string }).code ?? "ROUTE_FAILED";
      return NextResponse.json({ error: message, code }, { status: (err as { status?: number }).status ?? 500 });
    }
  }

  if (action === "sync-generation") {
    const { syncGenerationAssets } = await import("@/lib/production/showcase/generation-router");
    const result = await syncGenerationAssets(id);
    return NextResponse.json({ ok: true, ...result });
  }

  if (action === "generate-narration") {
    // SHOWCASE Phase 7: optional narration via the verified TTS seam.
    const { generateShowcaseNarration } = await import("@/lib/production/showcase/narration");
    const sceneKey = typeof body.sceneKey === "string" ? body.sceneKey : "";
    if (!sceneKey) return NextResponse.json({ error: "sceneKey is required." }, { status: 400 });
    try {
      const result = await generateShowcaseNarration(user.id, id, sceneKey, typeof body.voice === "string" ? body.voice : "tongtong");
      return NextResponse.json({ ok: true, ...result });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
    }
  }

  return NextResponse.json({ error: "action must be attach|decide|plan-generation|route-generation|sync-generation|generate-narration." }, { status: 400 });
}
