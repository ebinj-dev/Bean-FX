"use client";

/**
 * GANGZII panel (M5 §5) — the audio intelligence engine inside the editor.
 *
 * Mounted under the clip inspector: analyse the selected clip's media,
 * pick/edit processing parameters, apply them to a DERIVED asset and swap
 * the clip via ONE validated ReplaceClip command (undo/redo and autosave
 * come free from the M1/M2 session). A/B bypass swaps back to the original;
 * the original media is never modified.
 *
 * All server interaction goes through the thin GANGZII API (owner-checked,
 * zod-validated); the panel never composes FFmpeg arguments.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Sparkles, Activity, ArrowLeftRight, RefreshCw, Trash2 } from "lucide-react";
import type { Sequence } from "@/lib/editor/model";
import type { EditorSession } from "@/hooks/use-editor-session";
import { GANGZII_PRESETS, presetById } from "@/lib/gangzii/presets";
import type { GangziiInspection, GangziiParams } from "@/lib/gangzii/types";

interface ProcessRow {
  id: string;
  kind: string;
  status: string;
  name: string | null;
  paramsJson: string | null;
  analysisJson: string | null;
  resultAssetId: string | null;
  resultMetaJson: string | null;
  error: string | null;
  createdAt: string;
}

interface ProcessDetail {
  process: ProcessRow;
  job: { id: string; status: string; progress: number; stage: string | null; message: string | null } | null;
}

const num2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : "—");

async function jfetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

async function pollProcess(processId: string, onTick?: (p: ProcessDetail) => void): Promise<ProcessDetail> {
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error("GANGZII job timed out while polling (10 min).");
    const detail = await jfetch<ProcessDetail>(`/api/gangzii/process/${processId}`).catch(() => null);
    if (detail) {
      onTick?.(detail);
      const jobStatus = detail.job?.status;
      if (jobStatus === "COMPLETED" || jobStatus === "FAILED" || jobStatus === "CANCELLED") return detail;
      if (detail.process.status === "COMPLETED" || detail.process.status === "FAILED") return detail;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export function GangziiPanel({ sequence, session }: { sequence: Sequence; session: EditorSession }) {
  const clip = useMemo(
    () => sequence.clips.find((c) => c.id === session.selectedClipId) ?? null,
    [sequence, session.selectedClipId],
  );
  const assetId = clip?.sourceAssetId ?? null;
  const [analysis, setAnalysis] = useState<GangziiInspection | null>(null);
  const [params, setParams] = useState<GangziiParams | null>(null);
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [busy, setBusy] = useState<"analyze" | "process" | null>(null);
  const [progress, setProgress] = useState<string>("");
  const [notice, setNotice] = useState<string | null>(null);
  const [processes, setProcesses] = useState<ProcessRow[]>([]);
  const [originId, setOriginId] = useState<string | null>(null);
  const lastAppliedRef = useRef<{ clipId: string; originalAssetId: string; derivedAssetId: string } | null>(null);

  const reloadProcesses = useCallback(
    async (mediaId: string) => {
      try {
        const res = await jfetch<{ processes: ProcessRow[] }>(`/api/gangzii/processes?mediaId=${encodeURIComponent(mediaId)}`);
        setProcesses(res.processes);
        const latestAnalysis = res.processes.find((p) => p.kind === "ANALYSIS" && p.status === "COMPLETED");
        if (latestAnalysis?.analysisJson) {
          const parsed = GangziiInspectionSchemaSafe(latestAnalysis.analysisJson);
          if (parsed) setAnalysis(parsed);
        }
        const latestParams = res.processes.find((p) => p.kind === "PROCESS" && p.paramsJson);
        if (latestParams?.paramsJson) {
          try {
            setParams(sanitizeParams(JSON.parse(latestParams.paramsJson)));
            setActivePreset(null);
          } catch { /* keep defaults */ }
        }
      } catch (err) {
        setNotice(err instanceof Error ? err.message : "Failed to load GANGZII history.");
      }
    },
    [],
  );

  // Resolve the ORIGINAL asset when the selected clip points at a derived one
  // (A/B bypass after a reload), and load persisted history per asset.
  useEffect(() => {
    setAnalysis(null);
    setParams(null);
    setActivePreset(null);
    setNotice(null);
    setOriginId(null);
    lastAppliedRef.current = null;
    if (!assetId) return;
    void reloadProcesses(assetId);
    void (async () => {
      try {
        const res = await jfetch<{ mediaId: string | null }>(`/api/gangzii/processes?resultAssetId=${encodeURIComponent(assetId)}`);
        if (res.mediaId && res.mediaId !== assetId) {
          setOriginId(res.mediaId);
          await reloadProcesses(res.mediaId);
        }
      } catch { /* derived-origin lookup is best-effort */ }
    })();
  }, [assetId, reloadProcesses]);

  const effectiveParams: GangziiParams = useMemo(() => {
    if (params) return params;
    return sanitizeParams({});
  }, [params]);

  const applyPreset = useCallback((id: string) => {
    const preset = presetById(id);
    if (!preset) return;
    setParams(sanitizeParams(preset.params));
    setActivePreset(id);
  }, []);

  const runAnalyze = useCallback(async () => {
    if (!assetId || busy) return;
    setBusy("analyze");
    setNotice(null);
    setProgress("Queued…");
    try {
      const { processId } = await jfetch<{ processId: string }>("/api/gangzii/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mediaId: assetId }),
      });
      const detail = await pollProcess(processId, (d) => setProgress(`${d.job?.stage ?? "Working"} ${d.job?.progress ?? 0}%`));
      if (detail.process.status === "COMPLETED" && detail.process.analysisJson) {
        const parsed = GangziiInspectionSchemaSafe(detail.process.analysisJson);
        if (parsed) {
          setAnalysis(parsed);
          setNotice(
            `Analysis complete: ${parsed.loudness.integratedLufs ?? "n/a"} LUFS · TP ${parsed.truePeakDbtp} dBTP` +
              (parsed.clipping.suspected ? " · clipping detected" : "") +
              (parsed.channelImbalanceDb && parsed.channelImbalanceDb >= 1 ? ` · channel imbalance ${parsed.channelImbalanceDb} dB` : ""),
          );
        }
        void reloadProcesses(assetId);
      } else {
        setNotice(`Analysis did not complete: ${detail.process.error ?? detail.job?.message ?? "unknown reason"}`);
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Analysis failed.");
    } finally {
      setBusy(null);
      setProgress("");
    }
  }, [assetId, busy, reloadProcesses]);

  /** Apply params → derived asset → swap the clip with ONE ReplaceClip command. */
  const runApply = useCallback(
    async (paramsOverride?: GangziiParams, sourceOverride?: string, nameOverride?: string) => {
      if (!clip || busy) return;
      const sourceAssetId = sourceOverride ?? clip.sourceAssetId;
      if (!sourceAssetId) return;
      setBusy("process");
      setNotice(null);
      setProgress("Queued…");
      try {
        const { processId } = await jfetch<{ processId: string }>("/api/gangzii/process", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sourceAssetId, params: paramsOverride ?? effectiveParams, name: nameOverride ?? activePreset ?? "custom" }),
        });
        const detail = await pollProcess(processId, (d) => setProgress(`${d.job?.stage ?? "Working"} ${d.job?.progress ?? 0}%`));
        if (detail.process.status === "COMPLETED" && detail.process.resultAssetId) {
          const derivedAssetId = detail.process.resultAssetId;
          // One validated command — undo/redo and autosave are session-native.
          const ok = session.apply([
            {
              type: "ReplaceClip",
              clipId: clip.id,
              newSourceAssetId: derivedAssetId,
              newSourceInFrame: clip.sourceInFrame,
              newSourceOutFrame: clip.sourceOutFrame,
            },
          ]);
          lastAppliedRef.current = { clipId: clip.id, originalAssetId: sourceAssetId, derivedAssetId };
          if (sourceAssetId === clip.sourceAssetId && originId === null) setOriginId(sourceAssetId);
          if (ok) {
            const meta = detail.process.resultMetaJson ? (JSON.parse(detail.process.resultMetaJson) as { warnings?: string[]; notes?: string[] }) : null;
            setNotice(
              `GANGZII applied to clip (undo with Ctrl+Z). Derived asset ${derivedAssetId}.` +
                (meta?.warnings?.length ? ` Warnings: ${meta.warnings.join(" ")}` : ""),
            );
          } else {
            setNotice("The command engine refused the swap (locked track?) — the derived asset was created; use REPROCESS to re-apply.");
          }
          void reloadProcesses(clip.sourceAssetId);
        } else {
          setNotice(`Processing did not complete: ${detail.process.error ?? detail.job?.message ?? "unknown reason"}`);
        }
      } catch (err) {
        setNotice(err instanceof Error ? err.message : "Processing failed.");
      } finally {
        setBusy(null);
        setProgress("");
      }
    },
    [clip, busy, effectiveParams, activePreset, session, originId, reloadProcesses],
  );

  /** A/B bypass: swap the clip between the derived asset and the original. */
  const toggleBypass = useCallback(() => {
    if (!clip) return;
    const ref = lastAppliedRef.current;
    const original = originId;
    if (original && clip.sourceAssetId !== original) {
      const ok = session.apply([
        { type: "ReplaceClip", clipId: clip.id, newSourceAssetId: original, newSourceInFrame: clip.sourceInFrame, newSourceOutFrame: clip.sourceOutFrame },
      ]);
      if (ok) setNotice("BYPASS: clip plays the ORIGINAL audio (undo with Ctrl+Z).");
    } else if (ref && ref.clipId === clip.id && clip.sourceAssetId === ref.originalAssetId) {
      const ok = session.apply([
        { type: "ReplaceClip", clipId: clip.id, newSourceAssetId: ref.derivedAssetId, newSourceInFrame: clip.sourceInFrame, newSourceOutFrame: clip.sourceOutFrame },
      ]);
      if (ok) setNotice("PROCESS: clip plays the GANGZII-derived audio (undo with Ctrl+Z).");
    } else {
      setNotice("A/B needs a processed version of this clip — apply GANGZII first.");
    }
  }, [clip, originId, session]);

  const deleteProcess = useCallback(
    async (id: string) => {
      try {
        await jfetch(`/api/gangzii/process/${id}`, { method: "DELETE" });
        if (assetId) void reloadProcesses(assetId);
        setNotice("GANGZII record deleted (derived file removed; original untouched).");
      } catch (err) {
        setNotice(err instanceof Error ? err.message : "Delete failed.");
      }
    },
    [assetId, reloadProcesses],
  );

  if (!clip || !assetId) {
    return (
      <div className="rounded-lg border border-[#2a2a2a] bg-[#0b0b0a] p-3">
        <h2 className="bean-label text-[10px] text-[#8f8f8a]">GANGZII · AUDIO INTELLIGENCE</h2>
        <p className="mt-2 text-xs text-[#7a7a76]">Select an audio or video clip to analyse and process its audio.</p>
      </div>
    );
  }

  const isRunning = busy !== null;
  const patch = (over: Partial<GangziiParams>) => {
    setParams(sanitizeParams({ ...effectiveParams, ...over }));
    setActivePreset(null);
  };

  return (
    <div className="rounded-lg border border-[#2a2a2a] bg-[#0b0b0a] p-3">
      <div className="flex items-center justify-between">
        <h2 className="bean-label flex items-center gap-1.5 text-[10px] text-[#8f8f8a]">
          <Sparkles className="h-3 w-3 text-[#d4a017]" /> GANGZII · AUDIO INTELLIGENCE
        </h2>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => void runAnalyze()}
            disabled={isRunning}
            className="flex items-center gap-1 rounded border border-[#2a2a2a] bg-[#111110] px-2 py-1 text-[10px] text-[#d4a017] hover:border-[#d4a017] disabled:opacity-40"
            title="Analyse this clip's media (loudness, true peak, clipping, spectrum, noise floor)"
          >
            {busy === "analyze" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Activity className="h-3 w-3" />} ANALYZE
          </button>
          <button
            type="button"
            onClick={toggleBypass}
            disabled={isRunning}
            className="flex items-center gap-1 rounded border border-[#2a2a2a] bg-[#111110] px-2 py-1 text-[10px] text-[#8f8f8a] hover:border-[#d4a017] disabled:opacity-40"
            title="A/B bypass: swap the clip between original and processed audio"
          >
            <ArrowLeftRight className="h-3 w-3" /> A/B
          </button>
        </div>
      </div>

      {progress && <p className="mt-2 text-[10px] text-[#d4a017]">{progress}</p>}
      {notice && <p className="mt-2 text-[10px] leading-relaxed text-[#a0a09a]">{notice}</p>}

      {/* Measurements */}
      {analysis && (
        <dl className="mt-3 grid grid-cols-3 gap-1.5 text-[10px]">
          {[
            ["LUFS", num2(analysis.loudness.integratedLufs ?? NaN)],
            ["LRA", num2(analysis.loudness.lraLu ?? NaN)],
            ["TRUE PEAK", `${num2(analysis.truePeakDbtp)} dBTP`],
            ["SAMPLE PEAK", `${num2(analysis.samplePeakDbfs)} dBFS`],
            ["NOISE FLOOR", analysis.noiseFloorDbfs !== null ? `${num2(analysis.noiseFloorDbfs)} dBFS` : "—"],
            ["CLIPPING", analysis.clipping.suspected ? `${analysis.clipping.runs} runs ⚠` : "none"],
            ["DC OFFSET", `${analysis.dcOffsetPerChannel.map((v) => v.toFixed(3)).join(", ")}`],
            ["IMBALANCE", analysis.channelImbalanceDb !== null ? `${num2(analysis.channelImbalanceDb)} dB` : "—"],
            ["CLASS", analysis.levels.classification.toUpperCase()],
          ].map(([k, v]) => (
            <div key={k} className="rounded border border-[#1e1e1c] bg-[#050505] px-1.5 py-1">
              <dt className="bean-label text-[8px] text-[#7a7a76]">{k}</dt>
              <dd className="mt-0.5 font-mono text-[#d4a017]">{v}</dd>
            </div>
          ))}
        </dl>
      )}

      {/* Presets */}
      <div className="mt-3 flex flex-wrap gap-1">
        {GANGZII_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => applyPreset(p.id)}
            disabled={isRunning}
            title={p.description}
            className={`rounded border px-1.5 py-0.5 text-[9px] ${
              activePreset === p.id ? "border-[#d4a017] bg-[#d4a017]/10 text-[#d4a017]" : "border-[#2a2a2a] bg-[#111110] text-[#8f8f8a] hover:border-[#d4a017]"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Parameter editors (bounded, honest) */}
      <div className="mt-3 space-y-1.5 text-[10px] text-[#8f8f8a]">
        <label className="flex items-center justify-between gap-2">
          <span>Noise reduction (dB)</span>
          <input type="number" min={0} max={30} step={1} value={effectiveParams.noiseReductionDb}
            onChange={(e) => patch({ noiseReductionDb: Math.max(0, Math.min(30, Number(e.target.value) || 0)) })}
            className="w-16 rounded border border-[#2a2a2a] bg-[#111110] px-1 py-0.5 text-right text-[#d4a017]" />
        </label>
        <label className="flex items-center justify-between gap-2">
          <span>Mains hum</span>
          <select value={effectiveParams.humHz === 0 ? "0" : String(effectiveParams.humHz)}
            onChange={(e) => patch({ humHz: Number(e.target.value) })}
            className="w-16 rounded border border-[#2a2a2a] bg-[#111110] px-1 py-0.5 text-[#d4a017]">
            <option value="0">off</option><option value="50">50 Hz</option><option value="60">60 Hz</option>
          </select>
        </label>
        <label className="flex items-center justify-between gap-2">
          <span>Rumble high-pass (Hz, 0=off)</span>
          <input type="number" min={0} max={300} step={5} value={effectiveParams.rumbleHighPassHz}
            onChange={(e) => patch({ rumbleHighPassHz: Math.max(0, Math.min(300, Number(e.target.value) || 0)) })}
            className="w-16 rounded border border-[#2a2a2a] bg-[#111110] px-1 py-0.5 text-right text-[#d4a017]" />
        </label>
        <label className="flex items-center justify-between gap-2">
          <span>De-ess (0–1)</span>
          <input type="number" min={0} max={1} step={0.05} value={effectiveParams.deEss}
            onChange={(e) => patch({ deEss: Math.max(0, Math.min(1, Number(e.target.value) || 0)) })}
            className="w-16 rounded border border-[#2a2a2a] bg-[#111110] px-1 py-0.5 text-right text-[#d4a017]" />
        </label>
        <label className="flex items-center justify-between gap-2">
          <span>Click repair (0–1)</span>
          <input type="number" min={0} max={1} step={0.05} value={effectiveParams.clickRepair}
            onChange={(e) => patch({ clickRepair: Math.max(0, Math.min(1, Number(e.target.value) || 0)) })}
            className="w-16 rounded border border-[#2a2a2a] bg-[#111110] px-1 py-0.5 text-right text-[#d4a017]" />
        </label>
        <label className="flex items-center justify-between gap-2">
          <span>Remove DC offset</span>
          <input type="checkbox" checked={effectiveParams.removeDcOffset}
            onChange={(e) => patch({ removeDcOffset: e.target.checked })} className="accent-[#d4a017]" />
        </label>
        <label className="flex items-center justify-between gap-2">
          <span>Loudness target</span>
          <select
            value={effectiveParams.loudness.mode === "none" ? "none" : String(effectiveParams.loudness.target.integrated)}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "none") return patch({ loudness: { mode: "none" } });
              const targets: Record<string, { integrated: number; truePeak: number; lra: number }> = {
                "-16": { integrated: -16, truePeak: -1.5, lra: 11 },
                "-23": { integrated: -23, truePeak: -1, lra: 9 },
                "-14": { integrated: -14, truePeak: -1, lra: 11 },
              };
              patch({ loudness: { mode: "staticGain", target: targets[v] } });
            }}
            className="w-24 rounded border border-[#2a2a2a] bg-[#111110] px-1 py-0.5 text-[#d4a017]">
            <option value="none">off</option>
            <option value="-16">−16 LUFS (podcast)</option>
            <option value="-23">−23 LUFS (EBU R128)</option>
            <option value="-14">−14 LUFS (streaming)</option>
          </select>
        </label>
        <label className="flex items-center justify-between gap-2">
          <span>Output trim (dB)</span>
          <input type="number" min={-24} max={24} step={0.5} value={effectiveParams.outputGainDb}
            onChange={(e) => patch({ outputGainDb: Math.max(-24, Math.min(24, Number(e.target.value) || 0)) })}
            className="w-16 rounded border border-[#2a2a2a] bg-[#111110] px-1 py-0.5 text-right text-[#d4a017]" />
        </label>
        <label className="flex items-center justify-between gap-2">
          <span>Compressor</span>
          <input type="checkbox" checked={effectiveParams.compressor.enabled}
            onChange={(e) => patch({ compressor: { ...effectiveParams.compressor, enabled: e.target.checked } })}
            className="accent-[#d4a017]" />
        </label>
        {effectiveParams.compressor.enabled && (
          <div className="grid grid-cols-2 gap-1 rounded border border-[#1e1e1c] bg-[#050505] p-1.5">
            {([
              ["thr dBFS", "thresholdDbfs", -60, 0, 0.5],
              ["ratio", "ratio", 1, 20, 0.5],
              ["atk ms", "attackMs", 0.5, 500, 1],
              ["rel ms", "releaseMs", 10, 2000, 10],
              ["knee dB", "kneeDb", 0, 24, 0.5],
              ["makeup dB", "makeupDb", 0, 24, 0.5],
            ] as const).map(([label, key, min, max, step]) => (
              <label key={key} className="flex items-center justify-between gap-1">
                <span className="text-[9px]">{label}</span>
                <input type="number" min={min} max={max} step={step} value={effectiveParams.compressor[key]}
                  onChange={(e) => patch({ compressor: { ...effectiveParams.compressor, [key]: Math.max(min, Math.min(max, Number(e.target.value) || 0)) } })}
                  className="w-14 rounded border border-[#2a2a2a] bg-[#111110] px-1 py-0.5 text-right text-[#d4a017]" />
              </label>
            ))}
          </div>
        )}
        <label className="flex items-center justify-between gap-2">
          <span>True-peak limiter</span>
          <input type="checkbox" checked={effectiveParams.limiter.enabled}
            onChange={(e) => patch({ limiter: { ...effectiveParams.limiter, enabled: e.target.checked } })}
            className="accent-[#d4a017]" />
        </label>
      </div>

      <button
        type="button"
        onClick={() => void runApply()}
        disabled={isRunning}
        className="mt-3 flex w-full items-center justify-center gap-1.5 rounded border border-[#d4a017] bg-[#d4a017]/10 px-2 py-1.5 text-[10px] text-[#d4a017] hover:bg-[#d4a017]/20 disabled:opacity-40"
        title="Process into a derived asset and swap this clip (one undoable command; original untouched)"
      >
        {busy === "process" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
        APPLY GANGZII TO CLIP
      </button>

      {/* Persisted processes (reload/reprocess/delete) */}
      {processes.filter((p) => p.kind === "PROCESS").length > 0 && (
        <div className="mt-3">
          <h3 className="bean-label text-[9px] text-[#7a7a76]">SAVED PROFILES</h3>
          <ul className="mt-1 space-y-1">
            {processes.filter((p) => p.kind === "PROCESS").slice(0, 5).map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-1 rounded border border-[#1e1e1c] bg-[#050505] px-1.5 py-1">
                <span className="truncate text-[9px] text-[#8f8f8a]" title={p.name ?? p.id}>
                  {p.name ?? p.id.slice(0, 10)} · {p.status}
                </span>
                <span className="flex gap-1">
                  {p.status === "COMPLETED" && (
                    <>
                      <button type="button" disabled={isRunning} title="Reprocess from the ORIGINAL with the saved parameters"
                        onClick={() => {
                          if (!p.paramsJson) return;
                          const original = originId ?? assetId;
                          void runApply(sanitizeParams(JSON.parse(p.paramsJson)), original, p.name ?? undefined);
                        }}
                        className="rounded border border-[#2a2a2a] bg-[#111110] p-1 text-[#8f8f8a] hover:border-[#d4a017] disabled:opacity-40">
                        <RefreshCw className="h-3 w-3" />
                      </button>
                      {p.resultAssetId && (
                        <button type="button" disabled={isRunning} title="Swap this clip to this derived asset"
                          onClick={() => {
                            if (!clip) return;
                            const ok = session.apply([
                              { type: "ReplaceClip", clipId: clip.id, newSourceAssetId: p.resultAssetId!, newSourceInFrame: clip.sourceInFrame, newSourceOutFrame: clip.sourceOutFrame },
                            ]);
                            if (ok) setNotice("Clip swapped to the saved derived asset (undo with Ctrl+Z).");
                          }}
                          className="rounded border border-[#2a2a2a] bg-[#111110] p-1 text-[#8f8f8a] hover:border-[#d4a017] disabled:opacity-40">
                          <ArrowLeftRight className="h-3 w-3" />
                        </button>
                      )}
                    </>
                  )}
                  <button type="button" title="Delete this profile (derived file removed; original untouched)"
                    onClick={() => void deleteProcess(p.id)}
                    className="rounded border border-[#2a2a2a] bg-[#111110] p-1 text-[#8f8f8a] hover:border-red-500">
                    <Trash2 className="h-3 w-3" />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-2 text-[9px] leading-relaxed text-[#5a5a55]">
        Non-destructive: the original media is never modified — GANGZII writes a derived asset and swaps the clip with a
        validated command (undo/redo + autosave apply). A/B compares original vs processed.
      </p>
    </div>
  );
}

/** Client-side sanitization before render/state — the server re-validates everything. */
function sanitizeParams(raw: unknown): GangziiParams {
  return {
    noiseReductionDb: 0,
    noiseFloorDbfs: -50,
    humHz: 0,
    humHarmonics: 3,
    deEss: 0,
    rumbleHighPassHz: 0,
    clickRepair: 0,
    removeDcOffset: false,
    channelGainsDb: [],
    eq: { highPassHz: null, lowPassHz: null, lowShelfHz: null, lowShelfGainDb: 0, highShelfHz: null, highShelfGainDb: 0, bands: [] },
    compressor: { enabled: false, thresholdDbfs: -18, ratio: 3, attackMs: 20, releaseMs: 200, kneeDb: 6, makeupDb: 0 },
    limiter: { enabled: false, ceilingDbtp: -1, releaseMs: 100 },
    gate: { enabled: false, thresholdDbfs: -50, ratio: 4, attackMs: 5, releaseMs: 120, rangeDb: 30 },
    loudness: { mode: "none" },
    outputGainDb: 0,
    fadeInSec: 0,
    fadeOutSec: 0,
    ...(typeof raw === "object" && raw !== null ? (raw as Partial<GangziiParams>) : {}),
  } as GangziiParams;
}

function GangziiInspectionSchemaSafe(json: string): GangziiInspection | null {
  try {
    const raw = JSON.parse(json) as GangziiInspection;
    if (raw && typeof raw.loudness === "object" && typeof raw.truePeakDbtp === "number") return raw;
    return null;
  } catch {
    return null;
  }
}
