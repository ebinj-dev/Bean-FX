"use client";

/**
 * BEAN FX — Professional Editing Workspace (M15).
 *
 * The primary application experience: an integrated desktop editing
 * environment — application header (project/workspace/undo/save/export),
 * resizable PROJECT & MEDIA / EFFECTS left dock, PROGRAM MONITOR with the
 * interactive composition canvas, PROPERTIES INSPECTOR, editing-tool toolbar
 * and the multitrack timeline. Every control drives the existing M1 command
 * engine / engine panels — nothing decorative.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, Bot, Check, ChevronLeft, ChevronRight, CloudUpload, Download, LayoutGrid, Loader2,
  Pause, Play, Redo2, Settings, SlidersHorizontal, Sparkles, Undo2, Package } from "lucide-react";
import type { MediaMeta, RiisheAnalyzeResult, SavedDecisionView } from "@/lib/types";

interface ProjectSummary { id: string; name: string }
import { formatTimecode, rationalFromFps } from "@/lib/editor/time";
import type { Rational } from "@/lib/editor/time";
import { sequenceEndFrame } from "@/lib/editor/preview";
import { api } from "@/lib/client-api";
import { effectiveRemovalSec, planRiisheTimelineApply } from "@/lib/riishe-timeline";
import { useEditorSession } from "@/hooks/use-editor-session";
import { ProjectPortability } from "@/components/bean/editor/portability-panel";
import { ProgramMonitor } from "@/components/bean/editor/monitor";
import { EditorTimeline } from "@/components/bean/editor/timeline";
import { ClipInspector } from "@/components/bean/editor/inspector";
import { EditingToolbar } from "@/components/bean/editor/editing-toolbar";
import { MediaBrowser, useMediaImport } from "@/components/bean/editor/media-browser";
import { EffectsBrowser } from "@/components/bean/editor/effects-browser";
import { AiStudio } from "@/components/bean/editor/ai-studio";
import { PublishingPanel } from "@/components/bean/editor/publishing-panel";
import { AudioMixerPanel } from "@/components/bean/editor/audio-mixer-panel";
import { PresetsPanel } from "@/components/bean/editor/presets-panel";
import { BatchExportPanel } from "@/components/bean/editor/batch-export-panel";
import { WorkflowsPanel } from "@/components/bean/editor/workflows-panel";
import { StudioPanel } from "@/components/bean/editor/studio-panel";
import type { EditToolId } from "@/lib/editor/tools";
import { subscribeFrame } from "@/lib/editor/playback";

const DEFAULT_IMAGE_TIMELINE_SEC = 5;

type Drawer = "ai-studio" | "export" | "settings" | "mixer" | "presets" | "workflows" | "portability" | null;
type LeftTab = "media" | "effects";

export function EditorTool({ user }: { user: { id: string }; onLogout: () => void }) {
  void user;
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [newProjectName, setNewProjectName] = useState("");
  const [media, setMedia] = useState<MediaMeta[] | null>(null);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(1.5);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeTool, setActiveTool] = useState<EditToolId>("select");
  const [snap, setSnap] = useState(true);
  // M26 P1 — in/out range selection (I/O keys; cleared with Esc or after lift).
  const [range, setRange] = useState<{ in: number; out: number } | null>(null);
  const [guides, setGuides] = useState(false);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [leftTab, setLeftTab] = useState<LeftTab>("media");
  const [leftWidth, setLeftWidth] = useState(260);
  const [rightWidth, setRightWidth] = useState(300);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");

  const session = useEditorSession(projectId);
  const sequence = session.sequence;
  const [riisheBusy, setRiisheBusy] = useState(false);
  const refreshMedia = useCallback(() => {
    api.listMedia().then((res) => setMedia(res.media)).catch(() => undefined);
  }, []);
  const { importing, importFiles } = useMediaImport(refreshMedia, (m) => setNotice(m));

  // Open a project directly via #/editor?project=<id> (dashboard deep link).
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("project");
    if (wanted) setProjectId(wanted);
  }, []);

  const applyRiisheCuts = useCallback(async () => {
    const seq = session.sequence;
    if (!seq || riisheBusy) return;
    setRiisheBusy(true);
    setNotice(null);
    try {
      const assetIds = [...new Set(seq.clips.filter((c) => c.sourceAssetId && !c.missingMedia).map((c) => c.sourceAssetId))];
      const commands: unknown[] = [];
      const reserved: string[] = [];
      const lines: string[] = [];
      let assetsWithAnalysis = 0;
      for (const assetId of assetIds) {
        const list = await api.analyses(assetId).catch(() => null);
        if (!list?.ok || list.analyses.length === 0) continue;
        assetsWithAnalysis += 1;
        const jobId = list.analyses[0].jobId;
        const result = (await fetch(`/api/autocut/analyze/result/${encodeURIComponent(jobId)}`).then((r) => r.json())) as RiisheAnalyzeResult;
        const decisionRes = await api.decisions(jobId).catch(() => null);
        const decisions: SavedDecisionView[] = decisionRes?.decisions ?? [];
        const removals = effectiveRemovalSec(result.candidates, decisions, result.durationSec);
        const plan = planRiisheTimelineApply({ sequence: seq, removalsSec: removals, sourceAssetId: assetId, reservedIds: reserved });
        reserved.push(...plan.commands.filter((c): c is Extract<(typeof plan.commands)[number], { type: "SplitClip" }> => c.type === "SplitClip").map((c) => c.newRightId));
        if (plan.commands.length > 0) {
          commands.push(...plan.commands);
          lines.push(`${result.originalName}: ${plan.stats.cutsPlanned} cut(s) across ${plan.stats.clipsCut} clip(s)` + (plan.stats.clipsRemoved > 0 ? `, ${plan.stats.clipsRemoved} clip(s) fully removed` : "") + (plan.warnings.length > 0 ? ` — ${plan.warnings.length} proposal(s) skipped honestly` : ""));
        } else if (plan.warnings.length > 0) {
          lines.push(`${result.originalName}: nothing applied — ${plan.warnings[0]}`);
        }
      }
      if (commands.length === 0) {
        setNotice(assetsWithAnalysis === 0 ? "No completed RIISHE analysis found for the media used in this sequence — analyze the media in the Auto Cut tool first." : "RIISHE analyses found, but no approved cuts to apply.");
        return;
      }
      const ok = window.confirm(`Apply RIISHE cuts to the timeline?\n\n${lines.join("\n")}\n\n${commands.length} validated commands, applied atomically as one undoable step.`);
      if (!ok) return;
      const applied = session.apply(commands);
      setNotice(applied ? `RIISHE cuts applied — ${lines.join(" · ")} — undo with Ctrl+Z.` : "RIISHE apply was refused by the validated command engine. Nothing was changed.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "RIISHE apply failed.");
    } finally {
      setRiisheBusy(false);
    }
  }, [session, riisheBusy]);

  // ---- data loading --------------------------------------------------------
  useEffect(() => {
    api
      .projects()
      .then((res) => {
        setProjects(res.projects);
        setProjectId((current) => current ?? res.projects[0]?.id ?? null);
      })
      .catch((err) => setNotice(err instanceof Error ? err.message : "Failed to load projects."));
    refreshMedia();
  }, [refreshMedia]);

  const createProject = useCallback(async () => {
    const name = newProjectName.trim();
    if (!name) return;
    try {
      const res = await api.createProject(name);
      setProjects((prev) => [{ id: (res as { project: { id: string; name: string } }).project.id, name: (res as { project: { name: string } }).project.name }, ...(prev ?? [])]);
      setProjectId((res as { project: { id: string } }).project.id);
      setNewProjectName("");
      setNotice(null);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Failed to create project.");
    }
  }, [newProjectName]);

  const renameProject = useCallback(async () => {
    if (!projectId || !renameValue.trim()) return;
    try {
      await fetch(`/api/projects/${projectId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: renameValue.trim().slice(0, 120) }) });
      setProjects((prev) => prev?.map((p) => (p.id === projectId ? { ...p, name: renameValue.trim().slice(0, 120) } : p)) ?? prev);
      setRenaming(false);
      setNotice(null);
    } catch {
      setNotice("Rename failed.");
    }
  }, [projectId, renameValue]);

  const duplicateProject = useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await fetch(`/api/projects/${projectId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) }).then((r) => r.json());
      const created = res.project as { id: string; name: string } | undefined;
      if (created) {
        setProjects((prev) => [{ id: created.id, name: created.name }, ...(prev ?? [])]);
        setNotice(`Duplicated as "${created.name}" (editing state carried over when the project had a sequence).`);
      }
    } catch {
      setNotice("Duplicate failed.");
    }
  }, [projectId]);

  // ---- transport + edit actions --------------------------------------------
  const fpsRational = sequence?.fps ?? ({ num: 30, den: 1 } as Rational);
  const end = sequence ? sequenceEndFrame(sequence) : 0;

  const togglePlay = useCallback(() => {
    if (!sequence || end === 0) return;
    setPlaying((p) => !p);
  }, [sequence, end]);

  const step = useCallback(
    (delta: number) => {
      setPlaying(false);
      session.setPlayhead(Math.max(0, Math.min(end, session.playheadFrame + delta)));
    },
    [session, end],
  );

  const selectedClip = useMemo(() => sequence?.clips.find((c) => c.id === session.selectedClipId) ?? null, [sequence, session.selectedClipId]);

  const splitAtPlayhead = useCallback(() => {
    if (!sequence || !selectedClip) {
      setNotice("Select a clip to split at the playhead.");
      return;
    }
    const at = session.playheadFrame;
    if (at <= selectedClip.timelineStartFrame || at >= selectedClip.timelineStartFrame + selectedClip.timelineDurationFrames) {
      setNotice("The playhead is outside the selected clip — move it inside first.");
      return;
    }
    const ok = session.apply([{ type: "SplitClip", clipId: selectedClip.id, atTimelineFrame: at, newLeftId: selectedClip.id, newRightId: session.newId("clip") }]);
    if (ok) setNotice(null);
  }, [sequence, selectedClip, session]);

  const deleteSelection = useCallback(
    (ripple: boolean) => {
      if (!selectedClip) {
        setNotice("Select a clip to delete.");
        return;
      }
      const ok = session.apply([ripple ? { type: "RippleDelete", clipId: selectedClip.id } : { type: "RemoveClip", clipId: selectedClip.id }]);
      if (ok) setNotice(null);
    },
    [selectedClip, session],
  );

  const addCaptionAtPlayhead = useCallback(() => {
    if (!sequence) return;
    const capTrack = sequence.tracks.find((t) => t.kind === "CAPTION" && !t.locked);
    if (!capTrack) {
      setNotice("No caption track available.");
      return;
    }
    session.apply([
      {
        type: "AddCaption",
        clip: {
          id: session.newId("cap"),
          trackId: capTrack.id,
          sourceAssetId: "",
          sourceInFrame: 0,
          sourceOutFrame: Math.round(2 * (sequence.fps.num / sequence.fps.den)),
          sourceFps: sequence.fps,
          timelineStartFrame: session.playheadFrame,
          missingMedia: true,
          captionText: "New caption",
        },
      },
    ]);
  }, [sequence, session]);

  const addMediaAtPlayhead = useCallback(
    async (asset: MediaMeta) => {
      if (!sequence) return;
      const wantVideo = asset.kind === "VIDEO" || asset.kind === "IMAGE";
      const kind = wantVideo ? "VIDEO" : "AUDIO";
      const track = sequence.tracks.find((t) => t.kind === kind && !t.locked);
      if (!track) {
        setNotice(`No unlocked ${kind.toLowerCase()} track available — add one first.`);
        return;
      }
      let placed = asset;
      if ((asset.durationSec == null || asset.durationSec <= 0) && asset.kind !== "IMAGE" && asset.probeStatus && asset.probeStatus !== "READY" && asset.probeStatus !== "FAILED") {
        setNotice("Analyzing media — placing it as soon as the probe finishes…");
        placed = await api.waitForProbe(asset.id, 120_000);
      }
      if (placed.probeStatus === "FAILED") {
        setNotice(`Media analysis failed: ${placed.probeError ?? "the file may be corrupt or unsupported."}`);
        return;
      }
      const isImage = placed.kind === "IMAGE";
      if (!isImage && (placed.durationSec == null || placed.durationSec <= 0)) {
        setNotice("This asset has no measurable duration — it cannot be placed.");
        return;
      }
      const seqFps = sequence.fps.num / sequence.fps.den;
      const srcFps = isImage ? seqFps : placed.fps && placed.fps > 0 ? placed.fps : seqFps;
      const sourceDurationFrames = isImage ? Math.round(DEFAULT_IMAGE_TIMELINE_SEC * seqFps) : Math.round((placed.durationSec as number) * srcFps);
      const ok = session.apply([
        {
          type: "AddClip",
          clip: {
            id: session.newId("clip"),
            trackId: track.id,
            sourceAssetId: placed.id,
            sourceInFrame: 0,
            sourceOutFrame: sourceDurationFrames,
            sourceFps: isImage ? sequence.fps : rationalFromFps(srcFps),
            timelineStartFrame: session.playheadFrame,
            label: placed.originalName,
          },
        },
      ]);
      if (ok) {
        setNotice(null);
        session.select(null);
      }
    },
    [sequence, session],
  );

  // ---- keyboard: transport + tool shortcuts --------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        step(e.shiftKey ? -12 : -1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        step(e.shiftKey ? 12 : 1);
      } else if ((e.key === "s" || e.key === "S") && !e.metaKey && !e.ctrlKey) {
        if (snap) setSnap(false);
        else splitAtPlayhead();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteSelection(false);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "z") {
        e.preventDefault();
        if (e.shiftKey) session.redo();
        else session.undo();
      } else if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
        // Ctrl/Cmd+S — flush the autosave NOW (M16 reliability).
        e.preventDefault();
        void session.flushNow().then(() => setNotice(null));
      } else if (!e.metaKey && !e.ctrlKey) {
        // M26 P1 — range in/out + marker keys (frame-accurate, integer playhead).
        if (e.key === "i" || e.key === "I") {
          setRange((r) => ({ in: session.playheadFrame, out: Math.max(session.playheadFrame + 1, r?.out ?? session.playheadFrame + 1) }));
        } else if (e.key === "o" || e.key === "O") {
          setRange((r) => (r ? { in: r.in, out: Math.max(r.in + 1, session.playheadFrame) } : { in: Math.max(0, session.playheadFrame - 1), out: session.playheadFrame }));
        } else if (e.key === "m" || e.key === "M") {
          session.apply([{ type: "AddMarker", marker: { id: `mk-${Date.now().toString(36)}`, frame: session.playheadFrame, label: "" } }]);
        } else if (e.key === "Escape" && range) {
          setRange(null);
        }
        const toolKeys: Record<string, EditToolId> = { v: "select", a: "track-select", c: "razor", e: "roll", y: "slip", u: "slide", h: "hand", z: "zoom", t: "text", r: "transform" };
        const tool = toolKeys[e.key.toLowerCase()];
        if (tool) setActiveTool(tool);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [togglePlay, step, splitAtPlayhead, deleteSelection, session, snap, range]);

  // Unsaved-changes guard: never discard a pending autosave silently.
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (session.saveState === "saved" || session.saveState === "loading") return;
      e.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [session.saveState]);

  // ---- resizable docks ------------------------------------------------------
  const dragRef = useRef<{ side: "left" | "right"; startX: number; startWidth: number } | null>(null);
  const onDockDown = (side: "left" | "right") => (e: React.PointerEvent) => {
    dragRef.current = { side, startX: e.clientX, startWidth: side === "left" ? leftWidth : rightWidth };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onDockMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const { side, startX, startWidth } = dragRef.current;
    const delta = side === "left" ? e.clientX - startX : startX - e.clientX;
    const next = Math.max(200, Math.min(480, startWidth + delta));
    if (side === "left") setLeftWidth(next);
    else setRightWidth(next);
  };
  const onDockUp = () => {
    dragRef.current = null;
  };

  // M16: real asset durations (frames at the sequence rate) for roll/slide
  // extension decisions — from the media library's probe data only.
  const assetFrameDurations = useMemo(() => {
    const map = new Map<string, number>();
    const fps = sequence ? sequence.fps.num / sequence.fps.den : 30;
    for (const m of media ?? []) {
      if (m.durationSec && m.durationSec > 0) map.set(m.id, Math.floor(m.durationSec * fps));
    }
    return map;
  }, [media, sequence?.fps]);

  const saveBadge = {
    saved: { icon: <Check className="h-3 w-3" />, text: session.version ? `Saved v${session.version}` : "Saved", cls: "text-[#4cc47f]" },
    saving: { icon: <CloudUpload className="h-3 w-3 animate-pulse" />, text: "Saving…", cls: "text-[#d4a017]" },
    loading: { icon: <Loader2 className="h-3 w-3 animate-spin" />, text: "Loading…", cls: "text-[#8f8f8a]" },
    error: { icon: <AlertTriangle className="h-3 w-3" />, text: "Save failed", cls: "text-[#c45c4c]" },
    conflict: { icon: <AlertTriangle className="h-3 w-3" />, text: "Conflict — reloaded", cls: "text-[#c45c4c]" },
  }[session.saveState];

  const toolButton =
    "flex items-center justify-center rounded border border-[#2a2a2a] px-2 py-1.5 text-[#d8d8d2] transition-colors hover:border-[#d4a017] hover:text-[#d4a017] disabled:opacity-40 disabled:hover:border-[#2a2a2a] disabled:hover:text-[#d8d8d2]";
  const currentProject = projects?.find((p) => p.id === projectId);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#050505] text-[#d8d8d2]">
      {/* ── Application header ─────────────────────────────────────────── */}
      <header className="flex items-center gap-2 border-b border-[#2a2a2a] bg-[#0d0d0c] px-3 py-1.5">
        <a href="#/studio" className="bean-label shrink-0 text-[11px] text-[#d4a017] hover:text-[#e6b93a]">BEAN FX</a>
        <span className="mx-1 h-5 w-px bg-[#2a2a2a]" />
        {renaming ? (
          <input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value.slice(0, 120))}
            onKeyDown={(e) => e.key === "Enter" && void renameProject()}
            onBlur={() => setRenaming(false)}
            autoFocus
            className="w-40 rounded border border-[#d4a017]/60 bg-[#111110] px-1.5 py-0.5 text-xs outline-none"
          />
        ) : (
          <button type="button" onClick={() => { setRenameValue(currentProject?.name ?? ""); setRenaming(true); }} className="max-w-[220px] truncate rounded px-1.5 py-0.5 text-xs text-[#e6e6e0] hover:bg-[#181816]" title="Click to rename the project">
            {currentProject?.name ?? "No project selected"}
          </button>
        )}
        <select value={projectId ?? ""} onChange={(e) => { setPlaying(false); setProjectId(e.target.value || null); }} className="max-w-[160px] rounded border border-[#2a2a2a] bg-[#111110] px-1.5 py-1 text-xs text-[#e6e6e0] outline-none" aria-label="Switch project">
          <option value="">— select —</option>
          {(projects ?? []).map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <span className={`flex items-center gap-1 text-[10px] ${saveBadge.cls}`}>
          {saveBadge.icon}
          {saveBadge.text}
        </span>

        <span className="mx-1 h-5 w-px bg-[#2a2a2a]" />
        <button type="button" onClick={() => session.undo()} disabled={!session.canUndo} className={toolButton} title="Undo (Ctrl+Z)"><Undo2 className="h-4 w-4" /></button>
        <button type="button" onClick={() => session.redo()} disabled={!session.canRedo} className={toolButton} title="Redo (Ctrl+Shift+Z)"><Redo2 className="h-4 w-4" /></button>

        <span className="mx-1 h-5 w-px bg-[#2a2a2a]" />
        <div className="flex items-center gap-1">
          <input value={newProjectName} onChange={(e) => setNewProjectName(e.target.value.slice(0, 120))} onKeyDown={(e) => e.key === "Enter" && void createProject()} placeholder="New project…" className="w-32 rounded border border-[#2a2a2a] bg-[#111110] px-1.5 py-1 text-xs outline-none placeholder:text-[#5a5a55] focus:border-[#d4a017]" />
          <button type="button" onClick={() => void createProject()} disabled={!newProjectName.trim()} className={toolButton} title="Create project">+</button>
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <button type="button" onClick={() => setDrawer(drawer === "ai-studio" ? null : "ai-studio")} className={`flex items-center gap-1.5 rounded border px-2.5 py-1.5 text-[11px] ${drawer === "ai-studio" ? "border-[#d4a017] text-[#d4a017]" : "border-[#2a2a2a] text-[#d8d8d2] hover:border-[#d4a017] hover:text-[#d4a017]"}`}>
            <Bot className="h-3.5 w-3.5" /> AI STUDIO
          </button>
          <button type="button" onClick={() => setDrawer(drawer === "workflows" ? null : "workflows")} className={`flex items-center gap-1.5 rounded border px-2.5 py-1.5 text-[11px] ${drawer === "workflows" ? "border-[#d4a017] text-[#d4a017]" : "border-[#2a2a2a] text-[#d8d8d2] hover:border-[#d4a017] hover:text-[#d4a017]"}`} title="Workflow automation: multi-step production runs with approval gates">
            WORKFLOWS
          </button>
          <button type="button" onClick={() => setDrawer(drawer === "presets" ? null : "presets")} className={`flex items-center gap-1.5 rounded border px-2.5 py-1.5 text-[11px] ${drawer === "presets" ? "border-[#d4a017] text-[#d4a017]" : "border-[#2a2a2a] text-[#d8d8d2] hover:border-[#d4a017] hover:text-[#d4a017]"}`} title="Creative presets: save, apply, rename, duplicate">
            PRESETS
          </button>
          <button type="button" onClick={() => setDrawer(drawer === "mixer" ? null : "mixer")} className={`flex items-center gap-1.5 rounded border px-2.5 py-1.5 text-[11px] ${drawer === "mixer" ? "border-[#d4a017] text-[#d4a017]" : "border-[#2a2a2a] text-[#d8d8d2] hover:border-[#d4a017] hover:text-[#d4a017]"}`} title="Per-track faders with real meters">
            MIXER
          </button>
          <button type="button" onClick={() => setDrawer(drawer === "export" ? null : "export")} className={`flex items-center gap-1.5 rounded border px-2.5 py-1.5 text-[11px] ${drawer === "export" ? "border-[#d4a017] text-[#d4a017]" : "border-[#2a2a2a] text-[#d8d8d2] hover:border-[#d4a017] hover:text-[#d4a017]"}`}>
            <Download className="h-3.5 w-3.5" /> EXPORT
          </button>
          <button type="button" onClick={() => setDrawer(drawer === "settings" ? null : "settings")} className={toolButton} title="Project settings & history"><Settings className="h-4 w-4" /></button>
          <button type="button" onClick={() => setDrawer(drawer === "portability" ? null : "portability")} className={toolButton} title="Project portability: package, import, bulk relink"><Package className="h-4 w-4" /></button>
          <a href="#/studio" className="flex items-center gap-1 rounded border border-[#2a2a2a] px-2 py-1.5 text-[11px] text-[#d8d8d2] hover:border-[#d4a017] hover:text-[#d4a017]" title="Project dashboard">
            <LayoutGrid className="h-3.5 w-3.5" />
          </a>
        </div>
      </header>

      {(notice || session.error || session.conflictMessage) && (
        <div className="flex items-center gap-2 border-b border-[#2a2a2a] bg-[#1a1206] px-3 py-1.5 text-xs text-[#d4a017]">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{session.conflictMessage ?? session.error ?? notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="text-[#8f8f8a] hover:text-[#d8d8d2]">dismiss</button>
        </div>
      )}

      {/* ── Main workspace: browser · monitor · inspector ─────────────── */}
      <div className="flex min-h-0 flex-1">
        {/* Left dock */}
        <div className="flex shrink-0 flex-col overflow-hidden border-r border-[#2a2a2a] bg-[#0b0b0a]" style={{ width: leftWidth }}>
          <div className="flex items-center gap-1 border-b border-[#2a2a2a] px-2 py-1.5">
            {(["media", "effects"] as const).map((t) => (
              <button key={t} type="button" onClick={() => setLeftTab(t)} className={`rounded px-2 py-1 text-[10px] uppercase tracking-wide ${leftTab === t ? "bg-[#d4a017]/15 text-[#d4a017]" : "text-[#8f8f8a] hover:text-[#d8d8d2]"}`}>
                {t}
              </button>
            ))}
            <SlidersHorizontal className="ml-auto h-3 w-3 text-[#5a5a55]" />
          </div>
          {leftTab === "media" ? (
            <MediaBrowser media={media} onRefresh={refreshMedia} onPlace={(a) => void addMediaAtPlayhead(a)} importing={importing} onImport={(files) => void importFiles(files)} />
          ) : (
            <EffectsBrowser sequence={sequence} session={session} notice={setNotice} />
          )}
        </div>
        <div className="w-1 cursor-col-resize bg-transparent transition-colors hover:bg-[#d4a017]/30" onPointerDown={onDockDown("left")} onPointerMove={onDockMove} onPointerUp={onDockUp} />

        {/* Center: monitor + transport + timeline */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative flex min-h-0 flex-1">
            <ProgramMonitor sequence={sequence} playhead={session.playheadFrame} playing={playing} onPlayhead={session.setPlayhead} onPlayingChange={setPlaying} session={session} activeTool={activeTool} guides={guides} snapEnabled={snap} onDecodeError={setNotice} />
          </div>
          {/* Transport bar */}
          <div className="flex items-center gap-2 border-y border-[#2a2a2a] bg-[#0d0d0c] px-3 py-1">
            <button type="button" onClick={() => step(-1)} className={toolButton} title="Step back one frame (←)"><ChevronLeft className="h-4 w-4" /></button>
            <button type="button" onClick={togglePlay} disabled={!sequence || end === 0} className={toolButton} title="Play / pause (Space)">{playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}</button>
            <button type="button" onClick={() => step(1)} className={toolButton} title="Step forward one frame (→)"><ChevronRight className="h-4 w-4" /></button>
            <BusTimecode fpsRational={fpsRational} fallback={session.playheadFrame} />
            <button type="button" onClick={splitAtPlayhead} disabled={!selectedClip} className={toolButton} title="Split at playhead"><Sparkles className="h-4 w-4" /></button>
            <button type="button" onClick={() => deleteSelection(false)} disabled={!selectedClip} className={toolButton} title="Delete clip (Del)">✕</button>
            <button type="button" onClick={() => deleteSelection(true)} disabled={!selectedClip} className={toolButton} title="Ripple delete (closes the gap)">⇤</button>
            <button type="button" onClick={addCaptionAtPlayhead} disabled={!sequence} className={toolButton} title="Add caption at playhead">T</button>
            <button type="button" onClick={() => void applyRiisheCuts()} disabled={!sequence || riisheBusy} className={toolButton} title="Apply RIISHE cuts (M4)">{riisheBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}</button>
            <label className="ml-auto flex items-center gap-1.5 text-[10px] text-[#8f8f8a]">
              <input type="checkbox" checked={guides} onChange={(e) => setGuides(e.target.checked)} className="accent-[#d4a017]" />
              guides
            </label>
            <span className="font-mono text-[10px] text-[#5a5a55]">{sequence ? `${sequence.width}×${sequence.height} @${sequence.fps.num}/${sequence.fps.den}` : ""}</span>
          </div>
          {/* Editing tools + timeline */}
          <EditingToolbar activeTool={activeTool} onToolChange={setActiveTool} snap={snap} onSnapChange={setSnap} />
          <div className="flex min-h-[220px] flex-1 flex-col p-2 pt-0">
            {sequence ? (
              <EditorTimeline sequence={sequence} playhead={session.playheadFrame} session={session} zoom={zoom} onZoomChange={setZoom} activeTool={activeTool} snap={snap} notice={setNotice} assetDurations={assetFrameDurations} range={range} onRangeChange={setRange} />
            ) : (
              <div className="flex flex-1 items-center justify-center rounded-lg border border-[#2a2a2a] bg-[#0b0b0a]">
                {session.saveState === "loading" ? <Loader2 className="h-5 w-5 animate-spin text-[#d4a017]" /> : <p className="text-sm text-[#8f8f8a]">Create or select a project to start editing.</p>}
              </div>
            )}
          </div>
        </div>

        <div className="w-1 cursor-col-resize bg-transparent transition-colors hover:bg-[#d4a017]/30" onPointerDown={onDockDown("right")} onPointerMove={onDockMove} onPointerUp={onDockUp} />
        {/* Right dock: inspector */}
        <div className="flex shrink-0 flex-col overflow-y-auto border-l border-[#2a2a2a] bg-[#0b0b0a]" style={{ width: rightWidth }}>
          <div className="border-b border-[#2a2a2a] px-3 py-1.5 bean-label text-[10px] text-[#8f8f8a]">PROPERTIES INSPECTOR</div>
          {sequence && <ClipInspector sequence={sequence} session={session} notice={setNotice} />}
          {sequence && selectedClip && selectedClip.keyframes.length > 0 && (
            <div className="border-t border-[#2a2a2a] px-3 py-2 text-[10px] text-[#8f8f8a]">
              {selectedClip.keyframes.length} keyframe(s) — diamonds on the timeline block; edit via NIIKI (AI STUDIO) or effect parameters.
            </div>
          )}
          {sequence && <StudioPanel onProjectCreated={(id) => setProjectId(id)} />}
        </div>
      </div>

      {/* ── Drawers ────────────────────────────────────────────────────── */}
      {drawer === "ai-studio" && projectId && sequence && (
        <AiStudio
          sequence={sequence}
          session={session}
          projectId={projectId}
          onClose={() => setDrawer(null)}
          onSeekSec={(sec) => session.setPlayhead(Math.max(0, Math.round(sec * (fpsRational.num / fpsRational.den))))}
        />
      )}
      {drawer === "export" && projectId && (
        <div className="absolute inset-0 z-40 flex justify-end bg-black/50" role="dialog" aria-label="Export workspace">
          <div className="h-full w-full max-w-[520px] overflow-y-auto border-l border-[#2a2a2a] bg-[#0b0b0a] p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="bean-label text-[10px] text-[#d4a017]">EXPORT &amp; PUBLISH</span>
              <button type="button" onClick={() => setDrawer(null)} className="text-[#8f8f8a] hover:text-[#d8d8d2]">✕</button>
            </div>
            <PublishingPanel projectId={projectId} />
            <TimelineRenderPanel projectId={projectId} onNotice={setNotice} />
            <BatchExportPanel projectId={projectId} onNotice={setNotice} />
          </div>
        </div>
      )}
      {drawer === "workflows" && projectId && (
        <div className="border-t border-[#2a2a2a] bg-[#0b0b0a] px-4 py-3">
          <div className="mx-auto max-w-4xl">
            <WorkflowsPanel projectId={projectId} onNotice={setNotice} />
          </div>
        </div>
      )}
      {drawer === "presets" && (
        <div className="border-t border-[#2a2a2a] bg-[#0b0b0a] px-4 py-3">
          <div className="mx-auto max-w-4xl">
            <PresetsPanel sequence={sequence} session={session} notice={setNotice} />
          </div>
        </div>
      )}
      {drawer === "mixer" && sequence && (
        <div className="border-t border-[#2a2a2a] bg-[#0b0b0a] px-4 py-3">
          <div className="mx-auto max-w-4xl">
            <AudioMixerPanel sequence={sequence} session={session} />
          </div>
        </div>
      )}
      {drawer === "portability" && projectId && (
        <div className="absolute inset-0 z-40 flex justify-end bg-black/50" role="dialog" aria-label="Project portability">
          <div className="h-full w-full max-w-[440px] overflow-y-auto border-l border-[#2a2a2a] bg-[#0b0b0a] p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="bean-label text-[10px] text-[#d4a017]">PROJECT PORTABILITY</span>
              <button type="button" onClick={() => setDrawer(null)} className="text-[#8f8f8a] hover:text-[#d8d8d2]">✕</button>
            </div>
            <ProjectPortability session={session} projectId={projectId} onNotice={setNotice} />
          </div>
        </div>
      )}
      {drawer === "settings" && projectId && (
        <div className="absolute inset-0 z-40 flex justify-end bg-black/50" role="dialog" aria-label="Project settings">
          <div className="h-full w-full max-w-[440px] overflow-y-auto border-l border-[#2a2a2a] bg-[#0b0b0a] p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="bean-label text-[10px] text-[#d4a017]">PROJECT SETTINGS &amp; HISTORY</span>
              <button type="button" onClick={() => setDrawer(null)} className="text-[#8f8f8a] hover:text-[#d8d8d2]">✕</button>
            </div>
            <ProjectSettings projectId={projectId} onNotice={setNotice} onDuplicate={() => void duplicateProject()} onRestored={() => session.reload()} onDeleted={() => { setPlaying(false); setProjectId(null); }} />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * M16 — timeline render panel: enqueues the durable RENDER_TIMELINE job
 * (real FFmpeg graph from the canonical sequence) and shows real job/ExportFile
 * state. No fake progress — the durable worker drives the stages.
 */
function TimelineRenderPanel({ projectId, onNotice }: { projectId: string; onNotice: (m: string | null) => void }) {
  const [state, setState] = useState<{ jobs: { id: string; status: string; stage: string | null; progress: number; message: string | null; createdAt: string; range?: { startFrame?: number; endFrame?: number } | null }[]; exports: { id: string; filename: string; sizeBytes: number; durationSec: number; createdAt: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  // M25 P3 — real export range selection (backend-supported frames only).
  const [rangeMode, setRangeMode] = useState<"full" | "preview" | "custom">("full");
  const [startSec, setStartSec] = useState("0");
  const [endSec, setEndSec] = useState("");
  const load = useCallback(() => {
    fetch(`/api/editor/projects/${projectId}/render`).then((r) => r.json()).then((d) => setState(d)).catch(() => undefined);
  }, [projectId]);
  useEffect(() => {
    load();
    const id = window.setInterval(load, 3000);
    return () => window.clearInterval(id);
  }, [load]);
  const render = async (range?: { startFrame?: number; endFrame?: number }) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/editor/projects/${projectId}/render`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(range ?? {}) });
      const body = (await res.json()) as { jobId?: string; error?: string; code?: string };
      if (body.jobId) onNotice(`Render job queued — ${body.jobId}`);
      else onNotice(body.error ?? "Render enqueue failed.");
      load();
    } finally {
      setBusy(false);
    }
  };
  /** M25 P3 — cancel an active render (real DELETE /api/jobs/[id]). */
  const cancelJob = async (id: string) => {
    const res = await fetch(`/api/jobs/${id}`, { method: "DELETE" });
    onNotice(res.ok ? "Render cancelled." : "This job can no longer be cancelled.");
    load();
  };
  const rangeFrames = (fps: number): { startFrame?: number; endFrame?: number } => {
    if (rangeMode === "full") return {};
    if (rangeMode === "preview") return { startFrame: 0, endFrame: Math.max(1, Math.round(10 * fps)) };
    const st = Math.max(0, Math.round((Number(startSec) || 0) * fps));
    const en = endSec ? Math.max(st + 1, Math.round(Number(endSec) * fps)) : undefined;
    return en ? { startFrame: st, endFrame: en } : { startFrame: st };
  };
  return (
    <div className="mt-4 border-t border-[#2a2a2a] pt-3">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="bean-label text-[10px] text-[#d4a017]">RENDER TIMELINE (FFmpeg)</span>
        <button type="button" onClick={() => void render(rangeFrames(30))} disabled={busy} className="rounded border border-[#d4a017] px-2 py-1 text-[10px] font-bold text-[#d4a017] hover:bg-[#d4a017] hover:text-[#0c0c0c] disabled:opacity-40">
          {busy ? "…" : "RENDER SEQUENCE"}
        </button>
      </div>
      {/* M25 P3 — export range presets (real backend range support). */}
      <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[9px] text-[#8f8f8a]">
        {(["full", "preview", "custom"] as const).map((m) => (
          <button key={m} type="button" onClick={() => setRangeMode(m)} className={`rounded border px-1.5 py-0.5 ${rangeMode === m ? "border-[#d4a017] text-[#d4a017]" : "border-[#2a2a2a] text-[#d8d8d2] hover:border-[#d4a017]"}`}>
            {m === "full" ? "FULL SEQUENCE" : m === "preview" ? "PREVIEW (FIRST 10s)" : "CUSTOM RANGE"}
          </button>
        ))}
        {rangeMode === "custom" && (
          <span className="flex items-center gap-1">
            <input aria-label="Range start seconds" value={startSec} onChange={(e) => setStartSec(e.target.value.replace(/[^0-9.]/g, "").slice(0, 8))} className="w-14 rounded border border-[#2a2a2a] bg-[#111110] px-1 py-0.5 text-[9px] text-[#d4d4d0]" placeholder="start s" />
            <span>→</span>
            <input aria-label="Range end seconds" value={endSec} onChange={(e) => setEndSec(e.target.value.replace(/[^0-9.]/g, "").slice(0, 8))} className="w-14 rounded border border-[#2a2a2a] bg-[#111110] px-1 py-0.5 text-[9px] text-[#d4d4d0]" placeholder="end s" />
          </span>
        )}
      </div>
      <p className="mb-2 text-[9px] leading-relaxed text-[#6a6a64]">
        Renders the CURRENT sequence: every visual clip (effects, fades), captions, graphics and the full audio mix through the durable worker; output validated with FFprobe before it appears below.
      </p>
      {state?.jobs?.map((j) => (
        <div key={j.id} className="mb-1 rounded bg-[#111110] px-2 py-1.5 text-[10px]">
          <div className="flex items-center justify-between">
            <span className={j.status === "COMPLETED" ? "text-[#4cc47f]" : j.status === "FAILED" ? "text-[#c45c4c]" : "text-[#d4a017]"}>{j.status}</span>
            <span className="font-mono text-[9px] text-[#6a6a64]">{Math.round(j.progress)}%</span>
          </div>
          <div className="text-[9px] text-[#8f8f8a]">{j.stage ?? ""}{j.message ? ` — ${j.message.slice(0, 160)}` : ""}</div>
          {(j.status === "QUEUED" || j.status === "PROCESSING" || j.status === "RUNNING") && (
            <button type="button" onClick={() => void cancelJob(j.id)} className="mt-0.5 rounded border border-[#c45c4c]/40 px-1.5 py-0.5 text-[9px] text-[#c45c4c] hover:bg-[#c45c4c]/10">Cancel</button>
          )}
          {j.status === "FAILED" && (
            <button type="button" onClick={() => void render(j.range ?? {})} disabled={busy} className="mt-0.5 rounded border border-[#d4a017] px-1.5 py-0.5 text-[9px] text-[#d4a017] hover:bg-[#d4a017]/10 disabled:opacity-40" title="Re-run this exact render">
              Retry
            </button>
          )}
        </div>
      ))}
      {state?.exports?.map((e) => (
        <a key={e.id} href={`/api/exports/${e.id}/file`} className="mt-1 flex items-center justify-between rounded border border-[#1c1c1a] bg-[#111110] px-2 py-1.5 text-[10px] text-[#d8d8d2] hover:border-[#d4a017]">
          <span className="min-w-0 flex-1 truncate">{e.filename}</span>
          <span className="font-mono text-[9px] text-[#4cc47f]">{(e.sizeBytes / 1024 / 1024).toFixed(1)}MB · {e.durationSec?.toFixed?.(1) ?? "?"}s</span>
        </a>
      ))}
    </div>
  );
}

/** Transport timecode that paints from the frame bus (no per-frame render). */
function BusTimecode({ fpsRational, fallback }: { fpsRational: Rational; fallback: number }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    return subscribeFrame((frame) => {
      if (ref.current) ref.current.textContent = formatTimecode(frame, fpsRational);
    });
  }, [fpsRational]);
  return (
    <span ref={ref} className="rounded bg-[#111110] px-2 py-1 font-mono text-xs text-[#d4a017]">
      {formatTimecode(fallback, fpsRational)}
    </span>
  );
}

/** Settings drawer body: real project detail + version history (with restore) + duplicate. */
function ProjectSettings({ projectId, onNotice, onDuplicate, onRestored, onDeleted }: { projectId: string; onNotice: (m: string | null) => void; onDuplicate: () => void; onRestored: () => Promise<void>; onDeleted: () => void }) {
  const [detail, setDetail] = useState<{ project: { id: string; name: string; description: string | null; createdAt: string }; versions: { versionNo: number; autosave: boolean; createdAt: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [restoreMsg, setRestoreMsg] = useState<string | null>(null);
  // M25 P4 — deletion with typed-name safeguard.
  const [delConfirm, setDelConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);
  const loadDetail = useCallback(async () => {
    try {
      const r = await fetch(`/api/projects/${projectId}`);
      const d = await r.json();
      if (d.project) setDetail(d);
    } catch {
      setError("Could not load project detail.");
    }
  }, [projectId]);
  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);
  /** M24 §3.J — restore an older version as a NEW append-only version (real
   *  /api/editor/.../timeline/restore; conflict → honest 409 message). */
  const restoreVersion = async (versionNo: number, headVersion: number) => {
    setRestoreMsg(null);
    setRestoring(versionNo);
    try {
      const res = await fetch(`/api/editor/projects/${projectId}/timeline/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ versionNumber: versionNo, baseVersion: headVersion }),
      });
      const body = (await res.json().catch(() => ({}))) as { version?: { versionNumber?: number }; error?: string };
      if (res.ok) {
        setRestoreMsg(`Restored v${versionNo} as new v${body.version?.versionNumber ?? "?"} — timeline reloaded.`);
        await loadDetail();
        await onRestored();
        onNotice(`Timeline restored to v${versionNo} (saved as a new version).`);
      } else {
        setRestoreMsg(body.error ?? `Restore failed (${res.status}).`);
      }
    } catch {
      setRestoreMsg("Restore failed (network).");
    } finally {
      setRestoring(null);
    }
  };
  /** M25 P4 — real DELETE /api/projects/[id]?confirm=<name> (typed-name
   *  safeguard; the media library is never touched). */
  const deleteProject = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}?confirm=${encodeURIComponent(delConfirm.trim())}`, { method: "DELETE" });
      const body = (await res.json().catch(() => ({}))) as { deleted?: boolean; error?: string; versionsRemoved?: number };
      if (res.ok && body.deleted) {
        onNotice(`Project deleted (${body.versionsRemoved ?? 0} versions removed; media library untouched).`);
        onDeleted();
      } else {
        setRestoreMsg(body.error ?? `Delete failed (${res.status}).`);
      }
    } catch {
      setRestoreMsg("Delete failed (network).");
    } finally {
      setDeleting(false);
    }
  };
  if (error) return <p className="text-[11px] text-[#c45c4c]">{error}</p>;
  if (!detail) return <Loader2 className="h-4 w-4 animate-spin text-[#d4a017]" />;
  const headVersion = detail.versions.reduce((m, v) => Math.max(m, v.versionNo), 0);
  return (
    <div className="space-y-3 text-[11px]">
      <div className="rounded border border-[#2a2a2a] p-2">
        <div className="text-[#e6e6e0]">{detail.project.name}</div>
        <div className="text-[9px] text-[#6a6a64]">created {new Date(detail.project.createdAt).toLocaleString()}</div>
        <button type="button" onClick={onDuplicate} className="mt-2 rounded border border-[#2a2a2a] px-2 py-1 text-[10px] text-[#d8d8d2] hover:border-[#d4a017] hover:text-[#d4a017]">
          Duplicate project (with editing state)
        </button>
      </div>
      <div>
        <div className="bean-label mb-1 text-[9px] text-[#8f8f8a]">VERSION HISTORY (last 30)</div>
        <ul className="space-y-0.5">
          {detail.versions.map((v) => (
            <li key={v.versionNo} className="flex items-center justify-between rounded bg-[#111110] px-2 py-1">
              <span className="font-mono text-[10px] text-[#d4a017]">v{v.versionNo}</span>
              <span className="text-[9px] text-[#6a6a64]">{v.autosave ? "autosave" : "manual"} · {new Date(v.createdAt).toLocaleTimeString()}</span>
              {v.versionNo < headVersion && (
                <button
                  type="button"
                  onClick={() => void restoreVersion(v.versionNo, headVersion)}
                  disabled={restoring !== null}
                  className="rounded border border-[#2a2a2a] px-1.5 py-0.5 text-[9px] text-[#d4a017] hover:border-[#d4a017] disabled:opacity-40"
                  title={`Restore v${v.versionNo} as a new version (append-only)`}
                >
                  {restoring === v.versionNo ? "…" : "Restore"}
                </button>
              )}
            </li>
          ))}
          {detail.versions.length === 0 && <li className="text-[10px] text-[#6a6a64]">No versions yet.</li>}
        </ul>
        {restoreMsg && <p className="mt-1 text-[10px] text-[#a0a09a]" role="status">{restoreMsg}</p>}
      </div>
      {/* M25 P4 — danger zone: typed-name deletion. */}
      <div className="rounded border border-[#c45c4c]/40 p-2">
        <div className="bean-label mb-1 text-[9px] text-[#c45c4c]">DANGER ZONE</div>
        <p className="mb-1.5 text-[9px] leading-relaxed text-[#8f8f8a]">Deletes this project and its version history. Your media library is never touched. Type the project name to confirm.</p>
        <div className="flex gap-1">
          <input aria-label="Type project name to confirm deletion" value={delConfirm} onChange={(e) => setDelConfirm(e.target.value.slice(0, 120))} placeholder={detail.project.name} className="min-w-0 flex-1 rounded border border-[#2a2a2a] bg-[#111110] px-1.5 py-1 text-[10px] text-[#d4d4d0] placeholder:text-[#5a5a55]" />
          <button type="button" onClick={() => void deleteProject()} disabled={deleting || delConfirm.trim() !== detail.project.name} className="rounded border border-[#c45c4c] bg-[#c45c4c]/10 px-2 py-1 text-[10px] text-[#c45c4c] hover:bg-[#c45c4c]/20 disabled:opacity-40">
            {deleting ? "…" : "Delete project"}
          </button>
        </div>
        {restoreMsg && <p className="mt-1 text-[10px] text-[#a0a09a]" role="status">{restoreMsg}</p>}
      </div>
      <p className="text-[9px] text-[#6a6a64]">Recovery: the newest version reloads automatically when the project is reopened; undo/redo steps remain available in-session. Conflict handling reloads the authoritative version and tells you honestly.</p>
      <button type="button" onClick={() => onNotice(null)} className="text-[9px] text-[#8f8f8a]">close</button>
    </div>
  );
}
