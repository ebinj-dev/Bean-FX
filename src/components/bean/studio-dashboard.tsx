"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, Film, FolderPlus, Library, Loader2, Music, Package, Trash2 } from "lucide-react";
import { ToolShell } from "@/components/bean/tool-shell";
import type { SessionUser, MediaMeta, ExportView } from "@/lib/types";
import { formatBytes, formatDateTime, formatDuration } from "@/lib/format-utils";
import { cn } from "@/lib/utils";

interface Project {
  id: string;
  name: string;
  description: string | null;
  mediaCount: number;
  createdAt: string;
  updatedAt: string;
}

const TOOL_LINKS = [
  { label: "AUTO CUT", href: "#/autocut", desc: "Silence removal with review-first cut planning" },
  { label: "CAPTIONS", href: "#/captions", desc: "Transcribe, edit and export subtitles" },
  { label: "WATERMARK", href: "#/watermark", desc: "Blur, delogo or crop watermark regions" },
  { label: "AUDIO", href: "#/audio", desc: "Clean, shape and export audio" },
  { label: "B-ROLL", href: "#/broll", desc: "Library + transcript-linked suggestions" },
];

export function StudioDashboard({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  const [media, setMedia] = useState<MediaMeta[] | null>(null);
  const [exports, setExports] = useState<ExportView[] | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [newProject, setNewProject] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/media").then((r) => r.json()).then((d) => setMedia(d.media ?? [])).catch(() => setMedia([]));
    fetch("/api/exports").then((r) => r.json()).then((d) => setExports(d.exports ?? [])).catch(() => setExports([]));
    fetch("/api/projects").then((r) => r.json()).then((d) => setProjects(d.projects ?? [])).catch(() => setProjects([]));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const createProject = async () => {
    if (!newProject.trim()) return;
    setError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newProject.trim() }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Failed to create project.");
      setNewProject("");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create project.");
    }
  };

  const deleteMedia = async (id: string) => {
    setError(null);
    try {
      const res = await fetch(`/api/media/${id}`, { method: "DELETE" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Delete failed.");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed.");
    }
  };

  const deleteExport = async (id: string) => {
    await fetch(`/api/exports?id=${id}`, { method: "DELETE" }).catch(() => undefined);
    load();
  };

  const totalBytes = (media ?? []).reduce((a, m) => a + m.sizeBytes, 0);
  const audioCount = (media ?? []).filter((m) => m.kind === "AUDIO").length;
  const videoCount = (media ?? []).filter((m) => m.kind === "VIDEO").length;

  return (
    <ToolShell
      user={user}
      onLogout={onLogout}
      route="/studio"
      label="STUDIO"
      title={`Welcome back${user.name ? `, ${user.name}` : ""}`}
      description="Your media library, projects, export history and editing tools — one workspace."
    >
      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard icon={Library} label="MEDIA FILES" value={String(media?.length ?? 0)} sub={formatBytes(totalBytes)} />
        <StatCard icon={Music} label="AUDIO" value={String(audioCount)} />
        <StatCard icon={Film} label="VIDEO" value={String(videoCount)} />
        <StatCard icon={Package} label="EXPORTS" value={String(exports?.length ?? 0)} />
      </div>

      {/* Projects — first section: create or open a project immediately */}
{/* Projects */}
      <section className="mt-6 rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
        <h2 className="bean-label text-[10px] text-[#8f8f8a]">PROJECTS</h2>
        <div className="mt-3 flex gap-2">
          <input
            type="text"
            value={newProject}
            onChange={(e) => setNewProject(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && createProject()}
            placeholder="New project name…"
            className="h-9 min-w-0 flex-1 rounded-md border border-[#2a2a2a] bg-[#121212] px-3 text-sm text-white placeholder:text-[#555] focus:border-[#d4a017] focus:outline-none"
          />
          <button
            type="button"
            onClick={createProject}
            disabled={!newProject.trim()}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[#d4a017] px-3.5 text-[10px] font-extrabold uppercase tracking-wider text-[#0c0c0c] hover:bg-[#e9b52a] disabled:opacity-40"
          >
            <FolderPlus className="h-3.5 w-3.5" /> CREATE
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-[#f87171]">{error}</p>}
        {projects === null ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-[#d4a017]" />
          </div>
        ) : projects.length === 0 ? (
          <p className="mt-3 text-[11px] text-[#5c5c58]">No projects yet — create one to organize your media.</p>
        ) : (
          <ul className="bean-panel-scroll mt-3 max-h-64 space-y-2 overflow-y-auto pr-1">
            {projects.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2 rounded-lg border border-[#1c1c1c] bg-[#111] px-3 py-2.5">
                <div>
                  <p className="text-[12px] font-semibold text-white">{p.name}</p>
                  <p className="text-[10px] text-[#7a7a76]">
                    {p.mediaCount} media · updated {formatDateTime(p.updatedAt)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    await fetch(`/api/projects?id=${p.id}`, { method: "DELETE" }).catch(() => undefined);
                    load();
                  }}
                  className="rounded border border-[#2a2a2a] p-1.5 text-[#7a7a76] hover:border-[#ef4444] hover:text-[#f87171]"
                  aria-label={`Delete project ${p.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Tools */}
      <section className="mt-6">
        <h2 className="bean-label text-[10px] text-[#8f8f8a]">TOOLS</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {TOOL_LINKS.map((t) => (
            <a
              key={t.label}
              href={t.href}
              aria-label={`Open ${t.label}`}
              className="group block rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4 transition-colors hover:border-[#d4a017]/50 hover:bg-[#111] focus-visible:outline-none focus-visible:border-[#d4a017] focus-visible:ring-2 focus-visible:ring-[#d4a017]/40 active:bg-[#161309]"
            >
              <p className="bean-label text-[11px] text-[#d4a017]">{t.label}</p>
              <p className="mt-2 text-[12px] leading-snug text-[#9a9a94] group-hover:text-white">{t.desc}</p>
            </a>
          ))}
        </div>
      </section>

      {/* Recent exports */}
{/* Recent exports */}
      <section className="mt-6 rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
        <h2 className="bean-label text-[10px] text-[#8f8f8a]">RECENT EXPORTS</h2>
        {exports === null ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-[#d4a017]" />
          </div>
        ) : exports.length === 0 ? (
          <p className="mt-3 rounded-lg border border-dashed border-[#242424] px-4 py-8 text-center text-xs text-[#5c5c58]">
            No exports yet. Processed results appear here with validated files.
          </p>
        ) : (
          <ul className="bean-panel-scroll mt-3 max-h-80 space-y-2 overflow-y-auto pr-1">
            {exports.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-2 rounded-lg border border-[#1c1c1c] bg-[#111] px-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-[12px] font-semibold text-white">{e.filename}</p>
                  <p className="text-[10px] text-[#7a7a76]">
                    {e.kind} · {e.format.toUpperCase()} · {formatBytes(e.sizeBytes)}
                    {e.durationSec ? ` · ${formatDuration(e.durationSec)}` : ""} · {formatDateTime(e.createdAt)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <a
                    href={`/api/exports/${e.id}/file`}
                    className="rounded border border-[#2a2a2a] p-1.5 text-[#8f8f8a] hover:border-[#d4a017] hover:text-[#d4a017]"
                    aria-label={`Download ${e.filename}`}
                  >
                    <Download className="h-3.5 w-3.5" />
                  </a>
                  <button
                    type="button"
                    onClick={() => deleteExport(e.id)}
                    className="rounded border border-[#2a2a2a] p-1.5 text-[#7a7a76] hover:border-[#ef4444] hover:text-[#f87171]"
                    aria-label={`Delete ${e.filename}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Media library management */}
      <section className="mt-6 rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
        <h2 className="bean-label text-[10px] text-[#8f8f8a]">MEDIA LIBRARY</h2>
        {media === null ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-[#d4a017]" />
          </div>
        ) : media.length === 0 ? (
          <p className="mt-3 rounded-lg border border-dashed border-[#242424] px-4 py-8 text-center text-xs text-[#5c5c58]">
            No media yet — open any tool and import a file to begin. Uploads are validated server-side with ffprobe.
          </p>
        ) : (
          <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {media.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2 rounded-lg border border-[#1c1c1c] bg-[#111] px-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-[12px] font-semibold text-white">{m.originalName}</p>
                  <p className="text-[10px] text-[#7a7a76]">
                    {m.kind} · {formatDuration(m.durationSec)} · {formatBytes(m.sizeBytes)}
                    {m.role === "BROLL" ? " · B-ROLL" : ""}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => deleteMedia(m.id)}
                  className={cn("shrink-0 rounded border border-[#2a2a2a] p-1.5 text-[#7a7a76] hover:border-[#ef4444] hover:text-[#f87171]")}
                  aria-label={`Delete ${m.originalName}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </ToolShell>
  );
}

function StatCard({ icon: Icon, label, value, sub }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] px-4 py-3.5">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-[#d4a017]" />
        <p className="bean-label text-[9px] text-[#7a7a76]">{label}</p>
      </div>
      <p className="mt-1.5 font-mono text-xl font-bold text-white">{value}</p>
      {sub && <p className="text-[10px] text-[#7a7a76]">{sub}</p>}
    </div>
  );
}
