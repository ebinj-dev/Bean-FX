"use client";
/**
 * M29 P9 — project portability panel (additive drawer): package / import /
 * bulk relink / asset status. Deterministic validation is authoritative —
 * every match is previewed and explicitly confirmed before anything changes.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { EditorSession } from "@/hooks/use-editor-session";

interface MissingRef {
  deadAssetId: string;
  affectedClips: { clipId: string; expectedDurationSec: number }[];
  suggestions: { candidateAssetId: string; quality: string; warnings: string[]; asset: { id: string; originalName: string; kind: string; durationSec: number | null; width: number | null; height: number | null; fps: number | null; channels: number | null } }[];
}
interface StatusRow { assetId: string; status: string; originalName?: string; proxyStatus?: string | null; proxyStale?: boolean; probeStatus?: string | null; probeError?: string | null; isVfr?: boolean | null; sizeBytes?: number }
const QUALITY_COLOR: Record<string, string> = { EXACT: "text-[#4cc47f]", COMPATIBLE: "text-[#d4a017]", RISKY: "text-[#c47f4c]", INVALID: "text-[#c45c4c]" };

export function ProjectPortability({ session, projectId, onNotice }: { session: EditorSession; projectId: string; onNotice: (n: string) => void }) {
  const [mode, setMode] = useState<"FULL" | "NO_PROXIES" | "METADATA">("FULL");
  const [archiving, setArchiving] = useState(false);
  const [archive, setArchive] = useState<{ status: string; progress: number; stage: string | null; sizeBytes: number | null; assetCount: number | null; error: string | null } | null>(null);
  const [importing, setImporting] = useState(false);
  const [importState, setImportState] = useState<{ status: string; progress: number; stage: string | null; error: string | null } | null>(null);
  const [missing, setMissing] = useState<MissingRef[]>([]);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{ referenced: StatusRow[]; duplicateGroups: { sha256: string; assetIds: string[] }[]; unreferenced: { id: string; originalName: string; sizeBytes: number }[]; usage: { usedBytes: number; quotaBytes: number } } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const importArchiveId = useRef<string | null>(null);
  const archiveIdRef = useRef<string | null>(null);

  const loadStatus = useCallback(async () => {
    const [relink, assets] = await Promise.all([
      fetch(`/api/projects/${projectId}/relink`).then((r) => (r.ok ? r.json() : { missing: [] })).catch(() => ({ missing: [] })),
      fetch(`/api/projects/${projectId}/assets/status`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    setMissing(relink.missing ?? []);
    setStatus(assets);
  }, [projectId]);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  // Poll packaging progress while running.
  useEffect(() => {
    if (!archiving || !archive || ["COMPLETED", "FAILED", "CANCELLED"].includes(archive.status)) return;
    const t = setTimeout(async () => {
      const r = await fetch(`/api/projects/${projectId}/archive`).catch(() => null);
      const d = await r?.json().catch(() => null);
      if (d?.archive) setArchive(d.archive);
    }, 1500);
    return () => clearTimeout(t);
  }, [archiving, archive, projectId]);

  // Poll import progress while running.
  useEffect(() => {
    if (!importing || !importState || !importArchiveId.current || ["COMPLETED", "FAILED"].includes(importState.status)) return;
    const t = setTimeout(async () => {
      const r = await fetch(`/api/projects/import/status/${importArchiveId.current}`).catch(() => null);
      const d = await r?.json().catch(() => null);
      if (d?.archive) setImportState(d.archive);
    }, 1500);
    return () => clearTimeout(t);
  }, [importing, importState]);

  const startPackage = async () => {
    setArchiving(true);
    try {
      const r = await fetch(`/api/projects/${projectId}/archive`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { onNotice(d.error ?? "Packaging could not start."); return; }
      archiveIdRef.current = d.archiveId;
      setArchive({ status: "QUEUED", progress: 0, stage: "Queued", sizeBytes: null, assetCount: null, error: null });
    } finally {
      setArchiving(false);
    }
  };

  const downloadPackage = async () => {
    if (!archiveIdRef.current) return;
    window.location.href = `/api/project-archives/${archiveIdRef.current}/download`;
  };

  const startImport = async (file: File) => {
    setImporting(true);
    setImportState({ status: "UPLOADING", progress: 0, stage: "Uploading package", error: null });
    try {
      const r = await fetch("/api/projects/import", { method: "POST", body: file });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { onNotice(d.error ?? "Import could not start."); setImporting(false); setImportState(null); return; }
      importArchiveId.current = d.archiveId;
      setImportState({ status: "QUEUED", progress: 0, stage: "Queued", error: null });
    } catch {
      onNotice("Import upload failed.");
      setImporting(false);
      setImportState(null);
    }
  };

  const applyBulkRelink = () => {
    const mappings = missing.filter((m) => picks[m.deadAssetId]).map((m) => ({ deadAssetId: m.deadAssetId, newAssetId: picks[m.deadAssetId] }));
    if (mappings.length === 0) return;
    const ok = session.apply([{ type: "RelinkAssets", mappings }]);
    onNotice(ok ? `Relinked ${mappings.length} asset reference(s) — one undoable history entry.` : "Relink rejected by validation — nothing changed.");
    setPicks({});
    void loadStatus();
  };

  const fmt = (n: number) => (n > 1024 * 1024 * 1024 ? `${(n / 1024 / 1024 / 1024).toFixed(1)} GB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
  const missingRows = status?.referenced.filter((r) => r.status === "MISSING").length ?? 0;

  return (
    <div className="space-y-3">
      {/* Package */}
      <section className="rounded border border-[#1c1c1a] bg-[#111110] p-2" aria-label="Package project">
        <span className="bean-label text-[10px] text-[#d4a017]">PACKAGE PROJECT</span>
        <p className="mt-1 text-[10px] leading-snug text-[#8f8f8a]">Collects the project JSON, timeline history and every referenced source media (SHA-256 verified) into one zip. Proxies optional — they are regenerable. Duplicates are packaged once.</p>
        <div className="mt-1.5 flex items-center gap-1">
          <select aria-label="Package mode" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} className="min-w-0 flex-1 rounded border border-[#2a2a2a] bg-[#111110] px-1.5 py-1 text-[10px] text-[#d4d4d0]">
            <option value="FULL">Complete (originals + proxies)</option>
            <option value="NO_PROXIES">Without proxies (smaller)</option>
            <option value="METADATA">Metadata only (media relinked later)</option>
          </select>
          <button type="button" onClick={() => void startPackage()} disabled={archiving || missingRows > 0} title={missingRows > 0 ? `${missingRows} missing reference(s) — relink first` : "Create the package (verified)"} className="rounded border border-[#d4a017] bg-[#d4a017]/10 px-2 py-1 text-[10px] text-[#d4a017] hover:bg-[#d4a017]/20 disabled:opacity-40">Package</button>
        </div>
        {archive && (
          <div className="mt-1.5 text-[10px] text-[#a8a8a0]">
            <span aria-live="polite">{archive.status} — {archive.progress}% {archive.stage ? `· ${archive.stage}` : ""}</span>
            {archive.assetCount !== null && <span> · {archive.assetCount} assets</span>}
            {archive.sizeBytes !== null && <span> · {fmt(archive.sizeBytes)}</span>}
            {archive.error && <span className="text-[#c45c4c]"> · {archive.error}</span>}
            {archive.status === "COMPLETED" && (
              <button type="button" onClick={() => void downloadPackage()} className="ml-1 rounded border border-[#d4a017] px-1.5 py-0.5 text-[10px] text-[#d4a017] hover:bg-[#d4a017]/10">Download .zip</button>
            )}
          </div>
        )}
      </section>

      {/* Import */}
      <section className="rounded border border-[#1c1c1a] bg-[#111110] p-2" aria-label="Import project package">
        <span className="bean-label text-[10px] text-[#d4a017]">IMPORT PROJECT</span>
        <p className="mt-1 text-[10px] leading-snug text-[#8f8f8a]">Restores a .beanfx package as a NEW project (never overwrites existing projects). Checksums and the manifest are validated first; missing assets refuse the import with an exact list.</p>
        <input ref={fileRef} type="file" accept=".zip" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void startImport(f); e.target.value = ""; }} />
        <button type="button" onClick={() => fileRef.current?.click()} disabled={importing} className="mt-1.5 w-full rounded border border-[#2a2a2a] px-2 py-1 text-[10px] text-[#d8d8d2] hover:border-[#d4a017] hover:text-[#d4a017] disabled:opacity-40">Choose package file…</button>
        {importState && (
          <div className="mt-1.5 text-[10px] text-[#a8a8a0]">
            <span aria-live="polite">{importState.status} — {importState.progress}% {importState.stage ? `· ${importState.stage}` : ""}</span>
            {importState.error && <span className="text-[#c45c4c]"> · {importState.error}</span>}
            {importState.status === "COMPLETED" && <button type="button" onClick={() => window.location.reload()} className="ml-1 rounded border border-[#d4a017] px-1.5 py-0.5 text-[10px] text-[#d4a017]">Reload project list</button>}
          </div>
        )}
      </section>

      {/* Bulk relink */}
      <section className="rounded border border-[#1c1c1a] bg-[#111110] p-2" aria-label="Bulk relink">
        <span className="bean-label text-[10px] text-[#d4a017]">BULK RELINK {missing.length > 0 ? `(${missing.length} missing)` : ""}</span>
        {missing.length === 0 ? (
          <p className="mt-1 text-[10px] text-[#8f8f8a]">No missing media references in this project.</p>
        ) : (
          <>
            {missing.map((m) => {
              const picked = picks[m.deadAssetId] ?? "";
              const suggestion = m.suggestions.find((s) => s.candidateAssetId === picked);
              return (
                <div key={m.deadAssetId} className="mt-1.5 rounded border border-[#2a2a2a] p-1.5">
                  <div className="text-[9px] text-[#8f8f8a]">ref {m.deadAssetId.slice(-6)} · {m.affectedClips.length} clip(s) · expect ~{m.affectedClips[0]?.expectedDurationSec?.toFixed(1) ?? "?"}s</div>
                  <select aria-label={`Replacement for ${m.deadAssetId.slice(-6)}`} value={picked} onChange={(e) => setPicks((p) => ({ ...p, [m.deadAssetId]: e.target.value }))} className="mt-1 w-full rounded border border-[#2a2a2a] bg-[#111110] px-1.5 py-1 text-[10px] text-[#d4d4d0]">
                    <option value="">No replacement (keep placeholder)…</option>
                    {m.suggestions.map((s) => (
                      <option key={s.candidateAssetId} value={s.candidateAssetId}>{s.asset.originalName.slice(0, 44)} [{s.quality}]</option>
                    ))}
                    {m.suggestions.length === 0 && <option value="" disabled>No library candidates — add media first</option>}
                  </select>
                  {suggestion && (
                    <div className={`mt-1 text-[9px] ${QUALITY_COLOR[suggestion.quality] ?? "text-[#8f8f8a]"}`}>
                      {suggestion.quality === "EXACT" ? "✓ checksum match" : suggestion.quality === "RISKY" ? "⚠ possibly incompatible" : "○ compatible"}
                      {suggestion.warnings.length > 0 && <span> — {suggestion.warnings.join("; ")}</span>}
                    </div>
                  )}
                </div>
              );
            })}
            <button type="button" onClick={applyBulkRelink} disabled={Object.values(picks).every((v) => !v)} title="Applies as one undoable timeline edit — preview the [quality] labels before confirming" className="mt-2 w-full rounded border border-[#d4a017] bg-[#d4a017]/10 px-2 py-1 text-[10px] text-[#d4a017] hover:bg-[#d4a017]/20 disabled:opacity-40">
              Apply {Object.values(picks).filter(Boolean).length} relink(s)
            </button>
            <p className="mt-1 text-[9px] leading-snug text-[#8f8f8a]">In/out points and timeline placement are never altered — only the source reference is re-pointed, as one reversible history entry.</p>
          </>
        )}
      </section>

      {/* Asset status */}
      {status && (
        <section className="rounded border border-[#1c1c1a] bg-[#111110] p-2" aria-label="Asset status">
          <span className="bean-label text-[10px] text-[#d4a017]">ASSET STATUS</span>
          <div className="mt-1 space-y-0.5 text-[10px] text-[#a8a8a0]">
            <div>{status.referenced.filter((r) => r.status === "READY").length} ready · {missingRows} missing · {status.referenced.filter((r) => r.proxyStale).length} stale proxy(es)</div>
            {status.referenced.some((r) => r.isVfr) && <div className="text-[#d4a017]">VFR source(s) present — sub-frame timing is preserved passthrough.</div>}
            {status.duplicateGroups.length > 0 && <div>{status.duplicateGroups.length} duplicate content group(s) in the library (packaged once by checksum).</div>}
            {status.unreferenced.length > 0 && <div>{status.unreferenced.length} unreferenced asset(s) — cleanup candidates only; deletion is always explicit.</div>}
            <div>Storage: {fmt(status.usage.usedBytes)} of {fmt(status.usage.quotaBytes)} quota.</div>
          </div>
        </section>
      )}
    </div>
  );
}
