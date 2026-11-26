"use client";

/**
 * M45-A/B/D — the BEAN FX chat-first production home.
 *
 * ONE conversation, ONE connected project, ONE crew, ONE canonical timeline.
 * The chat rides the EXISTING /api/my-ai/chat service (server-persisted
 * Conversation/ConversationMessage + M44 structured plans), attachments ride
 * the EXISTING /api/media pipeline, video result cards stream REAL renders
 * through the EXISTING owner-validated /api/exports/[id]/file route, and the
 * local project folder rides the File System Access API (lib/project-folder).
 * No second chat backend, no second render path.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Clapperboard, Download, Film, FolderOpen, FolderPlus, Loader2, LogOut, MessageSquarePlus,
  Music, Paperclip, Play, RefreshCw, Search, Send, Settings, Sparkles, Users, X, CheckCircle2, AlertCircle,
} from "lucide-react";
import { BeanLogo } from "@/components/bean/logo";
import {
  connectAndCreate, reconnect, disconnect, status as folderStatus, verifyFiles, saveDeliverable,
  saveAssetFile, isSupported, type LocalFolderStatus,
} from "@/lib/project-folder";

type Section = "chat" | "projects" | "assets" | "crew" | "settings";

interface ConversationLite { id: string; title: string; projectId: string | null; updatedAt: string }
interface ChatMessage { id: string; role: string; content: string; plan?: PlanSummary | null; createdAt?: string }
interface PlanSummary { planId?: string; requestSummary?: string; status?: string; stepCount?: number }
interface ProjectLite { id: string; name: string; mediaAssets?: number }
interface AssetLite {
  id: string; originalName: string; kind: string; durationSec: number | null; sizeBytes: number | null;
  probeStatus?: string | null; thumbnailUrl?: string | null;
}
interface RenderCard {
  exportId: string; filename: string; format: string; sizeBytes: number | null;
  durationSec: number | null; createdAt: string; params?: { projectId?: string | null } | null;
}
interface CrewMember { name: string; role: string; blurb: string }

const CREW: CrewMember[] = [
  { name: "RIISHE", role: "Executive Director", blurb: "Understands your brief, builds the production plan, routes specialists, and executes approved work through the canonical command system." },
  { name: "NIIKI", role: "VFX & Motion Graphics", blurb: "Chroma key, shape masks, motion blur, real libvidstab stabilization, animated titles and graphics." },
  { name: "GANGZII", role: "Sound Director", blurb: "Audio analysis, levels, ducking and music direction — availability follows the configured providers." },
  { name: "JAZMII", role: "Footage Intelligence", blurb: "Scene and shot analysis of authorized footage; recommendations reference real assets." },
  { name: "LAXII", role: "Image Specialist", blurb: "Generated images and artwork when a provider is configured; provenance recorded." },
];

function fmtBytes(n: number | null): string {
  if (!n) return "—";
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function ProductionHome({ user, onLogout }: { user: { name: string | null; email: string }; onLogout: () => void }) {
  const [section, setSection] = useState<Section>("chat");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Conversations + chat
  const [conversations, setConversations] = useState<ConversationLite[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [providerMode, setProviderMode] = useState<string | null>(null);

  // Projects
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [newProjectName, setNewProjectName] = useState("");

  // Assets + renders
  const [assets, setAssets] = useState<AssetLite[]>([]);
  const [renders, setRenders] = useState<RenderCard[]>([]);

  // Attachments
  const [attachments, setAttachments] = useState<Array<{ id: string; name: string; state: "uploading" | "ready" | "failed"; kind?: string }>>([]);

  // Local folder
  const [folder, setFolder] = useState<LocalFolderStatus | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderNotice, setFolderNotice] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const loadConversations = useCallback(async () => {
    const res = await fetch("/api/my-ai/conversations");
    if (res.ok) {
      const d = await res.json();
      setConversations(d.conversations ?? []);
    }
  }, []);

  const loadProjects = useCallback(async () => {
    const res = await fetch("/api/projects");
    if (res.ok) {
      const d = await res.json();
      setProjects(d.projects ?? []);
    }
  }, []);

  const loadAssets = useCallback(async () => {
    const res = await fetch("/api/media");
    if (res.ok) {
      const d = await res.json();
      setAssets(d.media ?? []);
    }
  }, []);

  const loadRenders = useCallback(async (projectId: string | null) => {
    if (!projectId) {
      setRenders([]);
      return;
    }
    const res = await fetch("/api/exports?kind=TIMELINE_RENDER");
    if (res.ok) {
      const d = await res.json();
      const all = (d.exports ?? []) as RenderCard[];
      setRenders(all.filter((r) => r.params?.projectId === projectId));
    }
  }, []);

  const refreshFolder = useCallback(async () => {
    setFolder(await folderStatus());
  }, []);

  useEffect(() => {
    void loadConversations();
    void loadProjects();
    void loadAssets();
    void refreshFolder();
  }, [loadConversations, loadProjects, loadAssets, refreshFolder]);

  useEffect(() => {
    if (activeProjectId) void loadRenders(activeProjectId);
  }, [activeProjectId, loadRenders]);

  // Restore a conversation from the SERVER (history survives reload/devices).
  const openConversation = useCallback(async (id: string) => {
    setActiveConversationId(id);
    setSection("chat");
    setSidebarOpen(false);
    const res = await fetch(`/api/my-ai/conversations/${id}/messages`);
    if (res.ok) {
      const d = await res.json();
      const restored: ChatMessage[] = (d.messages ?? []).map((m: { id: string; role: string; content: string; meta: { planId?: string } | null; createdAt: string }) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        plan: m.meta?.planId ? { planId: m.meta.planId } : null,
        createdAt: m.createdAt,
      }));
      setMessages(restored);
      const conv = (d.conversation ?? {}) as { projectId?: string | null };
      if (conv.projectId) setActiveProjectId(conv.projectId);
    } else {
      setChatError("Conversation history could not be restored.");
    }
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, sending]);

  /** Start a new production: real project row + fresh conversation context. */
  const newProduction = useCallback(async () => {
    setSection("chat");
    setSidebarOpen(false);
    const name = (newProjectName.trim() || `Production ${new Date().toLocaleDateString()}`).slice(0, 80);
    setNewProjectName("");
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      setChatError("The project could not be created.");
      return;
    }
    const d = await res.json();
    setActiveProjectId(d.project.id);
    setActiveConversationId(null);
    setMessages([]);
    setAttachments([]);
    setRenders([]);
    setFolderNotice(null);
    await loadProjects();
  }, [newProjectName, loadProjects]);

  /** Attach files through the EXISTING media pipeline (probe + thumbnail). */
  const attachFiles = useCallback(async (files: FileList | File[]) => {
    for (const file of Array.from(files).slice(0, 8)) {
      const tempId = `up-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setAttachments((a) => [...a, { id: tempId, name: file.name, state: "uploading" }]);
      try {
        const res = await fetch("/api/media", {
          method: "POST",
          headers: { "x-filename": encodeURIComponent(file.name), "Content-Type": file.type || "application/octet-stream" },
          body: file,
        });
        const d = await res.json().catch(() => null);
        if (!res.ok || !d?.media?.id) throw new Error(d?.error ?? `Upload failed (${res.status})`);
        setAttachments((a) => a.map((x) => (x.id === tempId ? { ...x, id: d.media.id, state: "ready", kind: d.media.kind } : x)));
        void loadAssets();
      } catch (err) {
        setAttachments((a) => a.map((x) => (x.id === tempId ? { ...x, state: "failed" } : x)));
        setChatError(err instanceof Error ? err.message : "An upload failed.");
      }
    }
  }, [loadAssets]);

  /** Send a brief to RIISHE through the existing chat service. */
  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setChatError(null);
    const attachmentNote = attachments.filter((a) => a.state === "ready").map((a) => a.name).join(", ");
    const fullMessage = attachmentNote ? `${text}\n\n[Attached to this production: ${attachmentNote}]` : text;
    const optimistic: ChatMessage = { id: `local-${Date.now()}`, role: "user", content: text };
    setMessages((m) => [...m, optimistic]);
    setDraft("");
    try {
      const res = await fetch("/api/my-ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: activeProjectId, conversationId: activeConversationId, message: fullMessage }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) {
        setChatError(d?.error ?? `The chat service refused the message (${res.status}).`);
        return;
      }
      setActiveConversationId(d.conversationId);
      setProviderMode(d.mode ?? null);
      setMessages((m) => [
        ...m,
        { id: `a-${Date.now()}`, role: "assistant", content: d.reply ?? "", plan: d.plan ?? null },
      ]);
      if (d.plan) void loadConversations();
      if (activeProjectId) void loadRenders(activeProjectId);
    } catch {
      setChatError("Network error — the message was not delivered.");
    } finally {
      setSending(false);
    }
  }, [draft, sending, attachments, activeProjectId, activeConversationId, loadConversations, loadRenders]);

  /** Save a rendered deliverable into the connected local folder. */
  const saveToFolder = useCallback(async (card: RenderCard) => {
    setFolderBusy(true);
    setFolderNotice(null);
    try {
      const rel = await saveDeliverable(card.exportId, card.filename, card.sizeBytes);
      setFolderNotice(`Saved into the connected folder: ${rel}`);
    } catch (err) {
      setFolderNotice(err instanceof Error ? err.message : "The file could not be saved to the local folder.");
    } finally {
      setFolderBusy(false);
    }
  }, []);

  const saveAssetLocally = useCallback(async (asset: AssetLite) => {
    setFolderBusy(true);
    setFolderNotice(null);
    try {
      const res = await fetch(`/api/media/${asset.id}/file`);
      if (!res.ok) throw new Error(`The file could not be downloaded (${res.status}).`);
      const bytes = await res.arrayBuffer();
      const rel = await saveAssetFile({ id: asset.id, originalName: asset.originalName, kind: asset.kind, durationSec: asset.durationSec, sizeBytes: asset.sizeBytes }, bytes);
      setFolderNotice(`Saved into the connected folder: ${rel}`);
    } catch (err) {
      setFolderNotice(err instanceof Error ? err.message : "The asset could not be saved to the local folder.");
    } finally {
      setFolderBusy(false);
    }
  }, []);

  const connectFolder = useCallback(async (existing: boolean) => {
    if (!activeProjectId) {
      setFolderNotice("Create or select a production first — the folder belongs to a project.");
      return;
    }
    setFolderBusy(true);
    setFolderNotice(null);
    try {
      const project = projects.find((p) => p.id === activeProjectId);
      const st = await connectAndCreate(activeProjectId, project?.name ?? "BEAN FX Project", existing);
      setFolder(st);
      setFolderNotice(st.verified ? `Connected: ${st.folderName} — the standard BEAN FX project tree was created.` : st.detail);
    } catch (err) {
      setFolderNotice(err instanceof Error ? err.message : "Folder selection was cancelled or failed.");
    } finally {
      setFolderBusy(false);
    }
  }, [activeProjectId, projects]);

  const reconnectFolder = useCallback(async () => {
    if (!activeProjectId) return;
    setFolderBusy(true);
    setFolderNotice(null);
    try {
      const st = await reconnect(activeProjectId);
      setFolder(st);
      setFolderNotice(st.detail ?? `Reconnected: ${st.folderName}`);
    } catch (err) {
      setFolderNotice(err instanceof Error ? err.message : "Reconnect was cancelled or failed.");
    } finally {
      setFolderBusy(false);
    }
  }, [activeProjectId]);

  const checkFolderIntegrity = useCallback(async () => {
    setFolderBusy(true);
    try {
      const r = await verifyFiles();
      setFolderNotice(`Folder check: ${r.present} file(s) present${r.missing.length ? `, ${r.missing.length} missing: ${r.missing.slice(0, 4).join(", ")}${r.missing.length > 4 ? "…" : ""}` : ""}.`);
    } catch (err) {
      setFolderNotice(err instanceof Error ? err.message : "The folder could not be verified.");
    } finally {
      setFolderBusy(false);
    }
  }, []);

  const filteredConversations = conversations.filter((c) => c.title.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="flex h-screen overflow-hidden bg-[#050505] text-white">
      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <aside className={`${sidebarOpen ? "fixed inset-0 z-40 flex bg-[#050505]/97" : "hidden"} w-[280px] shrink-0 flex-col border-r border-[#161616] bg-[#080807] md:flex`}>
        <div className="flex items-center justify-between border-b border-[#161616] px-4 py-3">
          <a href="#/" aria-label="BEAN FX home"><BeanLogo /></a>
          <button onClick={() => setSidebarOpen(false)} className="rounded p-1 text-[#6a6a64] hover:text-white md:hidden" aria-label="Close menu"><X className="h-4 w-4" /></button>
        </div>
        <div className="px-3 pt-3">
          <button
            onClick={() => void newProduction()}
            className="bean-glow flex w-full items-center justify-center gap-2 rounded-lg bg-[#d4a017] px-3 py-2.5 text-[11px] font-extrabold uppercase tracking-[0.14em] text-[#0c0c0c] transition-colors hover:bg-[#e9b52a]"
          >
            <MessageSquarePlus className="h-4 w-4" /> New Production
          </button>
        </div>
        <div className="px-3 pt-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#55555a]" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search conversations"
              className="h-8 w-full rounded-md border border-[#242422] bg-[#0f0f0e] pl-8 pr-2 text-xs text-white placeholder:text-[#55555a] focus:border-[#d4a017] focus:outline-none"
            />
          </div>
        </div>
        <nav className="bean-panel-scroll mt-3 flex-1 overflow-y-auto px-3 pb-3">
          <p className="bean-label px-1 pb-1.5 text-[9px] text-[#5a5a55]">Recent conversations</p>
          <ul className="flex flex-col gap-0.5">
            {filteredConversations.slice(0, 12).map((c) => (
              <li key={c.id}>
                <button
                  onClick={() => void openConversation(c.id)}
                  className={`w-full truncate rounded px-2 py-1.5 text-left text-xs ${activeConversationId === c.id ? "bg-[#d4a017]/10 text-[#d4a017]" : "text-[#a8a8a0] hover:bg-[#111110] hover:text-white"}`}
                  title={c.title}
                >
                  {c.title}
                </button>
              </li>
            ))}
            {filteredConversations.length === 0 && (
              <li className="px-2 py-1.5 text-[11px] leading-relaxed text-[#55555a]">No conversations yet — describe the video you want to make.</li>
            )}
          </ul>
          <div className="mt-4 flex flex-col gap-0.5">
            {([
              ["chat", "Conversations", Sparkles],
              ["projects", "Projects", Film],
              ["assets", "Assets", Music],
              ["crew", "AI Crew", Users],
              ["settings", "Settings", Settings],
            ] as const).map(([key, label, Icon]) => (
              <button
                key={key}
                onClick={() => { setSection(key); setSidebarOpen(false); }}
                className={`flex items-center gap-2.5 rounded px-2 py-1.5 text-xs ${section === key ? "bg-[#111110] text-[#d4a017]" : "text-[#a8a8a0] hover:bg-[#111110] hover:text-white"}`}
              >
                <Icon className="h-3.5 w-3.5" /> {label}
              </button>
            ))}
          </div>
        </nav>
        <div className="border-t border-[#161616] px-4 py-3">
          <p className="truncate text-xs font-semibold text-[#d8d8d2]" title={user.email}>{user.name ?? user.email}</p>
          <button onClick={onLogout} className="mt-1.5 flex items-center gap-1.5 text-[11px] text-[#6a6a64] hover:text-[#f87171]">
            <LogOut className="h-3 w-3" /> Sign out
          </button>
        </div>
      </aside>

      {/* ── Main ────────────────────────────────────────────────────────── */}
      <main className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <div className="flex items-center justify-between border-b border-[#161616] px-4 py-2 md:hidden">
          <button onClick={() => setSidebarOpen(true)} className="rounded p-1.5 text-[#a8a8a0] hover:text-white" aria-label="Open menu"><Clapperboard className="h-5 w-5" /></button>
          <span className="text-xs font-bold text-[#d4a017]">BEAN FX</span>
          <button onClick={() => void newProduction()} aria-label="New production"><MessageSquarePlus className="h-5 w-5 text-[#d4a017]" /></button>
        </div>

        {section === "chat" && (
          <div className="flex min-h-0 flex-1 flex-col">
            {/* Chat header */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#161616] px-4 py-2.5 sm:px-6">
              <div className="flex min-w-0 items-center gap-2">
                <span className="bean-label text-[10px] text-[#7a7a76]">PRODUCTION CHAT</span>
                {activeProjectId && (
                  <span className="max-w-[220px] truncate rounded border border-[#2a2a2a] px-2 py-0.5 text-[10px] text-[#d4a017]" title={projects.find((p) => p.id === activeProjectId)?.name}>
                    {projects.find((p) => p.id === activeProjectId)?.name ?? "project"}
                  </span>
                )}
                {providerMode && (
                  <span className="rounded border border-[#2a2a2a] px-1.5 py-0.5 text-[9px] text-[#6a6a64]" title="Honest mode of the last assistant reply">
                    {providerMode === "deterministic" ? "deterministic (no LLM provider configured)" : providerMode}
                  </span>
                )}
              </div>
              {activeProjectId && (
                <div className="flex items-center gap-2">
                  <a
                    href={`#/editor?project=${activeProjectId}`}
                    className="rounded border border-[#2a2a2a] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-[#d4a017] hover:border-[#d4a017]"
                    title="Open this production in the professional editor"
                  >
                    Open Editor
                  </a>
                  <button onClick={() => void loadRenders(activeProjectId)} className="rounded border border-[#2a2a2a] p-1 text-[#8f8f8a] hover:border-[#d4a017] hover:text-[#d4a017]" title="Refresh renders" aria-label="Refresh renders">
                    <RefreshCw className="h-3 w-3" />
                  </button>
                </div>
              )}
            </div>

            {/* Messages */}
            <div className="bean-panel-scroll min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
              <div className="mx-auto flex max-w-3xl flex-col gap-4">
                {messages.length === 0 && (
                  <div className="rounded-2xl border border-[#1c1c1a] bg-[#0b0b0a] p-6 text-center">
                    <h2 className="text-lg font-extrabold text-white">What video should we produce?</h2>
                    <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-[#8f8f8a]">
                      Describe it like you would to a production studio — story, mood, duration, platform — and attach your
                      raw footage, references, music or documents. RIISHE will plan the production and route the crew.
                    </p>
                    <p className="mt-3 text-[11px] text-[#55555a]">
                      Tip: create the production first ({`"`}New Production{`"`}), then connect a local project folder from Settings.
                    </p>
                  </div>
                )}
                {messages.map((m) => (
                  m.role === "user" ? (
                    <div key={m.id} className="flex justify-end">
                      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-[#d4a017] px-4 py-2.5 text-[13px] leading-relaxed text-[#141414]">
                        {m.content}
                      </div>
                    </div>
                  ) : (
                    <div key={m.id} className="flex flex-col gap-2">
                      <div className="max-w-[92%] whitespace-pre-wrap rounded-2xl rounded-bl-md border border-[#22221f] bg-[#111110] px-4 py-3 text-[13px] leading-relaxed text-[#e6e6e0]">
                        {m.content}
                      </div>
                      {m.plan && (
                        <div className="ml-2 max-w-[92%] rounded-xl border border-[#d4a017]/30 bg-[#d4a017]/5 px-3.5 py-2.5">
                          <p className="bean-label text-[9px] text-[#d4a017]">EDITING PLAN · AWAITING YOUR APPROVAL</p>
                          <p className="mt-1 text-xs text-[#c8c8c2]">{m.plan.requestSummary ?? "A structured editing plan was drafted."}</p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {activeProjectId && (
                              <a href={`#/editor?project=${activeProjectId}`} className="rounded border border-[#d4a017]/40 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-[#d4a017] hover:bg-[#d4a017]/10">
                                Review in Editor
                              </a>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )
                ))}
                {chatError && (
                  <p className="flex items-start gap-2 rounded-lg border border-[#3b1515] bg-[#1a0d0d] px-3 py-2 text-xs leading-relaxed text-[#f87171]">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {chatError}
                  </p>
                )}
                {/* Real rendered outputs for this production (M45-D) */}
                {renders.length > 0 && (
                  <div className="flex flex-col gap-3">
                    <p className="bean-label text-[9px] text-[#7a7a76]">RENDERED VERSIONS · {renders.length}</p>
                    {renders.map((card, i) => (
                      <div key={card.exportId} className="overflow-hidden rounded-2xl border border-[#2a2a28] bg-[#0d0d0c]">
                        <div className="flex items-center justify-between border-b border-[#1c1c1a] px-3.5 py-2">
                          <span className="text-xs font-bold text-[#d4a017]">Version {renders.length - i}</span>
                          <span className="text-[10px] text-[#6a6a64]">{new Date(card.createdAt).toLocaleString()}</span>
                        </div>
                        <video
                          controls
                          preload="metadata"
                          src={`/api/exports/${card.exportId}/file`}
                          className="max-h-[320px] w-full bg-black"
                        />
                        <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 text-[10px] text-[#8f8f8a]">
                          <span>{card.format.toUpperCase()} · {card.durationSec ? `${card.durationSec.toFixed(1)}s` : "—"} · {fmtBytes(card.sizeBytes)}</span>
                          <div className="flex flex-wrap items-center gap-2">
                            <a href={`/api/exports/${card.exportId}/file?download=1`} download={card.filename} className="flex items-center gap-1 rounded border border-[#2a2a2a] px-2 py-1 text-[10px] text-[#d8d8d2] hover:border-[#d4a017] hover:text-[#d4a017]">
                              <Download className="h-3 w-3" /> Download
                            </a>
                            {activeProjectId && (
                              <a href={`#/editor?project=${activeProjectId}`} className="rounded border border-[#2a2a2a] px-2 py-1 text-[10px] text-[#d8d8d2] hover:border-[#d4a017] hover:text-[#d4a017]">
                                Open Editor
                              </a>
                            )}
                            <button
                              onClick={() => void saveToFolder(card)}
                              disabled={folderBusy || !folder?.verified}
                              className="flex items-center gap-1 rounded border border-[#2a2a2a] px-2 py-1 text-[10px] text-[#d8d8d2] hover:border-[#d4a017] hover:text-[#d4a017] disabled:opacity-40"
                              title={folder?.verified ? "Save into the connected local project folder" : "Connect a local folder in Settings first"}
                            >
                              <FolderPlus className="h-3 w-3" /> Save to folder
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            </div>

            {/* Composer */}
            <div className="border-t border-[#161616] px-4 pb-3 pt-3 sm:px-6">
              <div className="mx-auto max-w-3xl">
                {attachments.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {attachments.map((a) => (
                      <span key={a.id} className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] ${a.state === "ready" ? "border-[#1e3a26] bg-[#0d1a10] text-[#4cc47f]" : a.state === "failed" ? "border-[#3b1515] bg-[#1a0d0d] text-[#f87171]" : "border-[#2a2a2a] bg-[#111110] text-[#a8a8a0]"}`}>
                        {a.state === "uploading" && <Loader2 className="h-3 w-3 animate-spin" />}
                        {a.state === "failed" && <AlertCircle className="h-3 w-3" />}
                        {a.state === "ready" && <CheckCircle2 className="h-3 w-3" />}
                        <span className="max-w-[160px] truncate">{a.name}</span>
                        <button onClick={() => setAttachments((arr) => arr.filter((x) => x.id !== a.id))} aria-label={`Remove ${a.name}`} className="text-current opacity-60 hover:opacity-100"><X className="h-3 w-3" /></button>
                      </span>
                    ))}
                  </div>
                )}
                <div
                  className="rounded-2xl border border-[#242422] bg-[#0e0e0d] p-2 focus-within:border-[#d4a017]"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files.length) void attachFiles(e.dataTransfer.files); }}
                >
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void send();
                      }
                    }}
                    rows={2}
                    placeholder="Describe the video you want — or ask RIISHE to change something in the current production…"
                    className="max-h-40 w-full resize-none bg-transparent px-2 py-1.5 text-[13px] leading-relaxed text-white placeholder:text-[#55555a] focus:outline-none"
                  />
                  <div className="flex items-center justify-between px-1 pt-1">
                    <label className="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-[#8f8f8a] hover:text-[#d4a017]" title="Attach videos, images, audio or documents">
                      <Paperclip className="h-3.5 w-3.5" />
                      Attach
                      <input type="file" multiple className="hidden" onChange={(e) => { if (e.target.files) void attachFiles(e.target.files); e.target.value = ""; }} />
                    </label>
                    <button
                      onClick={() => void send()}
                      disabled={sending || !draft.trim()}
                      className="bean-glow flex items-center gap-1.5 rounded-lg bg-[#d4a017] px-4 py-1.5 text-[11px] font-extrabold uppercase tracking-[0.12em] text-[#0c0c0c] hover:bg-[#e9b52a] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                      Send
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {section === "projects" && (
          <SectionShell title="Projects">
            <div className="mb-3 flex gap-2">
              <input
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                placeholder="New production name"
                className="h-9 flex-1 rounded-md border border-[#242422] bg-[#0f0f0e] px-3 text-sm text-white placeholder:text-[#55555a] focus:border-[#d4a017] focus:outline-none"
              />
              <button onClick={() => void newProduction()} className="bean-glow rounded-md bg-[#d4a017] px-4 text-[11px] font-extrabold uppercase tracking-wider text-[#0c0c0c] hover:bg-[#e9b52a]">Create</button>
            </div>
            <ul className="flex flex-col gap-1.5">
              {projects.map((p) => (
                <li key={p.id}>
                  <button
                    onClick={() => { setActiveProjectId(p.id); setSection("chat"); }}
                    className={`flex w-full items-center justify-between rounded-lg border px-3.5 py-2.5 text-left ${activeProjectId === p.id ? "border-[#d4a017]/50 bg-[#d4a017]/5" : "border-[#1c1c1a] bg-[#0d0d0c] hover:border-[#2e2e2c]"}`}
                  >
                    <span className="truncate text-sm text-[#e6e6e0]">{p.name}</span>
                    <span className="ml-3 shrink-0 text-[10px] text-[#6a6a64]">{p.mediaAssets ?? 0} assets</span>
                  </button>
                </li>
              ))}
              {projects.length === 0 && <li className="text-xs text-[#55555a]">No productions yet.</li>}
            </ul>
          </SectionShell>
        )}

        {section === "assets" && (
          <SectionShell title="Assets" note="Uploaded through the existing probe pipeline — thumbnails appear once probing finishes.">
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {assets.map((a) => (
                <li key={a.id} className="flex gap-2.5 rounded-lg border border-[#1c1c1a] bg-[#0d0d0c] p-2.5">
                  {a.thumbnailUrl ? (
                    <img src={a.thumbnailUrl} alt="" loading="lazy" className="h-14 w-[96px] shrink-0 rounded object-cover" />
                  ) : (
                    <div className="flex h-14 w-[96px] shrink-0 items-center justify-center rounded bg-[#111110] text-[#3a3a38]">
                      {a.kind === "AUDIO" ? <Music className="h-5 w-5" /> : <Film className="h-5 w-5" />}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs text-[#e6e6e0]" title={a.originalName}>{a.originalName}</p>
                    <p className="mt-0.5 font-mono text-[10px] text-[#5a5a55]">
                      {a.durationSec ? `${a.durationSec.toFixed(1)}s` : a.kind.toLowerCase()} · {fmtBytes(a.sizeBytes)} · {a.probeStatus ?? "pending"}
                    </p>
                    <button
                      onClick={() => void saveAssetLocally(a)}
                      disabled={folderBusy || !folder?.verified}
                      className="mt-1.5 flex items-center gap-1 rounded border border-[#2a2a2a] px-1.5 py-0.5 text-[10px] text-[#d8d8d2] hover:border-[#d4a017] hover:text-[#d4a017] disabled:opacity-40"
                      title={folder?.verified ? "Copy into the connected local folder" : "Connect a local folder in Settings first"}
                    >
                      <FolderPlus className="h-3 w-3" /> Save to folder
                    </button>
                  </div>
                </li>
              ))}
              {assets.length === 0 && <li className="text-xs text-[#55555a]">No assets yet — attach files in the chat composer.</li>}
            </ul>
          </SectionShell>
        )}

        {section === "crew" && (
          <SectionShell title="AI Crew" note="RIISHE routes these specialists from your brief — you never need to drive each tab separately.">
            <ul className="flex flex-col gap-2">
              {CREW.map((c) => (
                <li key={c.name} className="rounded-lg border border-[#1c1c1a] bg-[#0d0d0c] p-3.5">
                  <p className="text-sm font-bold text-[#d4a017]">{c.name} <span className="ml-2 text-[11px] font-normal text-[#8f8f8a]">{c.role}</span></p>
                  <p className="mt-1 text-xs leading-relaxed text-[#a8a8a0]">{c.blurb}</p>
                </li>
              ))}
            </ul>
          </SectionShell>
        )}

        {section === "settings" && (
          <SectionShell title="Settings">
            <div className="rounded-lg border border-[#1c1c1a] bg-[#0d0d0c] p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-bold text-white">Local project folder</p>
                {folder?.connected && <span className="flex items-center gap-1 text-[10px] text-[#4cc47f]"><span className="h-1.5 w-1.5 rounded-full bg-[#4cc47f]" /> connected</span>}
                {folder && !folder.connected && folder.needsReconnect && <span className="text-[10px] text-[#d4a017]">needs reconnect</span>}
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-[#8f8f8a]">
                {isSupported()
                  ? "Connect a folder on your own computer. BEAN FX creates the standard project tree (00_Brief … 12_Archive) and a beanfx-manifest.json inside it. Nothing outside the picked folder is touched, and no absolute local path is stored on the server."
                  : "This browser does not support the File System Access API (use Chrome or Edge). Fallback: download deliverables normally — everything still works, files just land in your Downloads folder instead of a managed project tree."}
              </p>
              {folder?.folderName && (
                <p className="mt-2 text-[11px] text-[#a8a8a0]">
                  Connected folder: <span className="font-mono text-[#d4a017]">{folder.folderName}</span>
                  {folder.projectName ? <> · project: {folder.projectName}</> : null}
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <button onClick={() => void connectFolder(false)} disabled={folderBusy || !activeProjectId} className="flex items-center gap-1.5 rounded-md border border-[#2a2a2a] px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-[#d4a017] hover:border-[#d4a017] disabled:opacity-40">
                  <FolderPlus className="h-3.5 w-3.5" /> {folderBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Create & connect
                </button>
                <button onClick={() => void connectFolder(true)} disabled={folderBusy || !activeProjectId} className="rounded-md border border-[#2a2a2a] px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-[#8f8f8a] hover:border-[#d4a017] hover:text-[#d4a017] disabled:opacity-40" title="Select an existing BEAN FX project directory">
                  Use existing folder
                </button>
                {folder?.needsReconnect && (
                  <button onClick={() => void reconnectFolder()} disabled={folderBusy} className="rounded-md border border-[#d4a017]/50 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-[#d4a017] disabled:opacity-40">
                    Reconnect
                  </button>
                )}
                {folder?.connected && (
                  <>
                    <button onClick={() => void checkFolderIntegrity()} disabled={folderBusy} className="flex items-center gap-1.5 rounded-md border border-[#2a2a2a] px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-[#8f8f8a] hover:border-[#d4a017] hover:text-[#d4a017] disabled:opacity-40">
                      <FolderOpen className="h-3.5 w-3.5" /> Verify files
                    </button>
                    <button onClick={() => { disconnect(); void refreshFolder(); }} className="rounded-md border border-[#2a2a2a] px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-[#8f8f8a] hover:border-[#f87171] hover:text-[#f87171]">
                      Disconnect
                    </button>
                  </>
                )}
              </div>
              {!activeProjectId && <p className="mt-2 text-[11px] text-[#d4a017]">Create or select a production first — the folder belongs to a project.</p>}
              {folderNotice && <p className="mt-2 text-[11px] leading-relaxed text-[#a8a8a0]">{folderNotice}</p>}
            </div>
            <div className="mt-3 rounded-lg border border-[#1c1c1a] bg-[#0d0d0c] p-4">
              <p className="text-sm font-bold text-white">Account</p>
              <p className="mt-1 text-xs text-[#8f8f8a]">{user.name ?? "—"} · {user.email}</p>
              <button onClick={onLogout} className="mt-3 flex items-center gap-1.5 rounded-md border border-[#2a2a2a] px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-[#f87171] hover:border-[#f87171]">
                <LogOut className="h-3.5 w-3.5" /> Sign out
              </button>
            </div>
          </SectionShell>
        )}
      </main>
    </div>
  );
}

function SectionShell({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="bean-panel-scroll min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
      <div className="mx-auto max-w-3xl">
        <h2 className="text-base font-extrabold text-white">{title}</h2>
        {note && <p className="mt-1 text-xs leading-relaxed text-[#6a6a64]">{note}</p>}
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}

/** Play affordance exported for tests/a11y tooling. */
export const PlayIcon = Play;
