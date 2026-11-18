/**
 * M14.4 — AI Motion Art Director.
 *
 * Generates THREE distinct creative directions from a structured brief
 * (inspired by bang-motion's style-brief gate and vox-director's style
 * showdown — re-implemented natively; no upstream code or assets). Honesty:
 * the creator must APPROVE a direction before any asset generation or
 * timeline mutation; provenance is explicit on every element (user-provided
 * material vs generated suggestions); provider failures surface honestly.
 * A deterministic anti-homogenization fingerprint distinguishes proposals.
 */
import { db } from "@/lib/db";
import { llmProvider, myAiModel, myAiProviderId, type LLMProvider } from "@/lib/my-ai/gateway/provider";
import { chatValidated } from "@/lib/my-ai/gateway/structured";
import { recordUsage } from "@/lib/my-ai/gateway/usage";
import { ArtDirectionSetSchema, DirectionBriefSchema, type ArtDirection, type DirectionBrief, type ScenePlanDoc } from "./contracts";

const LANGUAGE_RULE: Record<"en" | "ta", string> = {
  en: "Write all text in English.",
  ta: "Write all human-readable text (names, rationale, on-screen guidance) in Tamil; keep technical field names in English.",
};

function directionSystemPrompt(language: "en" | "ta"): string {
  return [
    "You are the BEAN FX AI Motion Art Director. You propose THREE distinct creative directions for a short motion-graphics video.",
    "Each direction must be a genuinely different visual world (e.g. cinematic editorial, vintage sketch, paper collage, flat vector, hand-drawn illustration, visual journalism, poster color-block, luxury dark, technical blueprint, storybook illustration) — never three variations of one idea.",
    "HARD RULES:",
    "- palette: 3-8 swatches; each swatch's `source` is 'user-brand' when derived from the brand references, else 'direction'.",
    "- typography/backgroundTreatment/illustrationApproach/compositionApproach/motionLanguage/sceneContinuity: concrete, implementable guidance (max 240 chars each).",
    "- motionIntensity drives the motion language: subtle = gentle drifts and fades; moderate = motivated entrances and camera pushes; dynamic = kinetic typography and bold camera moves.",
    "- constraints: name real limitations (e.g. multiple independent image generations DO NOT guarantee identical character identity).",
    "- assetRequirements: concrete list of what must be generated or supplied.",
    "- NEVER copy an existing film's look verbatim; these are original creative directions.",
    LANGUAGE_RULE[language],
    "Respond with ONLY JSON: {\"directions\":[ ...exactly 3 ArtDirection objects... ]} with keys name, rationale, styleProfile {palette[{hex,role,source}], medium, texture, lineTreatment, lighting, composition, shapeLanguage, consistencyRules[]}, typography, backgroundTreatment, illustrationApproach, compositionApproach, motionLanguage, sceneContinuity, assetRequirements[], transitions[], constraints[].",
  ].join("\n");
}

/** Deterministic anti-homogenization fingerprint over the direction content. */
export function directionFingerprint(d: ArtDirection): string {
  const material = [d.name, d.styleProfile.medium, d.styleProfile.composition, d.styleProfile.lighting, d.styleProfile.palette.map((p) => p.hex).join("")].join("|").toLowerCase();
  let h = 2166136261;
  for (let i = 0; i < material.length; i++) {
    h ^= material.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `f${(h >>> 0).toString(16)}`;
}

export async function generateDirections(userId: string, projectId: string, briefInput: unknown, opts: { provider?: LLMProvider; consentVisual?: boolean } = {}): Promise<{ batchId: string; directions: { id: string; direction: ArtDirection; status: string }[]; disclosure: string }> {
  const parsed = DirectionBriefSchema.safeParse(briefInput);
  if (!parsed.success) throw new Error(`Brief invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const brief = parsed.data;
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project || project.userId !== userId) throw new Error("Project not found or not owned by the caller.");

  const provider = opts.provider ?? llmProvider();
  let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null = null;
  let latencyMs: number | null = null;
  const result = await chatValidated(userId, ArtDirectionSetSchema, [
    { role: "system", content: directionSystemPrompt(brief.language) },
    {
      role: "user",
      content: [
        `Project context: ${brief.projectContext || "(none given)"}`,
        `Story/product: ${brief.storyOrProduct}`,
        `Audience: ${brief.audience || "(none given)"}`,
        `Format: ${brief.format} · motion intensity: ${brief.motionIntensity}`,
        `Brand references: ${brief.brandReferences || "(none given)"}`,
        `Requested style hint: ${brief.requestedStyle || "(free choice)"}`,
        brief.narration ? `Narration (excerpt, ≤1200 chars):\n${brief.narration.slice(0, 1200)}` : "Narration: (none provided yet)",
        "",
        "Produce exactly 3 distinct directions.",
      ].join("\n"),
    },
  ], { provider, temperature: 0.8, maxTokens: 2600, purpose: "m14-art-direction", onUsage: (u: { usage?: { promptTokens: number; completionTokens: number; totalTokens: number } | null; latencyMs?: number }) => { usage = u.usage ?? null; latencyMs = u.latencyMs ?? null; } });
  void recordUsage(userId, { provider: myAiProviderId(), model: result.model, usage, latencyMs: latencyMs ?? 0, content: "" }, "m14-art-direction").catch(() => undefined);

  const batchId = `m14dir${Date.now().toString(36)}`;
  const directions = result.data.directions.map((d) => ({ ...d, fingerprint: directionFingerprint(d) }));
  const rows: { id: string; payloadJson: string; status: string }[] = [];
  for (const d of directions) {
    rows.push(
      await db.artDirection.create({
        data: {
          userId,
          projectId,
          name: d.name.slice(0, 80),
          status: "PROPOSED",
          payloadJson: JSON.stringify(d),
          fingerprint: d.fingerprint ?? "f0",
          batchId,
          provider: myAiProviderId(),
          model: result.model,
          consentVisual: Boolean(opts.consentVisual),
        },
      }),
    );
  }
  return {
    batchId,
    directions: rows.map((r) => ({ id: r.id, direction: JSON.parse(r.payloadJson) as ArtDirection, status: r.status })),
    disclosure: `3 candidate directions generated by ${myAiProviderId()}/${myAiModel()} (text-only call). ${brief.brandReferences ? "Brand references were used as palette provenance where the model flagged them." : "No brand references provided — palette provenance is direction/system."} Nothing is applied to the timeline until you APPROVE one direction.`,
  };
}

export async function approveDirection(userId: string, projectId: string, directionId: string): Promise<ArtDirection> {
  const row = await db.artDirection.findUnique({ where: { id: directionId } });
  if (!row || row.userId !== userId || row.projectId !== projectId) throw new Error("Direction not found or not owned by the caller.");
  // Approved direction; siblings of the same batch stay PROPOSED for comparison.
  await db.artDirection.update({ where: { id: directionId }, data: { status: "APPROVED" } });
  return JSON.parse(row.payloadJson) as ArtDirection;
}

export async function getApprovedDirection(userId: string, projectId: string): Promise<{ id: string; direction: ArtDirection } | null> {
  const row = await db.artDirection.findFirst({ where: { userId, projectId, status: "APPROVED" }, orderBy: { updatedAt: "desc" } });
  return row ? { id: row.id, direction: JSON.parse(row.payloadJson) as ArtDirection } : null;
}

/** Style-profile prompt block shared by LAXII asset generation (§6). */
export function styleProfilePromptBlock(d: ArtDirection): string {
  const p = d.styleProfile;
  return [
    `Art direction "${d.name}" — ${d.rationale.slice(0, 160)}`,
    `Palette (use EXACTLY these colors): ${p.palette.map((s) => `${s.hex} (${s.role})`).join(", ")}`,
    `Medium: ${p.medium}; texture: ${p.texture}; line: ${p.lineTreatment}; lighting: ${p.lighting}`,
    `Composition: ${p.composition}; shape language: ${p.shapeLanguage}`,
    `Consistency rules: ${p.consistencyRules.join(" | ")}`,
  ].join("\n");
}
