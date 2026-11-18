"use client";

/**
 * BEAN FX — Workflow automation panel (M26 P7).
 *
 * Starts runs ONLY from the whitelisted server-side templates; shows per-step
 * status, approval gates, cancel and safe retry. Every step maps to a real
 * backend contract (render/variant/GANGZII/JAZMII/LAXII jobs) — the panel
 * never fabricates progress: states come from WorkflowRun + Job rows.
 */
import { useCallback, useEffect, useState } from "react";

type TemplateRow = { id: string; name: string; description: string; requiredInputs: string[]; steps: Array<{ id: string; kind: string; label: string; approvalRequired: boolean }> };
type RunStep = { id: string; kind: string; label: string; status: string; stepError: string | null; approvalRequired: boolean };
type RunRow = { id: string; templateId: string; name: string; projectId: string | null; status: string; error: string | null; steps: RunStep[] };

const statusColor = (s: string) => (s === "COMPLETED" || s === "DONE" ? "text-[#4cc47f]" : s === "FAILED" ? "text-[#c45c4c]" : s === "AWAITING_APPROVAL" ? "text-[#c48f4c]" : s === "CANCELLED" || s === "SKIPPED" ? "text-[#8f8f8a]" : "text-[#d4a017]");

export function WorkflowsPanel({ projectId, onNotice }: { projectId: string; onNotice: (m: string | null) => void }) {
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetch("/api/workflows").then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (!d) return;
      setTemplates(d.templates ?? []);
      setRuns((d.runs ?? []).filter((r: RunRow) => !r.projectId || r.projectId === projectId));
    }).catch(() => undefined);
  }, [projectId]);
  useEffect(() => {
    load();
    const id = window.setInterval(load, 4000);
    return () => window.clearInterval(id);
  }, [load]);

  const start = async (t: TemplateRow) => {
    setBusy(true);
    try {
      const inputsForTemplate: Record<string, string> = {};
      for (const key of t.requiredInputs) {
        if (key !== "projectId") inputsForTemplate[key] = (inputs[`${t.id}:${key}`] ?? "").trim();
      }
      const res = await fetch("/api/workflows", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ templateId: t.id, projectId, inputs: inputsForTemplate }) });
      const body = (await res.json().catch(() => ({}))) as { error?: string; run?: { id: string } };
      onNotice(res.ok ? `Workflow started (${body.run?.id.slice(0, 8)}…).` : (body.error ?? `Start failed (${res.status}).`));
      load();
    } finally {
      setBusy(false);
    }
  };

  const act = async (runId: string, action: "approve" | "cancel" | "retry-step", stepId?: string) => {
    const res = await fetch(`/api/workflows/${runId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, stepId }) });
    const body = (await res.json().catch(() => ({}))) as { error?: string; status?: string };
    onNotice(res.ok ? `Workflow ${action} ok (${body.status}).` : (body.error ?? "Action failed."));
    load();
  };

  const needsAssetInput = (t: TemplateRow) => t.requiredInputs.filter((k) => k !== "projectId");

  return (
    <div className="space-y-3 text-xs text-[#b8b8b2]">
      <div>
        <span className="bean-label text-[10px] text-[#d4a017]">WORKFLOW TEMPLATES (server-whitelisted)</span>
        <ul className="mt-1 space-y-1.5">
          {templates.map((t) => (
            <li key={t.id} className="rounded border border-[#1c1c1a] bg-[#111110] px-2.5 py-2">
              <div className="flex items-center justify-between gap-2">
                <strong className="min-w-0 flex-1 truncate text-[#e6e6e0]">{t.name}</strong>
                <button type="button" onClick={() => void start(t)} disabled={busy} className="rounded border border-[#d4a017] bg-[#d4a017]/10 px-2 py-1 text-[10px] text-[#d4a017] hover:bg-[#d4a017]/20 disabled:opacity-40">
                  Start
                </button>
              </div>
              <p className="mt-0.5 text-[10px] leading-relaxed text-[#8f8f8a]">{t.description}</p>
              <div className="mt-1 flex flex-wrap gap-1 text-[9px] text-[#6a6a64]">
                {t.steps.map((s) => (
                  <span key={s.id} className="rounded border border-[#2a2a2a] px-1 py-0.5">{s.kind}{s.approvalRequired ? " ⚑" : ""}</span>
                ))}
              </div>
              {needsAssetInput(t).map((k) => (
                <label key={k} className="mt-1.5 flex items-center gap-1.5 text-[10px] text-[#8f8f8a]">
                  {k === "sourceAssetId" ? "AUDIO ASSET ID" : k === "mediaId" ? "MEDIA ID" : k.toUpperCase()}
                  <input aria-label={`Workflow input ${k}`} value={inputs[`${t.id}:${k}`] ?? ""} onChange={(e) => setInputs((s) => ({ ...s, [`${t.id}:${k}`]: e.target.value.slice(0, 64) }))} placeholder="paste the library asset id" className="min-w-0 flex-1 rounded border border-[#2a2a2a] bg-[#0b0b0a] px-1.5 py-0.5 text-[10px] text-[#d4d4d0] placeholder:text-[#5a5a55]" />
                </label>
              ))}
            </li>
          ))}
        </ul>
      </div>
      {runs.length > 0 && (
        <div>
          <span className="bean-label text-[10px] text-[#7a7a76]">RUNS</span>
          <ul className="mt-1 space-y-1.5">
            {runs.slice(0, 6).map((r) => (
              <li key={r.id} className="rounded border border-[#1c1c1a] bg-[#111110] px-2.5 py-2">
                <div className="flex items-center justify-between gap-2">
                  <strong className="min-w-0 flex-1 truncate text-[#e6e6e0]">{r.name}</strong>
                  <span className={`text-[10px] ${statusColor(r.status)}`}>{r.status}</span>
                  {(r.status === "RUNNING" || r.status === "AWAITING_APPROVAL" || r.status === "PENDING") && (
                    <button type="button" onClick={() => void act(r.id, "cancel")} className="rounded border border-[#c45c4c]/40 px-1.5 py-0.5 text-[9px] text-[#c45c4c] hover:bg-[#c45c4c]/10">Cancel</button>
                  )}
                </div>
                <ul className="mt-1 space-y-0.5">
                  {r.steps.map((s) => (
                    <li key={s.id} className="flex items-center gap-1.5 text-[10px]">
                      <span className={statusColor(s.status)}>{s.status}</span>
                      <span className="min-w-0 flex-1 truncate text-[#8f8f8a]">{s.label}</span>
                      {s.approvalRequired && s.status === "AWAITING_APPROVAL" && (
                        <button type="button" onClick={() => void act(r.id, "approve", s.id)} className="rounded border border-[#4cc47f]/50 px-1.5 py-0.5 text-[9px] text-[#4cc47f] hover:bg-[#4cc47f]/10" title="Approve this gate — the run continues">
                          Approve
                        </button>
                      )}
                      {s.status === "FAILED" && (
                        <button type="button" onClick={() => void act(r.id, "retry-step", s.id)} className="rounded border border-[#d4a017] px-1.5 py-0.5 text-[9px] text-[#d4a017] hover:bg-[#d4a017]/10">Retry</button>
                      )}
                    </li>
                  ))}
                </ul>
                {r.error && <p className="mt-1 text-[9px] text-[#c45c4c]">{r.error.slice(0, 160)}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-[10px] text-[#6a6a64]">⚑ = approval gate. Steps only run from the whitelisted library — no custom code. Cancellation also cancels the underlying job; retry re-dispatches the same verified step.</p>
    </div>
  );
}
