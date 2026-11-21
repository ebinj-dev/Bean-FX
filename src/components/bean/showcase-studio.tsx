"use client";

/**
 * M31 SHOWCASE STUDIO — product-to-promo-film tool. ORIGINAL BEAN FX UI on the
 * existing black/yellow design system. Nine-step flow: SELECT PRODUCT →
 * UNDERSTAND → CREATIVE CONCEPT → STORYBOARD → GENERATE → COMPOSE → REVIEW →
 * RENDER → DELIVER. All state comes from the persisted production APIs (the
 * same rows the PRODUCE board serves) — no fabricated progress, unknown costs
 * render as "unknown", illustrative demonstrations are labelled.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Plus, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SessionUser } from "@/lib/types";

interface StageView { key: string; state: string; order: number; jobId: string | null; error: string | null; output: Record<string, unknown> | null }
interface AssetRow { id: string; sceneKey: string | null; category: string; description: string; sourceType: string; provider: string | null; licenseState: string; status: string; costUnknown: boolean; costCents: number | null; mediaAssetId: string | null; error?: string | null }
interface SceneView { sceneKey: string; sceneNumber: number; durationSec: number; storyPurpose: string; textOverlay?: string; productElement?: string; transition?: string; compositionPrimitive?: string | null; demonstration?: { sourceMediaId: string; illustrative: boolean; maskNotes: string[] } | null; requiredAssetKind?: string; generationInstructions?: string; approval: string }
interface ProductArtifact { basis: string; identity: { name: string; tagline: string }; purpose: string; audience: string; problem: string; mainBenefit: string; capabilities: { name: string; evidence: string }[]; differentiators: string[]; workflow: string[]; brand: { colors: string[]; notes: string }; sources: { kind: string; ref: string; evidence: string }[]; unverifiedClaims: string[]; exclusions: string[]; approval: string }
interface ConceptOption { id: string; title: string; centralIdea: string; openingHook?: string; productReveal?: string; featureHighlights?: string[]; closingCta?: string; complexity: string; requiredCapabilities?: string[]; costNote?: string }
interface ShareCopyItem { platform: string; text: string; withinLimits: boolean }
interface Board {
  production: { id: string; title: string; templateId: string; status: string; projectId: string | null; qaState: string; qa: { checks?: { id: string; state: string; detail: string }[] } | null; delivery: { poster?: { sourceFrameSec?: number; sceneKey?: string | null; checks?: { id: string; state: string; detail: string }[] }; posterMediaAssetId?: string; shareCopy?: { items?: ShareCopyItem[] }; artifacts?: { exportFileId: string; sizeBytes: number; durationSec: number }[] } | null; approvedBudgetCents: number | null };
  stages: StageView[];
  assets: AssetRow[];
  events: { id: string; kind: string; stageKey: string | null; detail: Record<string, unknown> | null; createdAt: string }[];
  brief: { campaignType?: string; tonePreset?: string | null; targetDurationSec?: number; aspectRatio?: string; narrationPreference?: string; musicPreference?: string } | null;
  concept: { options?: ConceptOption[]; selectedId: string | null } | null;
  storyboard: { scenes: SceneView[] } | null;
  product: ProductArtifact | null;
  provider: { configured: boolean; reason: string };
}
interface MediaMeta { id: string; originalName: string; kind: string }

const STEP_STAGES: { step: string; stages: string[] }[] = [
  { step: "SELECT PRODUCT", stages: ["INTAKE"] },
  { step: "UNDERSTAND", stages: ["PRODUCT_UNDERSTANDING"] },
  { step: "CREATIVE CONCEPT", stages: ["BRIEF", "CONCEPT"] },
  { step: "STORYBOARD", stages: ["SCRIPT", "STORYBOARD"] },
  { step: "GENERATE", stages: ["ASSET_PLANNING", "ASSET_GENERATION"] },
  { step: "COMPOSE", stages: ["EDIT_PLANNING", "TIMELINE_ASSEMBLY", "ROUGH_CUT"] },
  { step: "REVIEW", stages: ["REVIEW"] },
  { step: "RENDER", stages: ["FINAL_RENDER"] },
  { step: "DELIVER", stages: ["QUALITY_ASSURANCE", "DELIVERY"] },
];

const STATE_STYLES: Record<string, string> = {
  SUCCEEDED: "text-emerald-400 border-emerald-500/40", RUNNING: "text-[#d4a017] border-[#d4a017]/40",
  AWAITING_APPROVAL: "text-sky-400 border-sky-500/40", FAILED: "text-red-400 border-red-500/40",
  BLOCKED: "text-orange-400 border-orange-500/40", READY: "text-neutral-300 border-neutral-600",
  NOT_STARTED: "text-neutral-500 border-neutral-800", SKIPPED: "text-neutral-500 border-neutral-700",
  CANCELLED: "text-neutral-400 border-neutral-700",
};

const CAMPAIGNS = [
  ["product-launch", "PRODUCT LAUNCH"], ["app-showcase", "APP SHOWCASE"], ["website-promo", "WEBSITE PROMO"],
  ["startup-intro", "STARTUP INTRO"], ["brand-commercial", "BRAND COMMERCIAL"], ["feature-demonstration", "FEATURE DEMONSTRATION"],
  ["social-promo", "SOCIAL MEDIA PROMO"], ["cinematic-trailer", "CINEMATIC TRAILER"],
] as const;
const TONES = ["premium", "cinematic", "minimal", "futuristic", "bold", "playful", "documentary", "luxury", "tech-commercial"] as const;
const PRIMITIVES = ["cinematic-title", "hero-product-reveal", "feature-spotlight", "ui-demonstration", "floating-product-frame", "split-screen-comparison", "product-showcase", "stat-reveal", "end-card", "logo-reveal", "cta-scene"] as const;

export function ShowcaseStudio({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  const [view, setView] = useState<"intake" | "board">("intake");
  const [media, setMedia] = useState<MediaMeta[] | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // ── M32: provider readiness / variants / masks ──
  interface ProviderReadiness { providerId: string; status: string; detail: string; cost: { state: string } }
  interface CapReport { operations: string[]; durationsSec?: string[]; sizes?: string[]; unsupported: string[]; pricing: { state: string }; cancellation?: string }
  interface ProviderBundle { video: { readiness: ProviderReadiness; capabilities: CapReport }; image: { readiness: ProviderReadiness; capabilities: CapReport } }
  interface VariantRow { id: string; format: string; status: string; resolution: string; fps: number; durationSec: number; projectId: string | null; framing: { default?: { strategy: string; cropLossPct: number }; manual?: Record<string, unknown> } | null; safeArea: { marginPct: number; note: string; issues: { sceneKey: string; kind: string; detail: string }[] } | null; renderJobId: string | null; exportId: string | null; error: string | null }
  interface MaskRow { id: string; sourceAssetId: string; width: number; height: number; method: string; version: number; validationStatus: string; notes: string | null }
  const [providers, setProviders] = useState<ProviderBundle | null>(null);
  const [variants, setVariants] = useState<VariantRow[] | null>(null);
  const [masterAspect, setMasterAspect] = useState<string>("16:9");
  const [masks, setMasks] = useState<MaskRow[] | null>(null);
  const [autoSeg, setAutoSeg] = useState<{ status: string; detail: string } | null>(null);

  const loadProviders = useCallback(async () => { const r = await fetch("/api/providers/readiness"); if (r.ok) setProviders(await r.json()); }, []);
  const loadVariants = useCallback(async () => {
    if (!activeId) return;
    const r = await fetch(`/api/productions/${activeId}/variants`);
    if (r.ok) { const j = await r.json(); setVariants(j.variants ?? []); setMasterAspect(j.master?.aspectRatio ?? "16:9"); }
  }, [activeId]);
  const loadMasks = useCallback(async () => {
    const r = await fetch("/api/masks");
    if (r.ok) { const j = await r.json(); setMasks(j.masks ?? []); setAutoSeg(j.autoSegmentation ?? null); }
  }, []);
  useEffect(() => { void loadProviders(); }, [loadProviders]);
  useEffect(() => { if (view === "board" && activeId) { void loadVariants(); void loadMasks(); } }, [view, activeId, loadVariants, loadMasks]);

  const variantAction = async (body: Record<string, unknown>) => {
    setBusy(true);
    try { const r = await fetch(`/api/productions/${activeId}/variants`, { method: body.__patch ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); await flash(r); await loadVariants(); }
    finally { setBusy(false); }
  };
  const maskAction = async (body: Record<string, unknown>) => {
    setBusy(true);
    try { const r = await fetch("/api/masks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); await flash(r); await loadMasks(); }
    finally { setBusy(false); }
  };
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // intake inputs
  const [productName, setProductName] = useState("");
  const [description, setDescription] = useState("");
  const [featureList, setFeatureList] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [screenshots, setScreenshots] = useState<string[]>([]);
  const [demoVideos, setDemoVideos] = useState<string[]>([]);
  const [projectId, setProjectId] = useState("");
  const [campaignType, setCampaignType] = useState<string>("product-launch");
  const [tonePreset, setTonePreset] = useState<string>("cinematic");
  const [duration, setDuration] = useState("30");
  const [aspect, setAspect] = useState("16:9");
  const [narration, setNarration] = useState("none");
  const [music, setMusic] = useState("user-provided");
  const [budget, setBudget] = useState("");

  const [productions, setProductions] = useState<{ id: string; title: string; status: string; qaState: string }[] | null>(null);
  const reload = useCallback(async () => {
    try {
      const r = await fetch("/api/media"); const j = await r.json(); setMedia(j.media ?? []);
    } catch { setMedia([]); }
    try {
      const r = await fetch("/api/productions"); const j = await r.json();
      setProductions((j.productions ?? []).filter((p: { templateId?: string }) => !p.templateId || p.templateId === "showcase-studio"));
    } catch { setProductions([]); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const openBoard = useCallback(async (id: string) => {
    setActiveId(id); setView("board");
    const load = async () => { const r = await fetch(`/api/productions/${id}`); if (r.ok) setBoard(await r.json()); };
    await load();
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(load, 5000);
  }, []);

  const refreshBoard = async () => { if (!activeId) return; const r = await fetch(`/api/productions/${activeId}`); if (r.ok) setBoard(await r.json()); };

  const flash = async (r: Response, okMsg?: string) => {
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setError(j.error ?? `Request failed (${r.status})`); return null; }
    setError(null);
    if (okMsg) setNote(okMsg);
    await refreshBoard();
    return j;
  };

  const createProduction = async () => {
    setBusy(true); setError(null);
    try {
      const r = await fetch("/api/productions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        templateId: "showcase-studio", briefText: description || `${productName} showcase`,
        title: productName || undefined, projectId: projectId || undefined,
        campaignType, tonePreset, targetDurationSec: Number(duration) || 30, aspectRatio: aspect,
        narrationPreference: narration, musicPreference: music,
        showcaseInputs: { productName, description, featureList, websiteUrl, screenshotMediaIds: screenshots, demoVideoMediaIds: demoVideos, projectId: projectId || null },
        sourceMediaIds: [...screenshots, ...demoVideos],
      }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Failed to create production");
      if (budget) await fetch(`/api/productions/${j.production.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "budget", approvedBudgetCents: Math.round(Number(budget) * 100) }) });
      await reload();
      await openBoard(j.production.id);
    } catch (e) { setError(String(e).replace("Error: ", "")); } finally { setBusy(false); }
  };

  const stageAction = async (key: string, action: string) => {
    setBusy(true);
    try { const r = await fetch(`/api/productions/${activeId}/stages/${key}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) }); await flash(r); }
    finally { setBusy(false); }
  };

  const boardPut = async (body: Record<string, unknown>) => {
    setBusy(true);
    try { const r = await fetch(`/api/productions/${activeId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); await flash(r); }
    finally { setBusy(false); }
  };

  const assetAction = async (body: Record<string, unknown>) => {
    setBusy(true);
    try { const r = await fetch(`/api/productions/${activeId}/assets`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); await flash(r); }
    finally { setBusy(false); }
  };

  const stageState = (key: string) => board?.stages.find((s) => s.key === key)?.state ?? "NOT_STARTED";
  const stepState = (stages: string[]) => {
    const states = stages.map(stageState);
    if (states.every((s) => s === "SUCCEEDED" || s === "SKIPPED")) return "SUCCEEDED";
    if (states.includes("AWAITING_APPROVAL")) return "AWAITING_APPROVAL";
    if (states.includes("RUNNING")) return "RUNNING";
    if (states.includes("FAILED")) return "FAILED";
    if (states.includes("BLOCKED")) return "BLOCKED";
    return "NOT_STARTED";
  };
  const currentStep = board ? STEP_STAGES.findIndex((s) => ["READY", "RUNNING", "AWAITING_APPROVAL", "FAILED", "BLOCKED"].includes(stepState(s.stages))) : -1;

  const fmtCents = (c: number | null | undefined) => (c === null || c === undefined ? "unknown" : `$${(c / 100).toFixed(2)}`);
  const med = (kind: string) => (media ?? []).filter((m) => m.kind === kind);
  const toggle = (list: string[], setList: (v: string[]) => void, id: string) => setList(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  // ── Intake view (SELECT PRODUCT) ──
  if (view === "intake") {
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-6 text-neutral-200">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-bold tracking-wide text-[#d4a017]">SHOWCASE STUDIO</h1>
          <div className="text-xs text-neutral-500">{user.email} · <button className="underline" onClick={onLogout}>logout</button></div>
        </div>
        <p className="mt-2 max-w-3xl text-sm text-neutral-400">Turn a product, website, app or BEAN FX project into a promotional film. You approve every step; the result is a real editable BEAN FX sequence plus poster and share copy. Private data is redacted from analysis; illustrative interactions are labelled.</p>
        {error && <div className="mt-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}
        <section className="mt-4 rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
          <h2 className="text-sm font-semibold text-neutral-200">1 · Select product & inputs</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-neutral-400">Product name
              <input value={productName} onChange={(e) => setProductName(e.target.value)} placeholder="e.g. Bean FX" className="mt-1 w-full rounded-lg border border-[#2a2a2a] bg-black/40 p-2 text-sm" /></label>
            <label className="text-xs text-neutral-400">Authorized public website URL (optional)
              <input value={websiteUrl} onChange={(e) => setWebsiteUrl(e.target.value)} placeholder="https://example.com" className="mt-1 w-full rounded-lg border border-[#2a2a2a] bg-black/40 p-2 text-sm" /></label>
            <label className="text-xs text-neutral-400 sm:col-span-2">Product description
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="What it is, who it is for, the problem it solves." className="mt-1 w-full rounded-lg border border-[#2a2a2a] bg-black/40 p-2 text-sm" /></label>
            <label className="text-xs text-neutral-400 sm:col-span-2">Feature list (one per line — the only source of capability claims)
              <textarea value={featureList} onChange={(e) => setFeatureList(e.target.value)} rows={3} placeholder={"Timeline editing\nAI captions\n4K export"} className="mt-1 w-full rounded-lg border border-[#2a2a2a] bg-black/40 p-2 text-sm" /></label>
          </div>
          <h3 className="mt-4 text-xs font-semibold text-neutral-300">Screenshots (IMAGE media — evidence for visual identity)</h3>
          <div className="mt-1 flex max-h-24 flex-wrap gap-2 overflow-y-auto">
            {med("IMAGE").map((m) => (
              <button key={m.id} onClick={() => toggle(screenshots, setScreenshots, m.id)} className={cn("rounded-md border px-2 py-1 text-xs", screenshots.includes(m.id) ? "border-[#d4a017] text-[#d4a017]" : "border-[#2a2a2a] text-neutral-400")}>{m.originalName.slice(0, 24)}</button>
            ))}
            {med("IMAGE").length === 0 && <span className="text-xs text-neutral-500">No images in your library — upload screenshots in STUDIO first.</span>}
          </div>
          <h3 className="mt-3 text-xs font-semibold text-neutral-300">Demo recordings (VIDEO media — real product usage)</h3>
          <div className="mt-1 flex max-h-24 flex-wrap gap-2 overflow-y-auto">
            {med("VIDEO").map((m) => (
              <button key={m.id} onClick={() => toggle(demoVideos, setDemoVideos, m.id)} className={cn("rounded-md border px-2 py-1 text-xs", demoVideos.includes(m.id) ? "border-[#d4a017] text-[#d4a017]" : "border-[#2a2a2a] text-neutral-400")}>{m.originalName.slice(0, 24)}</button>
            ))}
            {med("VIDEO").length === 0 && <span className="text-xs text-neutral-500">No videos in your library yet.</span>}
          </div>
          <h3 className="mt-4 text-xs font-semibold text-neutral-300">2 · Creative direction</h3>
          <div className="mt-2 grid gap-3 sm:grid-cols-3">
            <label className="text-xs text-neutral-400">Campaign type
              <select value={campaignType} onChange={(e) => setCampaignType(e.target.value)} className="mt-1 w-full rounded-lg border border-[#2a2a2a] bg-black/40 p-2 text-sm">{CAMPAIGNS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
            <label className="text-xs text-neutral-400">Tone
              <select value={tonePreset} onChange={(e) => setTonePreset(e.target.value)} className="mt-1 w-full rounded-lg border border-[#2a2a2a] bg-black/40 p-2 text-sm">{TONES.map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
            <label className="text-xs text-neutral-400">Aspect / duration
              <div className="mt-1 flex gap-2"><select value={aspect} onChange={(e) => setAspect(e.target.value)} className="w-full rounded-lg border border-[#2a2a2a] bg-black/40 p-2 text-sm">{["16:9", "9:16", "1:1", "4:5"].map((a) => <option key={a}>{a}</option>)}</select>
              <input value={duration} onChange={(e) => setDuration(e.target.value)} inputMode="numeric" className="w-20 rounded-lg border border-[#2a2a2a] bg-black/40 p-2 text-sm" title="seconds" /></div></label>
            <label className="text-xs text-neutral-400">Narration
              <select value={narration} onChange={(e) => setNarration(e.target.value)} className="mt-1 w-full rounded-lg border border-[#2a2a2a] bg-black/40 p-2 text-sm"><option value="none">off (default)</option><option value="generated-when-configured">generated (TTS, when configured)</option></select></label>
            <label className="text-xs text-neutral-400">Music
              <select value={music} onChange={(e) => setMusic(e.target.value)} className="mt-1 w-full rounded-lg border border-[#2a2a2a] bg-black/40 p-2 text-sm"><option value="user-provided">user-supplied track</option><option value="none">silence (explicit)</option></select></label>
            <label className="text-xs text-neutral-400">Approved budget $ (required before ANY paid generation)
              <input value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" placeholder="e.g. 5.00" className="mt-1 w-full rounded-lg border border-[#2a2a2a] bg-black/40 p-2 text-sm" /></label>
          </div>
          <button onClick={createProduction} disabled={busy || (!description.trim() && !featureList.trim() && !websiteUrl.trim() && screenshots.length === 0 && demoVideos.length === 0)} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-[#d4a017] px-4 py-2 text-sm font-semibold text-black disabled:opacity-40">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Start showcase production
          </button>
        </section>
        <section className="mt-6">
          <h2 className="text-sm font-semibold text-neutral-200">Your showcase productions</h2>
          <div className="mt-2 space-y-2">
            {(productions ?? []).map((p) => (
              <button key={p.id} onClick={() => void openBoard(p.id)} className="flex w-full flex-wrap items-center gap-2 rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] p-3 text-left text-sm hover:border-[#d4a017]/60">
                <span className="font-semibold text-neutral-100">{p.title}</span>
                <span className={cn("rounded border px-1.5 py-0.5 text-[10px]", p.status === "COMPLETED" ? STATE_STYLES.SUCCEEDED : p.status === "FAILED" ? STATE_STYLES.FAILED : STATE_STYLES.AWAITING_APPROVAL)}>{p.status}</span>
                <span className="text-xs text-neutral-500">QA {p.qaState}</span>
                <span className="ml-auto text-xs text-[#d4a017]">open board →</span>
              </button>
            ))}
            {productions && productions.length === 0 && <p className="text-xs text-neutral-500">No showcase productions yet.</p>}
          </div>
        </section>
      </div>
    );
  }

  // ── Board view (9-step flow) ──
  const product = board?.product ?? null;
  const scenes = board?.storyboard?.scenes ?? [];
  const assets = board?.assets ?? [];
  const copyItems = board?.production.delivery?.shareCopy?.items ?? [];
  const poster = board?.production.delivery?.poster ?? null;

  return (
    <div className="mx-auto w-full max-w-6xl px-3 py-6 text-neutral-200 sm:px-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-bold tracking-wide text-[#d4a017] sm:text-xl">SHOWCASE STUDIO — {board?.production.title}</h1>
        <div className="flex items-center gap-3 text-xs text-neutral-500">
          <button onClick={() => { setView("intake"); setBoard(null); }} className="underline">new showcase</button>
          <span>{user.email}</span>
        </div>
      </div>
      {/* step rail */}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {STEP_STAGES.map((s, i) => {
          const st = stepState(s.stages);
          return (
            <div key={s.step} className={cn("rounded-md border px-2 py-1 text-[10px] font-semibold sm:text-xs", STATE_STYLES[st] ?? STATE_STYLES.NOT_STARTED)}>
              {i + 1}. {s.step}{st === "AWAITING_APPROVAL" ? " ⏸" : st === "RUNNING" ? " …" : st === "SUCCEEDED" ? " ✓" : st === "FAILED" ? " ✗" : st === "BLOCKED" ? " ⛔" : ""}
            </div>
          );
        })}
      </div>
      {error && <div className="mt-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>}
      {note && <div className="mt-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">{note}</div>}

      {/* UNDERSTAND */}
      <Panel title="2 · Understand the product" state={stageState("PRODUCT_UNDERSTANDING")} onRun={() => stageAction("PRODUCT_UNDERSTANDING", "start")}>
        {product ? (
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="text-sm">
              <div className="font-semibold text-neutral-100">{product.identity.name}{product.identity.tagline ? ` — ${product.identity.tagline}` : ""}</div>
              <div className="mt-1 text-xs text-neutral-400">basis: {product.basis} · approval: <span className={product.approval === "APPROVED" ? "text-emerald-400" : "text-sky-400"}>{product.approval}</span></div>
              {product.purpose && <p className="mt-2 text-xs text-neutral-300">{product.purpose.slice(0, 400)}</p>}
              {product.mainBenefit && <p className="mt-1 text-xs text-neutral-300"><span className="text-neutral-500">main benefit:</span> {product.mainBenefit}</p>}
              <div className="mt-2 flex flex-wrap gap-1">{product.brand.colors.map((c) => <span key={c} className="inline-flex items-center gap-1 rounded border border-neutral-700 px-1.5 py-0.5 text-[10px]"><span className="h-2.5 w-2.5 rounded-sm border border-neutral-600" style={{ background: c }} />{c}</span>)}</div>
              {product.unverifiedClaims.length > 0 && <div className="mt-2 rounded border border-orange-500/40 bg-orange-500/10 p-2 text-[11px] text-orange-300">Unverified claims (excluded from copy): {product.unverifiedClaims.slice(0, 3).join(" · ")}</div>}
              {product.exclusions.length > 0 && <div className="mt-1 rounded border border-neutral-700 bg-black/30 p-2 text-[11px] text-neutral-400">Redactions: {product.exclusions.slice(0, 3).join(" · ")}</div>}
            </div>
            <div>
              <div className="text-xs font-semibold text-neutral-300">Capabilities (evidence-traced)</div>
              <ul className="mt-1 space-y-1">{product.capabilities.map((c, i) => <li key={i} className="rounded border border-[#2a2a2a] bg-black/20 p-2 text-[11px]"><span className="text-neutral-200">{c.name}</span><span className="mt-0.5 block text-neutral-500">evidence: {c.evidence.slice(0, 120)}</span></li>)}</ul>
              <div className="mt-2 flex gap-2">
                <button disabled={busy || product.approval === "APPROVED"} onClick={() => boardPut({ kind: "product-approval", decision: "APPROVED" })} className="rounded bg-[#d4a017] px-3 py-1.5 text-xs font-semibold text-black disabled:opacity-40">Approve artifact</button>
                <button disabled={busy} onClick={() => boardPut({ kind: "product-approval", decision: "REJECTED" })} className="rounded border border-neutral-600 px-3 py-1.5 text-xs text-neutral-300">Reject</button>
              </div>
            </div>
          </div>
        ) : <Empty text="Run UNDERSTANDING to analyze the product from your inputs." />}
      </Panel>

      {/* CREATIVE CONCEPT */}
      <Panel title="3 · Creative concept" state={stageState("CONCEPT")} onRun={() => stageAction("CONCEPT", "start")}>
        {(board?.concept?.options ?? []).length > 0 ? (
          <div className="grid gap-2 md:grid-cols-3">
            {(board?.concept?.options ?? []).map((o) => (
              <button key={o.id} onClick={() => boardPut({ kind: "concept", selectedId: o.id })} className={cn("rounded-lg border p-3 text-left text-xs", board?.concept?.selectedId === o.id ? "border-[#d4a017] bg-[#d4a017]/10" : "border-[#2a2a2a] bg-black/20")}>
                <div className="font-semibold text-neutral-100">{o.title}</div>
                <div className="mt-1 text-neutral-400">{o.centralIdea.slice(0, 160)}</div>
                {(o.featureHighlights ?? []).length > 0 && <div className="mt-1 text-neutral-500">features: {(o.featureHighlights ?? []).slice(0, 3).join(" · ")}</div>}
                <div className="mt-2 flex items-center justify-between text-[10px] text-neutral-500"><span>complexity {o.complexity}</span><span>{board?.concept?.selectedId === o.id ? "SELECTED" : "select"}</span></div>
              </button>
            ))}
          </div>
        ) : <Empty text="Approve the product artifact first — then run CONCEPT for three distinct campaign directions." />}
      </Panel>

      {/* STORYBOARD */}
      <Panel title="4 · Storyboard" state={stageState("STORYBOARD")} onRun={() => stageAction("STORYBOARD", "start")}>
        {scenes.length > 0 ? (
          <div className="space-y-2">
            {scenes.map((sc, i) => (
              <div key={sc.sceneKey} className="rounded-lg border border-[#2a2a2a] bg-black/20 p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-semibold text-[#d4a017]">#{sc.sceneNumber}</span>
                  <span className="text-neutral-300">{sc.storyPurpose.slice(0, 70) || "beat"}</span>
                  <span className="text-neutral-500">{sc.durationSec}s · {sc.transition ?? "cut"} · {sc.compositionPrimitive ?? "no primitive"}</span>
                  <span className={cn("ml-auto rounded border px-1.5 py-0.5 text-[10px]", sc.approval === "APPROVED" ? STATE_STYLES.SUCCEEDED : sc.approval === "REJECTED" ? STATE_STYLES.FAILED : STATE_STYLES.AWAITING_APPROVAL)}>{sc.approval}</span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                  <input defaultValue={sc.textOverlay ?? ""} onBlur={(e) => boardPut({ kind: "scene-edit", sceneKey: sc.sceneKey, patch: { textOverlay: e.target.value.slice(0, 120) }, reApprove: sc.approval === "APPROVED" })} placeholder="on-screen text" className="w-44 rounded border border-[#2a2a2a] bg-black/40 p-1.5" />
                  <select defaultValue={sc.compositionPrimitive ?? ""} onChange={(e) => boardPut({ kind: "scene-edit", sceneKey: sc.sceneKey, patch: { compositionPrimitive: e.target.value || null }, reApprove: sc.approval === "APPROVED" })} className="rounded border border-[#2a2a2a] bg-black/40 p-1.5">
                    <option value="">no primitive</option>{PRIMITIVES.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                  <button onClick={() => boardPut({ kind: "scene-approval", sceneKey: sc.sceneKey, decision: "APPROVED" })} className="rounded border border-emerald-600/50 px-2 py-1 text-emerald-400">approve</button>
                  <button onClick={() => boardPut({ kind: "scene-approval", sceneKey: sc.sceneKey, decision: "REJECTED" })} className="rounded border border-red-600/50 px-2 py-1 text-red-400">reject</button>
                  <button onClick={() => i > 0 && boardPut({ kind: "scene-reorder", sceneKey: sc.sceneKey, toIndex: i - 1 })} className="rounded border border-neutral-600 px-2 py-1 text-neutral-300">↑</button>
                  <button onClick={() => i < scenes.length - 1 && boardPut({ kind: "scene-reorder", sceneKey: sc.sceneKey, toIndex: i + 1 })} className="rounded border border-neutral-600 px-2 py-1 text-neutral-300">↓</button>
                  <button onClick={() => boardPut({ kind: "scene-duplicate", sceneKey: sc.sceneKey })} className="rounded border border-neutral-600 px-2 py-1 text-neutral-300">dup</button>
                  <button onClick={() => boardPut({ kind: "scene-remove", sceneKey: sc.sceneKey })} className="rounded border border-neutral-600 px-2 py-1 text-neutral-300">del</button>
                  <button onClick={() => boardPut({ kind: "scene-regenerate", sceneKey: sc.sceneKey })} className="rounded border border-neutral-600 px-2 py-1 text-neutral-300">regen</button>
                </div>
                {sc.demonstration && <div className="mt-1.5 text-[10px] text-neutral-500">demonstration: {sc.demonstration.sourceMediaId.slice(0, 12)} · {sc.demonstration.illustrative ? "ILLUSTRATIVE (labelled)" : "real capture"}{sc.demonstration.maskNotes.length > 0 ? ` · ${sc.demonstration.maskNotes.length} mask requirement(s)` : ""}</div>}
              </div>
            ))}
            <div className="text-[11px] text-neutral-500">Approved scenes are never silently changed — editing one requires re-approval (logged).</div>
          </div>
        ) : <Empty text="Approve the script (STORYBOARD stage will draft scenes from it)." />}
      </Panel>

      {/* GENERATE */}
      <Panel title="5 · Generate assets" state={stageState("ASSET_GENERATION")} onRun={() => stageAction("ASSET_GENERATION", "start")}>
        {assets.length > 0 ? (
          <div className="space-y-2">
            {assets.map((a) => (
              <div key={a.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-[#2a2a2a] bg-black/20 p-2 text-xs">
                <span className="text-neutral-300">{a.sceneKey ?? "—"}</span>
                <span className="rounded border border-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-400">{a.category}</span>
                <span className="text-neutral-500">{a.sourceType}{a.provider ? ` · ${a.provider}` : ""}</span>
                <span className={cn("rounded border px-1.5 py-0.5 text-[10px]", a.status === "READY" || a.status === "APPROVED" ? STATE_STYLES.SUCCEEDED : a.status === "FAILED" || a.status === "BLOCKED" ? STATE_STYLES.FAILED : STATE_STYLES.AWAITING_APPROVAL)}>{a.status}</span>
                <span className="text-neutral-500">cost {fmtCents(a.costCents)}{a.costUnknown && a.costCents === null ? " (unknown)" : ""}</span>
                {a.status === "PENDING" && a.sourceType === "USER_MEDIA" && (
                  <select onChange={(e) => e.target.value && assetAction({ action: "attach", assetRowId: a.id, mediaAssetId: e.target.value })} defaultValue="" className="rounded border border-[#2a2a2a] bg-black/40 p-1 text-[11px]">
                    <option value="">attach media…</option>{(media ?? []).map((m) => <option key={m.id} value={m.id}>{m.originalName.slice(0, 22)}</option>)}
                  </select>
                )}
                {a.status === "PLANNED" && a.sourceType === "GENERATION" && (
                  <button onClick={() => assetAction({ action: "route-generation", assetRowId: a.id, kind: a.category === "video" ? "generated_video" : "generated_image", prompt: a.description, approved: false })} className="rounded border border-[#d4a017]/60 px-2 py-1 text-[#d4a017]">route to provider…</button>
                )}
                {a.status === "READY" && (
                  <>
                    <button onClick={() => assetAction({ action: "decide", assetRowId: a.id, decision: "APPROVED" })} className="rounded border border-emerald-600/50 px-2 py-1 text-emerald-400">approve</button>
                    <button onClick={() => assetAction({ action: "decide", assetRowId: a.id, decision: "REJECTED" })} className="rounded border border-red-600/50 px-2 py-1 text-red-400">reject</button>
                  </>
                )}
                {a.status === "GENERATING" && <span className="text-neutral-500">job in flight…</span>}
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <button onClick={() => assetAction({ action: "sync-generation" })} className="inline-flex items-center gap-1 rounded border border-neutral-600 px-2 py-1 text-xs text-neutral-300"><RefreshCw className="h-3 w-3" /> sync generation jobs</button>
              {board?.brief?.narrationPreference === "generated-when-configured" && scenes.slice(0, 6).map((sc) => (
                <button key={sc.sceneKey} onClick={() => assetAction({ action: "generate-narration", sceneKey: sc.sceneKey })} className="rounded border border-neutral-600 px-2 py-1 text-xs text-neutral-300">narrate #{sc.sceneNumber}</button>
              ))}
            </div>
          </div>
        ) : <Empty text="Run ASSET PLANNING to draft the asset & demonstration plan." />}
      </Panel>

      {/* COMPOSE */}
      <Panel title="6 · Compose (native timeline)" state={stageState("TIMELINE_ASSEMBLY")} onRun={() => stageAction("TIMELINE_ASSEMBLY", "start")}>
        <p className="text-xs text-neutral-400">Assembly applies canonical commands only: real media clips + composition primitives (keyframes/effects/NIKKI graphics) land on the existing timeline — fully editable, undo/redo safe.</p>
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          <StageButton label="compose" state={stageState("TIMELINE_ASSEMBLY")} onClick={() => stageAction("TIMELINE_ASSEMBLY", "start")} />
          <StageButton label="verify rough cut" state={stageState("ROUGH_CUT")} onClick={() => stageAction("ROUGH_CUT", "start")} />
          {board?.production.projectId && <a href={`#/editor?project=${board.production.projectId}`} className="rounded border border-[#d4a017]/60 px-3 py-1.5 text-[#d4a017]">open in editor</a>}
        </div>
      </Panel>

      {/* REVIEW */}
      <Panel title="7 · Review (M30)" state={stageState("REVIEW")} onRun={() => stageAction("REVIEW", "start")}>
        <StageButton label="create client review" state={stageState("REVIEW")} onClick={() => stageAction("REVIEW", "start")} />
      </Panel>

      {/* RENDER */}
      <Panel title="8 · Render" state={stageState("FINAL_RENDER")} onRun={() => stageAction("FINAL_RENDER", "start")}>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <StageButton label="submit render" state={stageState("FINAL_RENDER")} onClick={() => stageAction("FINAL_RENDER", "start")} />
          {stageState("FINAL_RENDER") === "RUNNING" && <span className="text-neutral-400">render job {board?.stages.find((s) => s.key === "FINAL_RENDER")?.jobId} in flight — the board polls every 5s.</span>}
        </div>
      </Panel>

      {/* DELIVER */}
      <Panel title="9 · Deliver (QA · poster · share copy)" state={stageState("DELIVERY")} onRun={() => stageAction("DELIVERY", "start")}>
        <div className="grid gap-3 lg:grid-cols-2">
          <div>
            <div className="text-xs font-semibold text-neutral-300">QA ({board?.production.qaState})</div>
            <ul className="mt-1 space-y-1">{(board?.production.qa?.checks ?? []).map((c, i) => <li key={i} className="flex gap-2 text-[11px]"><span className={c.state === "PASSED" ? "text-emerald-400" : c.state === "FAILED" ? "text-red-400" : "text-neutral-500"}>{c.state}</span><span className="text-neutral-400">{c.id}: {c.detail}</span></li>)}</ul>
            <div className="mt-2 text-xs font-semibold text-neutral-300">Artifacts</div>
            <ul className="mt-1 space-y-1">{(board?.production.delivery?.artifacts ?? []).map((a, i) => <li key={i} className="text-[11px] text-neutral-400">export {a.exportFileId.slice(0, 10)}… · {(a.sizeBytes / 1024 / 1024).toFixed(1)} MB · {a.durationSec?.toFixed?.(1) ?? "?"}s</li>)}</ul>
            {poster && (
              <div className="mt-2 rounded border border-[#2a2a2a] bg-black/20 p-2 text-[11px]">
                <div className="font-semibold text-neutral-300">Poster {poster.sceneKey ? `(${poster.sceneKey} @ ${poster.sourceFrameSec?.toFixed?.(2)}s)` : ""}</div>
                <ul className="mt-1 space-y-0.5">{(poster.checks ?? []).map((c, i) => <li key={i} className={c.state === "PASSED" ? "text-emerald-400" : c.state === "FAILED" ? "text-red-400" : "text-neutral-500"}>{c.id}: {c.detail}</li>)}</ul>
                {board?.production.delivery?.posterMediaAssetId && <div className="mt-1 text-neutral-500">poster asset: {board.production.delivery.posterMediaAssetId}</div>}
              </div>
            )}
          </div>
          <div>
            <div className="text-xs font-semibold text-neutral-300">Share copy</div>
            <div className="mt-1 space-y-2">{copyItems.map((c, i) => (
              <div key={i} className="rounded border border-[#2a2a2a] bg-black/20 p-2">
                <div className="flex items-center justify-between text-[10px] text-neutral-500"><span className="font-semibold text-neutral-300">{c.platform.toUpperCase()}</span><span className={c.withinLimits ? "text-emerald-400" : "text-orange-400"}>{c.withinLimits ? "fits" : "TRIMMED"}</span></div>
                <p className="mt-1 whitespace-pre-wrap text-[11px] text-neutral-300">{c.text}</p>
              </div>
            ))}</div>
            <div className="mt-2"><StageButton label="finalize delivery" state={stageState("DELIVERY")} onClick={() => stageAction("DELIVERY", "start")} /></div>
          </div>
        </div>
      </Panel>

      {/* M32: provider readiness */}
      <Panel title="AI providers (honest readiness)" state={providers?.video.readiness.status === "READY" ? "SUCCEEDED" : "BLOCKED"}>
        {providers ? (
          <div className="grid gap-2 md:grid-cols-2">
            {(["video", "image"] as const).map((k) => {
              const b = providers[k];
              return (
                <div key={k} className="rounded-lg border border-[#2a2a2a] bg-black/20 p-2 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-neutral-200">{b.readiness.providerId} ({k})</span>
                    <span className={cn("rounded border px-1.5 py-0.5 text-[10px]", b.readiness.status === "READY" ? STATE_STYLES.SUCCEEDED : b.readiness.status === "CONFIGURATION_REQUIRED" ? "text-orange-400 border-orange-500/40" : STATE_STYLES.FAILED)}>{b.readiness.status}</span>
                  </div>
                  <p className="mt-1 text-[11px] text-neutral-400">{b.readiness.detail}</p>
                  <p className="mt-1 text-[11px] text-neutral-500">ops: {b.capabilities.operations.join(", ")}{b.capabilities.durationsSec ? ` · durations ${b.capabilities.durationsSec.join("/")}` : ""}{b.capabilities.sizes ? ` · ${b.capabilities.sizes.length} sizes` : ""} · cost {b.capabilities.pricing.state}</p>
                  {b.capabilities.unsupported.length > 0 && <p className="mt-1 text-[10px] text-orange-400">unsupported: {b.capabilities.unsupported[0]}…</p>}
                </div>
              );
            })}
          </div>
        ) : <Empty text="Probing providers…" />}
      </Panel>

      {/* M32: campaign variants */}
      <Panel title={`Campaign variants (master ${masterAspect} — immutable)`} state={variants && variants.length > 0 ? (variants.every((v) => v.status === "COMPLETED") ? "SUCCEEDED" : "RUNNING") : "NOT_STARTED"}>
        <div className="flex flex-wrap gap-2 text-xs">
          {["1:1", "9:16", "16:9"].filter((f) => f !== masterAspect).map((f) => (
            <button key={f} disabled={busy} onClick={() => variantAction({ formats: [f] })} className="rounded bg-[#d4a017] px-3 py-1.5 font-semibold text-black disabled:opacity-40">derive {f}</button>
          ))}
          <button disabled={busy || !variants?.length} onClick={() => variantAction({ action: "render" })} className="rounded border border-[#d4a017]/60 px-3 py-1.5 text-[#d4a017] disabled:opacity-40">render all variants</button>
        </div>
        <div className="mt-2 space-y-2">
          {(variants ?? []).map((v) => (
            <div key={v.id} className="rounded-lg border border-[#2a2a2a] bg-black/20 p-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-neutral-100">{v.format}</span>
                <span className={cn("rounded border px-1.5 py-0.5 text-[10px]", v.status === "COMPLETED" ? STATE_STYLES.SUCCEEDED : v.status === "FAILED" ? STATE_STYLES.FAILED : STATE_STYLES.AWAITING_APPROVAL)}>{v.status}</span>
                <span className="text-neutral-500">{v.resolution} · {v.durationSec?.toFixed?.(1)}s · framing {v.framing?.default?.strategy ?? "?"} (crop {((v.framing?.default?.cropLossPct ?? 0) * 100).toFixed(0)}%)</span>
                {v.projectId && <a href={`#/editor?project=${v.projectId}`} className="text-[#d4a017]">open in editor</a>}
                {v.status === "READY" && <button onClick={() => variantAction({ action: "render", formats: [v.format] })} className="rounded border border-neutral-600 px-2 py-1 text-neutral-300">render</button>}
              </div>
              {(v.safeArea?.issues ?? []).length > 0 && (
                <div className="mt-1 rounded border border-orange-500/40 bg-orange-500/10 p-1.5 text-[10px] text-orange-300">
                  safe area: {v.safeArea!.issues.slice(0, 2).map((i) => `${i.kind} @${i.sceneKey}: ${i.detail}`).join(" · ")}
                  <span className="block text-orange-400/70">{v.safeArea!.note}</span>
                </div>
              )}
              {v.error && <div className="mt-1 text-[10px] text-red-400">{v.error}</div>}
            </div>
          ))}
          {variants && variants.length === 0 && <Empty text={`No variants yet — derive ${["1:1", "9:16"].filter((f) => f !== masterAspect).join(" and ")} from the completed campaign.`} />}
        </div>
      </Panel>

      {/* M32: masks */}
      <Panel title="Masks (subject isolation — real compositing)" state={masks && masks.length > 0 ? "SUCCEEDED" : "NOT_STARTED"}>
        {autoSeg && <div className="mb-2 rounded border border-orange-500/40 bg-orange-500/10 p-2 text-[11px] text-orange-300">auto segmentation: {autoSeg.status} — {autoSeg.detail}</div>}
        <div className="space-y-2">
          {(masks ?? []).map((m) => (
            <div key={m.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-[#2a2a2a] bg-black/20 p-2 text-xs">
              <span className={cn("rounded border px-1.5 py-0.5 text-[10px]", m.validationStatus === "VALIDATED" ? STATE_STYLES.SUCCEEDED : m.validationStatus === "FAILED" ? STATE_STYLES.FAILED : STATE_STYLES.AWAITING_APPROVAL)}>{m.validationStatus}</span>
              <span className="text-neutral-300">{m.width}x{m.height}</span>
              <span className="text-neutral-500">{m.method} · v{m.version} · src {m.sourceAssetId.slice(0, 10)}…</span>
              <button onClick={() => maskAction({ action: "process", maskId: m.id, op: "invert" })} className="rounded border border-neutral-600 px-2 py-1 text-neutral-300">invert</button>
              <button onClick={() => maskAction({ action: "process", maskId: m.id, op: "feather", radiusPx: 4 })} className="rounded border border-neutral-600 px-2 py-1 text-neutral-300">feather</button>
            </div>
          ))}
          {masks && masks.length === 0 && <Empty text="Import a mask (IMAGE upload in STUDIO, then attach) to composite a subject over a background. Automatic segmentation is CONFIGURATION REQUIRED and is never faked." />}
        </div>
      </Panel>

      {/* real event log */}
      <section className="mt-6">
        <h2 className="text-xs font-semibold text-neutral-300">Production log (append-only, real events)</h2>
        <div className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-lg border border-[#1c1c1c] bg-[#0d0d0d] p-2">
          {(board?.events ?? []).slice(0, 30).map((e) => <div key={e.id} className="text-[10px] text-neutral-500">{new Date(e.createdAt).toLocaleTimeString()} · {e.kind}{e.stageKey ? ` · ${e.stageKey}` : ""}</div>)}
          {(board?.events ?? []).length === 0 && <div className="text-[10px] text-neutral-600">no events yet</div>}
        </div>
      </section>
    </div>
  );
}

function Panel({ title, state, onRun, children }: { title: string; state: string; onRun?: () => void; children: React.ReactNode }) {
  return (
    <section className="mt-4 rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-neutral-200">{title}</h2>
        <span className={cn("rounded border px-1.5 py-0.5 text-[10px]", STATE_STYLES[state] ?? STATE_STYLES.NOT_STARTED)}>{state}</span>
        {onRun && state !== "SUCCEEDED" && <button onClick={onRun} disabled={state === "RUNNING"} className="ml-auto rounded bg-[#d4a017] px-3 py-1.5 text-xs font-semibold text-black disabled:opacity-40">{state === "RUNNING" ? "running…" : "run step"}</button>}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function StageButton({ label, state, onClick }: { label: string; state: string; onClick: () => void }) {
  return <button onClick={onClick} disabled={state === "RUNNING" || state === "SUCCEEDED"} className={cn("rounded px-3 py-1.5 text-xs font-semibold", state === "SUCCEEDED" ? "border border-emerald-600/50 text-emerald-400" : "bg-[#d4a017] text-black", state === "RUNNING" && "opacity-40")}>{state === "SUCCEEDED" ? `${label} ✓` : state === "RUNNING" ? `${label}…` : label}</button>;
}

function Empty({ text }: { text: string }) {
  return <p className="text-xs text-neutral-500">{text}</p>;
}
