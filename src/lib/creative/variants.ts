/**
 * M10 — A/B Studio (§6): creative alternatives preserved ALONGSIDE the
 * original. Text variants (hook / title / description / CTA / narration
 * section) come from MY AI with the provider seam; scene-sequence variants
 * carry validated M1 command batches; thumbnail comparison REUSES the M9
 * Thumbnail Studio candidates (LAXII) instead of duplicating generation.
 *
 * Honesty: comparing variants is a CREATIVE EVALUATION — no performance
 * claim is possible without a real audience experiment, and comparisons carry
 * no win/loss assertions. Applying a text variant writes it into M9 approved
 * metadata; applying a scene-sequence runs the approved command batch through
 * the SAME approval/execution path as recommendations (stale-safe,
 * versioned). The original project/timeline is never silently replaced.
 */
import { db } from "@/lib/db";
import { chatValidated } from "@/lib/my-ai/gateway/structured";
import { llmProvider, type LLMProvider } from "@/lib/my-ai/gateway/provider";
import { z } from "zod";
import { parseCommand } from "@/lib/editor/commands";
import { VariantSchema, type Variant, type VariantPayload } from "./contracts";
import type { MeasuredContext } from "./context";
import { PermanentJobError } from "@/lib/job-helpers";

const GenerationSchema = z.object({
  variants: z.array(VariantSchema).min(1).max(5),
});

const GENERATION_SYSTEM = [
  "You generate CREATIVE ALTERNATIVES for parts of an existing video (A/B evaluation for the creator to judge — you cannot predict performance).",
  "HARD RULES:",
  "- Ground every variant in the provided measured context; never invent facts, sources or claims.",
  "- Preserve the creator's language (en/ta) and terminology.",
  "- Each variant: kind, label (short), description (what differs), changedElements[], payload {kind:\"text\", text}, provenance {basis:\"ai-alternative\"}.",
  "- For hook: 2-3 alternatives for the FIRST spoken/visual beat (short, punchy).",
  "- For title/description/cta: platform-appropriate copy alternatives.",
  "- For narration-section: rewrite the requested section, same meaning, tighter delivery.",
  "Respond with ONLY JSON: {\"variants\":[…]}",
].join(" ");

/** Generate text variants for one kind (typed, schema-validated). */
export async function generateTextVariants(
  userId: string,
  ctx: MeasuredContext,
  kind: "hook" | "title" | "description" | "cta" | "narration-section",
  language: "en" | "ta",
  opts: { provider?: LLMProvider; instruction?: string } = {},
): Promise<{ variants: Variant[]; model: string }> {
  const provider = opts.provider ?? llmProvider();
  const transcriptExcerpt = ctx.transcript?.available ? ctx.transcript.text.slice(0, 1200) : "(no transcript available — base alternatives on the project name and scene texts only; say so in each description)";
  const result = await chatValidated<{ variants: Variant[] }>(userId, GenerationSchema, [
    { role: "system", content: GENERATION_SYSTEM.replace("en/ta", language === "ta" ? "Tamil (ta)" : "English (en)") },
    {
      role: "user",
      content: `Project: ${ctx.projectName}\nVariant kind: ${kind}\nCreator instruction: ${opts.instruction?.slice(0, 400) ?? "(none)"}\nLanguage: ${language}\nScenes: ${ctx.scenes ? ctx.scenes.slice(0, 8).map((s) => `#${s.number} ${s.onScreenText || s.narration.slice(0, 60)}`).join(" | ") : "(none)"}\nApproved titles/CTAs: ${JSON.stringify(ctx.publishing)}\nTranscript excerpt: ${transcriptExcerpt}\n\nReturn 2-3 ${kind} variants.`,
    },
  ], { provider, temperature: 0.7, maxTokens: 1600, purpose: `creative-variants-${kind}` });
  const variants = result.data.variants.map((v) => ({
    ...v,
    kind,
    payload: (v.payload.kind === "text" ? v.payload : { kind: "text", text: String((v.payload as { text?: string }).text ?? "") }) as VariantPayload,
    provenance: { ...(v.provenance ?? {}), basis: "ai-alternative", model: result.model, generatedAt: new Date().toISOString() },
  }));
  return { variants, model: result.model };
}

/** Persist variants (validated) — original project untouched. */
export async function persistVariants(userId: string, projectId: string, reviewId: string | null, variants: Variant[]): Promise<string[]> {
  const ids: string[] = [];
  for (const v of variants) {
    const parsed = VariantSchema.safeParse(v);
    if (!parsed.success) continue;
    const row = await db.creativeVariant.create({
      data: {
        userId,
        projectId,
        reviewId,
        kind: parsed.data.kind,
        label: parsed.data.label.slice(0, 120),
        description: parsed.data.description.slice(0, 800),
        changedElementsJson: JSON.stringify(parsed.data.changedElements),
        payloadJson: JSON.stringify(parsed.data.payload),
        provenanceJson: JSON.stringify(parsed.data.provenance),
        status: "PROPOSED",
      },
    });
    ids.push(row.id);
  }
  return ids;
}

/** Register M9 thumbnail candidates as comparable thumbnail variants (reuse, no duplication). */
export async function registerThumbnailVariants(userId: string, projectId: string, platform: string): Promise<string[]> {
  const drafts = await db.thumbnailDraft.findMany({ where: { userId, projectId, platform }, take: 1 });
  if (!drafts.length) return [];
  const draft = drafts[0];
  const candidates = draft.candidateIdsJson ? (JSON.parse(draft.candidateIdsJson) as string[]) : [];
  const ids: string[] = [];
  for (const [i, assetId] of candidates.entries()) {
    const existing = await db.creativeVariant.findFirst({ where: { userId, projectId, kind: "thumbnail", payloadJson: { contains: assetId } } });
    if (existing) {
      ids.push(existing.id);
      continue;
    }
    const row = await db.creativeVariant.create({
      data: {
        userId,
        projectId,
        kind: "thumbnail",
        label: `Thumbnail alternative ${i + 1} (${platform})`,
        description: `LAXII-generated thumbnail base image from the M9 Thumbnail Studio draft for ${platform}.`,
        changedElementsJson: JSON.stringify(["thumbnail"]),
        payloadJson: JSON.stringify({ kind: "thumbnail", assetId }),
        provenanceJson: JSON.stringify({ basis: "laxii-candidate", source: "M9 Thumbnail Studio", draftId: draft.id }),
        status: "PROPOSED",
      },
    });
    ids.push(row.id);
  }
  return ids;
}

/** Side-by-side comparison rows (no performance claims — creative evaluation). */
export function compareVariants(variants: { id: string; kind: string; label: string; description: string; payloadJson: string; status: string }[]): Record<string, unknown>[] {
  return variants.map((v) => {
    let text: string | null = null;
    let assetId: string | null = null;
    try {
      const payload = JSON.parse(v.payloadJson) as VariantPayload;
      if (payload.kind === "text") text = payload.text;
      if (payload.kind === "thumbnail") assetId = payload.assetId;
    } catch {
      /* unparseable payload — surfaced as null */
    }
    return {
      id: v.id,
      kind: v.kind,
      label: v.label,
      description: v.description,
      text,
      assetId,
      status: v.status,
      evaluationNote: "Creative evaluation only — no audience experiment exists, so no performance prediction is offered.",
    };
  });
}

/** Apply a SELECTED variant. Text kinds write M9 approved metadata; thumbnail
 *  kinds select the asset on the M9 draft; scene-sequence requires the
 *  recommendation approval flow (the API converts it to a recommendation). */
export async function applyVariant(userId: string, variantId: string, decisionNote: string | null): Promise<{ applied: string; detail: string }> {
  const v = await db.creativeVariant.findUnique({ where: { id: variantId } });
  if (!v || v.userId !== userId) throw new PermanentJobError("Variant not found or not owned by the caller.");
  if (v.status === "DISCARDED") throw new PermanentJobError("Variant was discarded.");
  const payload = JSON.parse(v.payloadJson) as VariantPayload;

  if (payload.kind === "text") {
    const kindToField: Record<string, "title" | "description" | "callToAction"> = { title: "title", description: "description", cta: "callToAction" };
    const field = kindToField[v.kind];
    if (!field) throw new PermanentJobError(`Text variant kind "${v.kind}" is not directly applicable (hook/narration variants belong to the timeline review flow).`);
    // Write into M9 approved metadata for every platform row of this project (or create one for youtube_landscape).
    let rows = await db.publishMetadata.findMany({ where: { userId, projectId: v.projectId } });
    if (!rows.length) {
      const created = await db.publishMetadata.create({ data: { userId, projectId: v.projectId, platform: "youtube_landscape", language: "en", status: "DRAFT" } });
      rows = [created];
    }
    for (const row of rows) {
      const current = row.approvedJson ? (JSON.parse(row.approvedJson) as Record<string, unknown>) : {};
      current[field] = payload.text;
      await db.publishMetadata.update({ where: { id: row.id }, data: { approvedJson: JSON.stringify(current), status: "APPROVED" } });
    }
    await db.creativeVariant.update({ where: { id: v.id }, data: { status: "APPLIED", decisionNote: decisionNote?.slice(0, 300) ?? null, appliedAt: new Date() } });
    await db.automationAudit.create({ data: { userId, projectId: v.projectId, action: "CREATIVE_VARIANT_APPLIED", detailJson: JSON.stringify({ variantId: v.id, kind: v.kind, field }) } }).catch(() => undefined);
    return { applied: v.kind, detail: `Applied to M9 approved metadata field "${field}" (user-approved content, validated).` };
  }

  if (payload.kind === "thumbnail") {
    const asset = await db.mediaAsset.findFirst({ where: { id: payload.assetId, userId, kind: "IMAGE" } });
    if (!asset) throw new PermanentJobError("Thumbnail asset not found or not owned.");
    // The candidate came from a draft — select it there (platform from provenance).
    const provenance = v.provenanceJson ? (JSON.parse(v.provenanceJson) as { draftId?: string }) : {};
    if (provenance.draftId) {
      const d = await db.thumbnailDraft.findUnique({ where: { id: provenance.draftId } });
      if (d && d.userId === userId) {
        await db.thumbnailDraft.update({ where: { id: d.id }, data: { selectedAssetId: payload.assetId } });
      }
    }
    await db.creativeVariant.update({ where: { id: v.id }, data: { status: "APPLIED", decisionNote: decisionNote?.slice(0, 300) ?? null, appliedAt: new Date() } });
    await db.automationAudit.create({ data: { userId, projectId: v.projectId, action: "CREATIVE_VARIANT_APPLIED", detailJson: JSON.stringify({ variantId: v.id, kind: "thumbnail", assetId: payload.assetId }) } }).catch(() => undefined);
    return { applied: "thumbnail", detail: "Selected on the M9 Thumbnail Studio draft (the composited overlay can be re-applied there)." };
  }

  throw new PermanentJobError("scene-sequence variants must be applied through the recommendation approval flow (timeline commands).");
}

/** Validate a scene-sequence variant payload (command batch) — used by the API to convert it into an executable recommendation. */
export function parseSceneSequencePayload(payloadJson: string): { commands: unknown[] } | null {
  try {
    const payload = JSON.parse(payloadJson) as VariantPayload;
    if (payload.kind !== "timeline-commands") return null;
    for (const c of payload.commands) parseCommand(c); // throws on invalid
    return { commands: payload.commands };
  } catch {
    return null;
  }
}
