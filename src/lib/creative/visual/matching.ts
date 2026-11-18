/**
 * M12 — Narration-to-visual matching (§6).
 *
 * Connects the M11 APPROVED transcript (fallback: the RIISHE-reused measured
 * transcript) to the M12 visual index:
 *  1. transcript segments → exact timeline ranges (mapSilenceToTimeline — the
 *     M11 clip-placement mapper; AUDIO/VIDEO-track aware);
 *  2. timeline speech ∩ scene placements → matched scenes (deterministic);
 *  3. semantic relevance: ONLY with consent + a real vision provider does the
 *     narration get compared against ACTUAL frame descriptions; without it
 *     the verdict stays `unknown` with the missing data listed — a coverage
 *     statement is measured, a semantic claim never is.
 *
 * A mismatch is NEVER labeled an editing error: creative choices (b-roll on
 * abstract narration, montages, J/L cuts) are legitimate — the explanation
 * states this explicitly.
 */
import { db } from "@/lib/db";
import { mapSilenceToTimeline } from "../embedded-audio";
import { visionProvider } from "@/lib/my-ai/gateway/vision";
import { VisionMatchVerdictSchema } from "./contracts";
import { extractJson } from "@/lib/my-ai/gateway/structured";
import type { MeasuredContext } from "../context";
import type { NarrationMatch, VisualIndex } from "./contracts";

export interface MatchOptions {
  consentVisual: boolean;
  language?: string;
  /** Injectable provider (fixture tests). */
  provider?: ReturnType<typeof visionProvider>;
  signal?: AbortSignal;
  maxSegments?: number;
  onUsage?: (r: { provider: string; model: string; usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null }) => void;
}

export interface MatchResult {
  matches: NarrationMatch[];
  notes: string[];
  provider: string | null;
  model: string | null;
  transcriptVersionId: string | null;
  transcriptVersionNo: number | null;
}

interface Seg {
  start: number;
  end: number;
  text: string;
}

function coverageOf(tlStart: number | null, tlEnd: number | null, index: VisualIndex): { matchedSceneIds: string[]; coverage: NarrationMatch["coverage"] } {
  if (tlStart === null || tlEnd === null || tlEnd <= tlStart) return { matchedSceneIds: [], coverage: "unmappable" };
  const matched = new Set<string>();
  let coveredSec = 0;
  const spans: { s: number; e: number }[] = [];
  for (const scene of index.scenes) {
    for (const p of scene.timelinePlacements) {
      const s = Math.max(p.timelineStartSec, tlStart);
      const e = Math.min(p.timelineEndSec, tlEnd);
      if (e - s > 0.05) {
        matched.add(scene.sceneId);
        spans.push({ s, e });
      }
    }
  }
  spans.sort((a, b) => a.s - b.s);
  let cursor = tlStart;
  for (const sp of spans) {
    if (sp.e <= cursor) continue;
    coveredSec += Math.min(sp.e, tlEnd) - Math.max(sp.s, cursor);
    cursor = Math.max(cursor, sp.e);
  }
  const fraction = coveredSec / (tlEnd - tlStart);
  return { matchedSceneIds: [...matched].slice(0, 12), coverage: fraction >= 0.95 ? "full" : fraction > 0 ? "partial" : "none" };
}

/** Latest APPROVED transcript version for the project's primary audio asset. */
export async function approvedTranscriptFor(userId: string, projectId: string, assetId: string | null): Promise<{ id: string; versionNo: number; language: string; segments: Seg[]; sourceAssetId: string | null } | null> {
  const row = await db.transcriptVersion.findFirst({
    where: { userId, projectId, status: "APPROVED", ...(assetId ? { sourceAssetId: assetId } : {}) },
    orderBy: [{ versionNo: "desc" }, { updatedAt: "desc" }],
  });
  if (!row) return null;
  try {
    const segments = JSON.parse(row.segmentsJson) as Seg[];
    return { id: row.id, versionNo: row.versionNo, language: row.language, segments: segments.filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && typeof s.text === "string"), sourceAssetId: row.sourceAssetId };
  } catch {
    return null;
  }
}

const MATCH_PROMPT = `You compare video NARRATION with the VISUAL content of the scenes shown during that narration. For each narration segment, judge whether the described visual evidence supports what is being said. Respond with ONLY JSON:
{"verdicts":[{"segmentIndex":0,"relevance":"supported|partially-supported|unrelated|unknown","relevanceScore":0.0,"explanation":"one or two sentences citing the actual visual evidence"}]}
Rules: base the verdict ONLY on the provided visual descriptions of the matched scenes (real analyzed frames). If no scene was analyzed, use "unknown". A mismatch is not an error — b-roll, montages and abstract visuals are legitimate; explain what the visuals show instead.`;

/** Match narration segments against the visual index (§6). */
export async function matchNarrationToVisuals(userId: string, projectId: string, ctx: MeasuredContext, index: VisualIndex, opts: MatchOptions): Promise<MatchResult> {
  const notes: string[] = [];
  const matches: NarrationMatch[] = [];
  const maxSegments = opts.maxSegments ?? 40;

  // 1. transcript: APPROVED M11 version first, RIISHE-reused measured second.
  // The mapping source is the TRANSCRIPT's own asset (embedded-audio videos
  // have no dedicated AUDIO asset — the transcript knows where its speech came
  // from), falling back to the measured primary audio.
  const approved = await approvedTranscriptFor(userId, projectId, ctx.audio?.sourceAssetId ?? null);
  let segments: Seg[] = [];
  let language = "unknown";
  let transcriptVersionId: string | null = null;
  let transcriptVersionNo: number | null = null;
  const mappingAssetId: string | null = ctx.audio?.sourceAssetId ?? approved?.sourceAssetId ?? null;
  if (approved && approved.segments.length > 0) {
    segments = approved.segments;
    language = approved.language;
    transcriptVersionId = approved.id;
    transcriptVersionNo = approved.versionNo;
  } else if (ctx.transcript?.available && ctx.transcript.segments.length > 0) {
    segments = ctx.transcript.segments.map((s) => ({ start: s.start, end: s.end, text: s.text }));
    language = ctx.transcript.languageDescription ?? "unknown";
    notes.push("No APPROVED M11 transcript version — using the RIISHE-reused measured transcript (run integrated transcription and approve it for versioned matching).");
  } else {
    notes.push("No approved transcript exists — narration-to-visual matching is unavailable (recorded honestly, nothing inferred).");
    return { matches, notes, provider: null, model: null, transcriptVersionId: null, transcriptVersionNo: null };
  }
  if (segments.length > maxSegments) notes.push(`${segments.length} transcript segments — matching the first ${maxSegments} (bounded run).`);

  // 2. map speech to the timeline through clip placements (M11 mapper).
  const bounded = segments.slice(0, maxSegments);
  let timelineSpans: { start: number; end: number; clipIds: string[] }[] = [];
  if (mappingAssetId) {
    try {
      timelineSpans = await mapSilenceToTimeline(userId, projectId, mappingAssetId, bounded.map((s) => ({ start: s.start, end: s.end })), ctx.fps);
    } catch (err) {
      notes.push(`Speech→timeline mapping failed: ${(err as Error).message.slice(0, 180)}`);
    }
  } else {
    notes.push("No primary audio source — speech segments cannot be mapped to the timeline (coverage stays unmappable).");
  }

  // 3. deterministic coverage + semantic verdict.
  const coverageParts = bounded.map((seg, i) => coverageOf(timelineSpans[i]?.start ?? null, timelineSpans[i]?.end ?? null, index));

  let providerId: string | null = null;
  let modelId: string | null = null;
  const verdicts = new Map<number, { relevance: NarrationMatch["relevance"]; relevanceScore: number | null; explanation: string }>();
  const analyzable = bounded.map((_, i) => i).filter((i) => coverageParts[i].matchedSceneIds.length > 0 && index.scenes.some((s) => s.understanding === "semantic" && coverageParts[i].matchedSceneIds.includes(s.sceneId)));
  if (opts.consentVisual && analyzable.length > 0) {
    try {
      const provider = opts.provider ?? visionProvider();
      providerId = provider.id;
      modelId = provider.model;
      const sceneById = new Map(index.scenes.map((s) => [s.sceneId, s]));
      const listing = analyzable
        .map((i) => {
          const scenes = coverageParts[i].matchedSceneIds.map((id) => sceneById.get(id)).filter((s): s is NonNullable<typeof s> => Boolean(s));
          const desc = scenes.map((s) => `- ${s.sceneId} [${s.sourceStartSec.toFixed(1)}–${s.sourceEndSec.toFixed(1)}s]: ${s.description ?? "(no semantic description — heuristic-only scene)"}`).join("\n");
          return `SEGMENT ${i} (timeline ${timelineSpans[i]?.start.toFixed(1) ?? "?"}–${timelineSpans[i]?.end.toFixed(1) ?? "?"}s): "${bounded[i].text.slice(0, 300)}"\nVISUALS:\n${desc}`;
        })
        .join("\n\n");
      const first = await provider.analyze(`${MATCH_PROMPT}\n\n${listing}`, [], { timeoutMs: 120_000, signal: opts.signal, purpose: "visual-narration-match" });
      opts.onUsage?.({ provider: provider.id, model: first.model, usage: first.usage });
      let parsed: unknown;
      try {
        parsed = extractJson(first.content);
      } catch {
        parsed = null;
      }
      let ok = false;
      if (parsed) {
        try {
          const v = VisionMatchVerdictSchema.parse(parsed);
          for (const verdict of v.verdicts) verdicts.set(verdict.segmentIndex, verdict);
          ok = true;
        } catch (err) {
          notes.push(`Provider match verdicts failed validation: ${(err as Error).message.slice(0, 180)}`);
        }
      }
      if (!ok) {
        const repair = await provider.analyze(`${MATCH_PROMPT}\n\nYour previous reply was not valid JSON for the requested schema. Respond AGAIN with ONLY corrected JSON.\n\n${listing}`, [], { timeoutMs: 120_000, temperature: 0, purpose: "visual-narration-match-repair" });
        opts.onUsage?.({ provider: provider.id, model: repair.model, usage: repair.usage });
        const v = VisionMatchVerdictSchema.parse(extractJson(repair.content));
        for (const verdict of v.verdicts) verdicts.set(verdict.segmentIndex, verdict);
      }
    } catch (err) {
      notes.push(`Semantic narration matching failed honestly: ${(err as Error).message.slice(0, 220)}`);
    }
  } else if (analyzable.length > 0 && !opts.consentVisual) {
    notes.push(`${analyzable.length} segment(s) had analyzed scenes but semantic relevance was NOT assessed — external frame transmission requires explicit consent (coverage-only results below).`);
  }

  bounded.forEach((seg, i) => {
    const cov = coverageParts[i];
    const verdict = verdicts.get(i);
    const semanticAvailable = cov.matchedSceneIds.length > 0 && index.scenes.some((s) => s.understanding === "semantic" && cov.matchedSceneIds.includes(s.sceneId));
    const missingData: string[] = [];
    if (cov.coverage === "unmappable") missingData.push("speech could not be mapped to the timeline (no mapped clip placements)");
    if (cov.matchedSceneIds.length === 0 && cov.coverage !== "unmappable") missingData.push("no visual scenes overlap this speech span on the timeline");
    if (semanticAvailable && !verdict) missingData.push("semantic relevance not assessed (provider unavailable or failed)");
    if (!semanticAvailable) missingData.push("no analyzed frames for the matched scenes — only deterministic coverage is known");
    matches.push({
      segmentIndex: i,
      text: seg.text.slice(0, 500),
      language,
      sourceStartSec: Math.round(seg.start * 100) / 100,
      sourceEndSec: Math.round(seg.end * 100) / 100,
      timelineStartSec: timelineSpans[i]?.start ?? null,
      timelineEndSec: timelineSpans[i]?.end ?? null,
      matchedSceneIds: cov.matchedSceneIds,
      coverage: cov.coverage,
      relevance: verdict?.relevance ?? "unknown",
      relevanceScore: verdict?.relevanceScore ?? null,
      explanation: verdict?.explanation ?? (cov.coverage === "full" ? "Speech span is fully covered by timeline video placements; semantic relevance not assessed." : cov.coverage === "partial" ? "Speech span is partially covered by timeline video placements." : cov.coverage === "none" ? "No timeline video covers this speech span (deterministic measurement)." : "Speech-to-timeline mapping unavailable for this segment."),
      missingData: missingData.slice(0, 6),
      evidenceLabel: verdict ? "ai-interpretation" : cov.coverage === "unmappable" ? "insufficient-evidence" : "measured",
      provider: verdict ? providerId : null,
      model: verdict ? modelId : null,
    });
  });
  return { matches, notes, provider: providerId, model: modelId, transcriptVersionId, transcriptVersionNo };
}
