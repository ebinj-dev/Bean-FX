"use client";

/**
 * M47 Phase D — AI Production Crew control room (destination 2).
 * A professional production-control surface over the EXISTING M46 pipeline:
 * stage rail, task board with provenance, approval queue, live events,
 * asset-to-scene mapping and the deliverable manifest. No new backend —
 * every action hits the validated /api/productions endpoints.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { StudioNav, StudioTopbar, useStudioShortcuts, type DestinationId } from "@/components/bean/studio-nav";
import { Panel, PanelHead, Btn, StatusBadge, statusSense, Empty, ErrorNote, AgentDot, ModeTag, Select } from "@/components/bean/ui";
import type { SessionUser } from "@/lib/types";

type ProductionLite = { id: string; title: string; status: string; projectId: string | null; conversationId?: string | null };
type StageLite = { key: string; state: string; order: number; error: string | null };
type TaskLite = { id: string; stageKey: string; agent: string; roleLabel?: string | null; tool?: string | null; criteria?: string | null; status: string; error?: string | null; mode?: string | null; providerNote?: string | null; jobId?: string | null; startedAt?: string | null; completedAt?: string | null };
type EventLite = { id: string; kind?: string; label?: string; createdAt?: string; detail?: string | null; payloadJson?: string | null };
type AssetLite = { id: string; sceneKey: string | null; category: string; description: string; status: string; licenseState: string; mediaAssetId: string | null; attribution?: string | null };
type Artifact = { exportFileId?: string; sizeBytes?: number; durationSec?: number; versionNumber?: number };

const AGENT_ROSTER = [
  { name: "RIISHE", role: "Executive Director & Orchestrator", note: "Routes every specialist from your brief and reviews real task output before a stage can pass." },
  { name: "NIIKI", role: "VFX & Motion Graphics", note: "Provider-backed generation; honestly skipped with demo notes when no provider is configured." },
  { name: "GANGZII", role: "Audio & Sound", note: "Real audio handling through the ffmpeg pipeline; gains and fades are measured, not invented." },
  { name: "JAZMII", role: "Footage & Visual Intelligence", note: "Runs over your authorized sources only; analysis is disclosed, never fabricated." },
  { name: "LAXII", role: "Image & Artwork Generation", note: "Image provider jobs with provenance and license state per row." },
];

const fmtTime = (iso?: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—");

export function ProductionCrewPage({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  const [active, setActive] = useState<DestinationId>("crew");
  useStudioShortcuts(active);
  useEffect(() => {
    const onHash = () => {
      const h = window.location.hash.replace(/^#/, "").split("?")[0];
      const hit = { "/home": "chat", "/crew": "crew", "/editor": "editor", "/library": "library", "/intelligence": "intelligence", "/settings": "settings" }[h];
      if (hit) setActive(hit as DestinationId);
    };
    onHash();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const [productions, setProductions] = useState<ProductionLite[]>([]);
  const [prodId, setProdId] = useState<string | null>(null);
  const [stages, setStages] = useState<StageLite[]>([]);
  const [tasks, setTasks] = useState<TaskLite[]>([]);
  const [events, setEvents] = useState<EventLite[]>([]);
  const [assets, setAssets] = useState<AssetLite[]>([]);
  const [delivery, setDelivery] = useState<{ artifacts?: Artifact[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (id?: string) => {
    try {
      const res = await fetch("/api/productions");
      const d = await res.json();
      const mine: ProductionLite[] = d.productions ?? [];
      setProductions(mine);
      const target = id ?? mine[mine.length - 1]?.id ?? null; // newest first
      setProdId(target);
      if (!target) {
        setStages([]); setTasks([]); setEvents([]); setAssets([]); setDelivery(null);
        return;
      }
      const res2 = await fetch(`/api/productions/${target}`);
      if (!res2.ok) throw new Error(`Production load failed (HTTP ${res2.status}).`);
      const d2 = await res2.json();
      setStages(d2.stages ?? []);
      setTasks(d2.tasks ?? []);
      setEvents(d2.events ?? []);
      setAssets(d2.assets ?? []);
      setDelivery(d2.production?.delivery ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load productions.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  // Live polling — the control room reflects reality, not a snapshot.
  useEffect(() => {
    if (!prodId) return;
    const t = setInterval(() => void load(prodId), 6000);
    return () => clearInterval(t);
  }, [prodId, load]);

  const stageAction = useCallback(async (stageKey: string, action: string) => {
    if (!prodId) return;
    setBusy(stageKey);
    setError(null);
    try {
      const res = await fetch(`/api/productions/${prodId}/stages/${stageKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setError(`${stageKey.replaceAll("_", " ")} · ${action}: ${payload?.error ?? `HTTP ${res.status}`}`);
        return;
      }
      await load(prodId);
    } catch (err) {
      setError(`Network error: ${err instanceof Error ? err.message : "connection failed"}`);
    } finally {
      setBusy(null);
    }
  }, [prodId, load]);

  const ordered = useMemo(() => [...stages].sort((a, b) => a.order - b.order), [stages]);
  const awaiting = ordered.filter((s) => s.state === "AWAITING_APPROVAL");
  const failed = ordered.filter((s) => s.state === "FAILED");
  const running = ordered.filter((s) => s.state === "RUNNING" || s.state === "READY");
  const done = ordered.filter((s) => s.state === "SUCCEEDED").length;
  const latestTaskByStage = useMemo(() => {
    const m = new Map<string, TaskLite>();
    for (const t of tasks) if (!m.has(t.stageKey) || (t.startedAt ?? "") > (m.get(t.stageKey)?.startedAt ?? "")) m.set(t.stageKey, t);
    return m;
  }, [tasks]);

  return (
    <div className="flex min-h-screen bg-[var(--m47-bg)] text-[var(--m47-ink)]">
      <StudioNav user={user} active={active} onLogout={onLogout} />
      <div className="flex min-w-0 flex-1 flex-col">
        <StudioTopbar
          title="AI Production Crew"
          context={
            <Select value={prodId ?? ""} onChange={(e) => void load(e.target.value)} aria-label="Select production" className="max-w-[240px]">
              {productions.length === 0 && <option value="">No productions yet</option>}
              {productions.map((p) => (
                <option key={p.id} value={p.id}>{p.title || "Untitled production"} · {p.status}</option>
              ))}
            </Select>
          }
          right={<span className="m47-chip">{done}/{ordered.length} stages complete</span>}
        />

        <main className="bean-panel-scroll min-w-0 flex-1 overflow-y-auto p-4">
          <ErrorNote>{error}</ErrorNote>
          {!prodId && <Panel><Empty>No productions yet — start one from Studio Chat by describing the video you want.</Empty></Panel>}

          {prodId && (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
              {/* Approval queue + stage rail */}
              <div className="flex flex-col gap-4 xl:col-span-2">
                <Panel>
                  <PanelHead title="Approval queue" right={<span className="m47-chip">{awaiting.length} awaiting · {failed.length} failed · {running.length} active</span>} />
                  <div className="p-3">
                    {awaiting.length === 0 && failed.length === 0 && running.length === 0 && <Empty>Nothing needs you right now.</Empty>}
                    <ul className="flex flex-col gap-1.5">
                      {[...awaiting, ...failed, ...running].map((s) => (
                        <li key={s.key} className="flex items-center justify-between gap-2 rounded-md border border-[var(--m47-line)] bg-[var(--m47-bg)] px-3 py-2">
                          <div className="min-w-0">
                            <p className="truncate text-[12px] text-[var(--m47-ink)]">{s.key.replaceAll("_", " ")}</p>
                            {s.error && <p className="truncate text-[10px] text-[var(--m47-err)]" title={s.error}>{s.error}</p>}
                          </div>
                          <div className="flex flex-shrink-0 items-center gap-1.5">
                            <StatusBadge s={statusSense(s.state)}>{s.state}</StatusBadge>
                            {s.state === "AWAITING_APPROVAL" && (
                              <>
                                <Btn variant="primary" disabled={busy !== null} onClick={() => void stageAction(s.key, "approve")}>Approve</Btn>
                                <Btn variant="danger" disabled={busy !== null} onClick={() => void stageAction(s.key, "reject")}>Reject</Btn>
                                <Btn variant="ghost" disabled={busy !== null} onClick={() => void stageAction(s.key, "skip")}>Skip</Btn>
                              </>
                            )}
                            {s.state === "FAILED" && <Btn disabled={busy !== null} onClick={() => void stageAction(s.key, "retry")}>Retry</Btn>}
                            {(s.state === "READY" || s.state === "NOT_STARTED") && <Btn disabled={busy !== null} onClick={() => void stageAction(s.key, "start")}>Start</Btn>}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                </Panel>

                <Panel>
                  <PanelHead title="Stage visualization" right={<span className="m47-chip">13-stage pipeline</span>} />
                  <div className="flex flex-wrap gap-1.5 p-3">
                    {ordered.map((s) => (
                      <span key={s.key} className="m47-chip" title={`${s.state}${s.error ? ` — ${s.error}` : ""}`} style={{ borderColor: s.state === "SUCCEEDED" ? "rgba(76,196,127,.4)" : s.state === "FAILED" ? "rgba(248,113,113,.4)" : s.state === "RUNNING" || s.state === "AWAITING_APPROVAL" ? "rgba(212,160,23,.45)" : undefined, color: s.state === "SUCCEEDED" ? "var(--m47-ok)" : s.state === "FAILED" ? "var(--m47-err)" : s.state === "RUNNING" || s.state === "AWAITING_APPROVAL" ? "var(--m47-gold-soft)" : undefined }}>
                        {s.key.replaceAll("_", " ").toLowerCase()} · {s.state.toLowerCase()}
                      </span>
                    ))}
                  </div>
                </Panel>

                <Panel>
                  <PanelHead title="Task board — real execution provenance" />
                  <div className="p-3">
                    {tasks.length === 0 && <Empty>No crew tasks yet — tasks appear as stages execute.</Empty>}
                    <ul className="flex flex-col gap-1.5">
                      {tasks.map((t) => (
                        <li key={t.id} className="rounded-md border border-[var(--m47-line)] bg-[var(--m47-bg)] px-3 py-2">
                          <div className="flex items-center gap-2">
                            <AgentDot agent={t.agent} />
                            <span className="text-[12px] font-semibold text-[var(--m47-ink)]">{t.agent}</span>
                            {t.roleLabel && <span className="text-[10px] text-[var(--m47-ink-dim)]">{t.roleLabel}</span>}
                            <span className="ml-auto"><StatusBadge s={statusSense(t.status)}>{t.status}</StatusBadge></span>
                          </div>
                          <p className="mt-1 text-[10.5px] text-[var(--m47-ink-mid)]">
                            stage {t.stageKey.replaceAll("_", " ").toLowerCase()} · tool {t.tool ?? "—"}
                            {t.startedAt ? ` · started ${fmtTime(t.startedAt)}` : ""}
                            {t.completedAt ? ` · done ${fmtTime(t.completedAt)}` : ""}
                            {t.jobId ? ` · job ${t.jobId.slice(-6)}` : ""}
                          </p>
                          {t.criteria && <p className="mt-0.5 text-[10px] text-[var(--m47-ink-dim)]">criteria: {t.criteria}</p>}
                          <p className="mt-1 flex flex-wrap items-center gap-2"><ModeTag mode={t.mode} />{t.providerNote && <span className="text-[9.5px] text-[var(--m47-ink-dim)]">{t.providerNote}</span>}</p>
                          {t.error && <p className="mt-1 text-[10px] text-[var(--m47-err)]">error: {t.error}</p>}
                        </li>
                      ))}
                    </ul>
                  </div>
                </Panel>
              </div>

              {/* Right column: roster, events, asset map, manifest */}
              <div className="flex flex-col gap-4">
                <Panel>
                  <PanelHead title="Crew roster" />
                  <ul className="p-3">
                    {AGENT_ROSTER.map((a) => (
                      <li key={a.name} className="mb-2 flex items-start gap-2 last:mb-0">
                        <span className="mt-1"><AgentDot agent={a.name} /></span>
                        <div>
                          <p className="text-[12px] font-semibold text-[var(--m47-ink)]">{a.name} <span className="font-normal text-[var(--m47-ink-dim)]">· {a.role}</span></p>
                          <p className="text-[10px] leading-snug text-[var(--m47-ink-dim)]">{a.note}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                </Panel>

                <Panel>
                  <PanelHead title="Live activity" right={<span className="m47-rec-dot" aria-hidden="true" />} />
                  <ul className="m47-panel-scroll max-h-52 overflow-y-auto p-3">
                    {events.length === 0 && <Empty>No events yet.</Empty>}
                    {events.slice(0, 24).map((e, i) => (
                      <li key={e.id ?? i} className="border-b border-[var(--m47-line)] py-1.5 text-[10.5px] text-[var(--m47-ink-mid)] last:border-0">
                        <span className="text-[var(--m47-gold-soft)]">{fmtTime(e.createdAt)}</span> · {e.label ?? e.kind ?? "event"}
                        {e.detail ? ` — ${e.detail}` : ""}
                      </li>
                    ))}
                  </ul>
                </Panel>

                <Panel>
                  <PanelHead title="Asset → scene mapping" right={<span className="m47-chip">{assets.filter((a) => a.mediaAssetId).length}/{assets.length} bound</span>} />
                  <ul className="m47-panel-scroll max-h-52 overflow-y-auto p-3">
                    {assets.length === 0 && <Empty>No asset rows yet.</Empty>}
                    {assets.map((a) => (
                      <li key={a.id} className="border-b border-[var(--m47-line)] py-1.5 text-[10.5px] last:border-0">
                        <span className="text-[var(--m47-ink)]">{a.sceneKey ?? "music"}</span> · {a.category} · <StatusBadge s={a.status === "APPROVED" || a.status === "READY" ? "ok" : a.status === "REJECTED" ? "fail" : "run"}>{a.status}</StatusBadge>
                        <span className="block text-[var(--m47-ink-dim)]">
                          {a.mediaAssetId ? `media ${a.mediaAssetId.slice(-6)}` : "unbound"} · license {a.licenseState}
                          {a.attribution ? ` · ${a.attribution}` : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Panel>

                <Panel>
                  <PanelHead title="Deliverable manifest" />
                  <div className="p-3">
                    {!delivery?.artifacts?.length && <Empty>No delivered artifacts yet — the manifest appears when DELIVERY completes.</Empty>}
                    <ul className="flex flex-col gap-1.5">
                      {delivery?.artifacts?.map((a, i) => (
                        <li key={i} className="rounded-md border border-[var(--m47-line)] bg-[var(--m47-bg)] px-3 py-2 text-[11px]">
                          <span className="text-[var(--m47-gold-soft)]">v{a.versionNumber ?? i + 1}</span> · export {a.exportFileId?.slice(-6)} · {a.durationSec ? `${Number(a.durationSec).toFixed(1)} s` : "duration —"} · {a.sizeBytes ? `${(a.sizeBytes / 1024).toFixed(0)} KB` : "size —"}
                          {a.exportFileId && (
                            <span className="ml-2 inline-flex gap-2">
                              <a href={`/api/exports/${a.exportFileId}/file`} download className="text-[var(--m47-ink-mid)] underline decoration-[var(--m47-line-strong)] hover:text-[var(--m47-gold-soft)]">download</a>
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                </Panel>

                <Panel>
                  <PanelHead title="Production cost visibility" />
                  <p className="p-3 text-[11px] leading-relaxed text-[var(--m47-ink-mid)]">
                    Cost accrues only when a configured provider actually generates. Every bound asset row records its license state and attribution; provider jobs are disclosed per task. Deterministic automation and local ffmpeg work accrue no provider cost.
                  </p>
                </Panel>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
