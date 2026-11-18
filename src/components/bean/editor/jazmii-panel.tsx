"use client";

/**
 * JAZMII panel (M7 §6/§11) — video creative tools in the editor.
 *
 * Shot suggestions come from the deterministic JAZMII engine (proposal API);
 * generation goes through the durable worker (real job status; the provider
 * supplies task status, not fake progress). Inserting footage into the
 * timeline uses M1 commands exclusively. Provider options shown here mirror
 * the provider's REAL capability map — no decorative controls.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Film, Loader2, Scissors, Sparkles, Plus, RefreshCw } from "lucide-react";
import type { Sequence } from "@/lib/editor/model";
import type { EditorSession } from "@/hooks/use-editor-session";
import { clipEndFrame } from "@/lib/editor/model";

interface OutputAsset {
  id: string;
  originalName: string;
  kind: string;
  mimeType: string;
  sizeBytes: number;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  createdAt: string;
  provider: string | null;
  model: string | null;
  prompt: string | null;
  attribution: string | null;
}

interface Suggestion {
  id: string;
  description: string;
  subject: string;
  shotType: string;
  durationFrames: number;
  prompt: string | null;
  rationale: string;
  confidence: number | null;
  providerHint: string | null;
}

interface JobLite {
  id: string;
  status: string;
  progress: number;
  stage: string | null;
  message: string | null;
}

async function jfetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

let n = 0;
const newId = (kind: string) => `jazmii-${kind}-${Date.now().toString(36)}-${(n++).toString(36)}`;

export function JazmiiPanel({ sequence, session }: { sequence: Sequence; session: EditorSession }) {
  const [prompt, setPrompt] = useState("");
  const [quality, setQuality] = useState<"speed" | "quality">("speed");
  const [size, setSize] = useState<"1920x1080" | "1280x720" | "1080x1920" | "720x1280">("1920x1080");
  const [fps, setFps] = useState<"30" | "60">("30");
  const [durationSec, setDurationSec] = useState<"5" | "10">("5");
  const [withAudio, setWithAudio] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [job, setJob] = useState<JobLite | null>(null);
  const [outputs, setOutputs] = useState<OutputAsset[]>([]);
  const [busy, setBusy] = useState<null | "suggest" | "generate" | "insert" | "analyze">(null);
  const [notice, setNotice] = useState<string | null>(null);
  // M24 §3.E — footage analysis access (real /api/jazmii/analyze → background job).
  const [videoAssets, setVideoAssets] = useState<Array<{ id: string; originalName: string }>>([]);
  const [analyzeMediaId, setAnalyzeMediaId] = useState("");
  const [analyzeBusy, setAnalyzeBusy] = useState(false);

  const seqEnd = useMemo(
    () => Math.ceil(sequence.clips.reduce((m, c) => Math.max(m, c.timelineStartFrame + c.timelineDurationFrames), 0)),
    [sequence.clips],
  );
  const contextTexts = useMemo(() => {
    const texts: string[] = [];
    for (const c of sequence.clips) {
      if (c.captionText) texts.push(c.captionText);
      if (c.label) texts.push(c.label);
    }
    return texts.slice(0, 30);
  }, [sequence.clips]);

  const refreshOutputs = useCallback(async () => {
    try {
      const res = await jfetch<{ assets: OutputAsset[] }>("/api/ai/outputs?engine=JAZMII");
      setOutputs(res.assets.filter((a) => a.kind === "VIDEO"));
    } catch {
      /* history is non-critical */
    }
  }, []);

  useEffect(() => {
    void refreshOutputs();
  }, [refreshOutputs]);

  // M24 §3.E — load the user's video assets once for the analyze selector.
  useEffect(() => {
    fetch("/api/media/list?kind=VIDEO")
      .then((r) => (r.ok ? r.json() : { assets: [] }))
      .then((d: { assets?: Array<{ id: string; originalName: string }> }) => setVideoAssets((d.assets ?? []).slice(0, 50)))
      .catch(() => setVideoAssets([]));
  }, []);

  /** M24 §3.E — analyze a library video: real job (shot detection + keyframes),
   *  same durable pipeline as generation; polls /api/jobs/[id] like generate(). */
  const analyzeFootage = useCallback(async () => {
    if (!analyzeMediaId || analyzeBusy) return;
    setAnalyzeBusy(true);
    setNotice(null);
    try {
      const { jobId } = await jfetch<{ jobId: string }>("/api/jazmii/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mediaId: analyzeMediaId }),
      });
      const deadline = Date.now() + 10 * 60_000;
      for (;;) {
        if (Date.now() > deadline) throw new Error("Analysis polling timed out (10 min) — the job may still finish; check history later.");
        await new Promise((r) => setTimeout(r, 3000));
        const res = await jfetch<{ job: JobLite }>(`/api/jobs/${jobId}`);
        setJob(res.job);
        if (res.job.status === "COMPLETED") {
          setNotice(`Analysis complete: ${res.job.message ?? ""}`);
          break;
        }
        if (res.job.status === "FAILED" || res.job.status === "CANCELLED") {
          setNotice(`Analysis did not complete: ${res.job.message ?? res.job.status}`);
          break;
        }
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Analysis failed.");
    } finally {
      setAnalyzeBusy(false);
    }
  }, [analyzeMediaId, analyzeBusy]);

  const suggest = useCallback(async () => {
    setBusy("suggest");
    setNotice(null);
    try {
      const res = await jfetch<{ suggestions: Suggestion[] }>("/api/jazmii/proposal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ texts: contextTexts, fps: sequence.fps.num / sequence.fps.den, sequenceFrames: Math.max(24, seqEnd) }),
      });
      setSuggestions(res.suggestions);
      setNotice(res.suggestions.length ? `${res.suggestions.length} deterministic shot suggestion(s) — approve each one; nothing auto-runs.` : "No context matched. Add captions/labels or use direct generation.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Suggestion request failed.");
    } finally {
      setBusy(null);
    }
  }, [contextTexts, sequence.fps, seqEnd]);

  const generate = useCallback(
    async (genPrompt: string, genDuration: "5" | "10") => {
      if (!genPrompt.trim() || busy) return;
      setBusy("generate");
      setNotice(null);
      try {
        const { jobId } = await jfetch<{ jobId: string }>("/api/jazmii/generate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt: genPrompt.slice(0, 2000), operation: "textToVideo", quality, size, fps, durationSec: genDuration, withAudio, projectId: null }),
        });
        const deadline = Date.now() + 18 * 60_000;
        for (;;) {
          if (Date.now() > deadline) throw new Error("JAZMII polling timed out (18 min). The provider task may still finish — check the history later.");
          await new Promise((r) => setTimeout(r, 3000));
          const res = await jfetch<{ job: JobLite }>(`/api/jobs/${jobId}`);
          setJob(res.job);
          if (res.job.status === "COMPLETED") {
            setNotice(`JAZMII generation complete: ${res.job.message ?? ""}`);
            await refreshOutputs();
            break;
          }
          if (res.job.status === "FAILED" || res.job.status === "CANCELLED") {
            setNotice(`JAZMII generation did not complete: ${res.job.message ?? res.job.status}`);
            break;
          }
        }
      } catch (err) {
        setNotice(err instanceof Error ? err.message : "JAZMII generation failed.");
      } finally {
        setBusy(null);
      }
    },
    [busy, quality, size, fps, durationSec, withAudio, refreshOutputs],
  );

  /** Insert a generated/imported video as a clip on the first VIDEO track. */
  const insertAsset = useCallback(
    async (asset: OutputAsset) => {
      setBusy("insert");
      setNotice(null);
      try {
        const meta = await jfetch<{ media: { durationSec: number | null; fps: number | null; width: number | null; height: number | null } }>(`/api/media/${asset.id}`);
        const fpsNum = meta.media.fps && meta.media.fps > 0 ? meta.media.fps : sequence.fps.num / sequence.fps.den;
        const durFrames = Math.max(12, Math.round((meta.media.durationSec ?? Number(durationSec)) * fpsNum));
        const videoTrack = sequence.tracks.find((t) => t.kind === "VIDEO" && !t.locked);
        if (!videoTrack) {
          setNotice("No unlocked VIDEO track — add one in the timeline first.");
          return;
        }
        const at = Math.max(0, Math.min(session.playheadFrame, Math.max(0, seqEnd - 1)));
        const ok = session.apply([
          {
            type: "AddClip",
            clip: {
              id: newId("clip"),
              trackId: videoTrack.id,
              sourceAssetId: asset.id,
              sourceInFrame: 0,
              sourceOutFrame: durFrames,
              sourceFps: { num: Math.round(fpsNum * 1000), den: 1000 },
              timelineStartFrame: at,
              playbackSpeed: 1,
              volume: 1,
              muted: false,
              fadeInFrames: 0,
              fadeOutFrames: 0,
              transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
              captionText: null,
              captionStyle: null,
              graphicTemplateId: null,
              graphicStyle: null,
              label: `JAZMII: ${asset.prompt?.slice(0, 60) ?? asset.originalName}`,
              missingMedia: false,
              effects: [],
              keyframes: [],
            },
          },
        ]);
        setNotice(ok ? `Inserted ${asset.originalName} at the playhead on ${videoTrack.name} — trim/split/move/undo all work.` : "The command engine refused the insert (track locked?).");
      } catch (err) {
        setNotice(err instanceof Error ? err.message : "Insert failed.");
      } finally {
        setBusy(null);
      }
    },
    [sequence, session, seqEnd, durationSec],
  );

  const selectedClip = sequence.clips.find((c) => c.id === session.selectedClipId) ?? null;

  return (
    <div className="rounded-lg border border-[#2a2a2a] bg-[#0b0b0a] p-3">
      <div className="flex items-center justify-between">
        <h2 className="bean-label flex items-center gap-1.5 text-[10px] text-[#8f8f8a]">
          <Film className="h-3 w-3 text-[#d4a017]" /> JAZMII · VIDEO CREATIVE
        </h2>
        <button type="button" onClick={() => void suggest()} disabled={busy !== null} className="flex items-center gap-1 rounded border border-[#2a2a2a] bg-[#111110] px-2 py-1 text-[10px] text-[#d4a017] hover:border-[#d4a017] disabled:opacity-40" title="Deterministic shot suggestions from captions/labels">
          {busy === "suggest" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />} SUGGEST
        </button>
      </div>
      {notice && <p className="mt-2 text-[10px] leading-relaxed text-[#a0a09a]">{notice}</p>}

      {suggestions.length > 0 && (
        <div className="mt-2 space-y-1">
          {suggestions.map((s) => (
            <div key={s.id} className="rounded border border-[#1d1d1b] bg-[#101010] p-1.5 text-[10px] text-[#a0a09a]">
              <p className="text-[#d4d4d0]">{s.description} · {s.shotType} · {s.durationFrames}f</p>
              <p className="text-[9px] text-[#5a5a55]">{s.rationale}{s.confidence === null ? " · confidence: null (deterministic match)" : ""}</p>
              {s.prompt && (
                <button type="button" onClick={() => void generate(s.prompt!, "5")} disabled={busy !== null} className="mt-1 flex items-center gap-1 rounded border border-[#d4a017] bg-[#d4a017]/10 px-1.5 py-0.5 text-[9px] text-[#d4a017] hover:bg-[#d4a017]/20 disabled:opacity-40">
                  {busy === "generate" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />} APPROVE & GENERATE
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* M24 §3.E — footage analysis (shot detection + keyframes) on library videos. */}
      <div className="mt-3 space-y-1.5 text-[10px] text-[#8f8f8a]">
        <h3 className="bean-label text-[9px] text-[#7a7a76]">ANALYZE FOOTAGE (SHOT DETECTION + KEYFRAMES)</h3>
        <div className="flex gap-1">
          <select
            aria-label="Video to analyze"
            value={analyzeMediaId}
            onChange={(e) => setAnalyzeMediaId(e.target.value)}
            className="min-w-0 flex-1 rounded border border-[#2a2a2a] bg-[#111110] px-1 py-0.5 text-[10px] text-[#d4d4d0]"
          >
            <option value="">Select a video from your library…</option>
            {videoAssets.map((a) => <option key={a.id} value={a.id}>{a.originalName.slice(0, 60)}</option>)}
          </select>
          <button
            type="button"
            onClick={() => void analyzeFootage()}
            disabled={analyzeBusy || busy !== null || !analyzeMediaId}
            className="flex items-center gap-1 rounded border border-[#d4a017] bg-[#d4a017]/10 px-2 py-1 text-[#d4a017] hover:bg-[#d4a017]/20 disabled:opacity-40"
            title="Run real footage analysis as a background job"
          >
            {analyzeBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />} ANALYZE
          </button>
        </div>
        {videoAssets.length === 0 && <p className="text-[9px] text-[#5a5a55]">No videos in your library yet — upload or generate one first.</p>}
      </div>

      <div className="mt-3 space-y-1.5 text-[10px] text-[#8f8f8a]">
        <h3 className="bean-label text-[9px] text-[#7a7a76]">DIRECT GENERATION (PROVIDER OPTIONS ONLY)</h3>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value.slice(0, 2000))}
          rows={2}
          placeholder="Describe the footage to generate…"
          className="w-full rounded border border-[#2a2a2a] bg-[#111110] px-1.5 py-1 text-[10px] text-[#d4d4d0] placeholder:text-[#5a5a55]"
        />
        <div className="flex flex-wrap gap-1">
          <select value={quality} onChange={(e) => setQuality(e.target.value as typeof quality)} className="rounded border border-[#2a2a2a] bg-[#111110] px-1 py-0.5 text-[#d4d4d0]">
            <option value="speed">speed</option>
            <option value="quality">quality</option>
          </select>
          <select value={size} onChange={(e) => setSize(e.target.value as typeof size)} className="rounded border border-[#2a2a2a] bg-[#111110] px-1 py-0.5 text-[#d4d4d0]">
            {["1920x1080", "1280x720", "1080x1920", "720x1280"].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={fps} onChange={(e) => setFps(e.target.value as typeof fps)} className="rounded border border-[#2a2a2a] bg-[#111110] px-1 py-0.5 text-[#d4d4d0]">
            <option value="30">30fps</option>
            <option value="60">60fps</option>
          </select>
          <select value={durationSec} onChange={(e) => setDurationSec(e.target.value as typeof durationSec)} className="rounded border border-[#2a2a2a] bg-[#111110] px-1 py-0.5 text-[#d4d4d0]">
            <option value="5">5 s</option>
            <option value="10">10 s</option>
          </select>
          <label className="flex items-center gap-1 text-[9px]">
            <input type="checkbox" checked={withAudio} onChange={(e) => setWithAudio(e.target.checked)} /> AI audio
          </label>
          <button type="button" onClick={() => void generate(prompt, durationSec)} disabled={busy !== null || !prompt.trim()} className="flex items-center gap-1 rounded border border-[#d4a017] bg-[#d4a017]/10 px-2 py-1 text-[#d4a017] hover:bg-[#d4a017]/20 disabled:opacity-40">
            {busy === "generate" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Film className="h-3 w-3" />} GENERATE
          </button>
        </div>
        {selectedClip && (
          <button
            type="button"
            onClick={() => {
              const clip = selectedClip;
              const texts = [clip.captionText ?? "", clip.label ?? ""].filter(Boolean);
              void jfetch<{ suggestions: Suggestion[] }>("/api/jazmii/proposal", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ texts, fps: sequence.fps.num / sequence.fps.den, sequenceFrames: Math.max(24, seqEnd) }),
              }).then((r) => setSuggestions(r.suggestions)).catch(() => setNotice("Suggestion request failed."));
            }}
            className="mt-1 flex items-center gap-1 rounded border border-[#2a2a2a] bg-[#111110] px-1.5 py-0.5 text-[9px] text-[#8f8f8a] hover:border-[#d4a017]"
            title="Suggest cutaways for the selected clip's caption/label"
          >
            <Scissors className="h-3 w-3" /> Suggest for selected clip
          </button>
        )}
      </div>

      {job && (
        <p className="mt-2 text-[10px] text-[#a0a09a]">
          Job {job.id.slice(0, 10)}… · {job.stage ?? job.status} {job.progress}%
        </p>
      )}

      <div className="mt-3">
        <div className="flex items-center justify-between">
          <h3 className="bean-label text-[9px] text-[#7a7a76]">GENERATED FOOTAGE (PROVENANCE PRESERVED)</h3>
          <button type="button" onClick={() => void refreshOutputs()} className="text-[#5a5a55] hover:text-[#d4a017]" title="Refresh history"><RefreshCw className="h-3 w-3" /></button>
        </div>
        <div className="mt-1 space-y-1">
          {outputs.length === 0 && <p className="text-[9px] text-[#5a5a55]">No JAZMII outputs yet.</p>}
          {outputs.slice(0, 5).map((a) => (
            <div key={a.id} className="flex items-center justify-between gap-2 rounded border border-[#1d1d1b] bg-[#101010] px-1.5 py-1 text-[10px] text-[#a0a09a]">
              <span className="min-w-0 flex-1 truncate" title={a.prompt ?? a.originalName}>
                {a.originalName} · {a.width}×{a.height}{a.durationSec ? ` · ${a.durationSec.toFixed(1)}s` : ""}
              </span>
              <button type="button" onClick={() => void insertAsset(a)} disabled={busy !== null} className="flex items-center gap-1 rounded border border-[#2a2a2a] px-1.5 py-0.5 text-[9px] text-[#d4a017] hover:border-[#d4a017] disabled:opacity-40">
                <Plus className="h-3 w-3" /> INSERT
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
