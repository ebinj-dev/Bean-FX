"use client";

/**
 * BEAN FX — Editor workspace (Milestone 2, editor integration).
 *
 * The professional editing workspace inside the existing shell: project
 * picker, program monitor, multitrack timeline, inspector and media rail,
 * all driven by the validated command session (undo/redo, autosave, version
 * conflicts). Layout and visual language follow the established BEAN FX
 * design system (#050505 canvas, #2a2a2a borders, #d4a017 accent, bean-label).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Play,
  Pause,
  ChevronLeft,
  ChevronRight,
  Scissors,
  Trash2,
  Undo2,
  Redo2,
  RotateCcw,
  Type,
  Video as VideoIcon,
  Music,
  Loader2,
  AlertTriangle,
  CloudUpload,
  Check,
  Plus,
} from "lucide-react";
import type { MediaMeta } from "@/lib/types";
import type { Sequence } from "@/lib/editor/model";
import { formatTimecode } from "@/lib/editor/time";
import { sequenceEndFrame } from "@/lib/editor/preview";
import { api } from "@/lib/client-api";
import { useEditorSession } from "@/hooks/use-editor-session";
import { ProgramMonitor } from "@/components/bean/editor/monitor";
import { EditorTimeline } from "@/components/bean/editor/timeline";
import { ClipInspector } from "@/components/bean/editor/inspector";

interface ProjectSummary {
  id: string;
  name: string;
}

export function EditorTool({ user, onLogout }: { user: { id: string }; onLogout: () => void }) {
  void user;
  void onLogout;
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [newProjectName, setNewProjectName] = useState("");
  const [media, setMedia] = useState<MediaMeta[] | null>(null);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(1.5);
  const [notice, setNotice] = useState<string | null>(null);

  const session = useEditorSession(projectId);
  const sequence = session.sequence;

  // ---- data loading ------------------------------------------------------
  useEffect(() => {
    api
      .projects()
      .then((res) => {
        setProjects(res.projects);
        if (res.projects.length > 0) setProjectId((current) => current ?? res.projects[0].id);
      })
      .catch((err) => setNotice(err instanceof Error ? err.message : "Failed to load projects."));
    api
      .listMedia()
      .then((res) => setMedia(res.media))
      .catch(() => setMedia([]));
  }, []);

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

  // ---- transport + edit actions ------------------------------------------
  const fpsRational = sequence?.fps ?? { num: 30, den: 1 };
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

  const selectedClip = useMemo(
    () => sequence?.clips.find((c) => c.id === session.selectedClipId) ?? null,
    [sequence, session.selectedClipId],
  );

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
    const ok = session.apply([
      {
        type: "SplitClip",
        clipId: selectedClip.id,
        atTimelineFrame: at,
        newLeftId: selectedClip.id,
        newRightId: session.newId("clip"),
      },
    ]);
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
    const start = session.playheadFrame;
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
          timelineStartFrame: start,
          missingMedia: true,
          captionText: "New caption",
        },
      },
    ]);
  }, [sequence, session]);

  /** Place a library asset on the first compatible, unlocked track at the playhead. */
  const addMediaAtPlayhead = useCallback(
    (asset: MediaMeta) => {
      if (!sequence) return;
      const wantVideo = asset.kind === "VIDEO";
      const kind = wantVideo ? "VIDEO" : "AUDIO";
      const track = sequence.tracks.find((t) => t.kind === kind && !t.locked);
      if (!track) {
        setNotice(`No unlocked ${kind.toLowerCase()} track available — add one first.`);
        return;
      }
      if (asset.durationSec == null || asset.durationSec <= 0) {
        setNotice("This asset has no measurable duration — it cannot be placed.");
        return;
      }
      const srcFps = asset.fps && asset.fps > 0 ? asset.fps : sequence.fps.num / sequence.fps.den;
      const sourceDurationFrames = Math.round(asset.durationSec * srcFps);
      const ok = session.apply([
        {
          type: "AddClip",
          clip: {
            id: session.newId("clip"),
            trackId: track.id,
            sourceAssetId: asset.id,
            sourceInFrame: 0,
            sourceOutFrame: sourceDurationFrames,
            sourceFps: { num: Math.round(srcFps * 1000), den: 1000 },
            timelineStartFrame: session.playheadFrame,
            label: asset.originalName,
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

  // ---- keyboard shortcuts (skipped while typing) -------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        step(e.shiftKey ? -12 : -1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        step(e.shiftKey ? 12 : 1);
      } else if (e.key === "s" || e.key === "S") {
        splitAtPlayhead();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteSelection(false);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "z") {
        e.preventDefault();
        if (e.shiftKey) session.redo();
        else session.undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, step, splitAtPlayhead, deleteSelection, session]);

  const saveBadge = {
    saved: { icon: <Check className="h-3 w-3" />, text: session.version ? `Saved v${session.version}` : "Saved", cls: "text-[#4cc47f]" },
    saving: { icon: <CloudUpload className="h-3 w-3 animate-pulse" />, text: "Saving…", cls: "text-[#d4a017]" },
    loading: { icon: <Loader2 className="h-3 w-3 animate-spin" />, text: "Loading…", cls: "text-[#8f8f8a]" },
    error: { icon: <AlertTriangle className="h-3 w-3" />, text: "Save failed", cls: "text-[#c45c4c]" },
    conflict: { icon: <AlertTriangle className="h-3 w-3" />, text: "Conflict — reloaded", cls: "text-[#c45c4c]" },
  }[session.saveState];

  const toolButton =
    "flex items-center justify-center rounded border border-[#2a2a2a] px-2 py-1.5 text-[#d8d8d2] transition-colors hover:border-[#d4a017] hover:text-[#d4a017] disabled:opacity-40 disabled:hover:border-[#2a2a2a] disabled:hover:text-[#d8d8d2]";

  return (
    <div className="flex min-h-screen flex-col bg-[#050505] text-[#d8d8d2]">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[#2a2a2a] px-3 py-2">
        <span className="bean-label text-[10px] text-[#d4a017]">BEAN EDITOR</span>
        <select
          value={projectId ?? ""}
          onChange={(e) => {
            setPlaying(false);
            setProjectId(e.target.value || null);
          }}
          className="rounded border border-[#2a2a2a] bg-[#111110] px-2 py-1 text-xs text-[#e6e6e0] outline-none max-w-[200px]"
          aria-label="Project"
        >
          {(projects ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1">
          <input
            value={newProjectName}
            onChange={(e) => setNewProjectName(e.target.value.slice(0, 120))}
            onKeyDown={(e) => {
              if (e.key === "Enter") void createProject();
            }}
            placeholder="New project name…"
            className="w-36 rounded border border-[#2a2a2a] bg-[#111110] px-2 py-1 text-xs outline-none placeholder:text-[#5a5a55] focus:border-[#d4a017]"
          />
          <button type="button" onClick={() => void createProject()} disabled={!newProjectName.trim()} className={toolButton} title="Create project">
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>

        <span className="mx-1 h-5 w-px bg-[#2a2a2a]" />

        <button type="button" onClick={() => step(-1)} className={toolButton} title="Step back one frame (←)">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button type="button" onClick={togglePlay} disabled={!sequence || end === 0} className={toolButton} title="Play / pause (Space)">
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </button>
        <button type="button" onClick={() => step(1)} className={toolButton} title="Step forward one frame (→)">
          <ChevronRight className="h-4 w-4" />
        </button>
        <span className="rounded bg-[#111110] px-2 py-1 font-mono text-xs text-[#d4a017]">{formatTimecode(session.playheadFrame, fpsRational)}</span>

        <span className="mx-1 h-5 w-px bg-[#2a2a2a]" />

        <button type="button" onClick={splitAtPlayhead} disabled={!selectedClip} className={toolButton} title="Split at playhead (S)">
          <Scissors className="h-4 w-4" />
        </button>
        <button type="button" onClick={() => deleteSelection(false)} disabled={!selectedClip} className={toolButton} title="Delete clip (Del)">
          <Trash2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => deleteSelection(true)}
          disabled={!selectedClip}
          className={toolButton}
          title="Ripple delete (removes the clip and closes the gap)"
        >
          <RotateCcw className="h-4 w-4" />
        </button>
        <button type="button" onClick={addCaptionAtPlayhead} disabled={!sequence} className={toolButton} title="Add caption at playhead">
          <Type className="h-4 w-4" />
        </button>

        <span className="mx-1 h-5 w-px bg-[#2a2a2a]" />

        <button type="button" onClick={() => session.undo()} disabled={!session.canUndo} className={toolButton} title="Undo (Ctrl+Z)">
          <Undo2 className="h-4 w-4" />
        </button>
        <button type="button" onClick={() => session.redo()} disabled={!session.canRedo} className={toolButton} title="Redo (Ctrl+Shift+Z)">
          <Redo2 className="h-4 w-4" />
        </button>

        <span className={`ml-auto flex items-center gap-1.5 text-[11px] ${saveBadge.cls}`}>
          {saveBadge.icon}
          {saveBadge.text}
        </span>
      </div>

      {(notice || session.error || session.conflictMessage) && (
        <div className="flex items-center gap-2 border-b border-[#2a2a2a] bg-[#1a1206] px-3 py-1.5 text-xs text-[#d4a017]">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{session.conflictMessage ?? session.error ?? notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="text-[#8f8f8a] hover:text-[#d8d8d2]">
            dismiss
          </button>
        </div>
      )}

      {/* Main workspace: media rail · monitor · inspector */}
      <div className="flex min-h-0 flex-1 gap-2 p-2" style={{ minHeight: 360 }}>
        {/* Media rail */}
        <div className="flex w-56 shrink-0 flex-col overflow-hidden rounded-lg border border-[#2a2a2a] bg-[#0b0b0a]">
          <div className="flex items-center justify-between border-b border-[#2a2a2a] px-3 py-1.5">
            <span className="bean-label text-[10px] text-[#8f8f8a]">MEDIA</span>
            <button type="button" onClick={() => api.listMedia().then((r) => setMedia(r.media)).catch(() => undefined)} className="text-[10px] text-[#8f8f8a] hover:text-[#d4a017]">
              refresh
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {media === null ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-4 w-4 animate-spin text-[#d4a017]" />
              </div>
            ) : media.length === 0 ? (
              <p className="px-1 text-[11px] leading-relaxed text-[#8f8f8a]">
                No media yet. Upload through any tool (Auto Cut, Captions…) — the library is shared with the editor.
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {media.map((m) => (
                  <li key={m.id} className="rounded border border-[#1c1c1a] bg-[#111110] px-2 py-1.5">
                    <div className="flex items-center gap-1.5">
                      {m.kind === "VIDEO" ? <VideoIcon className="h-3 w-3 shrink-0 text-[#d4a017]" /> : m.kind === "AUDIO" ? <Music className="h-3 w-3 shrink-0 text-[#3fa7c4]" /> : null}
                      <span className="min-w-0 flex-1 truncate text-[11px] text-[#e6e6e0]" title={m.originalName}>
                        {m.originalName}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center justify-between">
                      <span className="font-mono text-[9px] text-[#5a5a55]">
                        {m.durationSec ? `${m.durationSec.toFixed(1)}s` : "?"} · {m.fps ? `${m.fps.toFixed(2)}fps` : m.kind}
                      </span>
                      <button
                        type="button"
                        onClick={() => addMediaAtPlayhead(m)}
                        className="rounded border border-[#2a2a2a] px-1.5 py-0.5 text-[10px] text-[#d8d8d2] hover:border-[#d4a017] hover:text-[#d4a017]"
                        title="Place at playhead on the first compatible track"
                      >
                        + place
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Monitor */}
        <ProgramMonitor
          sequence={sequence}
          playhead={session.playheadFrame}
          playing={playing}
          onPlayhead={session.setPlayhead}
          onPlayingChange={setPlaying}
        />

        {/* Inspector */}
        <div className="w-72 shrink-0">
          {sequence && <ClipInspector sequence={sequence} session={session} />}
        </div>
      </div>

      {/* Timeline */}
      <div className="flex min-h-[260px] flex-col p-2 pt-0">
        {sequence ? (
          <EditorTimeline sequence={sequence} playhead={session.playheadFrame} session={session} zoom={zoom} onZoomChange={setZoom} />
        ) : (
          <div className="flex flex-1 items-center justify-center rounded-lg border border-[#2a2a2a] bg-[#0b0b0a]">
            {session.saveState === "loading" ? (
              <Loader2 className="h-5 w-5 animate-spin text-[#d4a017]" />
            ) : (
              <p className="text-sm text-[#8f8f8a]">Create or select a project to start editing.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
