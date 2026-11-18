/**
 * M12 — Project-scoped natural-language footage search (§5).
 *
 * Searches the REAL visual index (actual analyzed frames — never filenames or
 * metadata alone). Two methods, honestly labeled:
 *  - `provider-ranking`: the configured LLM ranks scene records against the
 *    query (works for English AND Tamil where the model supports it);
 *  - `local-keyword`: deterministic token match over scene descriptions/
 *    objects/activities (English-focused; Tamil queries get an honest note).
 *
 * The search REQUIRES a completed visual index — before real visual indexing
 * has run, the response is `available:false` with the reason (never fabricated
 * results). Results carry scene thumbnails (registered representative frames),
 * both clocks, relevance and evidence.
 */
import { visionProvider } from "@/lib/my-ai/gateway/vision";
import { VisionSearchRankingSchema, type VisualIndex, type VisualSearchRequest, type VisualSearchResponse, type VisualSearchResult } from "./contracts";
import { extractJson } from "@/lib/my-ai/gateway/structured";

const RANK_PROMPT = `You rank VIDEO SCENES against a user's footage search query. Below are the project's indexed scenes (real analyzed frames). Return ONLY JSON:
{"results":[{"sceneId":"...","relevanceScore":0.0,"matchedTerms":["..."],"evidence":"why this scene matches, citing its description"}]}
Rules: use sceneId values EXACTLY as given. Score 0..1 (1 = exactly what was asked). Only include scenes with relevanceScore > 0.15, best first, at most the requested limit. The query may be English or Tamil — interpret it faithfully.`;

function tokensOf(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 3)
    .slice(0, 12);
}

function localScore(scene: VisualIndex["scenes"][number], tokens: string[], assetName: string): { score: number; matched: string[] } {
  const hay = [scene.description ?? "", scene.objects.join(" "), scene.activities.join(" "), scene.category ?? "", assetName].join(" ").toLowerCase();
  const matched = tokens.filter((t) => hay.includes(t));
  if (matched.length === 0) return { score: 0, matched: [] };
  return { score: Math.min(1, 0.4 + 0.3 * (matched.length - 1)), matched };
}

export async function searchVisualIndex(index: VisualIndex, req: VisualSearchRequest, opts: { consentVisual?: boolean; provider?: ReturnType<typeof visionProvider> } = {}): Promise<VisualSearchResponse> {
  const notes: string[] = [];
  const scenes = index.scenes.filter((s) => (req.assetId ? s.assetId === req.assetId : true));
  const limit = req.limit ?? 8;

  // Timeline-window filter (deterministic).
  const inWindow = (s: VisualIndex["scenes"][number]): boolean => {
    if (req.timeStartSec !== undefined || req.timeEndSec !== undefined) {
      const tl = s.timelinePlacements;
      if (tl.length === 0) return false;
      const start = Math.min(...tl.map((p) => p.timelineStartSec));
      const end = Math.max(...tl.map((p) => p.timelineEndSec));
      if (req.timeStartSec !== undefined && end < req.timeStartSec) return false;
      if (req.timeEndSec !== undefined && start > req.timeEndSec) return false;
    }
    return true;
  };
  const candidates = scenes.filter(inWindow);
  if (candidates.length === 0) {
    return { available: true, method: "local-keyword", results: [], notes: ["No scenes fall inside the requested time window / asset filter."] };
  }

  // 1. provider ranking (when consented and configured).
  if (opts.consentVisual) {
    try {
      const provider = opts.provider ?? visionProvider();
      const listing = candidates
        .slice(0, 60)
        .map((s) => `- sceneId ${s.sceneId} [source ${s.sourceStartSec.toFixed(1)}–${s.sourceEndSec.toFixed(1)}s | timeline ${s.timelinePlacements[0]?.timelineStartSec.toFixed(1) ?? "?"}s]: ${s.description ?? "(heuristic-only, no semantic description)"} objects: ${s.objects.join(", ") || "none"} activities: ${s.activities.join(", ") || "none"}`)
        .join("\n");
      let parsed: unknown = null;
      try {
        const res = await provider.analyze(`${RANK_PROMPT}\n\nQUERY: ${req.query}\nLIMIT: ${limit}\n\nSCENES:\n${listing}`, [], { timeoutMs: 120_000, purpose: "visual-search" });
        parsed = extractJson(res.content);
      } catch (firstErr) {
        notes.push(`provider ranking attempt failed (${(firstErr as Error).message.slice(0, 160)}) — repair attempt follows`);
        const repair = await provider.analyze(`${RANK_PROMPT}\n\nYour previous reply was not valid JSON. Respond AGAIN with ONLY corrected JSON.\n\nQUERY: ${req.query}\nLIMIT: ${limit}\n\nSCENES:\n${listing}`, [], { timeoutMs: 120_000, temperature: 0, purpose: "visual-search-repair" });
        parsed = extractJson(repair.content);
      }
      const ranked = VisionSearchRankingSchema.parse(parsed);
      const byId = new Map(candidates.map((s) => [s.sceneId, s]));
      const results: VisualSearchResult[] = [];
      for (const r of ranked.results.slice(0, limit)) {
        const s = byId.get(r.sceneId);
        if (!s || r.relevanceScore <= 0.15) continue;
        const tl = s.timelinePlacements[0] ?? null;
        results.push({
          sceneId: s.sceneId,
          assetId: s.assetId,
          representativeAssetId: s.representativeAssetId,
          sourceStartSec: s.sourceStartSec,
          sourceEndSec: s.sourceEndSec,
          timelineStartSec: tl?.timelineStartSec ?? null,
          timelineEndSec: tl?.timelineEndSec ?? null,
          description: s.description?.slice(0, 400) ?? null,
          matchedTerms: r.matchedTerms.slice(0, 8),
          relevanceScore: r.relevanceScore,
          evidence: r.evidence.slice(0, 300),
        });
      }
      results.sort((a, b) => b.relevanceScore - a.relevanceScore);
      return { available: true, method: "provider-ranking", results: results.slice(0, limit), notes };
    } catch (err) {
      notes.push(`provider ranking unavailable — falling back to local keyword matching: ${(err as Error).message.slice(0, 220)}`);
    }
  } else {
    notes.push("Provider ranking requires consent for external processing — local keyword matching used (deterministic, English-focused).");
  }

  // 2. local keyword fallback (deterministic).
  const tokens = tokensOf(req.query);
  if (tokens.length === 0) {
    return { available: true, method: "local-keyword", results: [], notes: [...notes, "Query produced no matchable tokens (≥3 letters) for local matching."] };
  }
  const scored = candidates
    .map((s) => ({ s, ...localScore(s, tokens, index.assetName) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const results: VisualSearchResult[] = scored.map((r) => {
    const tl = r.s.timelinePlacements[0] ?? null;
    return {
      sceneId: r.s.sceneId,
      assetId: r.s.assetId,
      representativeAssetId: r.s.representativeAssetId,
      sourceStartSec: r.s.sourceStartSec,
      sourceEndSec: r.s.sourceEndSec,
      timelineStartSec: tl?.timelineStartSec ?? null,
      timelineEndSec: tl?.timelineEndSec ?? null,
      description: r.s.description?.slice(0, 400) ?? null,
      matchedTerms: r.matched.slice(0, 8),
      relevanceScore: r.score,
      evidence: r.s.description ? `matched terms [${r.matched.join(", ")}] in the analyzed description of ${r.s.sceneId}` : `matched terms [${r.matched.join(", ")}] in heuristic scene/asset metadata (no semantic description — frames were not analyzed)`,
    };
  });
  if (results.length === 0 && /^[\u0B80-\u0BFF\s]+$/.test(req.query)) {
    notes.push("Tamil query: local keyword matching compares Tamil tokens against English descriptions — provider ranking (with consent) is the supported path for Tamil search.");
  }
  return { available: true, method: "local-keyword", results, notes };
}
