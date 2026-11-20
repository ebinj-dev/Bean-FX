/**
 * M31 — Production Studio API: create from a natural-language brief, list
 * productions. Stage execution is server-enforced (runner.ts); no client-side
 * state decisions are trusted.
 */
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { PIPELINE_TEMPLATES, getTemplate, ProductionBriefSchema } from "@/lib/production/engine";
import { extractBriefFields, logEvent, providerStatus } from "@/lib/production/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const productions = await db.production.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
    take: 50,
    select: { id: true, title: true, templateId: true, status: true, qaState: true, projectId: true, updatedAt: true },
  });
  return NextResponse.json({
    productions,
    templates: PIPELINE_TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description, active: t.active, unavailableReason: t.unavailableReason ?? null, deliveryFormats: t.deliveryFormats, version: t.version })),
    provider: providerStatus(),
  });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "A JSON body is required." }, { status: 400 });
  const templateId = typeof body.templateId === "string" ? body.templateId : "";
  const template = getTemplate(templateId);
  if (!template) return NextResponse.json({ error: "Unknown templateId." }, { status: 400 });
  const briefText = typeof body.briefText === "string" ? body.briefText.slice(0, 4000) : "";
  if (!briefText.trim()) return NextResponse.json({ error: "Describe the video you want in briefText (natural language)." }, { status: 400 });
  const projectId = typeof body.projectId === "string" && body.projectId ? body.projectId : null;
  if (projectId) {
    const project = await db.project.findUnique({ where: { id: projectId } });
    if (!project || project.userId !== user.id) return NextResponse.json({ error: "Project not found or not owned by the caller." }, { status: 404 });
  }
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 120) : (extractBriefFields(briefText, "Untitled production").title ?? "Untitled production");
  const fields = extractBriefFields(briefText, title);
  const brief = ProductionBriefSchema.parse({
    title,
    briefText,
    subject: typeof body.subject === "string" ? body.subject : briefText.slice(0, 300),
    targetDurationSec: typeof body.targetDurationSec === "number" ? body.targetDurationSec : fields.targetDurationSec ?? 30,
    aspectRatio: typeof body.aspectRatio === "string" ? body.aspectRatio : fields.aspectRatio ?? "16:9",
    sourceMediaIds: Array.isArray(body.sourceMediaIds) ? body.sourceMediaIds.filter((x: unknown) => typeof x === "string").slice(0, 100) : [],
    deliveryFormats: Array.isArray(body.deliveryFormats) && body.deliveryFormats.length > 0 ? body.deliveryFormats : template.deliveryFormats,
    ...(typeof body.tone === "string" ? { tone: body.tone } : {}),
    ...(typeof body.visualDirection === "string" ? { visualDirection: body.visualDirection } : {}),
    // ── SHOWCASE STUDIO fields (validated by the schema; absent = defaults) ──
    ...(typeof body.campaignType === "string" ? { campaignType: body.campaignType } : {}),
    ...(typeof body.tonePreset === "string" ? { tonePreset: body.tonePreset } : {}),
    ...(typeof body.narrationPreference === "string" ? { narrationPreference: body.narrationPreference } : {}),
    ...(typeof body.musicPreference === "string" ? { musicPreference: body.musicPreference } : {}),
    ...(typeof body.showcaseInputs === "object" && body.showcaseInputs !== null ? { showcaseInputs: body.showcaseInputs } : {}),
    ...(Array.isArray(body.shareCopyPlatforms) ? { shareCopyPlatforms: body.shareCopyPlatforms.filter((x: unknown) => typeof x === "string").slice(0, 6) } : {}),
    ...(typeof body.posterEnabled === "boolean" ? { posterEnabled: body.posterEnabled } : {}),
  });
  const production = await db.production.create({
    data: {
      userId: user.id,
      projectId,
      templateId,
      title,
      briefJson: JSON.stringify(brief),
      status: "PLANNED",
      stages: { create: template.stages.map((s, i) => ({ key: s.key, order: i, state: i === 0 ? "READY" : "NOT_STARTED" })) },
    },
    include: { stages: true },
  });
  await logEvent(production.id, "production.created", "INTAKE", { templateId, active: template.active, provider: providerStatus().configured ? "configured" : "absent (deterministic drafting)" });
  return NextResponse.json({ production, brief, template: { id: template.id, active: template.active, unavailableReason: template.unavailableReason ?? null } }, { status: 201 });
}
