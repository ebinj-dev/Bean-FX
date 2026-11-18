/**
 * M13 — Temporal visual search (§7).
 *
 * Searches REAL temporal observations — tracks (entry/exit/direction/speed),
 * motion measurements, camera classifications and events — never filenames
 * or isolated frame descriptions. Two methods, honestly labeled:
 *  - `local-predicate`: deterministic interpretation of the query over the
 *    temporal records (direction words, motion/no-motion, entry/exit,
 *    categories, camera classes) — English-focused;
 *  - `provider-ranking`: the configured LLM ranks bounded temporal records
 *    against the query (EN/TA), validated by VisionTemporalRankingSchema —
 *    runs only with stored consent (its evidence comes from consent-gated
 *    analysis artifacts; the ranking call itself sends TEXT only).
 * Insufficient temporal evidence produces honest empty results with notes.
 */
import { visionProvider } from "@/lib/my-ai/gateway/vision";
import { VisionTemporalRankingSchema, type TemporalIndex, type TemporalSearchRequest, type TemporalSearchResponse, type TemporalSearchResult } from "./contracts";
import { extractJson } from "@/lib/my-ai/gateway/structured";

const RANK_PROMPT = `You rank TEMPORAL video observations (tracked subjects, motion events, camera-motion records) against a search query. Return ONLY JSON:
{"results":[{"refId":"...","kind":"track|event|scene","relevanceScore":0.0,"evidence":"why this matches, citing the temporal evidence"}]}
Rules: use refId values EXACTLY as given. Score 0..1. Only include relevanceScore > 0.15, best first, at most the requested limit. The query may be English or Tamil — interpret it faithfully. Base verdicts ONLY on the provided temporal evidence.`;

interface Candidate {
  kind: "track" | "event" | "scene";
  refId: string;
  sourceStartSec: number;
  sourceEndSec: number;
  timelineStartSec: number | null;
  description: string;
  previewAssetId: string | null;
  evidence: string;
  score: number;
}

/** Deterministic query interpretation over temporal records (§7). */
export function localTemporalCandidates(index: TemporalIndex, req: TemporalSearchRequest): { candidates: Candidate[]; notes: string[] } {
  const notes: string[] = [];
  const q = req.query.toLowerCase();
  const tokens = q.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 3);
  const candidates: Candidate[] = [];
  const has = (...words: string[]) => words.some((w) => q.includes(w));

  for (const track of index.tracks) {
    const motion = index.motion.find((m) => m.trackId === track.trackId);
    const category = track.category;
    const dir = motion?.direction ?? null;
    let score = 0;
    const reasons: string[] = [];
    if (dir && has(dir)) {
      score += 0.5;
      reasons.push(`tracked direction ${dir}`);
    }
    if (dir === "right" && has("left to right", "l2r", "rightward")) {
      score += 0.5;
      reasons.push("left-to-right displacement");
    }
    if (dir === "left" && has("right to left", "leftward")) {
      score += 0.5;
      reasons.push("right-to-left displacement");
    }
    if (has("walking", "person", "people", "human", "man", "woman") && category && ["person", "people", "pedestrian", "human", "walking person"].some((c) => category.includes(c))) {
      score += 0.5;
      reasons.push(`tracked category "${track.category}"`);
    }
    if (has("vehicle", "car", "truck", "van", "bus") && category && ["vehicle", "car", "truck", "van", "bus"].some((c) => category.includes(c))) {
      score += 0.5;
      reasons.push(`tracked category "${track.category}"`);
    }
    if (has("enter", "enters", "appears", "entry") && track.terminationReason !== "window-end") {
      score += 0.3;
      reasons.push(`subject entered (termination: ${track.terminationReason})`);
    }
    if (has("exit", "exits", "leaves", "disappears", "disappear") && track.terminationReason === "left-frame") {
      score += 0.3;
      reasons.push("subject exited the frame");
    }
    if ((has("moving", "movement", "motion", "walk", "driving", "runs")) && (motion?.speedPxPerSec ?? 0) > 0.02 * (index.width ?? 100)) {
      score += 0.35;
      reasons.push(`measured motion ${motion?.speedPxPerSec}px/s`);
    }
    if (has("static", "no movement", "almost no movement", "still", "motionless") && (motion?.displacementPx ?? 1) < 0.01 * (index.width ?? 100)) {
      score += 0.4;
      reasons.push("subject measured static");
    }
    if (has("repeated", "repeat", "cycle", "periodic") && motion?.repeatedPatternSec) {
      score += 0.5;
      reasons.push(`repeated pattern ~${motion.repeatedPatternSec}s`);
    }
    if (tokens.some((t) => track.trackId.includes(t)) || (category && tokens.some((t) => category.toLowerCase().includes(t)))) {
      score += 0.2;
      reasons.push("category/id token match");
    }
    if (score > 0.15) {
      candidates.push({
        kind: "track",
        refId: track.trackId,
        sourceStartSec: track.entrySourceSec,
        sourceEndSec: track.exitSourceSec,
        timelineStartSec: track.entryTimelineSec,
        description: `${track.category ?? "subject"} tracked ${track.samples.length} samples, ${track.entrySourceSec.toFixed(1)}–${track.exitSourceSec.toFixed(1)}s${dir ? `, moving ${dir}` : ", static"}`,
        previewAssetId: null,
        evidence: reasons.join("; "),
        score: Math.min(1, score),
      });
    }
  }

  for (const ev of index.events) {
    let score = 0;
    const reasons: string[] = [];
    if (ev.type === "subject-entry" && has("enter", "appears", "enters the", "enters")) {
      score += 0.6;
      reasons.push(ev.description.slice(0, 120));
    }
    if (ev.type === "subject-exit" && has("exit", "leaves", "disappear")) {
      score += 0.6;
      reasons.push(ev.description.slice(0, 120));
    }
    if (ev.type === "camera-move" && has("camera", "pan", "tilt", "zoom", "moving camera")) {
      score += 0.55;
      reasons.push(ev.description.slice(0, 120));
    }
    if (ev.type === "repeated-motion" && has("repeated", "repeat", "periodic")) {
      score += 0.6;
      reasons.push(ev.description.slice(0, 120));
    }
    if (ev.type === "sudden-position-change" && has("sudden", "jump", "abrupt")) {
      score += 0.6;
      reasons.push(ev.description.slice(0, 120));
    }
    if (ev.type === "static-span" && has("no movement", "static", "almost no movement")) {
      score += 0.5;
      reasons.push(ev.description.slice(0, 120));
    }
    if (tokens.some((t) => ev.description.toLowerCase().includes(t))) {
      score += 0.15;
      reasons.push("description token match");
    }
    if (score > 0.15) {
      candidates.push({
        kind: "event",
        refId: ev.eventId,
        sourceStartSec: ev.sourceStartSec,
        sourceEndSec: ev.sourceEndSec,
        timelineStartSec: ev.timelineStartSec,
        description: ev.description,
        previewAssetId: null,
        evidence: reasons.join("; "),
        score: Math.min(1, score),
      });
    }
  }

  // Scene-level fallback (M12 scene summaries copied into the temporal index).
  for (const scene of index.sceneSummaries) {
    if (!scene.description) continue;
    const matched = tokens.filter((t) => scene.description!.toLowerCase().includes(t));
    if (matched.length === 0) continue;
    candidates.push({
      kind: "scene",
      refId: scene.sceneId,
      sourceStartSec: scene.sourceStartSec,
      sourceEndSec: scene.sourceEndSec,
      timelineStartSec: scene.timelineStartSec,
      description: scene.description,
      previewAssetId: scene.representativeAssetId,
      evidence: `scene description tokens [${matched.join(", ")}] — temporal claims need tracks/events, this is scene-level only`,
      score: Math.min(0.6, 0.25 + 0.15 * (matched.length - 1)),
    });
  }

  if (candidates.length === 0 && /^[\u0B80-\u0BFF\s]+$/.test(req.query)) {
    notes.push("Tamil query: local predicates match English direction/category words — provider ranking (with consent) is the supported path for Tamil temporal search.");
  }
  return { candidates, notes };
}

export async function searchTemporalIndex(index: TemporalIndex, req: TemporalSearchRequest, opts: { consentVisual?: boolean; provider?: ReturnType<typeof visionProvider> } = {}): Promise<TemporalSearchResponse> {
  const notes: string[] = [];
  const limit = req.limit ?? 8;

  const inWindow = (startSec: number): boolean => {
    if (req.timeStartSec !== undefined && startSec + 0.5 < req.timeStartSec) return false;
    if (req.timeEndSec !== undefined && startSec > req.timeEndSec) return false;
    return true;
  };
  const matchesFilters = (c: Candidate): boolean => {
    if (!inWindow(c.sourceStartSec)) return false;
    if (req.trackId && c.kind === "track" && c.refId !== req.trackId) return false;
    if (req.trackId && c.kind === "event") {
      const ev = index.events.find((e) => e.eventId === c.refId);
      if (!ev?.trackIds.includes(req.trackId)) return false;
    }
    if (req.assetId && c.refId.startsWith(req.assetId) === false && c.kind !== "scene") return false;
    return true;
  };

  if (opts.consentVisual) {
    try {
      const provider = opts.provider ?? visionProvider();
      const { candidates: all } = localTemporalCandidates(index, { ...req, limit: 20 });
      const pool = (all.length > 0 ? all : broadPool(index)).slice(0, 60);
      const listing = pool
        .map((c) => `- refId ${c.refId} kind ${c.kind} [${c.sourceStartSec.toFixed(1)}–${c.sourceEndSec.toFixed(1)}s]: ${c.description} | evidence: ${c.evidence}`)
        .join("\n");
      let parsed: unknown = null;
      try {
        const res = await provider.analyze(`${RANK_PROMPT}\n\nQUERY: ${req.query}\nLIMIT: ${limit}\n\nRECORDS:\n${listing}`, [], { timeoutMs: 120_000, purpose: "temporal-search" });
        parsed = extractJson(res.content);
      } catch (firstErr) {
        notes.push(`provider ranking attempt failed (${(firstErr as Error).message.slice(0, 160)}) — repair attempt follows`);
        const repair = await provider.analyze(`${RANK_PROMPT}\n\nYour previous reply was not valid JSON. Respond AGAIN with ONLY corrected JSON.\n\nQUERY: ${req.query}\nLIMIT: ${limit}\n\nRECORDS:\n${listing}`, [], { timeoutMs: 120_000, temperature: 0, purpose: "temporal-search-repair" });
        parsed = extractJson(repair.content);
      }
      const ranked = VisionTemporalRankingSchema.parse(parsed);
      const byId = new Map(pool.map((c) => [c.refId, c]));
      const results: TemporalSearchResult[] = [];
      for (const r of ranked.results.slice(0, limit)) {
        const c = byId.get(r.refId);
        if (!c || r.relevanceScore <= 0.15) continue;
        results.push({
          kind: c.kind,
          refId: c.refId,
          assetId: index.assetId,
          sourceStartSec: c.sourceStartSec,
          sourceEndSec: c.sourceEndSec,
          timelineStartSec: c.timelineStartSec,
          description: c.description.slice(0, 400),
          previewAssetId: c.previewAssetId,
          relevanceScore: r.relevanceScore,
          evidence: r.evidence.slice(0, 400),
        });
      }
      results.sort((a, b) => b.relevanceScore - a.relevanceScore);
      return { available: true, method: "provider-ranking", results, notes };
    } catch (err) {
      notes.push(`provider ranking unavailable — deterministic temporal predicates used: ${(err as Error).message.slice(0, 220)}`);
    }
  }

  const { candidates, notes: localNotes } = localTemporalCandidates(index, req);
  notes.push(...localNotes);
  const filtered = candidates.filter(matchesFilters).sort((a, b) => b.score - a.score).slice(0, limit);
  const results: TemporalSearchResult[] = filtered.map((c) => ({
    kind: c.kind,
    refId: c.refId,
    assetId: index.assetId,
    sourceStartSec: c.sourceStartSec,
    sourceEndSec: c.sourceEndSec,
    timelineStartSec: c.timelineStartSec,
    description: c.description.slice(0, 400),
    previewAssetId: c.previewAssetId,
    relevanceScore: c.score,
    evidence: c.evidence.slice(0, 400),
  }));
  return { available: true, method: "local-predicate", results, notes };
}

/** Bounded record pool when local predicates found nothing (provider path). */
function broadPool(index: TemporalIndex): Candidate[] {
  const out: Candidate[] = [];
  for (const t of index.tracks.slice(0, 12)) {
    const m = index.motion.find((mm) => mm.trackId === t.trackId);
    out.push({
      kind: "track",
      refId: t.trackId,
      sourceStartSec: t.entrySourceSec,
      sourceEndSec: t.exitSourceSec,
      timelineStartSec: t.entryTimelineSec,
      description: `${t.category ?? "subject"} tracked ${t.samples.length} samples ${t.entrySourceSec.toFixed(1)}–${t.exitSourceSec.toFixed(1)}s, ${m?.direction ?? "unknown motion"}`,
      previewAssetId: null,
      evidence: `${t.terminationReason}${m ? `, speed ${m.speedPxPerSec}px/s` : ""}`,
      score: 0.2,
    });
  }
  for (const e of index.events.slice(0, 20)) {
    out.push({
      kind: "event",
      refId: e.eventId,
      sourceStartSec: e.sourceStartSec,
      sourceEndSec: e.sourceEndSec,
      timelineStartSec: e.timelineStartSec,
      description: e.description,
      previewAssetId: null,
      evidence: `${e.method} (${e.evidenceLabel})`,
      score: 0.2,
    });
  }
  return out;
}
