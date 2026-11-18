"use client";

/**
 * BEAN FX — Creative presets drawer (M26 P4).
 *
 * Save / rename / duplicate / delete(confirm) / apply presets. Payloads are
 * engine-shaped (v1): VIDEO_EFFECT = effect stacks, CAPTION = caption styles,
 * AUDIO = GANGZII preset refs, EXPORT = export profile sets (used by batch).
 * Applying runs through reversible editor commands — the server never edits
 * timelines directly. Existing presets are never overwritten (unique names).
 */
import { useCallback, useEffect, useState } from "react";
import type { Sequence } from "@/lib/editor/model";
import type { EditorSession } from "@/hooks/use-editor-session";

type PresetRow = { id: string; kind: string; name: string; version: number; payload: Record<string, unknown> };
const KINDS = ["VIDEO_EFFECT", "CAPTION", "EXPORT", "AUDIO"] as const;
type Kind = (typeof KINDS)[number];

const KIND_LABEL: Record<Kind, string> = {
  VIDEO_EFFECT: "Video effect stacks",
  CAPTION: "Caption styles",
  EXPORT: "Export profile sets",
  AUDIO: "Audio processing (GANGZII)",
};

export function PresetsPanel({ sequence, session, notice }: { sequence: Sequence | null; session: EditorSession; notice: (m: string | null) => void }) {
  const [kind, setKind] = useState<Kind>("VIDEO_EFFECT");
  const [presets, setPresets] = useState<PresetRow[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/presets?kind=${kind}`);
      setPresets(res.ok ? ((await res.json()) as { presets: PresetRow[] }).presets : []);
    } catch {
      setPresets([]);
    }
  }, [kind]);
  useEffect(() => {
    void load();
  }, [load]);

  const selectedClip = sequence?.clips.find((c) => c.id === session.selectedClipId) ?? null;

  /** Save from the current selection — payload straight from engine state. */
  const saveFromSelection = async () => {
    if (!name.trim()) return notice("Give the preset a name first.");
    if (!selectedClip) return notice("Select a clip first — presets capture the selection's state.");
    setBusy(true);
    try {
      let payload: Record<string, unknown> | null = null;
      if (kind === "VIDEO_EFFECT") payload = { effects: selectedClip.effects.map((e) => ({ type: e.type, enabled: e.enabled, params: e.params, keyframes: e.keyframes, animatedParams: e.animatedParams })) };
      else if (kind === "CAPTION") payload = selectedClip.captionStyle ? { captionStyle: selectedClip.captionStyle } : null;
      else if (kind === "EXPORT") payload = { profileIds: [] };
      else payload = { gangziiPresetId: "" };
      if (!payload) return notice(`The selected clip has no ${kind === "CAPTION" ? "caption style" : "state"} to save for this kind.`);
      const res = await fetch("/api/presets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, name: name.trim(), payload }) });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) {
        notice(`Preset saved: ${name.trim()}`);
        setName("");
        void load();
      } else notice(body.error ?? `Save failed (${res.status}).`);
    } finally {
      setBusy(false);
    }
  };

  /** Apply — reversible command batches on the current selection. */
  const applyPreset = async (p: PresetRow) => {
    if (!selectedClip) return notice("Select a clip first — presets apply to the selection.");
    if (p.kind === "VIDEO_EFFECT") {
      const effects = (p.payload.effects as Array<{ type: string; enabled: boolean; params: Record<string, number | string | boolean>; keyframes?: Array<{ id: string; param: string; frame: number; value: number; interpolation: "HOLD" | "LINEAR" | "EASE_IN" | "EASE_OUT" | "EASE_IN_OUT" }>; animatedParams?: string[] }>) ?? [];
      if (effects.length === 0) return notice("Preset has an empty effect stack.");
      const ok = session.apply(effects.map((e) => ({ type: "AddEffect" as const, clipId: selectedClip.id, effect: { id: session.newId("fx"), type: e.type, enabled: e.enabled, params: e.params, keyframes: (e.keyframes ?? []).map((k) => ({ ...k, id: session.newId("ek") })), animatedParams: e.animatedParams ?? [] } })));
      notice(ok ? `Applied ${p.name} (${effects.length} effects, undoable).` : "Apply refused by the engine.");
    } else if (p.kind === "CAPTION") {
      const style = (p.payload.captionStyle as Record<string, unknown>) ?? null;
      if (!style) return notice("Preset has no caption style.");
      const ok = session.apply([{ type: "UpdateClipProperties", clipId: selectedClip.id, captionStyle: style as never }]);
      notice(ok ? `Applied caption style ${p.name}.` : "Apply refused.");
    } else {
      notice(`${p.kind === "AUDIO" ? "Audio presets run in the GANGZII audio tool." : "Export profile sets are consumed by the batch export drawer."}`);
    }
  };

  const rename = async () => {
    if (!renaming || !renaming.value.trim()) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/presets/${renaming.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: renaming.value.trim() }) });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      notice(res.ok ? "Renamed." : (body.error ?? `Rename failed (${res.status}).`));
      setRenaming(null);
      void load();
    } finally {
      setBusy(false);
    }
  };

  const duplicate = async (id: string) => {
    const res = await fetch(`/api/presets/${id}`, { method: "POST" });
    notice(res.ok ? "Duplicated." : "Duplicate failed.");
    void load();
  };

  const remove = async (p: PresetRow) => {
    const res = await fetch(`/api/presets/${p.id}?confirm=${encodeURIComponent(p.name)}`, { method: "DELETE" });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    notice(res.ok ? `Deleted ${p.name}.` : (body.error ?? `Delete failed (${res.status}).`));
    setDeleteConfirm(null);
    void load();
  };

  return (
    <div className="space-y-2 text-xs text-[#b8b8b2]">
      <div className="flex flex-wrap gap-1">
        {KINDS.map((k) => (
          <button key={k} type="button" onClick={() => setKind(k)} className={`rounded px-2 py-1 text-[10px] uppercase tracking-wide ${kind === k ? "bg-[#d4a017]/15 text-[#d4a017]" : "text-[#8f8f8a] hover:text-[#d8d8d2]"}`}>
            {k.replace("_", " ")}
          </button>
        ))}
      </div>
      <p className="text-[10px] text-[#8f8f8a]">{KIND_LABEL[kind]} — {kind === "VIDEO_EFFECT" || kind === "CAPTION" ? "save from the selected clip, apply to the selected clip (undoable)." : kind === "EXPORT" ? "profile sets consumed by batch export." : "GANGZII processing references."}</p>
      {(kind === "VIDEO_EFFECT" || kind === "CAPTION") && (
        <div className="flex gap-1">
          <input aria-label="New preset name" value={name} onChange={(e) => setName(e.target.value.slice(0, 80))} placeholder={`Preset name (${kind === "VIDEO_EFFECT" ? "captures selected clip's effect stack" : "captures caption style"})`} className="min-w-0 flex-1 rounded border border-[#2a2a2a] bg-[#111110] px-2 py-1 text-[11px] text-[#d4d4d0] placeholder:text-[#5a5a55]" />
          <button type="button" onClick={() => void saveFromSelection()} disabled={busy || !name.trim() || !selectedClip} className="rounded border border-[#d4a017] bg-[#d4a017]/10 px-2 py-1 text-[10px] text-[#d4a017] hover:bg-[#d4a017]/20 disabled:opacity-40">
            Save from selection
          </button>
        </div>
      )}
      <ul className="space-y-1">
        {presets === null && <li className="text-[10px] text-[#6a6a64]">Loading…</li>}
        {presets?.length === 0 && <li className="text-[10px] text-[#6a6a64]">No {kind} presets yet.</li>}
        {presets?.map((p) => (
          <li key={p.id} className="rounded border border-[#1c1c1a] bg-[#111110] px-2 py-1.5">
            {renaming?.id === p.id ? (
              <div className="flex gap-1">
                <input aria-label="Rename preset" value={renaming.value} onChange={(e) => setRenaming({ id: p.id, value: e.target.value.slice(0, 80) })} className="min-w-0 flex-1 rounded border border-[#2a2a2a] bg-[#0b0b0a] px-1.5 py-0.5 text-[10px] text-[#d4d4d0]" />
                <button type="button" onClick={() => void rename()} disabled={busy} className="rounded border border-[#d4a017] px-1.5 py-0.5 text-[9px] text-[#d4a017]">Save</button>
                <button type="button" onClick={() => setRenaming(null)} className="rounded border border-[#2a2a2a] px-1.5 py-0.5 text-[9px] text-[#8f8f8a]">Cancel</button>
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-[#e6e6e0]" title={p.name}>{p.name} <span className="text-[9px] text-[#6a6a64]">v{p.version}</span></span>
                {(p.kind === "VIDEO_EFFECT" || p.kind === "CAPTION") && (
                  <button type="button" onClick={() => void applyPreset(p)} className="rounded border border-[#2a2a2a] px-1.5 py-0.5 text-[9px] text-[#d8d8d2] hover:border-[#d4a017] hover:text-[#d4a017]" title="Apply to the selected clip (undoable)">
                    Apply
                  </button>
                )}
                <button type="button" onClick={() => setRenaming({ id: p.id, value: p.name })} className="rounded border border-[#2a2a2a] px-1.5 py-0.5 text-[9px] text-[#8f8f8a] hover:text-[#d8d8d2]" title="Rename">Ren</button>
                <button type="button" onClick={() => void duplicate(p.id)} className="rounded border border-[#2a2a2a] px-1.5 py-0.5 text-[9px] text-[#8f8f8a] hover:text-[#d8d8d2]" title="Duplicate">Dup</button>
                {deleteConfirm === p.id ? (
                  <button type="button" onClick={() => void remove(p)} className="rounded border border-[#c45c4c] px-1.5 py-0.5 text-[9px] text-[#c45c4c] hover:bg-[#c45c4c]/10" title="Confirm delete">
                    confirm?
                  </button>
                ) : (
                  <button type="button" onClick={() => setDeleteConfirm(p.id)} className="rounded border border-[#2a2a2a] px-1.5 py-0.5 text-[9px] text-[#8f8f8a] hover:border-[#c45c4c] hover:text-[#c45c4c]" title="Delete (with confirmation)">Del</button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
