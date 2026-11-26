"use client";

/**
 * M47 Phase G — Creative Intelligence (destination 5).
 * ONLY real computed data: scenes from the actual storyboard, asset probe
 * facts, source→final traceability from bound asset rows, QA results from the
 * real QUALITY_ASSURANCE stage, and the timeline change map from delivered
 * versions. Sections without data are hidden, never filled with placeholders.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { StudioNav, StudioTopbar, useStudioShortcuts, type DestinationId } from "@/components/bean/studio-nav";
import { Panel, PanelHead, Btn, Empty, StatusBadge, statusSense, Select, AgentDot } from "@/components/bean/ui";
import type { SessionUser } from "@/lib/types";

type ProductionLite = { id: string; title: string; status: string; projectId: string | null };
type StageLite = { key: string; state: string; order: number; output?: Record<string, unknown> | null };
type AssetRow = { id: string; sceneKey: string | null; category: string; description: string; status: string; mediaAssetId: string | null };
type MediaRow = { id: string; originalName: string; kind: string; durationSec?: number | null; width?: number | null; height?: number | null; fps?: string | number | null; probeStatus?: string | null };
type TaskLite = { id: string; stageKey: string; agent: string; status: string; error?: string | null };
type Artifact = { exportFileId?: string; versionNumber?: number; durationSec?: number; sizeBytes?: number };

export function IntelligencePage({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  const [active, setActive] = useState<DestinationId>("intelligence");
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
  const [prodId, setProdId] = useState<string>("");
  const [stages, setStages] = useState<StageLite[]>([]);
  const [assets, setAssets] = useState<AssetRow[]>([]);
  const [media, setMedia] = useState<MediaRow[]>([]);
  const [tasks, setTasks] = useState<TaskLite[]>([]);
  const [storyboard, setStoryboard] = useState<{ scenes?: Array<{ sceneKey?: string; description?: string; durationSec?: number; sourceHint?: string }> } | null>(null);
  const [delivery, setDelivery] = useState<{ artifacts?: Artifact[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadProductions = useCallback(async () => {
    const res = await fetch("/api/productions");
    const d = await res.json();
    setProductions(d.productions ?? []);
    setProdId((prev) => prev || (d.productions ?? [])[d.productions.length - 1]?.id || ""); // newest
  }, []);

  const loadDetail = useCallback(async () => {
    if (!prodId) return;
    setError(null);
    try {
      const res = await fetch(`/api/productions/${prodId}`);
      if (!res.ok) throw new Error(`Load failed (HTTP ${res.status}).`);
      const d = await res.json();
      setStages(d.stages ?? []);
      setAssets(d.assets ?? []);
      setTasks(d.tasks ?? []);
      setDelivery(d.production?.delivery ?? null);
      try { setStoryboard(d.production?.storyboard ? JSON.parse(d.production.storyboard) : null); } catch { setStoryboard(null); }
      if (d.production?.projectId) {
        const m = await fetch(`/api/media?projectId=${d.production.projectId}`);
        const md = await m.json();
        setMedia(md.media ?? []);
      } else setMedia([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load intelligence data.");
    }
  }, [prodId]);

  useEffect(() => { void loadProductions(); }, [loadProductions]);
  useEffect(() => { void loadDetail(); }, [loadDetail]);

  // ── Real computed views ────────────────────────────────────────────────────
  const boundMedia = useMemo(() => {
    const ids = new Set(assets.map((a) => a.mediaAssetId).filter(Boolean) as string[]);
    return media.filter((m) => ids.has(m.id));
  }, [assets, media]);
  const unboundAssets = assets.filter((a) => !a.mediaAssetId);
  const qa = stages.find((s) => s.key === "QUALITY_ASSURANCE");
  const qaOutput = (qa?.output ?? null) as Record<string, unknown> | null;
  const qaChecks = useMemo(() => {
    if (!qaOutput) return [];
    const raw = (qaOutput.checks ?? qaOutput.results ?? qaOutput) as Record<string, unknown> | Array<{ id?: string; name?: string; ok?: boolean; passed?: boolean; verdict?: string }>;
    if (Array.isArray(raw)) return raw.map((c, i) => ({ name: String(c.name ?? c.id ?? `check ${i + 1}`), ok: Boolean(c.ok ?? c.passed ?? c.verdict === "PASS") }));
    return Object.entries(raw).map(([k, v]) => ({ name: k, ok: v === true || (typeof v === "string" && /pass|ok/i.test(v)) }));
  }, [qaOutput]);
  const versions = useMemo(() => (delivery?.artifacts ?? []).slice().sort((a, b) => (a.versionNumber ?? 0) - (b.versionNumber ?? 0)), [delivery]);
  const shotCoverage = useMemo(() => {
    const scenes = storyboard?.scenes ?? [];
    if (scenes.length === 0) return null;
    const boundByScene = new Map<string, AssetRow[]>();
    for (const a of assets) {
      const k = a.sceneKey ?? "music";
      boundByScene.set(k, [...(boundByScene.get(k) ?? []), a]);
    }
    return scenes.map((sc, i) => {
      const key = sc.sceneKey ?? `scene-${i + 1}`;
      const bound = (boundByScene.get(key) ?? []).filter((a) => a.mediaAssetId);
      return { key, description: sc.description ?? "", boundCount: bound.length, total: (boundByScene.get(key) ?? []).length };
    });
  }, [storyboard, assets]);

  return (
    <div className="flex min-h-screen bg-[var(--m47-bg)] text-[var(--m47-ink)]">
      <StudioNav user={user} active={active} onLogout={onLogout} />
      <div className="flex min-w-0 flex-1 flex-col">
        <StudioTopbar
          title="Creative Intelligence"
          context={
            <Select value={prodId} onChange={(e) => setProdId(e.target.value)} aria-label="Select production" className="max-w-[240px]">
              {productions.length === 0 && <option value="">No productions yet</option>}
              {productions.map((p) => <option key={p.id} value={p.id}>{p.title || "Untitled"} · {p.status}</option>)}
            </Select>
          }
          right={<Btn onClick={() => void loadDetail()}>Recompute view</Btn>}
        />
        <main className="bean-panel-scroll min-w-0 flex-1 overflow-y-auto p-4">
          {error && <p className="mb-3 text-[11px] text-[var(--m47-err)]">{error}</p>}
          {!prodId && <Panel><Empty>Intelligence appears once a production exists — every panel here is computed from real pipeline data.</Empty></Panel>}

          {prodId && (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {shotCoverage && (
                <Panel className="lg:col-span-2">
                  <PanelHead title="Shot coverage map" right={<span className="m47-chip">{shotCoverage.filter((s) => s.boundCount > 0).length}/{shotCoverage.length} scenes with real material</span>} />
                  <ul className="p-3">
                    {shotCoverage.map((s) => (
                      <li key={s.key} className="mb-2 border-b border-[var(--m47-line)] pb-2 last:border-0">
                        <div className="flex items-center gap-2">
                          <StatusBadge s={s.boundCount > 0 ? "ok" : "fail"}>{s.boundCount > 0 ? "covered" : "uncovered"}</StatusBadge>
                          <span className="text-[12px] font-semibold">{s.key}</span>
                          <span className="text-[10.5px] text-[var(--m47-ink-dim)]">{s.boundCount}/{s.total || 0} rows bound to media</span>
                        </div>
                        {s.description && <p className="mt-0.5 line-clamp-2 text-[10.5px] text-[var(--m47-ink-mid)]">{s.description}</p>}
                      </li>
                    ))}
                  </ul>
                </Panel>
              )}

              <Panel>
                <PanelHead title="Source → final traceability" right={<span className="m47-chip">{boundMedia.length} sources in the final</span>} />
                <div className="p-3">
                  {boundMedia.length === 0 && <Empty>No bound sources yet — traceability appears when assets are attached to scenes.</Empty>}
                  <ul className="space-y-1.5">
                    {boundMedia.map((m) => (
                      <li key={m.id} className="rounded-md border border-[var(--m47-line)] bg-[var(--m47-bg)] px-3 py-2 text-[11px]">
                        <p className="truncate text-[var(--m47-ink)]">{m.originalName}</p>
                        <p className="text-[10px] text-[var(--m47-ink-dim)]">
                          {m.durationSec ? `${Number(m.durationSec).toFixed(1)} s` : "—"} · {m.width ? `${m.width}×${m.height}` : "dims —"} · {m.fps ? `${String(m.fps)} fps` : "fps —"} · probe {m.probeStatus ?? "—"}
                        </p>
                        <p className="text-[10px] text-[var(--m47-gold-soft)]">used by {assets.filter((a) => a.mediaAssetId === m.id).map((a) => a.sceneKey ?? "music").join(", ")}</p>
                      </li>
                    ))}
                  </ul>
                  {unboundAssets.length > 0 && (
                    <p className="mt-2 text-[10.5px] text-[var(--m47-warn)]">{unboundAssets.length} planned row(s) have no real media — the final video does NOT use invented footage for them.</p>
                  )}
                </div>
              </Panel>

              <Panel>
                <PanelHead title="Production QA insights" right={qa ? <StatusBadge s={statusSense(qa.state)}>{qa.state}</StatusBadge> : undefined} />
                <div className="p-3">
                  {!qa || !qaOutput ? <Empty>QA results appear after the QUALITY_ASSURANCE stage has run on a real render.</Empty> : (
                    <ul className="space-y-1">
                      {qaChecks.slice(0, 20).map((c, i) => (
                        <li key={i} className="flex items-center gap-2 text-[11.5px]">
                          <StatusBadge s={c.ok ? "ok" : "fail"}>{c.ok ? "pass" : "fail"}</StatusBadge>
                          <span className="text-[var(--m47-ink-mid)]">{c.name.replaceAll(/[_-]/g, " ")}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Panel>

              <Panel>
                <PanelHead title="Timeline change map" right={<span className="m47-chip">{versions.length} rendered version(s)</span>} />
                <div className="p-3">
                  {versions.length === 0 && <Empty>Rendered versions appear here with their exact durations — the lineage of the same production.</Empty>}
                  <ol className="space-y-1.5">
                    {versions.map((v, i) => (
                      <li key={i} className="flex items-center gap-2 text-[11.5px]">
                        <span className="m47-chip m47-chip-gold">v{v.versionNumber ?? i + 1}</span>
                        <span className="text-[var(--m47-ink-mid)]">{v.durationSec ? `${Number(v.durationSec).toFixed(2)} s` : "—"} · {v.sizeBytes ? `${(v.sizeBytes / 1024).toFixed(0)} KB` : "—"}</span>
                        <span className="text-[10px] text-[var(--m47-ink-dim)]">export …{v.exportFileId?.slice(-6)}</span>
                      </li>
                    ))}
                  </ol>
                  {versions.length > 1 && (
                    <p className="mt-2 text-[10.5px] text-[var(--m47-ink-dim)]">
                      {versions.length} renders of this production are retained; earlier outputs are never overwritten. Compare them in Studio Chat with "Compare versions".
                    </p>
                  )}
                </div>
              </Panel>

              <Panel className="lg:col-span-2">
                <PanelHead title="Crew execution trace" right={<span className="m47-chip">{tasks.length} tasks</span>} />
                <ul className="m47-panel-scroll max-h-56 overflow-y-auto p-3">
                  {tasks.length === 0 && <Empty>Tasks appear as the crew executes.</Empty>}
                  {tasks.map((t) => (
                    <li key={t.id} className="flex items-center gap-2 border-b border-[var(--m47-line)] py-1.5 text-[11px] last:border-0">
                      <AgentDot agent={t.agent} />
                      <span className="text-[var(--m47-ink)]">{t.agent}</span>
                      <span className="text-[var(--m47-ink-dim)]">{t.stageKey.replaceAll("_", " ").toLowerCase()}</span>
                      <StatusBadge s={statusSense(t.status)}>{t.status}</StatusBadge>
                      {t.error && <span className="truncate text-[var(--m47-err)]">{t.error}</span>}
                    </li>
                  ))}
                </ul>
              </Panel>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
