"use client";

/**
 * NIIKI panel (M6 §5–§8) — motion graphics inside the editor.
 *
 * Everything the panel does goes through validated editor commands applied
 * via the session (undo/redo/autosave native). The AI box posts to
 * /api/nikki/proposal and applies the returned COMMANDS — nothing executes
 * outside the command engine. RENDER posts the sequence snapshot to
 * /api/nikki/render (server-side plan, durable job).
 */
import { useCallback, useMemo, useState } from "react";
import { Loader2, Sparkles, Wand2, Clapperboard, RotateCcw } from "lucide-react";
import type { Sequence } from "@/lib/editor/model";
import type { EditorSession } from "@/hooks/use-editor-session";
import { NIKKI_TEMPLATES, templateById } from "@/lib/nikki/templates";
import type { NikkiGraphicStyle, NikkiTextAnim } from "@/lib/nikki/types";

interface JobViewLite {
  id: string;
  status: string;
  progress: number;
  stage: string | null;
  message: string | null;
}

async function jfetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

let idCounter = 0;
const newId = (kind: "clip" | "track" | "graphic"): string => `nikki-${kind}-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

export function NikkiPanel({ sequence, session }: { sequence: Sequence; session: EditorSession }) {
  const clip = useMemo(
    () => sequence.clips.find((c) => c.id === session.selectedClipId) ?? null,
    [sequence, session.selectedClipId],
  );
  const selectedGraphic = clip?.graphicStyle ? clip : null;
  const [busy, setBusy] = useState<null | "apply" | "ai" | "render">(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [renderJob, setRenderJob] = useState<JobViewLite | null>(null);
  const [customText, setCustomText] = useState("");

  const playhead = session.playheadFrame;
  const seqEnd = useMemo(
    () => Math.ceil(sequence.clips.reduce((m, c) => Math.max(m, c.timelineStartFrame + c.timelineDurationFrames), 0)),
    [sequence.clips],
  );

  const graphicTracks = useMemo(() => sequence.tracks.filter((t) => t.kind === "GRAPHIC"), [sequence.tracks]);

  const applyCommands = useCallback(
    (commands: Parameters<EditorSession["apply"]>[0], okMessage: string) => {
      const ok = session.apply(commands);
      setNotice(ok ? okMessage : "The command engine refused the edit (locked track?).");
      return ok;
    },
    [session],
  );

  /** Create a graphic from a template at the playhead (adds a track if needed). */
  const applyTemplate = useCallback(
    (templateId: string) => {
      const t = templateById(templateId);
      if (!t) return;
      const trackId = graphicTracks.find((tr) => !tr.locked)?.id ?? newId("track");
      const clipId = newId("clip");
      const duration = Math.max(30, Math.round((sequence.fps.num / sequence.fps.den) * 5));
      const commands = [] as Parameters<EditorSession["apply"]>[0];
      if (!graphicTracks.some((tr) => tr.id === trackId)) {
        commands.push({ type: "AddTrack", track: { id: trackId, kind: "GRAPHIC", name: "Graphics", visible: true, muted: false, solo: false, locked: false } });
      }
      commands.push({
        type: "AddGraphic",
        clip: {
          id: clipId,
          trackId,
          sourceAssetId: "",
          sourceInFrame: 0,
          sourceOutFrame: duration,
          sourceFps: { num: sequence.fps.num, den: sequence.fps.den },
          timelineStartFrame: Math.max(0, Math.min(playhead, Math.max(0, seqEnd - 1))),
          playbackSpeed: 1,
          volume: 1,
          muted: false,
          fadeInFrames: 0,
          fadeOutFrames: 0,
          transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
          captionText: null,
          captionStyle: null,
          graphicTemplateId: t.id,
          graphicStyle: { ...t.style, templateId: t.id, templateVersion: t.version },
          label: t.label,
          missingMedia: false,
          effects: [],
          keyframes: [],
        },
      });
      const ok = applyCommands(commands, `NIIKI: "${t.label}" added at the playhead — every property stays editable.`);
      if (ok) setCustomText("");
    },
    [graphicTracks, playhead, seqEnd, sequence.fps, applyCommands],
  );

  /** Edit the selected graphic's style (text/colors/animation). */
  const patchStyle = useCallback(
    (over: Partial<NikkiGraphicStyle>) => {
      if (!selectedGraphic?.graphicStyle) return;
      applyCommands(
        [{ type: "UpdateClipProperties", clipId: selectedGraphic.id, graphicStyle: { ...selectedGraphic.graphicStyle, ...over } }],
        "NIIKI: graphic updated (undo with Ctrl+Z).",
      );
    },
    [selectedGraphic, applyCommands],
  );

  const patchAnim = useCallback(
    (over: Partial<NikkiTextAnim>) => {
      if (!selectedGraphic?.graphicStyle) return;
      patchStyle({ textAnim: { ...selectedGraphic.graphicStyle.textAnim, ...over } });
    },
    [selectedGraphic, patchStyle],
  );

  /** Keyframe the selected graphic at the current playhead (clip-relative). */
  const addKeyframe = useCallback(
    (property: "opacity" | "scale" | "x" | "y" | "rotation" | "blur") => {
      if (!selectedGraphic) return;
      const local = Math.max(0, Math.min(selectedGraphic.timelineDurationFrames - 1, playhead - selectedGraphic.timelineStartFrame));
      const defaultValue: Record<string, number> = { opacity: 100, scale: 100, x: 0, y: 0, rotation: 0, blur: 0 };
      applyCommands(
        [{ type: "SetKeyframe", clipId: selectedGraphic.id, keyframe: { id: newId("graphic"), property, frame: local, value: defaultValue[property], interpolation: "EASE_IN_OUT", bezier: null } }],
        `NIIKI: ${property} keyframe set at clip frame ${local} (interpolation EASE_IN_OUT).`,
      );
    },
    [selectedGraphic, playhead, applyCommands],
  );

  /** MY AI: proposal → commands → apply (nothing executes outside the engine). */
  const runProposal = useCallback(async () => {
    if (!instruction.trim() || busy) return;
    setBusy("ai");
    setNotice(null);
    try {
      const res = await jfetch<{ proposal: { intent: string; explanation: string; caveats: string[]; commands: Parameters<EditorSession["apply"]>[0] } }>(
        "/api/nikki/proposal",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sequence,
            instruction,
            selectedClipId: selectedGraphic?.id ?? null,
            atFrame: playhead,
          }),
        },
      );
      const p = res.proposal;
      if (!p.commands || p.commands.length === 0) {
        setNotice(`NIIKI AI matched "${p.intent}" but produced no commands: ${p.explanation}`);
        return;
      }
      const ok = applyCommands(p.commands, `NIIKI AI (${p.intent}): ${p.explanation}${p.caveats.length ? ` Note: ${p.caveats.join(" ")}` : ""}`);
      if (ok) setInstruction("");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "NIIKI AI request failed.");
    } finally {
      setBusy(null);
    }
  }, [instruction, busy, sequence, selectedGraphic, playhead, applyCommands]);

  /** Render: snapshot the sequence to the server (validated) → durable job. */
  const runRender = useCallback(async () => {
    if (busy) return;
    setBusy("render");
    setNotice(null);
    try {
      const videoClip = sequence.clips.find((c) => c.sourceAssetId && sequence.tracks.find((t) => t.id === c.trackId)?.kind === "VIDEO");
      const { jobId } = await jfetch<{ jobId: string }>("/api/nikki/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sequence, sourceAssetId: videoClip?.sourceAssetId ?? null }),
      });
      setRenderJob({ id: jobId, status: "QUEUED", progress: 0, stage: "Queued", message: null });
      const deadline = Date.now() + 10 * 60_000;
      for (;;) {
        if (Date.now() > deadline) throw new Error("NIIKI render polling timed out (10 min).");
        await new Promise((r) => setTimeout(r, 1000));
        const job = await jfetch<{ job: JobViewLite }>(`/api/jobs/${jobId}`);
        setRenderJob(job.job);
        if (job.job.status === "COMPLETED") {
          setNotice(`NIIKI render complete: ${job.job.message ?? "export ready"} — see the exports panel.`);
          break;
        }
        if (job.job.status === "FAILED" || job.job.status === "CANCELLED") {
          setNotice(`NIIKI render did not complete: ${job.job.message ?? job.job.status}`);
          break;
        }
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "NIIKI render failed.");
    } finally {
      setBusy(null);
    }
  }, [busy, sequence]);

  const style = selectedGraphic?.graphicStyle ?? null;
  const anim = style?.textAnim ?? null;

  return (
    <div className="rounded-lg border border-[#2a2a2a] bg-[#0b0b0a] p-3">
      <div className="flex items-center justify-between">
        <h2 className="bean-label flex items-center gap-1.5 text-[10px] text-[#8f8f8a]">
          <Wand2 className="h-3 w-3 text-[#d4a017]" /> NIIKI · MOTION GRAPHICS
        </h2>
        <button
          type="button"
          onClick={() => void runRender()}
          disabled={busy !== null || sequence.clips.length === 0}
          className="flex items-center gap-1 rounded border border-[#2a2a2a] bg-[#111110] px-2 py-1 text-[10px] text-[#d4a017] hover:border-[#d4a017] disabled:opacity-40"
          title="Render the sequence's graphics + transitions with FFmpeg (durable job)"
        >
          {busy === "render" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Clapperboard className="h-3 w-3" />} RENDER
        </button>
      </div>

      {renderJob && (
        <p className="mt-2 text-[10px] text-[#a0a09a]">
          Render job {renderJob.id.slice(0, 10)}… · {renderJob.stage ?? renderJob.status} {renderJob.progress}%
        </p>
      )}
      {notice && <p className="mt-2 text-[10px] leading-relaxed text-[#a0a09a]">{notice}</p>}

      {/* Template grid */}
      <div className="mt-3">
        <h3 className="bean-label text-[9px] text-[#7a7a76]">TEMPLATES (VERSIONED · EDITABLE AFTER APPLY)</h3>
        <div className="mt-1 flex flex-wrap gap-1">
          {NIKKI_TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              disabled={busy !== null}
              onClick={() => applyTemplate(t.id)}
              title={t.description}
              className="rounded border border-[#2a2a2a] bg-[#111110] px-1.5 py-0.5 text-[9px] text-[#8f8f8a] hover:border-[#d4a017] disabled:opacity-40"
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* MY AI box */}
      <div className="mt-3">
        <h3 className="bean-label text-[9px] text-[#7a7a76]">NIIKI AI (PROPOSALS → VALIDATED COMMANDS)</h3>
        <div className="mt-1 flex gap-1">
          <input
            type="text"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void runProposal();
            }}
            placeholder='e.g. "make the captions appear word by word"'
            className="min-w-0 flex-1 rounded border border-[#2a2a2a] bg-[#111110] px-1.5 py-1 text-[10px] text-[#d4d4d0] placeholder:text-[#5a5a55]"
          />
          <button
            type="button"
            onClick={() => void runProposal()}
            disabled={busy !== null || !instruction.trim()}
            className="flex items-center gap-1 rounded border border-[#d4a017] bg-[#d4a017]/10 px-2 py-1 text-[10px] text-[#d4a017] hover:bg-[#d4a017]/20 disabled:opacity-40"
          >
            {busy === "ai" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />} PROPOSE
          </button>
        </div>
      </div>

      {/* Selected graphic editor */}
      {selectedGraphic && style ? (
        <div className="mt-3 space-y-1.5 text-[10px] text-[#8f8f8a]">
          <h3 className="bean-label text-[9px] text-[#7a7a76]">
            EDITING: {style.templateId} v{style.templateVersion} · {selectedGraphic.label ?? selectedGraphic.id}
          </h3>
          <label className="flex items-center justify-between gap-2">
            <span>Main text</span>
            <input
              type="text"
              value={style.primaryText}
              onChange={(e) => patchStyle({ primaryText: e.target.value.slice(0, 300) })}
              className="w-40 rounded border border-[#2a2a2a] bg-[#111110] px-1 py-0.5 text-right text-[#d4d4d0]"
            />
          </label>
          <label className="flex items-center justify-between gap-2">
            <span>Secondary text</span>
            <input
              type="text"
              value={style.secondaryText}
              onChange={(e) => patchStyle({ secondaryText: e.target.value.slice(0, 300) })}
              className="w-40 rounded border border-[#2a2a2a] bg-[#111110] px-1 py-0.5 text-right text-[#d4d4d0]"
            />
          </label>
          <label className="flex items-center justify-between gap-2">
            <span>Entrance</span>
            <select
              value={anim?.mode ?? "none"}
              onChange={(e) => patchAnim({ mode: e.target.value as NikkiTextAnim["mode"] })}
              className="w-32 rounded border border-[#2a2a2a] bg-[#111110] px-1 py-0.5 text-[#d4d4d0]"
            >
              {["none", "fade", "slide", "scale", "typewriter", "wordReveal", "charReveal"].map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center justify-between gap-2">
            <span>Exit</span>
            <select
              value={anim?.exitMode ?? "none"}
              onChange={(e) => patchAnim({ exitMode: e.target.value as NikkiTextAnim["exitMode"] })}
              className="w-32 rounded border border-[#2a2a2a] bg-[#111110] px-1 py-0.5 text-[#d4d4d0]"
            >
              {["none", "fade", "slide", "scale"].map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </label>
          {anim && (anim.mode === "wordReveal" || anim.mode === "charReveal") && (
            <label className="flex items-center justify-between gap-2">
              <span>Stagger (frames)</span>
              <input
                type="number" min={0} max={60}
                value={anim.staggerFrames}
                onChange={(e) => patchAnim({ staggerFrames: Math.max(0, Math.min(60, Number(e.target.value) || 0)) })}
                className="w-16 rounded border border-[#2a2a2a] bg-[#111110] px-1 py-0.5 text-right text-[#d4a017]"
              />
            </label>
          )}
          <label className="flex items-center justify-between gap-2">
            <span>Primary color</span>
            <input
              type="color"
              value={style.primaryColor.slice(0, 7)}
              onChange={(e) => patchStyle({ primaryColor: e.target.value })}
              className="h-6 w-10 rounded border border-[#2a2a2a] bg-[#111110]"
            />
          </label>
          <div className="flex flex-wrap gap-1 pt-1">
            {(["opacity", "scale", "x", "y", "rotation", "blur"] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => addKeyframe(p)}
                disabled={busy !== null}
                className="rounded border border-[#2a2a2a] bg-[#111110] px-1.5 py-0.5 text-[9px] text-[#8f8f8a] hover:border-[#d4a017] disabled:opacity-40"
                title={`Add a ${p} keyframe at the playhead`}
              >
                ◆ {p}
              </button>
            ))}
          </div>
          <p className="text-[9px] leading-relaxed text-[#5a5a55]">
            Keyframes: {selectedGraphic.keyframes.length} · clip frames {selectedGraphic.timelineStartFrame}–
            {selectedGraphic.timelineStartFrame + selectedGraphic.timelineDurationFrames}
          </p>
        </div>
      ) : (
        <p className="mt-3 text-[10px] text-[#5a5a55]">Select a graphic clip to edit it, or apply a template at the playhead.</p>
      )}
    </div>
  );
}
