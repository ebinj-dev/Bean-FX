/**
 * M9 — AI publishing metadata & SEO (§4), served by MY AI.
 *
 * Generates structured, EDITABLE publishing metadata (title, description,
 * keywords/tags, hashtags, chapters, summary, platform-specific description,
 * CTA) from REAL project context: the project's name/description, the latest
 * Social Video Studio production plan (script, scene narration, on-screen
 * text, scene durations) and any already-approved metadata. English and Tamil
 * are first-class; the user's original language is preserved and never
 * "translated away".
 *
 * Honesty rules (§4):
 *  - Chapters are emitted ONLY when reliable production timing exists (the
 *    approved scene durations of a Studio plan). Otherwise the chapters array
 *    is EMPTY and the row records `chaptersSource: "none"` — timestamps are
 *    never invented.
 *  - No facts, sources, links or statistics are fabricated: the prompt
 *    forbids them and the output schema has no place to put them.
 *  - AI suggestions (draftJson) and USER-APPROVED metadata (approvedJson) are
 *    stored separately — suggestions are never silently promoted.
 *  - When the configured LLM provider is unavailable the caller gets a typed
 *    NOT_CONFIGURED/PROVIDER_FAILURE error — no fake placeholder text.
 *  - Output is schema-validated BEFORE persistence (chatValidated: one
 *    informed repair attempt, then a hard failure).
 */
import { z } from "zod";
import { db } from "@/lib/db";
import { chatValidated } from "@/lib/my-ai/gateway/structured";
import { llmProvider, LLMError, type LLMProvider, myAiModel, myAiProviderId } from "@/lib/my-ai/gateway/provider";
import { PermanentJobError } from "@/lib/job-helpers";

export const MetadataLanguage = z.enum(["en", "ta"]);
export type MetadataLanguageId = z.infer<typeof MetadataLanguage>;

/** Tamil script block for hashtags (en hashtag = ASCII letters/digits/underscore). */
const HASHTAG_RE = /^#[A-Za-z0-9_\u0b80-\u0bff]+$/;

export const PublishFieldsSchema = z.object({
  title: z.string().min(1).max(150),
  description: z.string().min(1).max(5000),
  keywords: z.array(z.string().min(1).max(60)).max(30),
  hashtags: z.array(z.string().regex(HASHTAG_RE, "hashtags must be #word (letters, digits, underscore, Tamil)").max(64)).max(30),
  chapters: z.array(
    z.object({
      label: z.string().min(1).max(120),
      startSec: z.number().min(0).max(43200),
    }),
  ).max(50),
  summary: z.string().min(1).max(600),
  platformDescription: z.string().min(1).max(3000),
  callToAction: z.string().min(1).max(300),
});
export type PublishFields = z.infer<typeof PublishFieldsSchema>;

/** The per-field regeneration surface (one targeted LLM call per field). */
export const REGENERABLE_FIELDS = [
  "title",
  "description",
  "keywords",
  "hashtags",
  "chapters",
  "summary",
  "platformDescription",
  "callToAction",
] as const;
export type RegenerableField = (typeof REGENERABLE_FIELDS)[number];

export interface MetadataDraft {
  fields: PublishFields;
  provenance: { provider: string; model: string; generatedAt: string; fields: Partial<Record<RegenerableField, string>> };
  /** Where chapter timestamps came from — never fabricated. */
  chaptersSource: "studio-scene-timings" | "none";
}

interface ProjectContext {
  projectName: string;
  projectDescription: string | null;
  topic: string | null;
  fullScript: string | null;
  sceneCount: number | null;
  sceneSummaries: { number: number; durationSec: number; narration: string; onScreenText: string }[];
  chapters: { label: string; startSec: number }[];
}

/** Gather REAL project context (private media never leaves the server — text only). */
async function gatherContext(userId: string, projectId: string): Promise<ProjectContext> {
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project || project.userId !== userId) throw new PermanentJobError("Project not found or not owned by the caller.");

  const plan = await db.studioPlan.findFirst({
    where: { projectId, userId },
    orderBy: { updatedAt: "desc" },
    include: { scenes: { orderBy: { sceneNumber: "asc" } } },
  });

  const sceneSummaries = (plan?.scenes ?? []).map((s) => ({
    number: s.sceneNumber,
    durationSec: s.durationSec,
    narration: s.narration.slice(0, 400),
    onScreenText: s.onScreenText.slice(0, 120),
  }));

  // Chapter timing is derived ONLY from explicit scene durations (cumulative
  // starts). Scenes with no usable duration contribute nothing.
  const chapters: { label: string; startSec: number }[] = [];
  let elapsed = 0;
  for (const s of sceneSummaries) {
    if (s.durationSec > 0) {
      const label = (s.onScreenText || s.narration || `Scene ${s.number}`).trim().slice(0, 120) || `Scene ${s.number}`;
      chapters.push({ label, startSec: Math.round(elapsed) });
    }
    elapsed += Math.max(0, s.durationSec);
  }

  return {
    projectName: project.name,
    projectDescription: project.description,
    topic: plan?.briefJson ? (safeParseBrief(plan.briefJson)?.topic ?? null) : null,
    fullScript: plan?.planJson ? (safeParsePlan(plan.planJson)?.fullScript ?? null) : null,
    sceneCount: plan?.scenes.length ?? null,
    sceneSummaries,
    chapters: chapters.length > 0 ? chapters : [],
  };
}

function safeParseBrief(raw: string): { topic?: string } | null {
  try {
    const v = JSON.parse(raw) as { topic?: string };
    return typeof v === "object" && v !== null ? v : null;
  } catch {
    return null;
  }
}

function safeParsePlan(raw: string): { fullScript?: string } | null {
  try {
    const v = JSON.parse(raw) as { fullScript?: string };
    return typeof v === "object" && v !== null ? v : null;
  } catch {
    return null;
  }
}

function systemPrompt(language: MetadataLanguageId, hasChapterTiming: boolean): string {
  const langRule =
    language === "ta"
      ? "Write ALL human-facing text in TAMIL (Tamil script). Keep any technical terms the source material uses as-is."
      : "Write ALL human-facing text in ENGLISH.";
  return [
    "You are the BEAN FX publishing metadata assistant. You produce metadata for a video the creator ALREADY MADE.",
    langRule,
    "Preserve the creator's original wording, names and intent; do not translate away proper nouns.",
    "STRICT HONESTY RULES:",
    "- NEVER invent facts, statistics, sources, links, URLs, quotes, product claims or episode numbers that are not in the provided context.",
    hasChapterTiming
      ? "- You receive a chapter list WITH real timestamps measured from the production plan: use those exact timestamps and labels (you may lightly clean up the labels but NEVER change the times)."
      : "- NO reliable chapter timing exists in the context: you MUST return an EMPTY chapters array. Inventing timestamps is forbidden.",
    "- Keywords/hashtags come from the actual content; hashtags match ^#[A-Za-z0-9_\\u0b80-\\u0bff]+$.",
    "Respond with ONLY a JSON object matching the requested shape — no prose, no markdown fences.",
  ].join(" ");
}

function userPrompt(ctx: ProjectContext, platform: string, language: MetadataLanguageId): string {
  const parts = [
    `Project name: ${ctx.projectName}`,
    ctx.projectDescription ? `Project description: ${ctx.projectDescription}` : null,
    ctx.topic ? `Studio brief topic: ${ctx.topic}` : null,
    ctx.fullScript ? `Production script (may be long, use only what is real):\n${ctx.fullScript.slice(0, 4000)}` : null,
    ctx.sceneCount ? `Scenes (${ctx.sceneCount}):\n${ctx.sceneSummaries.map((s) => `#${s.number} [${s.durationSec}s] text="${s.onScreenText}" narration="${s.narration}"`).join("\n")}` : null,
    ctx.chapters.length
      ? `VERIFIED chapter timing (from scene durations; timestamps are measured, use as-is):\n${ctx.chapters.map((c) => `${c.startSec}s ${c.label}`).join("\n")}`
      : "Chapter timing: NONE available — chapters must be [].",
    `Target platform: ${platform}`,
    `Metadata language: ${language === "ta" ? "Tamil (ta)" : "English (en)"}`,
    "Return JSON with keys: title (string), description (string), keywords (string[]), hashtags (string[]), chapters ({label,startSec}[]), summary (string), platformDescription (string), callToAction (string).",
  ].filter(Boolean);
  return parts.join("\n\n");
}

const FIELD_KEYS = PublishFieldsSchema.keyof().options as readonly (keyof PublishFields)[];

function singleFieldSchema(field: keyof PublishFields): z.ZodType<{ value: unknown }> {
  const shape = PublishFieldsSchema.shape as Record<string, z.ZodTypeAny>;
  return z.object({ value: shape[field] }).strict() as z.ZodType<{ value: unknown }>;
}

async function recordUsage(
  userId: string,
  result: { model: string; usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null; latencyMs?: number } | null,
  ok: boolean,
): Promise<void> {
  if (!result) return;
  await db
    .aIUsage.create({
      data: {
        userId,
        provider: myAiProviderId(),
        model: result.model,
        purpose: "publish-metadata",
        promptTokens: result.usage?.promptTokens ?? 0,
        completionTokens: result.usage?.completionTokens ?? 0,
        totalTokens: result.usage?.totalTokens ?? 0,
        ok,
      },
    })
    .catch(() => undefined);
}

export interface GenerateOptions {
  /** Explicit provider (service seam). Omitted = the configured MY AI provider. */
  provider?: LLMProvider;
  /** Existing approved fields to steer regeneration (never overwritten silently). */
  seedApproved?: PublishFields | null;
}

/**
 * Generate a full metadata draft for one project+platform. Returns the
 * validated draft (caller persists). Throws LLMError on provider failure —
 * an honest failure, never placeholder content.
 */
export async function generatePublishFields(
  userId: string,
  projectId: string,
  platform: string,
  language: MetadataLanguageId,
  opts: GenerateOptions = {},
): Promise<{ fields: PublishFields; chaptersSource: MetadataDraft["chaptersSource"]; raw: string; model: string }> {
  const ctx = await gatherContext(userId, projectId);
  const hasTiming = ctx.chapters.length > 0;
  const provider = opts.provider ?? llmProvider();

  let result: Awaited<ReturnType<typeof chatValidated<PublishFields>>>;
  try {
    result = await chatValidated<PublishFields>(userId, PublishFieldsSchema, [
      { role: "system", content: systemPrompt(language, hasTiming) },
      { role: "user", content: userPrompt(ctx, platform, language) },
    ], {
      provider,
      temperature: 0.6,
      maxTokens: 2400,
      purpose: "publish-metadata",
      onUsage: (r) => void recordUsage(userId, { ...r, latencyMs: 0 }, true),
    });
  } catch (err) {
    if (err instanceof LLMError) await recordUsage(userId, { model: provider.model, usage: null }, false);
    throw err;
  }

  // Post-validation honesty guard: without verified timing there are NO
  // chapters, whatever the model claimed.
  let chaptersSource: MetadataDraft["chaptersSource"] = "none";
  if (hasTiming && result.data.chapters.length > 0) {
    result.data.chapters = ctx.chapters.map((c) => ({ ...c }));
    chaptersSource = "studio-scene-timings";
  } else {
    result.data.chapters = [];
  }

  if (opts.seedApproved) {
    // Approved content wins where it exists: a regeneration must never
    // silently replace user-approved fields.
    for (const key of FIELD_KEYS) {
      const approvedVal = opts.seedApproved[key];
      if (approvedVal !== undefined && approvedVal !== null) {
        Object.assign(result.data, { [key]: approvedVal });
      }
    }
  }

  return { fields: result.data, chaptersSource, raw: result.raw, model: result.model };
}

/** Regenerate ONE field with a targeted call (§4 "regeneration of individual fields"). */
export async function regeneratePublishField(
  userId: string,
  projectId: string,
  platform: string,
  language: MetadataLanguageId,
  field: RegenerableField,
  currentFields: PublishFields,
  opts: GenerateOptions = {},
): Promise<{ value: PublishFields[RegenerableField]; model: string; raw: string }> {
  if (!REGENERABLE_FIELDS.includes(field)) throw new PermanentJobError(`Field "${field}" is not regenerable.`);
  const ctx = await gatherContext(userId, projectId);
  const hasTiming = ctx.chapters.length > 0;
  const provider = opts.provider ?? llmProvider();

  const result = await chatValidated<{ value: unknown }>(userId, singleFieldSchema(field), [
    { role: "system", content: systemPrompt(language, hasTiming) },
    {
      role: "user",
      content: `${userPrompt(ctx, platform, language)}\n\nCurrent metadata (improve ONLY the "${field}" field, keep its language and intent; other fields stay as they are):\n${JSON.stringify({ [field]: currentFields[field] })}\n\nReturn JSON: {"value": <the regenerated ${field}>}. ${
        field === "chapters" ? (hasTiming ? "Use the VERIFIED timestamps above as-is." : "chapters MUST be [] — no timing exists.") : ""
      }`,
    },
  ], {
    provider,
    temperature: 0.6,
    maxTokens: 1200,
    purpose: "publish-metadata-field",
    onUsage: (r) => void recordUsage(userId, { ...r, latencyMs: 0 }, true),
  });

  const value = result.data.value as PublishFields[RegenerableField];
  if (field === "chapters" && !hasTiming) {
    // Guard: no timing → no chapters, regardless of the model's answer.
    return { value: [] as PublishFields["chapters"], model: result.model, raw: result.raw };
  }
  return { value, model: result.model, raw: result.raw };
}

export { myAiModel };
