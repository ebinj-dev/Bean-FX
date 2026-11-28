/**
 * BEAN FX — M48-I2/I3 professional primary grading panel.
 *
 * Every control dispatches validated, reversible canonical commands
 * (SetClipGrade / SetClipLut / AddLut) — no decorative controls: the panel's
 * math IS the grading model in src/lib/color/grade-model.ts, consumed
 * identically by the WebGL preview and the lut3d export. Reset/Bypass/
 * Before-after are command-driven so they undo and persist like any edit.
 */
"use client";
import { useCallback, useMemo, useState } from "react";
import type { Sequence } from "@/lib/editor/model";
import type { EditorSession } from "@/hooks/use-editor-session";
import { DEFAULT_GRADE, type GradeParams } from "@/lib/color/grade-model";

type Grade = NonNullable<Sequence["clips"][number]["grade"]>;

const SLIDERS: { key: keyof GradeParams; label: string; min: number; max: number; step: number; unit?: string }[] = [
  { key: "exposure", label: "Exposure", min: -4, max: 4, step: 0.05, unit: "st" },
  { key: "temperature", label: "Temperature", min: -1, max: 1, step: 0.01 },
  { key: "tint", label: "Tint", min: -1, max: 1, step: 0.01 },
  { key: "contrast", label: "Contrast", min: 0.25, max: 4, step: 0.01 },
  { key: "pivot", label: "Pivot", min: 0, max: 1, step: 0.01 },
  { key: "highlights", label: "Highlights", min: -1, max: 1, step: 0.01 },
  { key: "shadows", label: "Shadows", min: -1, max: 1, step: 0.01 },
  { key: "whites", label: "Whites", min: -1, max: 1, step: 0.01 },
  { key: "blacks", label: "Blacks", min: -1, max: 1, step: 0.01 },
  { key: "saturation", label: "Saturation", min: 0, max: 3, step: 0.01 },
  { key: "vibrance", label: "Vibrance", min: -1, max: 1, step: 0.01 },
];

const WHEELS: { key: keyof GradeParams; label: string; min: number; max: number; step: number }[] = [
  { key: "liftR", label: "L·R", min: -0.5, max: 0.5, step: 0.005 },
  { key: "liftG", label: "L·G", min: -0.5, max: 0.5, step: 0.005 },
  { key: "liftB", label: "L·B", min: -0.5, max: 0.5, step: 0.005 },
  { key: "gammaR", label: "γ·R", min: 0.25, max: 4, step: 0.01 },
  { key: "gammaG", label: "γ·G", min: 0.25, max: 4, step: 0.01 },
  { key: "gammaB", label: "γ·B", min: 0.25, max: 4, step: 0.01 },
  { key: "gainR", label: "G·R", min: 0, max: 4, step: 0.01 },
  { key: "gainG", label: "G·G", min: 0, max: 4, step: 0.01 },
  { key: "gainB", label: "G·B", min: 0, max: 4, step: 0.01 },
  { key: "red", label: "RGB·R", min: 0, max: 2, step: 0.01 },
  { key: "green", label: "RGB·G", min: 0, max: 2, step: 0.01 },
  { key: "blue", label: "RGB·B", min: 0, max: 2, step: 0.01 },
];

export function ColorGradePanel({
  sequence,
  session,
  clipId,
  projectId,
  onNotice,
}: {
  sequence: Sequence;
  session: EditorSession;
  clipId: string;
  projectId: string;
  onNotice?: (m: string | null) => void;
}) {
  const clip = useMemo(() => sequence.clips.find((c) => c.id === clipId), [sequence, clipId]);
  const grade = clip?.grade ?? null;
  const lutId = clip?.lutId ?? null;
  const [importing, setImporting] = useState(false);
  const [beforeAfter, setBeforeAfter] = useState(false);
  const lut = sequence.luts.find((l) => l.id === lutId) ?? null;

  const setGrade = useCallback(
    (patch: Partial<Grade>) => {
      const next: Grade = { ...DEFAULT_GRADE, ...(grade ?? {}), ...patch } as Grade;
      session.apply([{ type: "SetClipGrade", clipId, grade: next }]);
    },
    [session, clipId, grade],
  );

  /** Hold-to-compare: bypass is a REAL command (undoable, audited, exported). */
  const holdBefore = useCallback(() => {
    setBeforeAfter(true);
    setGrade({ bypass: true });
  }, [setGrade]);
  const releaseBefore = useCallback(() => {
    setBeforeAfter(false);
    setGrade({ bypass: false });
  }, [setGrade]);

  const importLut = useCallback(
    async (file: File) => {
      if (!file.name.toLowerCase().endsWith(".cube")) {
        onNotice?.("Only .cube LUTs are supported.");
        return;
      }
      setImporting(true);
      try {
        const fd = new FormData();
        fd.set("file", file);
        fd.set("name", file.name.replace(/\.cube$/i, ""));
        const r = await fetch(`/api/editor/projects/${projectId}/luts`, { method: "POST", body: fd });
        const j = (await r.json().catch(() => null)) as { lut?: { id: string; name: string; size: number; bytes: number; createdAt: string; sourceName: string } } | null;
        if (!r.ok || !j?.lut) {
          onNotice?.(`LUT import refused: ${(j as { error?: string } | null)?.error ?? `HTTP ${r.status}`}`);
          return;
        }
        session.apply([
          { type: "AddLut", lut: j.lut },
          { type: "SetClipLut", clipId, lutId: j.lut.id },
        ]);
        onNotice?.(`LUT "${j.lut.name}" (${j.lut.size}³) applied.`);
      } finally {
        setImporting(false);
      }
    },
    [projectId, session, clipId, onNotice],
  );

  if (!clip) return null;
  return (
    <div className="rounded border border-[#2a2a2a] p-2 text-[11px]" data-testid="color-grade-panel">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-[#8f8f8a]">Color — primary grade</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            title="Hold to see the ungraded source (real bypass command)"
            onMouseDown={holdBefore}
            onMouseUp={releaseBefore}
            onMouseLeave={() => beforeAfter && releaseBefore()}
            className={`rounded border px-1.5 py-0.5 text-[9px] ${beforeAfter ? "border-[#d4a017] text-[#d4a017]" : "border-[#2a2a2a] text-[#8f8f8a] hover:text-[#d8d8d2]"}`}
          >
            BEFORE
          </button>
          <button
            type="button"
            onClick={() => setGrade({ bypass: !grade?.bypass })}
            className={`rounded border px-1.5 py-0.5 text-[9px] ${grade?.bypass ? "border-[#d4a017] text-[#d4a017]" : "border-[#2a2a2a] text-[#8f8f8a] hover:text-[#d8d8d2]"}`}
          >
            {grade?.bypass ? "BYPASSED" : "BYPASS"}
          </button>
          <button
            type="button"
            title="Reset to the neutral grade"
            onClick={() => session.apply([{ type: "SetClipGrade", clipId, grade: { ...DEFAULT_GRADE } }])}
            className="rounded border border-[#2a2a2a] px-1.5 py-0.5 text-[9px] text-[#8f8f8a] hover:text-[#d8d8d2]"
          >
            RESET
          </button>
        </div>
      </div>

      {/* LUT — applied BEFORE the primary grade (input transform) */}
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <span className="text-[9px] uppercase text-[#8f8f8a]">LUT</span>
        <select
          value={lutId ?? ""}
          onChange={(e) => session.apply([{ type: "SetClipLut", clipId, lutId: e.target.value || null }])}
          className="rounded border border-[#2a2a2a] bg-[#141412] px-1 py-0.5 text-[10px] text-[#d8d8d2]"
        >
          <option value="">None</option>
          {sequence.luts.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} ({l.size}³)
            </option>
          ))}
        </select>
        {lut && (
          <button
            type="button"
            onClick={() => session.apply([{ type: "SetClipLut", clipId, lutId: null }])}
            className="rounded border border-[#2a2a2a] px-1.5 py-0.5 text-[9px] text-[#c45c4c] hover:text-[#e06c55]"
          >
            remove
          </button>
        )}
        <label className={`cursor-pointer rounded border px-1.5 py-0.5 text-[9px] ${importing ? "border-[#2a2a2a] text-[#8f8f8a]" : "border-[#2a2a2a] text-[#d8d8d2] hover:border-[#d4a017] hover:text-[#d4a017]"}`}>
          {importing ? "importing…" : "+ import .cube"}
          <input
            type="file"
            accept=".cube"
            className="hidden"
            disabled={importing}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importLut(f);
              e.target.value = "";
            }}
          />
        </label>
      </div>
      <p className="mb-2 text-[9px] leading-relaxed text-[#6f6f6a]">
        Preview and export consume the same LUT cube and the same grade math (lut3d bridge). Licensing of imported LUTs is your responsibility.
      </p>

      <div className="grid grid-cols-1 gap-1.5">
        {SLIDERS.map((s) => (
          <label key={s.key} className="grid grid-cols-[64px_1fr_44px] items-center gap-2">
            <span className="text-[9px] text-[#8f8f8a]">{s.label}</span>
            <input
              type="range"
              min={s.min}
              max={s.max}
              step={s.step}
              value={Number((grade as GradeParams | null)?.[s.key] ?? DEFAULT_GRADE[s.key])}
              onChange={(e) => setGrade({ [s.key]: Number(e.target.value) } as Partial<Grade>)}
              className="h-1 w-full accent-[#d4a017]"
            />
            <span className="text-right font-mono text-[9px] text-[#d8d8d2]">
              {Number((grade as GradeParams | null)?.[s.key] ?? DEFAULT_GRADE[s.key]).toFixed(2)}
              {s.unit ?? ""}
            </span>
          </label>
        ))}
      </div>

      <div className="mt-2 border-t border-[#2a2a2a] pt-2">
        <span className="text-[9px] uppercase text-[#8f8f8a]">Lift / Gamma / Gain · RGB</span>
        <div className="mt-1 grid grid-cols-3 gap-1">
          {WHEELS.map((w) => (
            <label key={w.key} className="flex items-center gap-1">
              <span className="w-8 text-[9px] text-[#8f8f8a]">{w.label}</span>
              <input
                type="range"
                min={w.min}
                max={w.max}
                step={w.step}
                value={Number((grade as GradeParams | null)?.[w.key] ?? DEFAULT_GRADE[w.key])}
                onChange={(e) => setGrade({ [w.key]: Number(e.target.value) } as Partial<Grade>)}
                className="h-1 w-full accent-[#d4a017]"
              />
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
