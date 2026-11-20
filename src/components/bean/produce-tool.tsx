"use client";

/**
 * M31 — BEAN AI Production Studio: PRODUCE tool. Original BEAN FX UI.
 * Sections: intake (brief) → production board (stages / decisions rail /
 * asset wall / real event log / honest budget) → storyboard approvals →
 * stage actions. All state comes from the persisted API — no fabricated
 * progress, no fake thumbnails, unknown costs render as "unknown".
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Plus, RefreshCw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SessionUser } from "@/lib/types";

interface TemplateMeta { id: string; name: string; description: string; active: boolean; unavailableReason: string | null }
interface StageView { key: string; state: string; jobId: string | null; error: string | null; output: Record<string, unknown> | null; costs: { blocked: boolean; reason: string; estimatedCents: number | null; costUnknown: boolean } | null }
interface AssetRow { id: string; sceneKey: string | null; category: string; description: string; sourceType: string; licenseState: string; status: string; costUnknown: boolean; costCents: number | null; mediaAssetId: string | null }
interface DecisionRow { id: string; kind: string; value: Record<string, unknown>; createdAt: string }
interface EventRow { id: string; kind: string; stageKey: string | null; detail: Record<string, unknown> | null; createdAt: string }
interface Board {
  production: { id: string; title: string; templateId: string; status: string; projectId: string | null; qaState: string; qa: { checks?: { id: string; state: string; detail: string }[] } | null; delivery: { artifacts?: { exportFileId: string; sizeBytes: number; durationSec: number }[] } | null; approvedBudgetCents: number | null; research: { verdict?: string; note?: string } | null; reference: { segments?: unknown[]; note?: string } | null };
  stages: StageView[];
  decisions: DecisionRow[];
  assets: AssetRow[];
  events: EventRow[];
  concept: { options?: { id: string; title: string; centralIdea: string; complexity: string }[]; selectedId: string | null } | null;
  script: { revision: number; targetDurationSec: number; lines: { id: string; sceneNumber: number; durationSec: number; onScreenText: string; visual: string }[] } | null;
  storyboard: { scenes: { sceneKey: string; sceneNumber: number; durationSec: number; storyPurpose: string; approval: string }[] } | null;
  scriptDurationValid: boolean | null;
  provider: { configured: boolean; reason: string };
}
interface MediaMeta { id: string; originalName: string; kind: string }

const STATE_STYLES: Record<string, string> = {
  SUCCEEDED: "text-emerald-400 border-emerald-500/40", RUNNING: "text-[#d4a017] border-[#d4a017]/40",
  AWAITING_APPROVAL: "text-sky-400 border-sky-500/40", FAILED: "text-red-400 border-red-500/40",
  BLOCKED: "text-orange-400 border-orange-500/40", READY: "text-neutral-300 border-neutral-600",
  NOT_STARTED: "text-neutral-500 border-neutral-800", SKIPPED: "text-neutral-500 border-neutral-700",
  CANCELLED: "text-neutral-400 border-neutral-700", CANCEL_REQUESTED: "text-orange-300 border-orange-500/30",
  SUPERSEDED: "text-neutral-500 border-neutral-700",
};

export function ProduceTool({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  const [view, setView] = useState<"intake" | "board">("intake");
  const [templates, setTemplates] = useState<TemplateMeta[] | null>(null);
  const [productions, setProductions] = useState<{ id: string; title: string; templateId: string; status: string; qaState: string }[] | null>(null);
  const [media, setMedia] = useState<MediaMeta[] | null>(null);
  const [briefText, setBriefText] = useState("");
  const [templateId, setTemplateId] = useState("social-video-factory");
  const [projectId, setProjectId] = useState("");
  const [selectedMedia, setSelectedMedia] = useState<string[]>([]);
  const [budget, setBudget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const reload = useCallback(async () => {
    try {
      const r = await fetch("/api/productions");
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Failed to load");
      const j = await r.json();
      setTemplates(j.templates);
      setProductions(j.productions);
      setMedia(j.media ?? null);
    } catch (e) {
      setError(String(e).replace("Error: ", ""));
    }
  }, []);

  useEffect(() => { void reload(); void fetch("/api/media").then((r) => r.json()).then((j) => setMedia(j.media ?? [])).catch(() => undefined); }, [reload]);

  const openBoard = useCallback(async (id: string) => {
    setActiveId(id); setView("board");
    const load = async () => {
      const r = await fetch(`/api/productions/${id}`);
      if (r.ok) setBoard(await r.json());
    };
    await load();
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(load, 5000); // persisted-state polling; no fake animation
  }, []);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const createProduction = async () => {
    setBusy(true); setError(null);
    try {
      const r = await fetch("/api/productions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ templateId, briefText, projectId: projectId || undefined, sourceMediaIds: selectedMedia, title: undefined }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Failed to create production");
      if (budget) await fetch(`/api/productions/${j.production.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "budget", approvedBudgetCents: Math.round(Number(budget) * 100) }) });
      await reload();
      await openBoard(j.production.id);
    } catch (e) {
      setError(String(e).replace("Error: ", ""));
    } finally { setBusy(false); }
  };

  const stageAction = async (key: string, action: string) => {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/productions/${activeId}/stages/${key}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Action failed");
      const rr = await fetch(`/api/productions/${activeId}`);
      if (rr.ok) setBoard(await rr.json());
    } catch (e) {
      setError(String(e).replace("Error: ", ""));
    } finally { setBusy(false); }
  };

  const attachMedia = async (assetRowId: string, mediaAssetId: string) => {
    await fetch(`/api/productions/${activeId}/assets`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "attach", assetRowId, mediaAssetId }) });
    const rr = await fetch(`/api/productions/${activeId}`);
    if (rr.ok) setBoard(await rr.json());
  };

  const decideAsset = async (assetRowId: string, decision: "APPROVED" | "REJECTED") => {
    const r = await fetch(`/api/productions/${activeId}/assets`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "decide", assetRowId, decision }) });
    if (!r.ok) setError((await r.json().catch(() => ({}))).error ?? "Decision failed");
    const rr = await fetch(`/api/productions/${activeId}`);
    if (rr.ok) setBoard(await rr.json());
  };

  const selectConcept = async (selectedId: string) => {
    await fetch(`/api/productions/${activeId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "concept", selectedId }) });
    const rr = await fetch(`/api/productions/${activeId}`);
    if (rr.ok) setBoard(await rr.json());
  };

  const fmtCents = (c: number | null | undefined) => c === null || c === undefined ? "unknown" : `$${(c / 100).toFixed(2)}`;

  // ── Intake view ──
  if (view === "intake") {
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-6 text-neutral-200">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-bold tracking-wide text-[#d4a017]">PRODUCE — BEAN AI Production Studio</h1>
          <div className="text-xs text-neutral-500">{user.email} · <button className="underline" onClick={onLogout}>logout</button></div>
        </div>
        <p className="mt-2 max-w-3xl text-sm text-neutral-400">Describe the video you want. BEAN plans a production, you approve every consequential step, and the result becomes a real, editable BEAN FX project with a rendered, QA-validated deliverable.</p>
        {error && <div className="mt-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}
        <section className="mt-4 rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
          <h2 className="text-sm font-semibold text-neutral-200">1. Describe your video</h2>
          <textarea value={briefText} onChange={(e) => setBriefText(e.target.value)} rows={4} placeholder="e.g. Create a 30-second social clip for my product launch. Vertical for Reels, bold captions, energetic." className="mt-2 w-full rounded-lg border border-[#2a2a2a] bg-black/40 p-3 text-sm outline-none focus:border-[#d4a017]/60" />
          <h2 className="mt-4 text-sm font-semibold text-neutral-200">2. Choose a production template</h2>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {(templates ?? []).map((t) => (
              <button key={t.id} onClick={() => setTemplateId(t.id)} className={cn("rounded-lg border p-3 text-left text-sm", templateId === t.id ? "border-[#d4a017] bg-[#d4a017]/10" : "border-[#2a2a2a] bg-black/20", !t.active && "opacity-60")}>
                <div className="flex items-center justify-between gap-2"><span className="font-semibold text-neutral-100">{t.name}</span><span className={cn("rounded px-1.5 py-0.5 text-[10px] uppercase", t.active ? "bg-emerald-500/15 text-emerald-400" : "bg-orange-500/15 text-orange-400")}>{t.active ? "available" : "blocked"}</span></div>
                <div className="mt-1 text-xs text-neutral-400">{t.description}</div>
                {!t.active && t.unavailableReason && <div className="mt-1 text-[11px] text-orange-300/90">{t.unavailableReason}</div>}
              </button>
            ))}
          </div>
          <h2 className="mt-4 text-sm font-semibold text-neutral-200">3. Source media (optional — attach your footage)</h2>
          <div className="mt-2 flex max-h-28 flex-wrap gap-2 overflow-y-auto">
            {(media ?? []).map((m) => (
              <button key={m.id} onClick={() => setSelectedMedia((s) => s.includes(m.id) ? s.filter((x) => x !== m.id) : [...s, m.id])} className={cn("rounded-md border px-2 py-1 text-xs", selectedMedia.includes(m.id) ? "border-[#d4a017] text-[#d4a017]" : "border-[#2a2a2a] text-neutral-400")}>{m.originalName.slice(0, 26)}</button>
            ))}
            {media && media.length === 0 && <span className="text-xs text-neutral-500">No media in your library yet — upload in STUDIO first.</span>}
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-neutral-400">Attach to project (optional)
              <input value={projectId} onChange={(e) => setProjectId(e.target.value)} placeholder="existing project id" className="mt-1 w-full rounded-lg border border-[#2a2a2a] bg-black/40 p-2 text-sm" />
            </label>
            <label className="text-xs text-neutral-400">Approved budget ($, optional — required before ANY paid generation)
              <input value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" placeholder="e.g. 5.00" className="mt-1 w-full rounded-lg border border-[#2a2a2a] bg-black/40 p-2 text-sm" />
            </label>
          </div>
          <button onClick={createProduction} disabled={busy || !briefText.trim()} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-[#d4a017] px-4 py-2 text-sm font-semibold text-black disabled:opacity-40">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Create production
          </button>
        </section>
        <section className="mt-6">
          <h2 className="text-sm font-semibold text-neutral-200">Your productions</h2>
          <div className="mt-2 space-y-2">
            {(productions ?? []).map((p) => (
              <button key={p.id} onClick={() => openBoard(p.id)} className="flex w-full flex-wrap items-center justify-between gap-2 rounded-lg border border-[#1c1c1c] bg-[#0d0d0d] px-3 py-2 text-left text-sm hover:border-[#d4a017]/50">
                <span className="font-medium text-neutral-100">{p.title}</span>
                <span className="text-xs text-neutral-500">{p.templateId}</span>
                <span className={cn("rounded px-2 py-0.5 text-[10px] uppercase", STATE_STYLES[p.status] ?? "text-neutral-400")}>{p.status}</span>
                <span className="text-[10px] text-neutral-500">QA: {p.qaState}</span>
              </button>
            ))}
            {productions && productions.length === 0 && <div className="text-sm text-neutral-500">No productions yet.</div>}
          </div>
        </section>
      </div>
    );
  }

  // ── Board view ──
  const p = board?.production;
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 text-neutral-200">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-bold text-[#d4a017]">{p?.title ?? "Production Board"}</h1>
        <div className="flex items-center gap-2 text-xs">
          <span className="rounded border border-[#2a2a2a] px-2 py-0.5 uppercase text-neutral-300">{p?.status ?? "—"}</span>
          <span className="text-neutral-500">{p?.templateId}</span>
          <button onClick={() => { setView("intake"); if (pollRef.current) clearInterval(pollRef.current); }} className="rounded border border-[#2a2a2a] px-2 py-1 text-neutral-300 hover:border-[#d4a017]/60"><X className="inline h-3 w-3" /> close</button>
        </div>
      </div>
      {error && <div className="mt-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}

      {/* A. Overview */}
      <section className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        {[["Status", p?.status ?? "—"], ["QA", p?.qaState ?? "NOT_RUN"], ["Budget (approved)", fmtCents(p?.approvedBudgetCents)], ["Provider LLM", board?.provider.configured ? "configured" : "not configured"]].map(([k, v]) => (
          <div key={k as string} className="rounded-lg border border-[#1c1c1c] bg-[#0d0d0d] p-3"><div className="text-neutral-500">{k}</div><div className="mt-1 font-semibold text-neutral-100">{v as string}</div></div>
        ))}
      </section>

      {/* B. Stage timeline */}
      <section className="mt-4 rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
        <h2 className="text-sm font-semibold text-neutral-200">Stage timeline</h2>
        <div className="mt-2 space-y-1.5">
          {(board?.stages ?? []).map((s) => (
            <div key={s.key} className="flex flex-wrap items-center gap-2 rounded-lg border border-[#1c1c1c] bg-black/30 px-3 py-2">
              <span className={cn("w-44 shrink-0 rounded border px-2 py-0.5 text-[11px] uppercase", STATE_STYLES[s.state] ?? "text-neutral-400")}>{s.key}</span>
              <span className="text-xs text-neutral-400">{s.state === "SUCCEEDED" ? "complete" : s.state === "AWAITING_APPROVAL" ? "waiting for your decision" : s.state === "RUNNING" ? `job ${s.jobId ?? "starting"}` : s.state === "BLOCKED" || s.costs?.blocked ? s.costs?.reason ?? s.error : s.error ?? ""}</span>
              <div className="ml-auto flex flex-wrap gap-1">
                {["NOT_STARTED", "READY", "FAILED", "CANCELLED"].includes(s.state) && <button onClick={() => stageAction(s.key, "start")} disabled={busy} className="rounded border border-[#d4a017]/60 px-2 py-1 text-[11px] text-[#d4a017]">start</button>}
                {s.state === "AWAITING_APPROVAL" && <><button onClick={() => stageAction(s.key, "approve")} disabled={busy} className="rounded border border-emerald-500/60 px-2 py-1 text-[11px] text-emerald-400">approve</button><button onClick={() => stageAction(s.key, "reject")} disabled={busy} className="rounded border border-red-500/60 px-2 py-1 text-[11px] text-red-400">reject</button></>}
                {["FAILED", "RUNNING"].includes(s.state) && <button onClick={() => stageAction(s.key, s.state === "RUNNING" ? "cancel" : "retry")} disabled={busy} className="rounded border border-[#2a2a2a] px-2 py-1 text-[11px] text-neutral-300">{s.state === "RUNNING" ? "cancel" : "retry"}</button>}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* C. Concept selection */}
      {board?.concept?.options && (
        <section className="mt-4 rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
          <h2 className="text-sm font-semibold text-neutral-200">Concept direction</h2>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            {board.concept.options.map((o) => (
              <button key={o.id} onClick={() => selectConcept(o.id)} className={cn("rounded-lg border p-3 text-left text-xs", board.concept?.selectedId === o.id ? "border-[#d4a017] bg-[#d4a017]/10" : "border-[#2a2a2a]")}>
                <div className="font-semibold text-neutral-100">{o.title}</div>
                <div className="mt-1 text-neutral-400">{o.centralIdea}</div>
                <div className="mt-1 text-[10px] text-neutral-500">complexity {o.complexity}</div>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* D. Storyboard approvals */}
      {board?.storyboard?.scenes && (
        <section className="mt-4 rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
          <h2 className="text-sm font-semibold text-neutral-200">Storyboard ({board.storyboard.scenes.length} scenes)</h2>
          <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {board.storyboard.scenes.map((sc) => (
              <div key={sc.sceneKey} className="rounded-lg border border-[#2a2a2a] bg-black/30 p-3 text-xs">
                <div className="flex items-center justify-between"><span className="font-semibold text-neutral-100">Scene {sc.sceneNumber}</span><span className="text-neutral-500">{sc.durationSec}s</span></div>
                <div className="mt-1 h-16 rounded bg-black/60 text-center text-[10px] leading-[4rem] text-neutral-600">placeholder — pending real asset</div>
                <div className="mt-1 text-neutral-400">{sc.storyPurpose}</div>
                <div className="mt-2 flex items-center justify-between">
                  <span className={cn("rounded px-1.5 py-0.5 text-[10px]", sc.approval === "APPROVED" ? "bg-emerald-500/15 text-emerald-400" : sc.approval === "REJECTED" ? "bg-red-500/15 text-red-400" : "bg-neutral-800 text-neutral-400")}>{sc.approval}</span>
                  <div className="flex gap-1">
                    <button onClick={() => fetch(`/api/productions/${activeId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "scene-approval", sceneKey: sc.sceneKey, decision: "APPROVED" }) }).then(() => fetch(`/api/productions/${activeId}`).then((r) => r.json()).then(setBoard))} className="rounded border border-emerald-500/50 px-1.5 py-0.5 text-[10px] text-emerald-400">approve</button>
                    <button onClick={() => fetch(`/api/productions/${activeId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "scene-approval", sceneKey: sc.sceneKey, decision: "REJECTED" }) }).then(() => fetch(`/api/productions/${activeId}`).then((r) => r.json()).then(setBoard))} className="rounded border border-red-500/50 px-1.5 py-0.5 text-[10px] text-red-400">reject</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* E. Asset wall */}
      <section className="mt-4 rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
        <h2 className="text-sm font-semibold text-neutral-200">Asset wall</h2>
        <div className="mt-2 space-y-2">
          {(board?.assets ?? []).map((a) => (
            <div key={a.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-[#1c1c1c] bg-black/30 px-3 py-2 text-xs">
              <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase text-neutral-300">{a.category}</span>
              <span className="text-neutral-300">{a.description.slice(0, 60)}</span>
              <span className={cn("rounded px-1.5 py-0.5 text-[10px]", a.licenseState === "USER_CONFIRMED" ? "bg-emerald-500/15 text-emerald-400" : a.licenseState === "RESTRICTED" ? "bg-red-500/15 text-red-400" : "bg-orange-500/15 text-orange-300")}>{a.licenseState}</span>
              <span className="text-neutral-500">cost: {a.costUnknown ? "unknown" : fmtCents(a.costCents)}</span>
              <span className={cn("rounded px-1.5 py-0.5 text-[10px]", STATE_STYLES[a.status] ?? "text-neutral-400")}>{a.status}</span>
              <div className="ml-auto flex flex-wrap gap-1">
                {!a.mediaAssetId && (media ?? []).slice(0, 4).map((m) => (
                  <button key={m.id} onClick={() => attachMedia(a.id, m.id)} className="rounded border border-[#2a2a2a] px-1.5 py-0.5 text-[10px] text-neutral-300">attach {m.originalName.slice(0, 14)}</button>
                ))}
                {a.status === "READY" && <><button onClick={() => decideAsset(a.id, "APPROVED")} className="rounded border border-emerald-500/60 px-1.5 py-0.5 text-[10px] text-emerald-400">approve</button><button onClick={() => decideAsset(a.id, "REJECTED")} className="rounded border border-red-500/60 px-1.5 py-0.5 text-[10px] text-red-400">reject</button></>}
              </div>
            </div>
          ))}
          {(board?.assets ?? []).length === 0 && <div className="text-xs text-neutral-500">No assets planned yet.</div>}
        </div>
      </section>

      {/* F. Decisions rail (append-only) */}
      <section className="mt-4 rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
        <h2 className="text-sm font-semibold text-neutral-200">Decisions (append-only history)</h2>
        <div className="mt-2 max-h-40 space-y-1 overflow-y-auto text-xs">
          {(board?.decisions ?? []).map((d) => (
            <div key={d.id} className="text-neutral-400"><span className="text-neutral-500">{new Date(d.createdAt).toLocaleTimeString()}</span> <span className="text-[#d4a017]">{d.kind}</span> {JSON.stringify(d.value).slice(0, 120)}</div>
          ))}
          {(board?.decisions ?? []).length === 0 && <div className="text-neutral-500">No decisions recorded yet.</div>}
        </div>
      </section>

      {/* G. QA + Delivery */}
      {(board?.production.qa?.checks || board?.production.delivery) && (
        <section className="mt-4 rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
          <h2 className="text-sm font-semibold text-neutral-200">QA ({p?.qaState}) {board?.production.delivery?.artifacts?.length ? `· ${board.production.delivery.artifacts.length} delivered artifact(s)` : ""}</h2>
          <div className="mt-2 grid gap-1 text-xs sm:grid-cols-2">
            {(board?.production.qa?.checks ?? []).map((c) => (
              <div key={c.id} className="flex items-center gap-2"><span className={cn("rounded px-1.5 py-0.5 text-[10px]", c.state === "PASSED" ? "bg-emerald-500/15 text-emerald-400" : c.state === "FAILED" ? "bg-red-500/15 text-red-400" : "bg-neutral-800 text-neutral-400")}>{c.state}</span><span className="text-neutral-400">{c.id}: {c.detail}</span></div>
            ))}
          </div>
          {(board?.production.delivery?.artifacts ?? []).map((a) => (
            <div key={a.exportFileId} className="mt-2 text-xs text-neutral-400">Delivered: {a.exportFileId} · {a.sizeBytes} bytes · {a.durationSec}s</div>
          ))}
        </section>
      )}

      {/* H. Real production log */}
      <section className="mt-4 rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
        <h2 className="text-sm font-semibold text-neutral-200">Production log (real events)</h2>
        <div className="mt-2 max-h-48 space-y-1 overflow-y-auto font-mono text-[11px] text-neutral-400">
          {(board?.events ?? []).map((e) => (
            <div key={e.id}><span className="text-neutral-600">{new Date(e.createdAt).toLocaleTimeString()}</span> <span className="text-[#d4a017]">{e.kind}</span>{e.stageKey ? ` [${e.stageKey}]` : ""} {e.detail ? JSON.stringify(e.detail).slice(0, 100) : ""}</div>
          ))}
        </div>
      </section>
      <div className="mb-6 flex justify-end"><button onClick={() => openBoard(activeId!)} className="inline-flex items-center gap-1 rounded border border-[#2a2a2a] px-2 py-1 text-xs text-neutral-400"><RefreshCw className="h-3 w-3" /> refresh board</button></div>
    </div>
  );
}
