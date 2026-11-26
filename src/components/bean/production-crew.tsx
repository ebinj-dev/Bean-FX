"use client";

/**
 * M45-D — the production crew panel for the chat-first home.
 *
 * Rides the EXISTING durable production system (src/lib/production/runner.ts,
 * Prisma Production/ProductionStage, POST /api/productions, stage actions
 * start/approve/reject/skip via POST /api/productions/[id]/stages/[key]).
 * No second executor: assembly applies canonical timeline commands and the
 * render stage enqueues the durable RENDER_TIMELINE job.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, ChevronRight, CircleDashed, Clock, Loader2, Users } from "lucide-react";

export interface TaskLite {
  id: string; stageKey: string; seq: number; agent: string; roleLabel: string; tool: string;
  status: string; criteria: string | null; error: string | null; jobId: string | null;
  startedAt: string | null; completedAt: string | null;
  input: Record<string, unknown> | null; output: Record<string, unknown> | null;
}
export interface EventLite { id: string; kind: string; stageKey: string | null; createdAt: string; detail?: Record<string, unknown> | null }
export interface StageLite {
  key: string;
  state: string;
  order: number;
  jobId: string | null;
  error: string | null;
  output: Record<string, unknown> | null;
}
export interface DeliveryArtifact { exportFileId?: string; sizeBytes?: number; durationSec?: number; storagePath?: string; versionNumber?: number; jobId?: string }
export interface ProductionLite {
  id: string;
  title: string;
  templateId: string;
  status: string;
  projectId: string | null;
  script: { beats?: string[]; hook?: string; cta?: string } | null;
  storyboard: { scenes?: Array<{ key?: string; description?: string; shot?: string }> } | null;
  delivery: { deliveredAt?: string; artifacts?: DeliveryArtifact[] } | null;
}

/** Which canonical agent leads each stage — role PROFILES, not new identities. */
const STAGE_AGENT: Record<string, string> = {
  INTAKE: "RIISHE",
  PRODUCT_UNDERSTANDING: "JAZMII",
  BRIEF: "RIISHE",
  CONCEPT: "RIISHE",
  SCRIPT: "Scriptwriter · RIISHE",
  STORYBOARD: "Storyboard Artist · RIISHE",
  ASSET_PLANNING: "JAZMII",
  ASSET_GENERATION: "LAXII · NIIKI",
  EDIT_PLANNING: "Assistant Editor · RIISHE",
  ASSEMBLY: "Video Editor · RIISHE",
  ROUGH_CUT: "QC Editor",
  REVIEW: "RIISHE",
  RENDER: "Render Pipeline",
  VARIANTS: "Delivery Specialist",
  QA: "QC Editor",
  DELIVERY: "Delivery Specialist",
  RESEARCH: "JAZMII",
  ANALYSIS: "JAZMII",
  CLIP_SELECTION: "Video Editor",
};

const STATE_STYLE: Record<string, string> = {
  SUCCEEDED: "text-[#4cc47f]",
  AWAITING_APPROVAL: "text-[#d4a017]",
  RUNNING: "text-[#7ab8ff]",
  QUEUED: "text-[#8f8f8a]",
  FAILED: "text-[#f87171]",
  CANCELLED: "text-[#6a6a64]",
  SKIPPED: "text-[#6a6a64]",
  PENDING: "text-[#55555a]",
};

function StateBadge({ state }: { state: string }) {
  const cls = STATE_STYLE[state] ?? "text-[#8f8f8a]";
  if (state === "SUCCEEDED") return <CheckCircle2 className={`h-3.5 w-3.5 ${cls}`} />;
  if (state === "RUNNING") return <Loader2 className={`h-3.5 w-3.5 animate-spin ${cls}`} />;
  if (state === "AWAITING_APPROVAL") return <Clock className={`h-3.5 w-3.5 ${cls}`} />;
  if (state === "FAILED") return <AlertCircle className={`h-3.5 w-3.5 ${cls}`} />;
  if (state === "PENDING") return <CircleDashed className={`h-3.5 w-3.5 ${cls}`} />;
  return <CircleDashed className={`h-3.5 w-3.5 ${cls}`} />;
}

export function ProductionCrewPanel({
  production,
  stages,
  tasks,
  events,
  busyAction,
  onAction,
  onOpenEditor,
}: {
  production: ProductionLite;
  stages: StageLite[];
  tasks: TaskLite[];
  events: EventLite[];
  busyAction: string | null;
  onAction: (stageKey: string, action: "start" | "approve" | "reject" | "skip") => void;
  onOpenEditor: () => void;
}) {
  const ordered = [...stages].sort((a, b) => a.order - b.order);
  const [logOpen, setLogOpen] = useState(false);
  const [intelOpen, setIntelOpen] = useState(false);
  const [intel, setIntel] = useState<{ coverage: Array<{ scene: string; covered: boolean }>; versions: number; lastVersion: number; traced: Array<{ from: string; via: string; to: string }> } | null>(null);
  useEffect(() => {
    // M45 intelligence foundations — computed from REAL data only:
    // coverage = storyboard scenes vs actual timeline clips; change map =
    // timeline version history; traceability = bound assets → render artifact.
    let alive = true;
    const run = async () => {
      if (!production.projectId) return;
      try {
        const t = await fetch(`/api/editor/projects/${production.projectId}/timeline`).then((r) => (r.ok ? r.json() : null));
        const v = await fetch(`/api/editor/projects/${production.projectId}/timeline/versions`).then((r) => (r.ok ? r.json() : null));
        if (!alive) return;
        const clips: Array<{ label?: string; name?: string }> = (t && (t.sequence?.clips ?? [])) || [];
        const scenes = production.storyboard?.scenes ?? [];
        const coverage = scenes.map((sc) => {
          const key = (sc.key ?? "").toLowerCase();
          return { scene: sc.key ?? "scene", covered: clips.some((c) => `${c.label ?? ""} ${c.name ?? ""}`.toLowerCase().includes(key)) };
        });
        const versionList: Array<{ versionNumber?: number }> = (v && (v.versions ?? v)) || [];
        const bound = tasks.filter((x) => x.stageKey === "ASSET_PLANNING" || x.stageKey === "TIMELINE_ASSEMBLY");
        const artifact = production.delivery?.artifacts?.[0];
        const traced = [
          ...bound.map((x) => ({ from: x.stageKey, via: x.tool, to: x.output ? "timeline revision" : "pending" })),
          ...(artifact ? [{ from: `timeline v${artifact.versionNumber ?? "?"}`, via: `render job ${String(artifact.jobId ?? "").slice(-6) || "durable"}`, to: `export ${String(artifact.exportFileId ?? "").slice(-8)}` }] : []),
        ];
        setIntel({ coverage, versions: versionList.length, lastVersion: versionList[0]?.versionNumber ?? 0, traced });
      } catch {
        // intelligence stays null — never fabricated
      }
    };
    void run();
    return () => { alive = false; };
  }, [production.projectId, production.storyboard, production.delivery, tasks]);
  const actionable = ordered.find((s) => s.state === "AWAITING_APPROVAL");
  const startable = ordered.find((s) => s.state === "PENDING" && (!actionable || s === actionable));
  const doneCount = ordered.filter((s) => s.state === "SUCCEEDED" || s.state === "SKIPPED").length;
  const scriptBeats = production.script?.beats?.length ?? 0;
  const scenes = production.storyboard?.scenes?.length ?? 0;

  return (
    <div className="overflow-hidden rounded-2xl border border-[#d4a017]/30 bg-[#0d0d0c]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1c1c1a] bg-[#d4a017]/5 px-3.5 py-2.5">
        <p className="flex items-center gap-2 text-xs font-bold text-[#d4a017]">
          <Users className="h-3.5 w-3.5" /> PRODUCTION CREW · {production.title}
        </p>
        <span className="text-[10px] text-[#8f8f8a]">{doneCount}/{ordered.length} stages complete</span>
      </div>
      <div className="px-3.5 py-2">
        {(scriptBeats > 0 || scenes > 0) && (
          <p className="mb-1.5 text-[11px] text-[#a8a8a0]">
            {scriptBeats > 0 && <>Script drafted: {scriptBeats} beats. </>}
            {scenes > 0 && <>Storyboard: {scenes} scenes.</>}
          </p>
        )}
        <ol className="flex flex-col">
          {ordered.map((s) => (
            <li key={s.key} className="flex items-center justify-between gap-2 border-b border-[#161615] py-1.5 last:border-0">
              <span className="flex min-w-0 items-center gap-2">
                <StateBadge state={s.state} />
                <span className="truncate text-[11px] text-[#e6e6e0]">{s.key.replaceAll("_", " ")}</span>
                <span className="shrink-0 rounded border border-[#242422] px-1.5 py-0.5 text-[9px] text-[#8f8f8a]">{STAGE_AGENT[s.key] ?? "RIISHE"}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
                {s.state === "AWAITING_APPROVAL" && (
                  <>
                    <button
                      onClick={() => onAction(s.key, "approve")}
                      disabled={busyAction !== null}
                      className="rounded bg-[#d4a017] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#0c0c0c] hover:bg-[#e9b52a] disabled:opacity-40"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => onAction(s.key, "reject")}
                      disabled={busyAction !== null}
                      className="rounded border border-[#3b1515] px-2 py-0.5 text-[10px] text-[#f87171] hover:border-[#f87171] disabled:opacity-40"
                    >
                      Reject
                    </button>
                  </>
                )}
                {s.state === "PENDING" && (actionable === undefined || actionable === s) && startable?.key === s.key && (
                  <button
                    onClick={() => onAction(s.key, "start")}
                    disabled={busyAction !== null}
                    className="flex items-center gap-1 rounded border border-[#2a2a2a] px-2 py-0.5 text-[10px] text-[#d4a017] hover:border-[#d4a017] disabled:opacity-40"
                  >
                    Start <ChevronRight className="h-3 w-3" />
                  </button>
                )}
                {s.state === "FAILED" && (
                  <button
                    onClick={() => onAction(s.key, "start")}
                    disabled={busyAction !== null}
                    className="rounded border border-[#2a2a2a] px-2 py-0.5 text-[10px] text-[#f87171] hover:border-[#f87171] disabled:opacity-40"
                  >
                    Retry
                  </button>
                )}
              </span>
            </li>
          ))}
        </ol>
        {actionable && (
          <p className="mt-1.5 text-[10px] leading-relaxed text-[#d4a017]">
            {actionable.key.replaceAll("_", " ")} is awaiting your approval — RIISHE pauses the crew here.
          </p>
        )}
        {/* M45-P1 — the latest real task per stage: agent · tool · status · error */}
        {tasks.length > 0 && (
          <details className="mt-2 rounded-lg border border-[#1c1c1a] bg-[#101010] px-2.5 py-1.5">
            <summary className="cursor-pointer text-[10px] font-bold uppercase tracking-wider text-[#8f8f8a]">Crew tasks ({tasks.length} executed)</summary>
            <ul className="mt-1.5 flex max-h-40 flex-col gap-1 overflow-y-auto">
              {tasks.slice().reverse().map((t) => (
                <li key={t.id} className="text-[10px] leading-relaxed">
                  <span className={t.status === "SUCCEEDED" ? "text-[#4cc47f]" : t.status === "FAILED" ? "text-[#f87171]" : "text-[#d4a017]"}>[{t.status}]</span>{" "}
                  <span className="text-[#c8c8c2]">{t.stageKey.replaceAll("_", " ")}</span>
                  <span className="text-[#6a6a64]"> · {t.agent} · {t.tool}</span>
                  {t.error && <span className="text-[#f87171]"> · {t.error.slice(0, 90)}</span>}
                </li>
              ))}
            </ul>
          </details>
        )}
        {/* M45 — expandable real activity log (ProductionEvent stream) */}
        {events.length > 0 && (
          <details className="mt-1.5 rounded-lg border border-[#1c1c1a] bg-[#101010] px-2.5 py-1.5">
            <summary className="cursor-pointer text-[10px] font-bold uppercase tracking-wider text-[#8f8f8a]" onClick={() => setLogOpen((o) => !o)}>Activity log ({events.length} events)</summary>
            {logOpen && (
              <ul className="mt-1.5 flex max-h-40 flex-col gap-0.5 overflow-y-auto">
                {events.slice(0, 30).map((e) => (
                  <li key={e.id} className="text-[9px] text-[#8f8f8a]">
                    <span className="text-[#55555a]">{new Date(e.createdAt).toLocaleTimeString()}</span> <span className="text-[#c8c8c2]">{e.kind}</span>{e.stageKey ? <span className="text-[#55555a]"> · {e.stageKey}</span> : ""}
                  </li>
                ))}
              </ul>
            )}
          </details>
        )}
        {/* M45 intelligence foundations — real computed data, never panels of air */}
        {intel && (
          <details className="mt-1.5 rounded-lg border border-[#1c1c1a] bg-[#101010] px-2.5 py-1.5">
            <summary className="cursor-pointer text-[10px] font-bold uppercase tracking-wider text-[#8f8f8a]" onClick={() => setIntelOpen((o) => !o)}>Production intelligence</summary>
            {intelOpen && (
              <div className="mt-1.5 flex flex-col gap-1.5 text-[10px] leading-relaxed">
                <p className="text-[#c8c8c2]">Shot coverage radar: {intel.coverage.filter((c) => c.covered).length}/{intel.coverage.length || 0} storyboard scenes present in the timeline{intel.coverage.some((c) => !c.covered) ? ` — missing: ${intel.coverage.filter((c) => !c.covered).map((c) => c.scene).join(", ")}` : ""}</p>
                <p className="text-[#c8c8c2]">Timeline change map: {intel.versions} revision(s) recorded; current v{intel.lastVersion}</p>
                {intel.traced.length > 0 && (
                  <p className="text-[#c8c8c2]">Source-to-final trace: {intel.traced.map((t) => `${t.from} → ${t.to}`).join(" → ")}</p>
                )}
              </div>
            )}
          </details>
        )}
        <div className="mt-2 flex justify-end">
          <button onClick={onOpenEditor} className="rounded border border-[#2a2a2a] px-2 py-0.5 text-[10px] text-[#d8d8d2] hover:border-[#d4a017] hover:text-[#d4a017]">
            Open Editor
          </button>
        </div>
      </div>
    </div>
  );
}

/** Poll the production detail endpoint while any stage is in flight. */
export function useProductionPolling(
  productionId: string | null,
  onTick: (p: { stages: StageLite[]; tasks: TaskLite[]; events: EventLite[]; production: ProductionLite }) => void,
  intervalMs = 4000,
): void {
  const cbRef = useRef(onTick);
  useEffect(() => {
    cbRef.current = onTick;
  }, [onTick]);
  useEffect(() => {
    if (!productionId) return;
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(`/api/productions/${productionId}`);
        if (!res.ok) return;
        const d = await res.json();
        if (!alive) return;
        cbRef.current({
          stages: d.stages ?? [],
          tasks: d.tasks ?? [],
          events: d.events ?? [],
          production: {
            id: d.production.id,
            title: d.production.title,
            templateId: d.production.templateId,
            status: d.production.status,
            projectId: d.production.projectId,
            script: d.production.script ?? null,
            storyboard: d.production.storyboard ?? null,
            delivery: d.production.delivery ?? null,
          },
        });
      } catch {
        // network hiccup — keep polling
      }
    };
    void tick();
    const timer = setInterval(tick, intervalMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [productionId, intervalMs]);
}
