"use client";

/**
 * M47 Phase F — Media Library (destination 4).
 * The source of truth for assets: grid/list, search + filters, real previews,
 * upload with progress, roles, project association, storage totals. Uploads go
 * through the SAME shared uploader and server validation as the composer —
 * ownership is never silently changed, originals are never moved.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StudioNav, StudioTopbar, useStudioShortcuts, type DestinationId } from "@/components/bean/studio-nav";
import { Panel, PanelHead, Btn, Empty, ErrorNote, TextInput, Select, Skeleton, StatusBadge } from "@/components/bean/ui";
import type { SessionUser } from "@/lib/types";
import { uploadMedia } from "@/lib/client-api";

type MediaRow = {
  id: string; originalName: string; kind: string; role?: string | null; projectId?: string | null;
  durationSec?: number | null; sizeBytes?: number | null; width?: number | null; height?: number | null;
  probeStatus?: string | null; thumbnailUrl?: string | null; createdAt?: string;
};
type ProjectRow = { id: string; name: string };

const KINDS = ["VIDEO", "AUDIO", "IMAGE", "DOCUMENT"] as const;
const ROLES = ["SOURCE_FOOTAGE", "REFERENCE", "REFERENCE_IMAGE", "AUDIO_MUSIC", "GENERATED"] as const;

const humanSize = (b?: number | null) => (b ? `${(b / 1024 / (b > 1024 * 1024 ? 1024 : 1)).toFixed(b > 1024 * 1024 ? 1 : 0)} ${b > 1024 * 1024 ? "MB" : "KB"}` : "—");
const fmtDur = (d?: number | null) => (d ? `${Math.floor(d / 60)}:${String(Math.round(d % 60)).padStart(2, "0")}` : "—");

export function MediaLibraryPage({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  const [active, setActive] = useState<DestinationId>("library");
  useStudioShortcuts(active);
  useEffect(() => {
    const onHash = () => {
      const h = window.location.hash.replace(/^#/, "").split("?")[0];
      const hit = { "/home": "chat", "/crew": "crew", "/editor": "editor", "/library": "library", "/intelligence": "intelligence", "/settings": "settings" }[h];
      if (hit) setActive(hit as DestinationId);
    };
    onHash();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [projectId, setProjectId] = useState<string>("");
  const [rows, setRows] = useState<MediaRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [role, setRole] = useState("");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [preview, setPreview] = useState<MediaRow | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [uploadName, setUploadName] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const loadProjects = useCallback(async () => {
    const res = await fetch("/api/projects");
    const d = await res.json();
    const mine: ProjectRow[] = d.projects ?? [];
    setProjects(mine);
    setProjectId((prev) => prev ?? ""); // default: all owned assets
  }, []);

  const loadRows = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(projectId ? `/api/media?projectId=${projectId}` : "/api/media");
      if (!res.ok) throw new Error(`Media load failed (HTTP ${res.status}).`);
      const d = await res.json();
      setRows(d.media ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the library.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void loadProjects(); }, [loadProjects]);
  useEffect(() => { void loadRows(); }, [loadRows]);

  const filtered = useMemo(() => rows.filter((r) => {
    if (kind && r.kind !== kind) return false;
    if (role && (r.role ?? "") !== role) return false;
    if (query && !r.originalName.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  }), [rows, kind, role, query]);

  const totals = useMemo(() => ({
    count: rows.length,
    bytes: rows.reduce((s, r) => s + (r.sizeBytes ?? 0), 0),
    seconds: rows.reduce((s, r) => s + (r.durationSec ?? 0), 0),
  }), [rows]);

  const onUpload = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    for (const file of Array.from(files).slice(0, 8)) {
      setUploadName(file.name);
      try {
        await uploadMedia(file, {
          projectId: projectId || null,
          productionRole: /^(video)\//.test(file.type) ? "SOURCE_FOOTAGE" : /^(audio)\//.test(file.type) ? "AUDIO_MUSIC" : /^(image)\//.test(file.type) ? "REFERENCE_IMAGE" : "REFERENCE",
          onProgress: (pct) => setUploadPct(pct),
        });
      } catch (err) {
        setError(`Upload failed for ${file.name}: ${err instanceof Error ? err.message : "error"}`);
      }
    }
    setUploadPct(null);
    setUploadName(null);
    void loadRows();
  }, [projectId, loadRows]);

  const attachToChat = (m: MediaRow) => {
    // Hand the asset identity (never the filename) to Studio Chat.
    try {
      const prior = JSON.parse(localStorage.getItem("beanfx.attach") ?? "[]");
      if (!prior.some((x: { id: string }) => x.id === m.id)) prior.push({ id: m.id, name: m.originalName, kind: m.kind, role: m.role ?? null });
      localStorage.setItem("beanfx.attach", JSON.stringify(prior.slice(-8)));
      window.location.hash = "#/home";
    } catch {
      setError("Could not stage the attachment for Studio Chat.");
    }
  };

  return (
    <div className="flex min-h-screen bg-[var(--m47-bg)] text-[var(--m47-ink)]">
      <StudioNav user={user} active={active} onLogout={onLogout} />
      <div className="flex min-w-0 flex-1 flex-col">
        <StudioTopbar
          title="Media Library"
          context={
            <Select value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project filter" className="max-w-[220px]">
              <option value="">All projects (owned by you)</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          }
          right={
            <>
              <span className="m47-chip">{totals.count} assets · {humanSize(totals.bytes)}</span>
              <Btn onClick={() => fileInput.current?.click()} disabled={uploadPct !== null}>{uploadPct !== null ? `Uploading ${uploadPct}%` : "Upload"}</Btn>
            </>
          }
        />
        <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => { void onUpload(e.target.files); e.target.value = ""; }} />

        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--m47-line)] px-5 py-2.5">
          <TextInput placeholder="Search by name…" value={query} onChange={(e) => setQuery(e.target.value)} className="w-52" aria-label="Search assets" />
          <Select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind filter">
            <option value="">All kinds</option>
            {KINDS.map((k) => <option key={k} value={k}>{k.toLowerCase()}</option>)}
          </Select>
          <Select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role filter">
            <option value="">All roles</option>
            {ROLES.map((r) => <option key={r} value={r}>{r.replaceAll("_", " ").toLowerCase()}</option>)}
          </Select>
          <div className="ml-auto flex gap-1">
            <Btn variant={view === "grid" ? "primary" : "ghost"} onClick={() => setView("grid")}>Grid</Btn>
            <Btn variant={view === "list" ? "primary" : "ghost"} onClick={() => setView("list")}>List</Btn>
          </div>
        </div>

        <main className="bean-panel-scroll min-w-0 flex-1 overflow-y-auto p-4">
          <ErrorNote>{error}</ErrorNote>
          {uploadPct !== null && uploadName && (
            <p className="mb-3 text-[11px] text-[var(--m47-gold-soft)]">Uploading {uploadName} — {uploadPct}% (bound to the selected project; originals untouched)</p>
          )}
          {loading && <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-36" />)}</div>}
          {!loading && filtered.length === 0 && <Panel><Empty>No assets match. Upload from here or from the Studio Chat composer.</Empty></Panel>}

          {view === "grid" && !loading && (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
              {filtered.map((m) => (
                <button key={m.id} onClick={() => setPreview(m)} className="m47-panel group overflow-hidden text-left transition-colors hover:border-[var(--m47-gold)]" title={`Preview ${m.originalName}`}>
                  <div className="flex h-24 items-center justify-center bg-black/40">
                    {m.thumbnailUrl ? (
                      <img src={m.thumbnailUrl} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <span className="text-[10px] uppercase tracking-widest text-[var(--m47-ink-dim)]">{m.kind}</span>
                    )}
                  </div>
                  <div className="px-2.5 py-2">
                    <p className="truncate text-[11px] text-[var(--m47-ink)]">{m.originalName}</p>
                    <p className="text-[9.5px] text-[var(--m47-ink-dim)]">{fmtDur(m.durationSec)} · {humanSize(m.sizeBytes)}{m.role ? ` · ${m.role.replaceAll("_", " ").toLowerCase()}` : ""}</p>
                  </div>
                </button>
              ))}
            </div>
          )}

          {view === "list" && !loading && (
            <Panel>
              <table className="w-full text-left text-[11.5px]">
                <thead>
                  <tr className="border-b border-[var(--m47-line)] text-[var(--m47-ink-dim)]">
                    <th className="px-3 py-2 font-semibold">Name</th><th className="px-3 py-2">Kind</th><th className="px-3 py-2">Role</th><th className="px-3 py-2">Duration</th><th className="px-3 py-2">Size</th><th className="px-3 py-2">Probe</th><th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((m) => (
                    <tr key={m.id} className="border-b border-[var(--m47-line)]/60 last:border-0 hover:bg-[var(--m47-bg-hover)]">
                      <td className="max-w-[240px] truncate px-3 py-2">{m.originalName}</td>
                      <td className="px-3 py-2 text-[var(--m47-ink-dim)]">{m.kind.toLowerCase()}</td>
                      <td className="px-3 py-2 text-[var(--m47-ink-dim)]">{m.role ? m.role.replaceAll("_", " ").toLowerCase() : "—"}</td>
                      <td className="px-3 py-2">{fmtDur(m.durationSec)}</td>
                      <td className="px-3 py-2">{humanSize(m.sizeBytes)}</td>
                      <td className="px-3 py-2"><StatusBadge s={m.probeStatus === "OK" ? "ok" : m.probeStatus ? "fail" : "idle"}>{m.probeStatus ?? "—"}</StatusBadge></td>
                      <td className="px-3 py-2 text-right">
                        <Btn variant="ghost" onClick={() => attachToChat(m)}>Attach to chat</Btn>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          )}

          {/* Preview dialog */}
          {preview && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" role="dialog" aria-modal="true" onClick={() => setPreview(null)}>
              <div className="m47-panel w-full max-w-2xl" onClick={(e) => e.stopPropagation()}>
                <PanelHead title={preview.originalName} right={<Btn variant="ghost" onClick={() => setPreview(null)}>✕ Close</Btn>} />
                <div className="bg-black/60 p-4">
                  {preview.kind === "VIDEO" && <video controls preload="metadata" src={`/api/media/${preview.id}/file`} className="max-h-[320px] w-full" />}
                  {preview.kind === "AUDIO" && <audio controls preload="metadata" src={`/api/media/${preview.id}/file`} className="w-full" />}
                  {preview.kind === "IMAGE" && (
                    <img src={`/api/media/${preview.id}/file`} alt={preview.originalName} className="max-h-[320px] w-full object-contain" />
                  )}
                  {preview.kind === "DOCUMENT" && <Empty>Document preview opens in a new tab. <a className="underline" href={`/api/media/${preview.id}/file`} target="_blank" rel="noreferrer">Open file</a></Empty>}
                </div>
                <div className="flex items-center justify-between px-4 py-3">
                  <p className="text-[10.5px] text-[var(--m47-ink-dim)]">
                    id …{preview.id.slice(-6)} · {fmtDur(preview.durationSec)} · {humanSize(preview.sizeBytes)}
                    {preview.width ? ` · ${preview.width}×${preview.height}` : ""} · probe {preview.probeStatus ?? "—"}
                  </p>
                  <Btn variant="primary" onClick={() => { attachToChat(preview); setPreview(null); }}>Attach to Studio Chat</Btn>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
