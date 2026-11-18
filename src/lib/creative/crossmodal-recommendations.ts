/**
 * M11 §7 — scene-aware recommendations routed from cross-modal findings.
 * Same typed payload contract as M10 (timeline-commands | engine-action |
 * informational); no new execution paths.
 */
import type { MeasuredContext } from "./context";
import type { Finding, Recommendation } from "./contracts";

export function buildCrossModalRecommendations(ctx: MeasuredContext, findings: Finding[]): Recommendation[] {
  const recs: Recommendation[] = [];
  const used = new Set<number>();
  const add = (r: Recommendation) => {
    if (used.has(r.recNo)) return;
    used.add(r.recNo);
    recs.push(r);
  };
  for (const f of findings) {
    if (f.category === "narration-without-visuals") {
      add({
        recNo: f.findingNo,
        engine: "JAZMII",
        kind: "executable",
        title: `Generate B-roll for unsupported narration @ ${f.startSec?.toFixed(1) ?? "?"}s`,
        detail: "Spoken narration plays with no video coverage. Queue a JAZMII text-to-video generation as candidate b-roll — a NEW asset is created; nothing changes on the timeline until you insert it.",
        target: { clipId: null, trackId: null, startSec: f.startSec, endSec: f.endSec },
        payload: { kind: "engine-action", engine: "JAZMII", action: "jazmii-broll", params: { prompt: "b-roll cutaway matching the narration topic (derived from the review evidence)", size: "1920x1080", durationSec: "5" } },
        preview: { engine: "JAZMII", note: "metered external provider; result lands in the media library" },
        requiresApproval: true,
        rationale: `Finding #${f.findingNo} (${f.category}, ${f.evidenceLabel}): ${f.explanation.slice(0, 260)}`,
      });
    }
    if (f.category === "static-visuals" && f.evidenceLabel === "model-observed") {
      add({
        recNo: f.findingNo,
        engine: "JAZMII",
        kind: "informational",
        title: `Cover the static hold @ ${f.startSec?.toFixed(1) ?? "?"}s`,
        detail: "Local scene analysis measured a static section. Options: insert a cutaway (JAZMII/LAXII assets), tighten the hold on the timeline, or add NIIKI motion text. Measured evidence; creative choice is yours.",
        target: { clipId: null, trackId: null, startSec: f.startSec, endSec: f.endSec },
        payload: { kind: "informational", note: "static section — cutaway/trim/motion-text options" },
        preview: null,
        requiresApproval: false,
        rationale: `Finding #${f.findingNo} (model-observed by local JAZMII scene analysis).`,
      });
    }
    if (f.category === "caption-mismatch" && f.evidenceLabel === "inferred") {
      add({
        recNo: f.findingNo,
        engine: "RIISHE",
        kind: "informational",
        title: "Re-align captions with the transcript",
        detail: "Captions share limited wording with the measured transcript. If captions should follow narration, run the integrated transcription (M11) and APPROVE it — that creates a NEW SRT asset; your existing captions are never overwritten.",
        target: null,
        payload: { kind: "informational", note: "transcript-based caption regeneration preserves existing captions" },
        preview: null,
        requiresApproval: false,
        rationale: `Finding #${f.findingNo} (measured overlap below threshold).`,
      });
    }
    if (f.category === "visuals-without-narration") {
      add({
        recNo: f.findingNo,
        engine: "GANGZII",
        kind: "informational",
        title: `Add narration or music under the silent visual @ ${f.startSec?.toFixed(1) ?? "?"}s`,
        detail: "A visual section runs with no speech. Options: record/generate narration (Studio TTS), add music (GANGZII processing presets), or intentionally keep the quiet beat. Verify embedded audio covers it first (multimodal analysis).",
        target: { clipId: null, trackId: null, startSec: f.startSec, endSec: f.endSec },
        payload: { kind: "informational", note: "silent visual section — narration/music options" },
        preview: null,
        requiresApproval: false,
        rationale: `Finding #${f.findingNo} (measured transcript coverage gap).`,
      });
    }
    if (f.category === "audio-gap") {
      add({
        recNo: f.findingNo,
        engine: "GANGZII",
        kind: "informational",
        title: `Verify audio coverage @ ${f.startSec?.toFixed(1) ?? "?"}s`,
        detail: "A visual stretch has no dedicated audio clip beneath it. If the source video carries embedded audio this is fine (multimodal analysis measures it); otherwise add narration/music or the stretch will be silent.",
        target: { clipId: null, trackId: null, startSec: f.startSec, endSec: f.endSec },
        payload: { kind: "informational", note: "possible silent stretch — verify embedded audio" },
        preview: null,
        requiresApproval: false,
        rationale: `Finding #${f.findingNo} (measured audio-clip coverage gap).`,
      });
    }
    if (f.category === "av-sync" && f.severity !== "info") {
      add({
        recNo: f.findingNo,
        engine: "MYAI",
        kind: "informational",
        title: "Review A/V duration drift",
        detail: "Embedded audio diverges from the video stream beyond tolerance. Re-encode the source with matched streams, or trim the tail before import. BEAN FX never modifies source media.",
        target: null,
        payload: { kind: "informational", note: "source-level drift — re-encode or trim before use" },
        preview: null,
        requiresApproval: false,
        rationale: `Finding #${f.findingNo} (measured drift).`,
      });
    }
  }
  void ctx;
  return recs;
}
