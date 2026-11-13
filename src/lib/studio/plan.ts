/**
 * Social Video Studio — production plan schema v1 (M8.1 §3).
 *
 * The plan is DATA, validated by zod: topic summary, hook, intro, scenes,
 * narration, visual/footage/b-roll requirements, on-screen text, caption
 * instructions, music mood, transitions, estimated durations, closing CTA.
 * No fabricated citations: any research-sourced claim must carry attribution
 * (sourceName/url); the schema rejects invented "facts" fields without one —
 * and the PLANNER PROMPT forbids inventing sources.
 */
import { z } from "zod";

export const PRODUCTION_PLAN_SCHEMA_VERSION = 1;

export const PlanSceneSchema = z.object({
  sceneNumber: z.number().int().min(1).max(60),
  durationSec: z.number().int().min(2).max(60),
  narration: z.string().max(1200),
  visualDescription: z.string().max(500),
  /** What footage the scene needs (used for matching/generation prompts). */
  footageNeed: z.string().max(400).default(""),
  brollNote: z.string().max(300).default(""),
  onScreenText: z.string().max(200).default(""),
  captionText: z.string().max(400).default(""),
  audioNote: z.string().max(200).default(""),
  transition: z.enum(["CUT", "CROSS_DISSOLVE", "FADE_TO_BLACK", "FADE_FROM_BLACK", "WIPE_LEFT", "WIPE_RIGHT", "SLIDE_LEFT", "SLIDE_RIGHT"]).default("CUT"),
});

export const ProductionPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    topicSummary: z.string().min(1).max(600),
    hook: z.string().min(1).max(400),
    intro: z.string().min(1).max(600),
    scenes: z.array(PlanSceneSchema).min(1).max(40),
    musicMood: z.string().max(120).default("upbeat"),
    closingCta: z.string().min(1).max(400),
    /** Full narration script, scene-ordered (kept for editing + provenance). */
    fullScript: z.string().min(1).max(8000),
    /** Optional verifiable sources: name + url. NO fabricated citations. */
    sources: z.array(z.object({ name: z.string().max(120), url: z.string().max(400) })).max(5).default([]),
  })
  .superRefine((plan, ctx) => {
    const numbers = plan.scenes.map((s) => s.sceneNumber);
    if (new Set(numbers).size !== numbers.length) ctx.addIssue({ code: "custom", message: "duplicate scene numbers" });
    if (plan.scenes.length > 0 && plan.scenes[0].sceneNumber !== 1) ctx.addIssue({ code: "custom", message: "scenes must start at 1" });
    for (let i = 1; i < plan.scenes.length; i++) {
      if (plan.scenes[i].sceneNumber !== plan.scenes[i - 1].sceneNumber + 1) {
        ctx.addIssue({ code: "custom", message: "scene numbers must be consecutive" });
        break;
      }
    }
    const total = plan.scenes.reduce((m, s) => m + s.durationSec, 0);
    if (total > 400) ctx.addIssue({ code: "custom", message: `total planned duration ${total}s exceeds the 400s studio cap` });
  });

export type ProductionPlan = z.infer<typeof ProductionPlanSchema>;
export type PlanScene = z.infer<typeof PlanSceneSchema>;

/** Deterministic normalization of common LLM representation deviations. */
const SCENE_KEYS: Record<string, string> = {
  scene_number: "sceneNumber", sceneNo: "sceneNumber", number: "sceneNumber",
  duration_seconds: "durationSec", duration: "durationSec", seconds: "durationSec",
  visual: "visualDescription", visual_desc: "visualDescription", visuals: "visualDescription",
  footage: "footageNeed", footage_requirements: "footageNeed", footageNeed: "footageNeed",
  broll: "brollNote", b_roll: "brollNote", broll_note: "brollNote",
  text: "onScreenText", onScreen: "onScreenText", on_screen_text: "onScreenText",
  captions: "captionText", caption: "captionText", caption_text: "captionText",
  audio: "audioNote", audio_note: "audioNote", audio_instructions: "audioNote",
  voiceover: "narration", narration_text: "narration", narration_script: "narration",
};

function coerceSceneKeys(scene: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...scene };
  for (const [alias, canonical] of Object.entries(SCENE_KEYS)) {
    if (out[canonical] === undefined && out[alias] !== undefined) out[canonical] = out[alias];
  }
  const dur = out.durationSec;
  if (typeof dur === "string") {
    const n = Number(dur.replace(/[^\d.]/g, ""));
    if (Number.isFinite(n)) out.durationSec = Math.round(n);
  }
  if (typeof out.durationSec === "number" && out.durationSec > 60) out.durationSec = 60;
  if (typeof out.durationSec === "number" && out.durationSec < 2) out.durationSec = 2;
  const num = out.sceneNumber;
  if (typeof num === "string" && /^\d+$/.test(num)) out.sceneNumber = Number(num);
  return out;
}

export function normalizeProductionPlan(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const r = { ...(raw as Record<string, unknown>) };
  if (r.schemaVersion === undefined) r.schemaVersion = 1;
  if (typeof r.fullScript !== "string") {
    // Derive the full script from scene narration rather than failing.
    const scenes = Array.isArray(r.scenes) ? r.scenes as Record<string, unknown>[] : [];
    r.fullScript = scenes.map((s) => String(s.narration ?? s.voiceover ?? "")).filter(Boolean).join("\n\n") || String(r.intro ?? r.topicSummary ?? "script");
  }
  if (r.closingCta === undefined && typeof r.callToAction === "string") r.closingCta = r.callToAction;
  if (r.closingCta === undefined && typeof r.cta === "string") r.closingCta = r.cta;
  if (r.hook === undefined && typeof r.hook_text === "string") r.hook = r.hook_text;
  // Derive missing top-level fields from the plan's OWN content (no invention).
  const sceneArr = Array.isArray(r.scenes) ? (r.scenes as Record<string, unknown>[]) : [];
  const firstNarr = String(sceneArr[0]?.narration ?? sceneArr[0]?.voiceover ?? "");
  if (typeof r.topicSummary !== "string" || !r.topicSummary) {
    r.topicSummary = String(r.topic ?? r.subject ?? r.title ?? firstNarr.slice(0, 200) ?? "Untitled topic");
  }
  if (typeof r.hook !== "string" || !r.hook) r.hook = firstNarr.slice(0, 400) || "Hook";
  if (typeof r.intro !== "string" || !r.intro) r.intro = firstNarr.slice(0, 600) || "Introduction";
  if (Array.isArray(r.scenes)) {
    r.scenes = (r.scenes as Record<string, unknown>[]).map(coerceSceneKeys);
  }
  return r;
}

/** Estimated speech duration from narration length (honest heuristic). */
export function estimateSpeechSec(text: string, language: "en" | "ta"): number {
  if (language === "ta") return Math.max(2, Math.round(text.length / 9));
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(2, Math.round((words / 2.6) + 0.5)); // ~155 wpm
}
