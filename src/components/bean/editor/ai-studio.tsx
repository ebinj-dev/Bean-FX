"use client";

/**
 * M15 Phase D — Unified AI Studio.
 *
 * ONE workspace for all five engines + MY AI, opened from the editing
 * workspace without leaving the editor. Every tab hosts the REAL existing
 * engine panel (M7–M14 contracts unchanged) and a CONTEXT bar that states
 * what the assistant can see: selected clip, playhead, sequence shape and
 * media count. MY AI receives the selection context in its plan requests.
 * No simulated generation — provider status comes from the panels' own
 * health checks.
 */
import { useMemo, useState } from "react";
import { Bot, Mic2, AudioLines, Sparkles, Clapperboard, Image as ImageIcon, Layers, X } from "lucide-react";
import type { Sequence } from "@/lib/editor/model";
import { sequenceEndFrame } from "@/lib/editor/preview";
import type { EditorSession } from "@/hooks/use-editor-session";
import { AiEditChat } from "@/components/bean/editor/ai-edit-chat";
import { MyAiPanel } from "@/components/bean/editor/my-ai-panel";
import { GangziiPanel } from "@/components/bean/editor/gangzii-panel";
import { NikkiPanel } from "@/components/bean/editor/nikki-panel";
import { JazmiiPanel } from "@/components/bean/editor/jazmii-panel";
import { LaxiiPanel } from "@/components/bean/editor/laxii-panel";
import { CreativeDirectorPanel } from "@/components/bean/editor/creative-panel";

type StudioTab = "aichat" | "myai" | "riishe" | "gangzii" | "nikki" | "jazmii" | "laxii" | "compose";

const TABS: { id: StudioTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "aichat", label: "AI EDIT CHAT", icon: Sparkles },
  { id: "myai", label: "MY AI", icon: Bot },
  { id: "riishe", label: "RIISHE", icon: Mic2 },
  { id: "gangzii", label: "GANGZII", icon: AudioLines },
  { id: "nikki", label: "NIIKI", icon: Sparkles },
  { id: "jazmii", label: "JAZMII", icon: Clapperboard },
  { id: "laxii", label: "LAXII", icon: ImageIcon },
  { id: "compose", label: "COMPOSE", icon: Layers },
];

export function AiStudio({
  sequence,
  session,
  projectId,
  onClose,
  onSeekSec,
}: {
  sequence: Sequence;
  session: EditorSession;
  projectId: string;
  onClose: () => void;
  onSeekSec: (sec: number) => void;
}) {
  const [tab, setTab] = useState<StudioTab>("myai");
  const selectedClip = sequence.clips.find((c) => c.id === session.selectedClipId) ?? null;
  const context = useMemo(() => {
    // M16 Phase G: the full editing context — selection, effects, captions,
    // audio and track structure — so MY AI proposals reference real objects.
    const parts: string[] = [];
    if (selectedClip) {
      const track = sequence.tracks.find((t) => t.id === selectedClip.trackId);
      parts.push(`clip "${selectedClip.label || selectedClip.captionText || selectedClip.id}" on ${track?.name ?? "?"} (${track?.kind}) at ${selectedClip.timelineStartFrame}f–${selectedClip.timelineStartFrame + selectedClip.timelineDurationFrames}f`);
      if (selectedClip.effects.length > 0) parts.push(`effects: ${selectedClip.effects.map((e) => `${e.type}${e.enabled ? "" : " (off)"}`).join(", ")}`);
      if (selectedClip.captionText) parts.push(`caption text: "${selectedClip.captionText.slice(0, 60)}"`);
      if (selectedClip.volume !== 1) parts.push(`volume ${selectedClip.volume.toFixed(2)}`);
      if (selectedClip.fadeInFrames || selectedClip.fadeOutFrames) parts.push(`fades in/out ${selectedClip.fadeInFrames}/${selectedClip.fadeOutFrames}f`);
    } else {
      parts.push("no clip selected");
    }
    parts.push(`playhead ${session.playheadFrame}f of ${sequenceEndFrame(sequence)}f`);
    const kinds = sequence.tracks.map((t) => t.kind[0]).join("");
    parts.push(`${sequence.tracks.length} tracks [${kinds}] / ${sequence.clips.length} clips`);
    const captionCount = sequence.clips.filter((c) => c.captionText).length;
    if (captionCount > 0) parts.push(`${captionCount} caption clip(s)`);
    const audioClips = sequence.clips.filter((c) => {
      const t = sequence.tracks.find((x) => x.id === c.trackId);
      return t?.kind === "AUDIO";
    }).length;
    if (audioClips > 0) parts.push(`${audioClips} audio clip(s)`);
    return parts.join(" · ");
  }, [sequence, session.playheadFrame, session.selectedClipId, selectedClip]);

  return (
    <div className="absolute inset-0 z-40 flex justify-end bg-black/50" role="dialog" aria-label="AI Studio">
      <div className="flex h-full w-full max-w-[560px] flex-col border-l border-[#2a2a2a] bg-[#0b0b0a]">
        <div className="flex items-center justify-between border-b border-[#2a2a2a] px-3 py-2">
          <span className="bean-label text-[10px] text-[#d4a017]">AI STUDIO</span>
          <button type="button" onClick={onClose} title="Close AI Studio" className="rounded p-1 text-[#8f8f8a] hover:text-[#d8d8d2]">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="border-b border-[#2a2a2a] px-3 py-1.5 text-[10px] text-[#8f8f8a]">
          <span className="text-[#6a6a64]">CONTEXT:</span> {context}
        </div>
        <div className="flex flex-wrap gap-1 border-b border-[#2a2a2a] px-2 py-1.5">
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <button key={t.id} type="button" onClick={() => setTab(t.id)} className={`flex items-center gap-1 rounded border px-2 py-1 text-[10px] ${tab === t.id ? "border-[#d4a017] text-[#d4a017]" : "border-[#2a2a2a] text-[#a8a8a0] hover:text-[#d8d8d2]"}`}>
                <Icon className="h-3 w-3" />
                {t.label}
              </button>
            );
          })}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {tab === "aichat" && <AiEditChat sequence={sequence} session={session} projectId={projectId} selectionContext={context} />}
          {tab === "myai" && <MyAiPanel sequence={sequence} session={session} projectId={projectId} selectionContext={context} />}
          {tab === "riishe" && (
            <div className="space-y-2">
              <p className="text-[11px] text-[#8f8f8a]">
                RIISHE — speech &amp; caption intelligence. Transcribe and edit captions, detect pauses, generate Auto Cut proposals, and apply approved cuts to the timeline from the toolbar (Sparkles button). The full RIISHE workspace:
              </p>
              <CreativeDirectorPanel projectId={projectId} onSeekSec={onSeekSec} />
              <button type="button" onClick={() => window.location.hash = "#/captions"} className="rounded border border-[#2a2a2a] px-2 py-1 text-[10px] text-[#d8d8d2] hover:border-[#d4a017] hover:text-[#d4a017]">
                Open the caption editor (real waveform)
              </button>
            </div>
          )}
          {tab === "gangzii" && <GangziiPanel sequence={sequence} session={session} />}
          {tab === "nikki" && <NikkiPanel sequence={sequence} session={session} projectId={projectId ?? null} />}
          {tab === "jazmii" && <JazmiiPanel sequence={sequence} session={session} />}
          {tab === "laxii" && <LaxiiPanel sequence={sequence} session={session} />}
          {tab === "compose" && <CreativeDirectorPanel projectId={projectId} onSeekSec={onSeekSec} initialTab="compose" />}
        </div>
      </div>
    </div>
  );
}
