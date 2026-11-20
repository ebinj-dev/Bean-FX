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

  return NextResponse.json({ error: "action must be attach|decide|plan-generation." }, { status: 400 });
}
