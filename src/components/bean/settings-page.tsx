"use client";

/**
 * M47 Phase H — Settings & Studio Control (destination 6).
 * Provider health is reported from the LIVE capability registry: a configured
 * key is reported as configured, and a model is only "ready" when the registry
 * verified it — configuration alone is never presented as proof of capability.
 */
import { useCallback, useEffect, useState } from "react";
import { StudioNav, StudioTopbar, useStudioShortcuts, type DestinationId } from "@/components/bean/studio-nav";
import { Panel, PanelHead, Btn, StatusBadge, Empty, ErrorNote, Kbd, Skeleton } from "@/components/bean/ui";
import { STUDIO_DESTINATIONS } from "@/components/bean/studio-nav";
import type { SessionUser } from "@/lib/types";

type ModelRow = { id?: string; displayName?: string; provider?: string; capabilities?: string[]; ready?: boolean; detail?: string | null; model?: string };
type Me = { user?: { id?: string; email?: string; name?: string; role?: string } };

export function SettingsPage({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  const [active, setActive] = useState<DestinationId>("settings");
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

  const [models, setModels] = useState<ModelRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [storage, setStorage] = useState<{ count?: number; bytes?: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/ai/models");
      const d = await res.json();
      setModels(d.models ?? d.registry ?? []);
      const res2 = await fetch("/api/media");
      const d2 = await res2.json();
      const media = d2.media ?? [];
      setStorage({ count: media.length, bytes: media.reduce((s: number, m: { sizeBytes?: number }) => s + (m.sizeBytes ?? 0), 0) });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the registry.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const humanBytes = (b?: number) => (b === undefined ? "—" : `${(b / 1024 / 1024).toFixed(1)} MB`);

  return (
    <div className="flex min-h-screen bg-[var(--m47-bg)] text-[var(--m47-ink)]">
      <StudioNav user={user} active={active} onLogout={onLogout} />
      <div className="flex min-w-0 flex-1 flex-col">
        <StudioTopbar title="Settings & Studio Control" right={<Btn onClick={() => void load()}>Refresh registry</Btn>} />
        <main className="bean-panel-scroll min-w-0 flex-1 overflow-y-auto p-4">
          <ErrorNote>{error}</ErrorNote>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">

            <Panel>
              <PanelHead title="Account" />
              <div className="space-y-1.5 p-3 text-[12px]">
                <p><span className="text-[var(--m47-ink-dim)]">Name</span> · {user.name || "—"}</p>
                <p><span className="text-[var(--m47-ink-dim)]">Email</span> · {user.email}</p>
                <p className="text-[10.5px] text-[var(--m47-ink-dim)]">Authentication, projects and permissions are enforced server-side on every route; this screen only displays them.</p>
              </div>
            </Panel>

            <Panel>
              <PanelHead title="Storage" right={storage ? <span className="m47-chip">{storage.count} assets · {humanBytes(storage.bytes)}</span> : undefined} />
              <div className="p-3 text-[12px] text-[var(--m47-ink-mid)]">
                <p>Originals are stored once and never modified by any operation; exports are new validated files. Deleting assets is explicit and never automatic.</p>
              </div>
            </Panel>

            <Panel className="lg:col-span-2">
              <PanelHead title="AI providers — live capability registry" right={<span className="m47-chip">{models ? `${models.filter((m) => m.ready).length}/${models.length} verified ready` : "loading"}</span>} />
              {!models && <div className="p-3"><Skeleton className="h-24" /></div>}
              {models && models.length === 0 && <Empty>No providers registered.</Empty>}
              <ul className="m47-panel-scroll max-h-80 overflow-y-auto p-3">
                {(models ?? []).map((m, i) => (
                  <li key={m.id ?? i} className="mb-2 border-b border-[var(--m47-line)] pb-2 last:border-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge s={m.ready ? "ok" : "idle"}>{m.ready ? "verified ready" : "not ready"}</StatusBadge>
                      <span className="text-[12px] font-semibold">{m.displayName ?? m.id ?? "model"}</span>
                      {m.provider && <span className="m47-chip">{m.provider}</span>}
                      {(m.capabilities ?? []).map((c) => <span key={c} className="m47-chip">{c}</span>)}
                    </div>
                    {m.detail && <p className="mt-1 text-[10.5px] text-[var(--m47-ink-dim)]">{m.detail}</p>}
                  </li>
                ))}
              </ul>
              <p className="border-t border-[var(--m47-line)] px-3 py-2 text-[10px] text-[var(--m47-ink-dim)]">
                "Configured" means an environment integration exists; "verified ready" means the registry actually validated the capability. No paid provider is enabled without explicit owner approval.
              </p>
            </Panel>

            <Panel>
              <PanelHead title="Privacy" />
              <ul className="space-y-1.5 p-3 text-[11.5px] text-[var(--m47-ink-mid)]">
                <li>· Private source media is never uploaded to an external provider without your explicit authorization on the specific action.</li>
                <li>· Audio captured for voice input is processed only by the providers disclosed at record time; nothing is recorded before you activate voice mode.</li>
                <li>· Transcripts stay in your conversation history and can be edited before submission.</li>
              </ul>
            </Panel>

            <Panel>
              <PanelHead title="Keyboard shortcuts" />
              <ul className="space-y-1.5 p-3 text-[11.5px]">
                {STUDIO_DESTINATIONS.map((d) => (
                  <li key={d.id} className="flex items-center justify-between">
                    <span className="text-[var(--m47-ink-mid)]">{d.label}</span>
                    <Kbd>{d.num}</Kbd>
                  </li>
                ))}
                <li className="flex items-center justify-between"><span className="text-[var(--m47-ink-mid)]">Shortcuts ignored while typing</span><span className="text-[var(--m47-ink-dim)]">automatic</span></li>
              </ul>
            </Panel>

            <Panel className="lg:col-span-2">
              <PanelHead title="Render settings" />
              <p className="p-3 text-[11.5px] text-[var(--m47-ink-mid)]">
                Rendering runs the canonical ffmpeg pipeline (durable jobs, real encode, ffprobe-verified output). Output resolution, frame rate and format follow the production timeline spec — no user-facing toggles pretend to control them.
              </p>
            </Panel>
          </div>
        </main>
      </div>
    </div>
  );
}
