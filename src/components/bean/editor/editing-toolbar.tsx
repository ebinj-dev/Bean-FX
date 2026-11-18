"use client";

/**
 * M15 — Professional editing toolbar. Nine tools, each with a REAL compiled
 * behavior in the timeline/monitor (see lib/editor/tools.ts): no tool is
 * displayed unless its action is implemented and committed through the M1
 * command engine.
 */
import { MousePointer2, MoveVertical, Scissors, ChevronsLeftRight, ArrowLeftRight, MoveHorizontal, Hand, ZoomIn, Type, Frame } from "lucide-react";
import { EDIT_TOOLS, type EditToolId } from "@/lib/editor/tools";

const TOOL_ICONS: Record<EditToolId, React.ComponentType<{ className?: string }>> = {
  select: MousePointer2,
  "track-select": MoveVertical,
  razor: Scissors,
  roll: ChevronsLeftRight,
  slip: ArrowLeftRight,
  slide: MoveHorizontal,
  hand: Hand,
  zoom: ZoomIn,
  text: Type,
  transform: Frame,
};

export function EditingToolbar({
  activeTool,
  onToolChange,
  snap,
  onSnapChange,
}: {
  activeTool: EditToolId;
  onToolChange: (tool: EditToolId) => void;
  snap: boolean;
  onSnapChange: (snap: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-1 border-b border-[#2a2a2a] bg-[#0d0d0c] px-2 py-1" role="toolbar" aria-label="Editing tools">
      {EDIT_TOOLS.map((tool) => {
        const Icon = TOOL_ICONS[tool.id];
        const active = activeTool === tool.id;
        return (
          <button
            key={tool.id}
            type="button"
            title={`${tool.label} (${tool.shortcut}) — ${tool.hint}`}
            aria-pressed={active}
            onClick={() => onToolChange(tool.id)}
            className={`flex h-7 w-7 items-center justify-center rounded border transition-colors ${
              active ? "border-[#d4a017] bg-[#d4a017]/10 text-[#d4a017]" : "border-transparent text-[#a8a8a0] hover:border-[#2a2a2a] hover:text-[#d8d8d2]"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        );
      })}
      <span className="mx-1.5 h-5 w-px bg-[#2a2a2a]" />
      <button
        type="button"
        onClick={() => onSnapChange(!snap)}
        title={snap ? "Snapping on — clips and playhead snap to clip edges (S toggles)" : "Snapping off"}
        aria-pressed={snap}
        className={`rounded border px-2 py-0.5 text-[10px] uppercase tracking-wide transition-colors ${
          snap ? "border-[#d4a017]/60 text-[#d4a017]" : "border-[#2a2a2a] text-[#8f8f8a] hover:text-[#d8d8d2]"
        }`}
      >
        Snap
      </button>
    </div>
  );
}
