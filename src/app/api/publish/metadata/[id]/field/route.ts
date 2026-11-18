/**
 * M9 API — regenerate ONE metadata field (§4).
 * POST /api/publish/metadata/[id]/field {field}
 * Targeted LLM call for a single field; validated, stored in the DRAFT with
 * field provenance + bounded history. Approved fields are never overwritten.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { badRequest, notFound, unauthorized } from "@/lib/process-helpers";
import { PublishFieldsSchema, REGENERABLE_FIELDS, regeneratePublishField, type MetadataDraft, type RegenerableField } from "@/lib/publish/metadata";

export const runtime = "nodejs";

const Schema = z.object({ field: z.enum(REGENERABLE_FIELDS as unknown as [string, ...string[]]) });

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return unauthorized();
  const { id } = await ctx.params;
  const row = await db.publishMetadata.findUnique({ where: { id } });
  if (!row || row.userId !== user.id) return notFound();
  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(`Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const field = parsed.data.field as RegenerableField;

  // Current fields = approved values if present (never regenerated away), else draft.
  const currentFields = PublishFieldsSchema.safeParse(
    row.approvedJson ? JSON.parse(row.approvedJson) : row.draftJson ? (JSON.parse(row.draftJson) as MetadataDraft).fields : null,
  );
  if (!currentFields.success) return badRequest("No valid current metadata to regenerate from — generate a draft first.");

  try {
    const result = await regeneratePublishField(user.id, row.projectId, row.platform, row.language as "en" | "ta", field, currentFields.data);
    const base = row.draftJson ? (JSON.parse(row.draftJson) as MetadataDraft) : { fields: currentFields.data, provenance: { provider: "configured-gateway", model: result.model, generatedAt: new Date().toISOString(), fields: {} }, chaptersSource: "none" as const };
    const updatedFields = { ...base.fields, [field]: result.value };
    const history = [...(row.fieldHistoryJson ? (JSON.parse(row.fieldHistoryJson) as unknown[]) : []).slice(-19), { at: new Date().toISOString(), kind: `field:${field}`, model: result.model }];
    const draft: MetadataDraft = {
      ...base,
      fields: updatedFields,
      provenance: { ...base.provenance, fields: { ...base.provenance.fields, [field]: result.model } },
    };
    const updated = await db.publishMetadata.update({
      where: { id },
      data: { draftJson: JSON.stringify(draft), status: row.status === "APPROVED" ? "APPROVED" : "GENERATED", fieldHistoryJson: JSON.stringify(history), model: result.model },
    });
    return NextResponse.json({ ok: true, status: updated.status, field, value: result.value });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Field regeneration failed.", unavailable: true }, { status: 503 });
  }
}
