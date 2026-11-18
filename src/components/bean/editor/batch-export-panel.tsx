"use client";

/**
 * BEAN FX — Batch export panel (M26 P5).
 *
 * Fan a rendered master out to multiple social profiles through the REAL
 * ExportVariant pipeline (probe → variant jobs → ffprobe-validated outputs).
 * Idempotent per (master, profile): re-submitting or refreshing never
 * duplicates jobs. Per-variant progress, cancel and retry reuse the existing
 * variant routes.
 */
import { useCallback, useEffect, useState } from "react";

type MasterRow = { id: string; filename: string; createdAt: string; sizeBytes: number; durationSec: number | null };
type VariantRow = { id: string; profileId: string; status: string; progress: number; stage: string | null; sourceExportId: string | null; error: string | null };
type ProfileRow = { id: string; label: string; width: number; height: number };

const batchBtn = "rounded border border-[#d4a017] bg-[#d4a017]/10 px-2 py-1 text-[10px] text-[#d4a017] hover:bg-[#d4a017]/20 disabled:opacity-40";

export function BatchExportPanel({ projectId, onNotice }: { projectId: string; onNotice: (m: string | null) => void }) {
  const [masters, setMasters] = useState<MasterRow[]>([]);
  const [masterId, setMasterId] = useState<string>("");
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [variants, setVariants] = useState<VariantRow[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetch(`/api/editor/projects/${projectId}/batch-export`).then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (!d) return;
      setMasters(d.masters ?? []);
      setVariants(d.variants ?? []);
      if (!masterId && d.masters?.[0]) setMasterId(d.masters[0].id);
    }).catch(() => undefined);
    fetch("/api/publish/profiles").then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (d?.profiles) setProfiles(d.profiles.map((p: ProfileRow & { fps?: number }) => ({ id: p.id, label: p.label, width: p.width, height: p.height })));
    }).catch(() => undefined);
  }, [projectId, masterId]);
  useEffect(() => {
    load();
    const id = window.setInterval(load, 3000);
    return () => window.clearInterval(id);
  }, [load]);

  const submit = async () => {
    if (!masterId || selected.size === 0) {
      onNotice("Pick a master export and at least one profile.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/editor/projects/${projectId}/batch-export`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceExportId: masterId, profileIds: [...selected] }) });
      const body = (await res.json().catch(() => ({}))) as { error?: string; batch?: Array<{ profileId: string; reused: boolean }>; rejected?: Array<{ profileId: string; reason: string }> };
      if (res.ok) {
        const fresh = (body.batch ?? []).filter((b) => !b.reused).map((b) => b.profileId);
        const reused = (body.batch ?? []).filter((b) => b.reused).map((b) => b.profileId);
        const rejected = body.rejected ?? [];
        onNotice([
          fresh.length ? `Queued ${fresh.length} variant(s): ${fresh.join(", ")}` : "",
          reused.length ? `reused existing: ${reused.join(", ")}` : "",
          rejected.length ? `rejected: ${rejected.map((r) => `${r.profileId} (${r.reason})`).join("; ")}` : "",
        ].filter(Boolean).join(" — ") || "Nothing submitted.");
        load();
      } else onNotice(body.error ?? `Batch failed (${res.status}).`);
    } finally {
      setBusy(false);
    }
  };

  const cancelVariant = async (id: string) => {
    const res = await fetch(`/api/publish/variants/${id}`, { method: "DELETE" });
    onNotice(res.ok ? "Variant cancelled." : "This variant can no longer be cancelled.");
    load();
  };
  const retryVariant = async (id: string) => {
    const res = await fetch(`/api/publish/variants/${id}/retry`, { method: "POST" });
    onNotice(res.ok ? "Variant re-queued." : "Retry refused.");
    load();
  };

  return (
    <div className="mt-4 border-t border-[#2a2a2a] pt-3">
      <span className="bean-label text-[10px] text-[#d4a017]">BATCH EXPORT (M26 — multi-profile fan-out)</span>
      <p className="mb-2 mt-1 text-[9px] leading-relaxed text-[#6a6a64]">
        Renders a finished master (timeline render or video export) into several aspect ratios in one submission through the durable variant worker. Each (master, profile) pair submits at most once — refreshing or retrying never duplicates jobs.
      </p>
      {masters.length === 0 ? (
        <p className="text-[10px] text-[#8f8f8a]">No completed master yet — render the timeline or export a video first.</p>
      ) : (
        <>
          <label className="mb-2 flex items-center gap-2 text-[10px] text-[#8f8f8a]">
            MASTER
            <select aria-label="Master export" value={masterId} onChange={(e) => setMasterId(e.target.value)} className="min-w-0 flex-1 rounded border border-[#2a2a2a] bg-[#111110] px-1.5 py-1 text-[10px] text-[#d4d4d0]">
              {masters.map((m) => (
                <option key={m.id} value={m.id}>{m.filename.slice(0, 44)} · {(m.sizeBytes / 1024 / 1024).toFixed(1)}MB</option>
              ))}
            </select>
          </label>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {profiles.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setSelected((s) => { const n = new Set(s); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n; })}
                className={`rounded border px-1.5 py-0.5 text-[9px] ${selected.has(p.id) ? "border-[#d4a017] text-[#d4a017]" : "border-[#2a2a2a] text-[#d8d8d2] hover:border-[#d4a017]"}`}
                title={`${p.width}×${p.height}`}
              >
                {p.label}
              </button>
            ))}
            {profiles.length === 0 && <span className="text-[9px] text-[#6a6a64]">Profiles unavailable.</span>}
          </div>
          <button type="button" onClick={() => void submit()} disabled={busy || !masterId || selected.size === 0} className={batchBtn}>
            {busy ? "…" : `BATCH EXPORT (${selected.size} profile${selected.size === 1 ? "" : "s"})`}
          </button>
        </>
      )}
      {variants.length > 0 && (
        <div className="mt-2">
          <span className="bean-label text-[9px] text-[#7a7a76]">VARIANT QUEUE</span>
          {variants.map((v) => (
            <div key={v.id} className="mt-1 rounded bg-[#111110] px-2 py-1.5 text-[10px]">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 flex-1 truncate text-[#d8d8d2]">{v.profileId}</span>
                <span className={v.status === "COMPLETED" ? "text-[#4cc47f]" : v.status === "FAILED" ? "text-[#c45c4c]" : "text-[#d4a017]"}>{v.status}</span>
                <span className="font-mono text-[9px] text-[#6a6a64]">{Math.round(v.progress)}%</span>
              </div>
              {v.stage && <div className="text-[9px] text-[#8f8f8a]">{v.stage}</div>}
              {v.error && <div className="text-[9px] text-[#c45c4c]">{v.error.slice(0, 120)}</div>}
              {(v.status === "QUEUED" || v.status === "RENDERING") && (
                <button type="button" onClick={() => void cancelVariant(v.id)} className="mt-0.5 rounded border border-[#c45c4c]/40 px-1.5 py-0.5 text-[9px] text-[#c45c4c] hover:bg-[#c45c4c]/10">Cancel</button>
              )}
              {v.status === "FAILED" && (
                <button type="button" onClick={() => void retryVariant(v.id)} className="mt-0.5 rounded border border-[#d4a017] px-1.5 py-0.5 text-[9px] text-[#d4a017] hover:bg-[#d4a017]/10">Retry</button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
