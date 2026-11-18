"use client";

/**
 * LAXII panel (M7 §7/§11) — image creative tools in the editor.
 *
 * Only the provider's REAL options are exposed (7 sizes; no transparency, no
 * negative prompts — the provider has neither, stated in the capability map).
 * Outputs are registered assets with provenance; thumbnails and aspect
 * adaptations are CHILD assets (originals never modified). Inserting a still
 * onto a video/graphics track uses M1 commands; NIIKI can then animate it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image as ImageIcon, Loader2, Plus, RefreshCw, Sparkles, Wand2 } from "lucide-react";
import type { Sequence } from "@/lib/editor/model";
import type { EditorSession } from "@/hooks/use-editor-session";

interface OutputAsset {
  id: string;
  originalName: string;
  kind: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  createdAt: string;
  provider: string | null;
  model: string | null;
  prompt: string | null;
  attribution: string | null;
}

interface JobLite {
  id: string;
  status: string;
  progress: number;
  stage: string | null;
  message: string | null;
}

const SIZES = ["1024x1024", "768x1344", "864x1152", "1344x768", "1152x864", "1440x720", "720x1440"] as const;
const ASPECTS = ["original", "16:9", "9:16", "1:1", "4:5"] as const;

async function jfetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

let n = 0;
const newId = (kind: string) => `laxii-${kind}-${Date.now().toString(36)}-${(n++).toString(36)}`;

export function LaxiiPanel({ sequence, session }: { sequence: Sequence; session: EditorSession }) {
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<"generate" | "edit">("generate");
  const [size, setSize] = useState<(typeof SIZES)[number]>("1344x768");
  const [count, setCount] = useState(1);
  const [aspect, setAspect] = useState<(typeof ASPECTS)[number]>("original");
  const [referenceId, setReferenceId] = useState<string>("");
  const [imageAssets, setImageAssets] = useState<OutputAsset[]>([]);
  const [outputs, setOutputs] = useState<OutputAsset[]>([]);
  const [job, setJob] = useState<JobLite | null>(null);
  // M25 P5 — last generation params for honest retry + cancel support.
  const lastGen = useRef<{ prompt: string } | null>(null);
  const [busy, setBusy] = useState<null | "generate" | "insert">(null);
  const [notice, setNotice] = useState<string | null>(null);

  const seqEnd = useMemo(
    () => Math.ceil(sequence.clips.reduce((m, c) => Math.max(m, c.timelineStartFrame + c.timelineDurationFrames), 0)),
    [sequence.clips],
  );

  const refresh = useCallback(async () => {
    try {
      const mine = await jfetch<{ assets: OutputAsset[] }>("/api/ai/outputs?engine=LAXII");
      setOutputs(mine.assets);
      const all = await jfetch<{ assets: OutputAsset[] }>("/api/media/list?kind=IMAGE").catch(() => ({ assets: [] as OutputAsset[] }));
      setImageAssets(all.assets.filter((a) => a.kind === "IMAGE").slice(0, 20));
    } catch {
      /* history is non-critical */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const generate = useCallback(async () => {
    if (!prompt.trim() || busy) return;
    lastGen.current = { prompt };
    setBusy("generate");
    setNotice(null);
    try {
      const { jobId } = await jfetch<{ jobId: string }>("/api/laxii/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: prompt.slice(0, 2000),
          mode,
          referenceAssetId: mode === "edit" && referenceId ? referenceId : null,
          size,
          count,
          aspect,
          projectId: null,
        }),
      });
      const deadline = Date.now() + 12 * 60_000;
      for (;;) {
        if (Date.now() > deadline) throw new Error("LAXII polling timed out (12 min).");
        await new Promise((r) => setTimeout(r, 3000));
        const res = await jfetch<{ job: JobLite }>(`/api/jobs/${jobId}`);
        setJob(res.job);
        if (res.job.status === "COMPLETED") {
          setNotice(`LAXII complete: ${res.job.message ?? ""}`);
          await refresh();
          break;
        }
        if (res.job.status === "FAILED" || res.job.status === "CANCELLED") {
          setNotice(`LAXII generation did not complete: ${res.job.message ?? res.job.status}`);
          break;
        }
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "LAXII generation failed.");
    } finally {
      setBusy(null);
    }
  }, [prompt, busy, mode, referenceId, size, count, aspect, refresh]);

  /** Insert a still image as a clip on a VIDEO track (M1 commands; NIIKI-animatable). */
  const insertStill = useCallback(
    (asset: OutputAsset) => {
      const track = sequence.tracks.find((t) => t.kind === "VIDEO" && !t.locked) ?? sequence.tracks.find((t) => t.kind === "GRAPHIC" && !t.locked);
      if (!track) {
        setNotice("No unlocked VIDEO/GRAPHIC track — add one in the timeline first.");
        return;
      }
      const durFrames = Math.round((sequence.fps.num / sequence.fps.den) * 5); // 5 s still, editable
      const at = Math.max(0, Math.min(session.playheadFrame, Math.max(0, seqEnd - 1)));
      const ok = session.apply([
        {
          type: "AddClip",
          clip: {
            id: newId("clip"),
            trackId: track.id,
            sourceAssetId: asset.id,
            sourceInFrame: 0,
            sourceOutFrame: durFrames,
            sourceFps: { num: sequence.fps.num, den: sequence.fps.den },
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
            label: `LAXII: ${asset.prompt?.slice(0, 60) ?? asset.originalName}`,
            missingMedia: false,
            effects: [],
            keyframes: [],
          },
        },
      ]);
      setNotice(ok ? `Inserted still ${asset.originalName} on ${track.name} — NIIKI can animate position/scale/opacity via keyframes.` : "The command engine refused the insert.");
    },
    [sequence, session, seqEnd],
  );

  return (
    <div className="rounded-lg border border-[#2a2a2a] bg-[#0b0b0a] p-3">
      <div className="flex items-center justify-between">
        <h2 className="bean-label flex items-center gap-1.5 text-[10px] text-[#8f8f8a]">
          <Wand2 className="h-3 w-3 text-[#d4a017]" /> LAXII · IMAGE CREATIVE
        </h2>
      </div>
      {notice && <p className="mt-2 text-[10px] leading-relaxed text-[#a0a09a]">{notice}</p>}

      <div className="mt-2 space-y-1.5 text-[10px] text-[#8f8f8a]">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value.slice(0, 2000))}
          rows={2}
          placeholder="Describe the image: backgrounds, illustrations, thumbnails…"
          className="w-full rounded border border-[#2a2a2a] bg-[#111110] px-1.5 py-1 text-[10px] text-[#d4d4d0] placeholder:text-[#5a5a55]"
        />
        <div className="flex flex-wrap gap-1">
          <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} className="rounded border border-[#2a2a2a] bg-[#111110] px-1 py-0.5 text-[#d4d4d0]">
            <option value="generate">text→image</option>
            <option value="edit">image→image</option>
          </select>
          {mode === "edit" && (
            <select value={referenceId} onChange={(e) => setReferenceId(e.target.value)} className="max-w-[10rem] rounded border border-[#2a2a2a] bg-[#111110] px-1 py-0.5 text-[#d4d4d0]">
              <option value="">Reference image…</option>
              {imageAssets.map((a) => <option key={a.id} value={a.id}>{a.originalName}</option>)}
            </select>
          )}
          <select value={size} onChange={(e) => setSize(e.target.value as typeof size)} className="rounded border border-[#2a2a2a] bg-[#111110] px-1 py-0.5 text-[#d4d4d0]">
            {SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={count} onChange={(e) => setCount(Math.max(1, Math.min(4, Number(e.target.value))))} className="rounded border border-[#2a2a2a] bg-[#111110] px-1 py-0.5 text-[#d4d4d0]" title="Alternatives (each registered; originals preserved)">
            {[1, 2, 3, 4].map((c) => <option key={c} value={c}>{c}×</option>)}
          </select>
          <select value={aspect} onChange={(e) => setAspect(e.target.value as typeof aspect)} className="rounded border border-[#2a2a2a] bg-[#111110] px-1 py-0.5 text-[#d4d4d0]" title="Local aspect adaptation (child asset; original preserved)">
            {ASPECTS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          {busy === "generate" && job && (
            <button type="button" onClick={() => void fetch(`/api/jobs/${job.id}`, { method: "DELETE" }).catch(() => undefined)} className="rounded border border-[#c45c4c]/40 bg-[#c45c4c]/10 px-2 py-1 text-[#c45c4c] hover:bg-[#c45c4c]/20" title="Cancel the active generation job">
              CANCEL JOB
            </button>
          )}
          {busy !== "generate" && job?.status === "FAILED" && lastGen.current && (
            <button type="button" onClick={() => void generate()} className="rounded border border-[#d4a017] px-2 py-1 text-[#d4a017] hover:bg-[#d4a017]/10" title="Retry the last generation">
              RETRY
            </button>
          )}
          <button type="button" onClick={() => void generate()} disabled={busy !== null || !prompt.trim() || (mode === "edit" && !referenceId)} className="flex items-center gap-1 rounded border border-[#d4a017] bg-[#d4a017]/10 px-2 py-1 text-[#d4a017] hover:bg-[#d4a017]/20 disabled:opacity-40">
            {busy === "generate" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />} GENERATE
          </button>
        </div>
        <p className="text-[9px] leading-relaxed text-[#5a5a55]">
          Provider notes: no transparency or negative prompts (capability list is honest). Images are sent externally only when you press GENERATE.
        </p>
      </div>

      {job && (
        <p className="mt-2 text-[10px] text-[#a0a09a]">Job {job.id.slice(0, 10)}… · {job.stage ?? job.status} {job.progress}%</p>
      )}

      <div className="mt-3">
        <div className="flex items-center justify-between">
          <h3 className="bean-label text-[9px] text-[#7a7a76]">GENERATED IMAGES (PROVENANCE PRESERVED)</h3>
          <button type="button" onClick={() => void refresh()} className="text-[#5a5a55] hover:text-[#d4a017]"><RefreshCw className="h-3 w-3" /></button>
        </div>
        <div className="mt-1 space-y-1">
          {outputs.length === 0 && <p className="text-[9px] text-[#5a5a55]">No LAXII outputs yet.</p>}
          {outputs.slice(0, 6).map((a) => (
            <div key={a.id} className="flex items-center justify-between gap-2 rounded border border-[#1d1d1b] bg-[#101010] px-1.5 py-1 text-[10px] text-[#a0a09a]">
              <span className="min-w-0 flex-1 truncate" title={a.prompt ?? a.originalName}>
                <ImageIcon className="mr-1 inline h-3 w-3 text-[#d4a017]" />
                {a.originalName} · {a.width}×{a.height}{a.model ? ` · ${a.model}` : ""}
              </span>
              <button type="button" onClick={() => insertStill(a)} disabled={busy !== null} className="flex items-center gap-1 rounded border border-[#2a2a2a] px-1.5 py-0.5 text-[9px] text-[#d4a017] hover:border-[#d4a017] disabled:opacity-40">
                <Plus className="h-3 w-3" /> INSERT
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
