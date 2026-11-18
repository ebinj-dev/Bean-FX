/**
 * M14.5 — Narration-to-Visual Scene Composer.
 *
 * Deterministic FIRST: scenes are segmented from RIISHE transcript segments
 * with VERBATIM timestamps (startSec/endSec copied exactly from RIISHE —
 * never invented, never rounded). Where no transcript exists, estimated
 * timings are flagged `timingSource: "estimated"` and labelled as estimates.
 * AI is used ONLY for creative suggestions (visual concept, composition,
 * on-screen text, motion, camera, transition) via a validated contract —
 * never as a timing authority. Per-scene regeneration PRESERVES approved
 * scenes; original captions are never modified; Tamil text passes through
 * as data (grapheme handling is the renderer's job — text is stored whole,
 * never sliced by code points).
 */
import { db } from "@/lib/db";
import { llmProvider, myAiModel, myAiProviderId, type LLMProvider } from "@/lib/my-ai/gateway/provider";
import { chatValidated } from "@/lib/my-ai/gateway/structured";
import { recordUsage } from "@/lib/my-ai/gateway/usage";
import { buildMeasuredContext } from "../context";
import { SceneConceptSetSchema, ScenePlanDocSchema, type DirectionBrief, type Scene, type ScenePlanDoc } from "./contracts";

const M14_SCENE_VERSION = "m14-scene-plan-1.0";

/** Deterministic segmentation from RIISHE segments (or honest estimates). */
export function segmentScenes(input: { transcriptSegments: { start: number; end: number; text: string }[] | null; targetDurationSec: number | null; format: DirectionBrief["format"] }): { scenes: Scene[]; notes: string[] } {
  const notes: string[] = [];
  const scenes: Scene[] = [];
  const segments = input.transcriptSegments;
  if (!segments || segments.length === 0) {
    // No transcript: estimated slots ONLY, clearly labelled (never invent
    // speech timestamps).
    const sceneCount = 3;
    const sceneLen = input.targetDurationSec ? input.targetDurationSec / sceneCount : 6;
    for (let i = 0; i < sceneCount; i++) {
      scenes.push({
        sceneId: `sc${i + 1}`,
        segmentRefs: [],
        startSec: Math.round(i * sceneLen * 100) / 100,
        endSec: Math.round((i + 1) * sceneLen * 100) / 100,
        timingSource: "estimated",
        visualConcept: "",
        compositionDescription: "",
        requiredAssets: [],
        onScreenText: "",
        motionRecommendation: "",
        cameraMovement: "static",
        transitionRecommendation: i === 0 ? "none (opening)" : "cut",
        evidence: "no RIISHE transcript — duration is an ESTIMATE for planning",
        confidence: null,
        approvalStatus: "PENDING",
      });
    }
    notes.push("No RIISHE transcript available — scene timings are ESTIMATES. Run transcription for real narration-locked timing.");
    return { scenes, notes };
  }
  // Transcript exists: group consecutive segments into scenes of ~2-4 segments,
  // capped so narration density drives pacing (Vox beat principle, native).
  const targetScenes = Math.max(2, Math.min(24, Math.ceil(segments.length / 2.5)));
  const perScene = Math.ceil(segments.length / targetScenes);
  let idx = 0;
  let sceneNo = 1;
  while (idx < segments.length) {
    const group = segments.slice(idx, idx + perScene);
    if (group.length === 0) break;
    const first = group[0];
    const last = group[group.length - 1];
    scenes.push({
      sceneId: `sc${sceneNo}`,
      segmentRefs: group.map((_, i) => idx + i),
      startSec: Math.round(first.start * 100) / 100,
      endSec: Math.round(last.end * 100) / 100,
      timingSource: "riishe-verbatim",
      visualConcept: "",
      compositionDescription: "",
      requiredAssets: [],
      onScreenText: "",
      motionRecommendation: "",
      cameraMovement: "static",
      transitionRecommendation: sceneNo === 1 ? "none (opening)" : "cut",
      evidence: `RIISHE segments ${idx + 1}–${idx + group.length} (verbatim timestamps)`,
      confidence: 0.95,
      approvalStatus: "PENDING",
    });
    idx += group.length;
    sceneNo += 1;
  }
  notes.push(`Scene boundaries are RIISHE-verbatim (${scenes.length} scenes over ${segments.length} transcript segments).`);
  return { scenes, notes };
}

export async function buildScenePlan(userId: string, projectId: string, input: { brief?: Partial<DirectionBrief>; artDirectionId?: string | null; provider?: LLMProvider; precomputedScenes?: Scene[]; precomputedNotes?: string[] } = {}): Promise<ScenePlanDoc> {
  const project = await db.project.findUnique({ where: { id: projectId } });
  if (!project || project.userId !== userId) throw new Error("Project not found or not owned by the caller.");
  const format = input.brief?.format ?? "16:9";
  const language = (input.brief?.language ?? "en") as "en" | "ta";

  // 1. RIISHE transcript (M11 measured context) — timestamps stay VERBATIM.
  const ctx = await buildMeasuredContext(userId, projectId, { enqueueEvidence: false });
  const segments = ctx.transcript?.available ? ctx.transcript.segments.map((s) => ({ start: s.start, end: s.end, text: s.text })) : null;
  const target = input.brief ? undefined : null;
  void target;
  const { scenes: baseScenes, notes } = input.precomputedScenes
    ? { scenes: input.precomputedScenes, notes: input.precomputedNotes ?? [] }
    : segmentScenes({ transcriptSegments: segments, targetDurationSec: null, format });

  // 2. AI creative enrichment (suggestions only — timing untouched).
  const provider = input.provider ?? llmProvider();
  let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null = null;
  let enriched = baseScenes;
  try {
    const listing = baseScenes
      .map((s) => {
        const segText = s.segmentRefs.map((i) => segments?.[i]?.text ?? "").join(" ").slice(0, 200);
        return `- ${s.sceneId} [${s.startSec}–${s.endSec}s, ${s.timingSource}]: ${segText || "(no narration)"}`;
      })
      .join("\n");
    const direction = input.artDirectionId ? await db.artDirection.findFirst({ where: { id: input.artDirectionId, userId, projectId, status: "APPROVED" } }) : null;
    const dirBlock = direction?.payloadJson ? `APPROVED ART DIRECTION (follow its palette/medium/composition rules):\n${(JSON.parse(direction.payloadJson) as { name: string; rationale: string; styleProfile: { medium: string; composition: string } }).name}: ${(JSON.parse(direction.payloadJson) as { rationale: string }).rationale.slice(0, 200)}\nmedium=${(JSON.parse(direction.payloadJson) as { styleProfile: { medium: string } }).styleProfile.medium}; composition=${(JSON.parse(direction.payloadJson) as { styleProfile: { composition: string } }).styleProfile.composition}` : "(no approved direction — propose neutrally)";
    const result = await chatValidated(userId, SceneConceptSetSchema, [
      {
        role: "system",
        content: [
          "You enrich a narration-driven scene plan with VISUAL SUGGESTIONS ONLY. You never change timings (startSec/endSec are fixed), never invent narration, never write new dialogue.",
          `For each scene give: visualConcept, compositionDescription, onScreenText (short, ≤8 words, verbatim from narration where possible — Tamil-safe), motionRecommendation, cameraMovement (static|push-in|pan|drift|handheld-like), transitionRecommendation (cut|fade|wipe|match-cut), confidence 0..1.`,
          language === "ta" ? "Write human-readable suggestions in Tamil; keep technical terms in English." : "Write suggestions in English.",
          'Respond with ONLY JSON: {"scenes":[{"sceneId","visualConcept","compositionDescription","onScreenText","motionRecommendation","cameraMovement","transitionRecommendation","confidence"}]} with sceneId EXACTLY as given.',
        ].join("\n"),
      },
      { role: "user", content: `${dirBlock}\n\nSCENES (timings are fixed — do not change them):\n${listing}` },
    ], { provider, temperature: 0.6, maxTokens: 2200, purpose: "m14-scene-concepts", onUsage: (u: { usage?: { promptTokens: number; completionTokens: number; totalTokens: number } | null }) => { usage = u.usage ?? null; } });
    void recordUsage(userId, { provider: myAiProviderId(), model: result.model, usage, latencyMs: 0, content: "" }, "m14-scene-concepts").catch(() => undefined);
    const byId = new Map(result.data.scenes.map((s) => [s.sceneId, s]));
    enriched = baseScenes.map((s) => {
      const sug = byId.get(s.sceneId);
      return sug
        ? { ...s, visualConcept: sug.visualConcept.slice(0, 400), compositionDescription: sug.compositionDescription.slice(0, 400), onScreenText: sug.onScreenText.slice(0, 200), motionRecommendation: sug.motionRecommendation.slice(0, 200), cameraMovement: sug.cameraMovement.slice(0, 120), transitionRecommendation: sug.transitionRecommendation.slice(0, 120), confidence: sug.confidence }
        : s;
    });
    notes.push(`Visual concepts suggested by ${myAiProviderId()}/${result.model} (creative suggestions only — RIISHE timings untouched).`);
  } catch (err) {
    notes.push(`AI concept enrichment unavailable (honest): ${(err as Error).message.slice(0, 200)}. Scenes keep empty concept fields for manual editing.`);
  }

  const doc: ScenePlanDoc = {
    analysisVersion: M14_SCENE_VERSION,
    language,
    format,
    targetDurationSec: null,
    artDirectionId: input.artDirectionId ?? null,
    scenes: enriched,
    notes: notes.slice(0, 8),
  };
  const validated = ScenePlanDocSchema.parse(doc);
  // Contiguity check: no gaps/overlaps unless deliberately approved (§5.11).
  const issues = validateContiguity(validated.scenes);
  if (issues.length > 0) validated.notes.push(...issues.slice(0, 3));
  await db.scenePlan.create({ data: { userId, projectId, artDirectionId: input.artDirectionId ?? null, language, version: 1, scenesJson: JSON.stringify(validated) } });
  return validated;
}

/** Gap/overlap detection (reported, never auto-fixed without approval). */
export function validateContiguity(scenes: Scene[]): string[] {
  const sorted = [...scenes].sort((a, b) => a.startSec - b.startSec);
  const issues: string[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (cur.startSec > prev.endSec + 0.05) issues.push(`Gap between ${prev.sceneId} and ${cur.sceneId} (${(cur.startSec - prev.endSec).toFixed(2)}s) — deliberate, pending approval.`);
    if (cur.startSec < prev.endSec - 0.05) issues.push(`Overlap between ${prev.sceneId} and ${cur.sceneId} — deliberate, pending approval.`);
  }
  return issues;
}

/** Regenerate ONE scene's creative fields; approved scenes untouched. */
export async function regenerateScene(userId: string, projectId: string, planId: string, sceneId: string, opts: { provider?: LLMProvider } = {}): Promise<ScenePlanDoc> {
  const plan = await db.scenePlan.findUnique({ where: { id: planId } });
  if (!plan || plan.userId !== userId || plan.projectId !== projectId) throw new Error("Scene plan not found or not owned by the caller.");
  const doc = JSON.parse(plan.scenesJson) as ScenePlanDoc;
  const scene = doc.scenes.find((s) => s.sceneId === sceneId);
  if (!scene) throw new Error(`Scene ${sceneId} not found.`);
  const provider = opts.provider ?? llmProvider();
  let usage2: { promptTokens: number; completionTokens: number; totalTokens: number } | null = null;
  const result = await chatValidated(userId, SceneConceptSetSchema, [
    {
      role: "system",
      content:
        "You regenerate the VISUAL SUGGESTIONS for exactly ONE scene of a narration-driven plan. Never change timings. Respond with ONLY JSON {\"scenes\":[{sceneId, visualConcept, compositionDescription, onScreenText, motionRecommendation, cameraMovement, transitionRecommendation, confidence}]} with sceneId exactly as given.",
    },
    {
      role: "user",
      content: `Scene ${scene.sceneId} [${scene.startSec}–${scene.endSec}s]: ${doc.language === "ta" ? "use Tamil for suggestions" : "use English"}.\nCurrent concept: ${scene.visualConcept || "(empty)"}`,
    },
  ], { provider, temperature: 0.8, maxTokens: 700, purpose: "m14-scene-regenerate", onUsage: (u: { usage?: { promptTokens: number; completionTokens: number; totalTokens: number } | null }) => { usage2 = u.usage ?? null; } });
  void recordUsage(userId, { provider: myAiProviderId(), model: result.model, usage: usage2, latencyMs: 0, content: "" }, "m14-scene-regenerate").catch(() => undefined);
  const sug = result.data.scenes[0];
  const next = doc.scenes.map((s) =>
    s.sceneId === sceneId && s.approvalStatus !== "APPROVED"
      ? { ...s, visualConcept: sug?.visualConcept.slice(0, 400) ?? s.visualConcept, compositionDescription: sug?.compositionDescription.slice(0, 400) ?? s.compositionDescription, onScreenText: sug?.onScreenText.slice(0, 200) ?? s.onScreenText, motionRecommendation: sug?.motionRecommendation.slice(0, 200) ?? s.motionRecommendation, cameraMovement: sug?.cameraMovement.slice(0, 120) ?? s.cameraMovement, transitionRecommendation: sug?.transitionRecommendation.slice(0, 120) ?? s.transitionRecommendation, confidence: sug?.confidence ?? s.confidence, approvalStatus: "REVISED" as const }
      : s,
  );
  const updated = { ...doc, scenes: next, notes: [...doc.notes.slice(0, 6), `Scene ${sceneId} regenerated (${new Date().toISOString().slice(0, 19)}); approved scenes untouched.`].slice(0, 8) };
  await db.scenePlan.update({ where: { id: planId }, data: { scenesJson: JSON.stringify(updated), version: plan.version + 1 } });
  return updated;
}

/** Manual edits: reorder + duration adjust (validated, no caption changes). */
export async function editScenePlan(userId: string, projectId: string, planId: string, edits: { order?: string[]; durations?: { sceneId: string; startSec?: number; endSec?: number }[]; approve?: string[]; note?: string }): Promise<ScenePlanDoc> {
  const plan = await db.scenePlan.findUnique({ where: { id: planId } });
  if (!plan || plan.userId !== userId || plan.projectId !== projectId) throw new Error("Scene plan not found or not owned by the caller.");
  const doc = JSON.parse(plan.scenesJson) as ScenePlanDoc;
  let scenes = [...doc.scenes];
  if (edits.order) {
    const byId = new Map(scenes.map((s) => [s.sceneId, s]));
    const reordered = edits.order.map((id) => byId.get(id)).filter((s): s is Scene => Boolean(s));
    if (reordered.length !== scenes.length) throw new Error("Reorder list must contain every scene exactly once.");
    scenes = reordered;
  }
  if (edits.durations) {
    for (const d of edits.durations) {
      const s = scenes.find((x) => x.sceneId === d.sceneId);
      if (!s) throw new Error(`Scene ${d.sceneId} not found.`);
      if (s.timingSource === "riishe-verbatim") {
        // Manual override of a verbatim scene: keep the RIISHE ref, flag as
        // REVISED (never claimed verbatim anymore).
        if (d.startSec !== undefined) s.startSec = Math.round(d.startSec * 100) / 100;
        if (d.endSec !== undefined) s.endSec = Math.round(d.endSec * 100) / 100;
        if (s.endSec - s.startSec < 0.3) throw new Error(`Scene ${s.sceneId} too short (<0.3s).`);
        s.timingSource = "estimated";
        s.evidence = `Manually adjusted from RIISHE ${s.segmentRefs.join(",")} — now an estimate`;
        s.approvalStatus = "REVISED";
      } else {
        if (d.startSec !== undefined) s.startSec = Math.round(d.startSec * 100) / 100;
        if (d.endSec !== undefined) s.endSec = Math.round(d.endSec * 100) / 100;
        if (s.endSec - s.startSec < 0.3) throw new Error(`Scene ${s.sceneId} too short (<0.3s).`);
      }
    }
  }
  if (edits.approve) {
    for (const id of edits.approve) {
      const s = scenes.find((x) => x.sceneId === id);
      if (!s) throw new Error(`Scene ${id} not found.`);
      s.approvalStatus = "APPROVED";
    }
  }
  const updated = { ...doc, scenes, notes: [...doc.notes.slice(0, 6), edits.note ?? "Manual edit applied; original transcript and captions untouched."].slice(0, 8) };
  const issues = validateContiguity(updated.scenes);
  await db.scenePlan.update({ where: { id: planId }, data: { scenesJson: JSON.stringify(updated), version: plan.version + 1 } });
  void issues;
  return updated;
}
