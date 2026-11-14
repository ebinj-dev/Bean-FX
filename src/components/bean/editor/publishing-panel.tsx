"use client";

/**
 * Publishing workspace panel (M9 §2) — the creator publishing workflow inside
 * the existing editor shell: THUMBNAIL (LAXII Thumbnail Studio), METADATA
 * (MY AI suggestions + user approval), BRAND (presets), EXPORTS (multi-
 * platform variants + history), PACKAGE (publication-ready zip). Reuses the
 * BEAN FX visual language; publishing integrations are NOT offered (none are
 * configured — the status is surfaced honestly via /api/publish/status).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Image as ImageIcon, Type, Palette, Download, Package as PackageIcon, RefreshCw, X, Check, Ban, RotateCcw, Copy, Trash2, Plus } from "lucide-react";

interface ProfileInfo {
  id: string;
  label: string;
  platform: string;
  width: number;
  height: number;
  fps: number;
  aspect: string;
  maxDurationSec: number | null;
  bitrateSource: string;
  videoBitrateKbps: number;
  notes: string;
  sources: string[];
  thumbnailDims: { width: number; height: number } | null;
}

interface Candidate {
  id: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  provider: string | null;
  model: string | null;
  prompt: string | null;
}

interface ThumbnailDraftView {
  id: string;
  platform: string;
  status: string;
  prompt: string;
  layout: { title?: string; position?: string; align?: string; fontScale?: number; textColor?: string; accentColor?: string; backdrop?: string; backdropOpacity?: number; shadow?: boolean } | null;
  candidateIds: string[];
  selectedAssetId: string | null;
  compositedAssetId: string | null;
  provenance: { provider?: string; size?: string; generatedAt?: string } | null;
  error: string | null;
  jobId: string | null;
}

interface Fields {
  title: string;
  description: string;
  keywords: string[];
  hashtags: string[];
  chapters: { label: string; startSec: number }[];
  summary: string;
  platformDescription: string;
  callToAction: string;
}

interface MetadataRowView {
  id: string;
  platform: string;
  language: string;
  status: string;
  draft: { fields: Fields; chaptersSource: string; provenance: { model?: string } } | null;
  approved: Fields | null;
  model: string | null;
}

interface PresetView {
  id: string;
  name: string;
  brandName: string;
  primaryColor: string;
  secondaryColor: string;
  fontFamily: string;
  defaultExportProfile: string | null;
}

interface VariantView {
  id: string;
  profileId: string;
  profileVersion: string;
  status: string;
  progress: number;
  stage: string | null;
  resultExportId: string | null;
  validation: { ok?: boolean; failures?: { code: string; message: string }[] } | null;
  error: string | null;
  attempts: number;
  createdAt: string;
}

interface PackageView {
  id: string;
  status: string;
  variantIds: string[];
  metadataId: string | null;
  thumbnailDraftId: string | null;
  manifestSha256: string | null;
  sizeBytes: number | null;
  error: string | null;
  createdAt: string;
}

interface ExportRow {
  id: string;
  kind: string;
  format: string;
  filename: string;
  sizeBytes: number;
  createdAt: string;
}

interface MediaRow {
  id: string;
  originalName: string;
  kind: string;
}

type Tab = "thumbnail" | "metadata" | "brand" | "exports" | "package";

async function jfetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; failures?: { code: string; message: string }[] };
  if (!res.ok) {
    const detail = body.failures?.length ? ` ${body.failures.map((f) => f.message).join(" ")}` : "";
    throw new Error((body.error ?? `Request failed (${res.status})`) + detail);
  }
  return body;
}

const STATUS_COLOR: Record<string, string> = {
  COMPLETED: "#7fb069",
  READY: "#7fb069",
  APPROVED: "#7fb069",
  FAILED: "#e06c55",
  CANCELLED: "#8a8a84",
  QUEUED: "#d4a017",
  BUILDING: "#d4a017",
  GENERATING: "#d4a017",
  RENDERING: "#d4a017",
  GENERATED: "#6aa9c9",
  DRAFT: "#8a8a84",
};

function Badge({ status }: { status: string }) {
  return (
    <span className="rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ background: "rgba(255,255,255,0.06)", color: STATUS_COLOR[status] ?? "#d8d8d2" }}>
      {status}
    </span>
  );
}

const inputCls = "w-full rounded border border-[#2a2a2a] bg-[#141413] px-2 py-1.5 text-xs text-[#d8d8d2] placeholder-[#6a6a64] focus:border-[#d4a017] focus:outline-none";
const btnCls = "inline-flex items-center gap-1 rounded border border-[#2a2a2a] px-2 py-1 text-[11px] text-[#d8d8d2] hover:border-[#d4a017] hover:text-[#d4a017] disabled:opacity-40";
const labelCls = "text-[10px] uppercase tracking-wide text-[#8a8a84]";

export function PublishingPanel({ projectId }: { projectId: string }) {
  const [tab, setTab] = useState<Tab>("exports");
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [profiles, setProfiles] = useState<{ version: string; source: string; profiles: ProfileInfo[] } | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    jfetch<{ version: string; source: string; profiles: ProfileInfo[] }>("/api/publish/profiles").then(setProfiles).catch((e) => setNotice({ kind: "err", text: String(e.message) }));
  }, []);

  // Durable jobs progress in the background — poll while the panel is open.
  useEffect(() => {
    const t = setInterval(() => setRefreshTick((n) => n + 1), 3500);
    return () => clearInterval(t);
  }, []);

  const flash = useCallback((kind: "ok" | "err", text: string) => {
    setNotice({ kind, text });
    setTimeout(() => setNotice(null), 6000);
  }, []);

  const profileOptions = useMemo(() => profiles?.profiles ?? [], [profiles]);

  return (
    <div className="rounded-lg border border-[#2a2a2a] bg-[#101010] p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-semibold text-[#d4a017]">
          <Download className="h-3.5 w-3.5" /> Publishing
        </div>
        <div className="text-[10px] text-[#6a6a64]">{profiles ? `profiles v${profiles.version} (${profiles.source})` : ""}</div>
      </div>

      <div className="mb-2 flex flex-wrap gap-1">
        {(
          [
            ["exports", "Exports", Download],
            ["thumbnail", "Thumbnail", ImageIcon],
            ["metadata", "Metadata", Type],
            ["brand", "Brand", Palette],
            ["package", "Package", PackageIcon],
          ] as [Tab, string, typeof Download][]
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-[11px] ${tab === id ? "border-[#d4a017] text-[#d4a017]" : "border-[#2a2a2a] text-[#8a8a84] hover:text-[#d8d8d2]"}`}
          >
            <Icon className="h-3 w-3" /> {label}
          </button>
        ))}
      </div>

      {notice && <div className={`mb-2 rounded border px-2 py-1 text-[11px] ${notice.kind === "ok" ? "border-[#3a5a3a] text-[#a8c9a0]" : "border-[#6a3a30] text-[#e0a094]"}`}>{notice.text}</div>}

      {tab === "exports" && <ExportsTab projectId={projectId} profiles={profileOptions} tick={refreshTick} flash={flash} />}
      {tab === "thumbnail" && <ThumbnailTab projectId={projectId} profiles={profileOptions} tick={refreshTick} flash={flash} />}
      {tab === "metadata" && <MetadataTab projectId={projectId} profiles={profileOptions} tick={refreshTick} flash={flash} />}
      {tab === "brand" && <BrandTab projectId={projectId} profiles={profileOptions} flash={flash} />}
      {tab === "package" && <PackageTab projectId={projectId} profiles={profileOptions} tick={refreshTick} flash={flash} />}
    </div>
  );
}

// ── EXPORTS ─────────────────────────────────────────────────────────────────

function ExportsTab({ projectId, profiles, tick, flash }: { projectId: string; profiles: ProfileInfo[]; tick: number; flash: (k: "ok" | "err", t: string) => void }) {
  const [variants, setVariants] = useState<VariantView[]>([]);
  const [sources, setSources] = useState<ExportRow[]>([]);
  const [media, setMedia] = useState<MediaRow[]>([]);
  const [profileId, setProfileId] = useState("");
  const [sourceKey, setSourceKey] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    jfetch<{ variants: VariantView[] }>(`/api/publish/variants${projectId ? `?projectId=${projectId}` : ""}`).then((d) => setVariants(d.variants)).catch(() => undefined);
    jfetch<{ exports: ExportRow[] }>("/api/exports?kind=VIDEO").then((d) => setSources(d.exports)).catch(() => undefined);
    jfetch<{ media: MediaRow[] }>("/api/media").then((d) => setMedia(d.media.filter((m) => m.kind === "VIDEO"))).catch(() => undefined);
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load, tick]);

  const create = async () => {
    if (!profileId || !sourceKey) return flash("err", "Pick a profile and a source first.");
    const [kind, id] = sourceKey.split(":");
    setBusy(true);
    try {
      await jfetch("/api/publish/variants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileId, projectId, [kind === "export" ? "sourceExportId" : "sourceAssetId"]: id }),
      });
      flash("ok", "Variant queued on the durable worker.");
      load();
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const act = async (fn: () => Promise<unknown>, okText: string) => {
    try {
      await fn();
      flash("ok", okText);
      load();
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "Failed");
    }
  };

  return (
    <div className="space-y-3">
      <div className="rounded border border-[#2a2a2a] p-2">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-[#8a8a84]">New export variant</div>
        <div className="flex flex-col gap-1.5">
          <select className={inputCls} value={profileId} onChange={(e) => setProfileId(e.target.value)}>
            <option value="">Platform / format…</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label} — {p.width}×{p.height}@{p.fps}
                {p.maxDurationSec ? ` · cap ${p.maxDurationSec}s` : ""}
              </option>
            ))}
          </select>
          <select className={inputCls} value={sourceKey} onChange={(e) => setSourceKey(e.target.value)}>
            <option value="">Master source…</option>
            <optgroup label="Completed renders">
              {sources.map((s) => (
                <option key={`export:${s.id}`} value={`export:${s.id}`}>
                  render · {s.filename}
                </option>
              ))}
            </optgroup>
            <optgroup label="Owned videos">
              {media.map((m) => (
                <option key={`asset:${m.id}`} value={`asset:${m.id}`}>
                  media · {m.originalName}
                </option>
              ))}
            </optgroup>
          </select>
          <button type="button" className={btnCls} disabled={busy || !profileId || !sourceKey} onClick={create}>
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />} Validate &amp; queue
          </button>
          <div className="text-[10px] text-[#6a6a64]">The master is probed with ffprobe and validated against the profile (duration caps are real platform rules) BEFORE anything is encoded.</div>
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <div className={labelCls}>Export history</div>
          <button type="button" className={btnCls} onClick={load}>
            <RefreshCw className="h-3 w-3" /> Refresh
          </button>
        </div>
        {variants.length === 0 && <div className="text-[11px] text-[#6a6a64]">No variants yet. Exports of one approved project can target several platforms — each variant keeps the original timeline and media untouched.</div>}
        {variants.map((v) => (
          <div key={v.id} className="rounded border border-[#2a2a2a] p-2">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs text-[#d8d8d2]">
                {profiles.find((p) => p.id === v.profileId)?.label ?? v.profileId} <span className="text-[#6a6a64]">· profile v{v.profileVersion}</span>
              </div>
              <Badge status={v.status} />
            </div>
            {v.status === "RENDERING" || v.status === "QUEUED" ? (
              <div className="mt-1 h-1 w-full rounded bg-[#1c1c1a]">
                <div className="h-1 rounded bg-[#d4a017]" style={{ width: `${v.progress}%` }} />
              </div>
            ) : null}
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-[#8a8a84]">
              <span>{v.stage ?? ""}</span>
              <span>attempts {v.attempts}</span>
              {v.resultExportId && (
                <a className="text-[#d4a017] hover:underline" href={`/api/exports/${v.resultExportId}/file`}>
                  download
                </a>
              )}
              {(v.status === "QUEUED" || v.status === "RENDERING") && (
                <button type="button" className="text-[#e06c55] hover:underline" onClick={() => act(() => jfetch(`/api/publish/variants/${v.id}`, { method: "DELETE" }), "Variant cancelled — sources untouched.")}>
                  cancel
                </button>
              )}
              {(v.status === "FAILED" || v.status === "QUEUED") && (
                <button type="button" className="text-[#6aa9c9] hover:underline" onClick={() => act(() => jfetch(`/api/publish/variants/${v.id}/retry`, { method: "POST" }), "Retry queued.")}>
                  retry
                </button>
              )}
            </div>
            {v.error && <div className="mt-1 text-[10px] text-[#e06c55]">{v.error}</div>}
            {v.validation?.failures?.length ? (
              <div className="mt-1 text-[10px] text-[#e0a094]">
                {v.validation.failures.map((f, i) => (
                  <div key={i}>
                    {f.code}: {f.message}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── THUMBNAIL ───────────────────────────────────────────────────────────────

const DEFAULT_LAYOUT = { title: "", font: "auto" as const, position: "bottom" as const, align: "left" as const, fontScale: 0.09, textColor: "#ffffff", accentColor: "#d4a017", backdrop: "band" as const, backdropOpacity: 0.55, shadow: true };

function ThumbnailTab({ projectId, profiles, tick, flash }: { projectId: string; profiles: ProfileInfo[]; tick: number; flash: (k: "ok" | "err", t: string) => void }) {
  const [platform, setPlatform] = useState("youtube_landscape");
  const [draft, setDraft] = useState<ThumbnailDraftView | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [compositeId, setCompositeId] = useState<string | null>(null);
  const [genCount, setGenCount] = useState(2);
  const [genPrompt, setGenPrompt] = useState("");
  const [layout, setLayout] = useState({ ...DEFAULT_LAYOUT });
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    async (platformId: string) => {
      try {
        const list = await jfetch<{ drafts: ThumbnailDraftView[] }>(`/api/publish/thumbnails?projectId=${projectId}`);
        const found = list.drafts.find((d) => d.platform === platformId) ?? null;
        setDraft(found);
        setLayout({ ...DEFAULT_LAYOUT, ...(found?.layout ?? {}), title: found?.layout?.title ?? "" } as typeof layout);
        if (found) {
          const detail = await jfetch<{ candidates: Candidate[]; composite: { id: string } | null }>(`/api/publish/thumbnails/${found.id}`);
          setCandidates(detail.candidates);
          setCompositeId(detail.composite?.id ?? null);
        } else {
          setCandidates([]);
          setCompositeId(null);
        }
      } catch {
        setDraft(null);
        setCandidates([]);
      }
    },
    [projectId],
  );

  useEffect(() => {
    void load(platform);
  }, [load, platform, tick]);

  const ensureDraft = async (): Promise<ThumbnailDraftView> => {
    const created = await jfetch<{ draft: { id: string } }>("/api/publish/thumbnails", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, platform }),
    });
    return { id: created.draft.id } as ThumbnailDraftView;
  };

  const generate = async () => {
    setBusy("generate");
    try {
      const d = await ensureDraft();
      await jfetch(`/api/publish/thumbnails/${d.id}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: genCount, prompt: genPrompt || undefined }),
      });
      flash("ok", "Thumbnail generation queued via LAXII (durable job).");
      setTimeout(() => void load(platform), 1200);
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  };

  const select = async (assetId: string) => {
    if (!draft) return;
    try {
      await jfetch(`/api/publish/thumbnails/${draft.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ selectedAssetId: assetId }) });
      flash("ok", "Base image selected.");
      void load(platform);
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "Failed");
    }
  };

  const applyLayout = async () => {
    if (!draft) return flash("err", "Open a draft first.");
    if (!layout.title.trim()) return flash("err", "Enter a title for the overlay first.");
    setBusy("composite");
    try {
      await jfetch(`/api/publish/thumbnails/${draft.id}/composite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ layout }),
      });
      flash("ok", "Overlay applied to a NEW composite asset (previous selections preserved).");
      void load(platform);
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  };

  const profile = profiles.find((p) => p.id === platform);

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-1.5">
        <select className={inputCls} value={platform} onChange={(e) => setPlatform(e.target.value)}>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        {profile?.thumbnailDims && <div className="text-[10px] text-[#6a6a64]">Thumbnail geometry: {profile.thumbnailDims.width}×{profile.thumbnailDims.height}. Generated bases come from LAXII at the closest supported size and are cover-cropped to this.</div>}
        <div className="flex gap-1.5">
          <input className={inputCls} placeholder="Optional creator direction for LAXII (subject, mood, colors)…" value={genPrompt} onChange={(e) => setGenPrompt(e.target.value)} />
          <select className={`${inputCls} max-w-[70px]`} value={genCount} onChange={(e) => setGenCount(Number(e.target.value))}>
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                ×{n}
              </option>
            ))}
          </select>
          <button type="button" className={btnCls} disabled={busy === "generate"} onClick={generate}>
            {busy === "generate" ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Generate
          </button>
        </div>
        {draft?.status === "GENERATING" && (
          <div className="flex items-center gap-1 text-[10px] text-[#d4a017]">
            <Loader2 className="h-3 w-3 animate-spin" /> Generating via LAXII (durable job {draft.jobId?.slice(0, 8)}…) — previous selections are preserved.
          </div>
        )}
        {draft?.error && <div className="text-[10px] text-[#e06c55]">{draft.error}</div>}
      </div>

      {candidates.length > 0 && (
        <div>
          <div className={labelCls}>Candidates (select a base — provenance is recorded per asset)</div>
          <div className="mt-1 grid grid-cols-3 gap-1.5">
            {candidates.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => void select(c.id)}
                className={`overflow-hidden rounded border ${draft?.selectedAssetId === c.id ? "border-[#d4a017]" : "border-[#2a2a2a]"} hover:border-[#d4a017]`}
                title={`${c.provider ?? ""} ${c.model ?? ""} — ${c.width ?? "?"}×${c.height ?? "?"}`}
              >
                <img src={`/api/media/${c.id}/file`} alt="candidate" className="h-16 w-full object-cover" />
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="rounded border border-[#2a2a2a] p-2">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-[#8a8a84]">Title overlay (editable — composited server-side onto the selected base)</div>
        <input className={inputCls} placeholder="Thumbnail title text…" value={layout.title} onChange={(e) => setLayout({ ...layout, title: e.target.value })} />
        <div className="mt-1.5 grid grid-cols-2 gap-1.5">
          <select className={inputCls} value={layout.position} onChange={(e) => setLayout({ ...layout, position: e.target.value as typeof layout.position })}>
            <option value="top">top</option>
            <option value="center">center</option>
            <option value="bottom">bottom</option>
          </select>
          <select className={inputCls} value={layout.align} onChange={(e) => setLayout({ ...layout, align: e.target.value as typeof layout.align })}>
            <option value="left">left</option>
            <option value="center">center</option>
            <option value="right">right</option>
          </select>
          <select className={inputCls} value={layout.backdrop} onChange={(e) => setLayout({ ...layout, backdrop: e.target.value as typeof layout.backdrop })}>
            <option value="none">no backdrop</option>
            <option value="band">band</option>
            <option value="box">box</option>
          </select>
          <div className="flex items-center gap-1">
            <span className={labelCls}>size</span>
            <input type="range" min={0.05} max={0.16} step={0.01} value={layout.fontScale} onChange={(e) => setLayout({ ...layout, fontScale: Number(e.target.value) })} className="h-1 flex-1" />
          </div>
          <label className="flex items-center gap-1 text-[11px] text-[#8a8a84]">
            text <input type="color" value={layout.textColor} onChange={(e) => setLayout({ ...layout, textColor: e.target.value })} className="h-6 w-8 rounded border border-[#2a2a2a] bg-transparent" />
          </label>
          <label className="flex items-center gap-1 text-[11px] text-[#8a8a84]">
            accent <input type="color" value={layout.accentColor} onChange={(e) => setLayout({ ...layout, accentColor: e.target.value })} className="h-6 w-8 rounded border border-[#2a2a2a] bg-transparent" />
          </label>
        </div>
        <div className="mt-1.5 flex items-center justify-between">
          <label className="flex items-center gap-1 text-[11px] text-[#8a8a84]">
            <input type="checkbox" checked={layout.shadow} onChange={(e) => setLayout({ ...layout, shadow: e.target.checked })} /> shadow
          </label>
          <button type="button" className={btnCls} disabled={busy === "composite" || !draft?.selectedAssetId} onClick={applyLayout}>
            {busy === "composite" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Apply overlay
          </button>
        </div>
        {!draft?.selectedAssetId && <div className="mt-1 text-[10px] text-[#6a6a64]">Select a base image first (candidates above). The overlay is a real text layer — Tamil titles are rendered with proper shaping; the image itself is not per-layer editable (provider capability).</div>}
      </div>

      {compositeId && (
        <div>
          <div className={labelCls}>Composited thumbnail (latest)</div>
          <img src={`/api/media/${compositeId}/file`} alt="composite" className="mt-1 max-h-44 rounded border border-[#2a2a2a]" />
        </div>
      )}
    </div>
  );
}

// ── METADATA ────────────────────────────────────────────────────────────────

const FIELD_LABELS: [keyof Fields, string][] = [
  ["title", "Title"],
  ["summary", "Summary"],
  ["description", "Description"],
  ["platformDescription", "Platform-specific description"],
  ["callToAction", "Call to action"],
];

function MetadataTab({ projectId, profiles, tick, flash }: { projectId: string; profiles: ProfileInfo[]; tick: number; flash: (k: "ok" | "err", t: string) => void }) {
  const [platform, setPlatform] = useState("youtube_landscape");
  const [language, setLanguage] = useState<"en" | "ta">("en");
  const [row, setRow] = useState<MetadataRowView | null>(null);
  const [edit, setEdit] = useState<Fields | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await jfetch<{ metadata: MetadataRowView[] }>(`/api/publish/metadata?projectId=${projectId}&platform=${platform}`);
      const found = d.metadata[0] ?? null;
      setRow(found);
      setEdit(found?.draft?.fields ?? found?.approved ?? null);
    } catch {
      setRow(null);
      setEdit(null);
    }
  }, [projectId, platform]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  const generate = async () => {
    setBusy("generate");
    try {
      await jfetch("/api/publish/metadata", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, platform, language }) });
      flash("ok", "AI metadata generated (suggestions — approve explicitly to package them).");
      await load();
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "Generation failed — provider unavailable.");
    } finally {
      setBusy(null);
    }
  };

  const regen = async (field: string) => {
    if (!row) return;
    setBusy(field);
    try {
      await jfetch(`/api/publish/metadata/${row.id}/field`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ field }) });
      flash("ok", `Field "${field}" regenerated (draft updated; approved fields untouched).`);
      await load();
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "Regeneration failed.");
    } finally {
      setBusy(null);
    }
  };

  const approve = async () => {
    if (!row || !edit) return;
    setBusy("approve");
    try {
      await jfetch(`/api/publish/metadata/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: edit }),
      });
      flash("ok", "Metadata approved — AI suggestions and approved content are tracked separately.");
      await load();
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "Approval failed.");
    } finally {
      setBusy(null);
    }
  };

  const fields: Fields | null = edit ?? row?.draft?.fields ?? null;

  return (
    <div className="space-y-3">
      <div className="flex gap-1.5">
        <select className={inputCls} value={platform} onChange={(e) => setPlatform(e.target.value)}>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <select className={`${inputCls} max-w-[110px]`} value={language} onChange={(e) => setLanguage(e.target.value as "en" | "ta")}>
          <option value="en">English</option>
          <option value="ta">தமிழ் (Tamil)</option>
        </select>
        <button type="button" className={btnCls} disabled={busy === "generate"} onClick={generate}>
          {busy === "generate" ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Generate
        </button>
      </div>

      {row && (
        <div className="flex flex-wrap items-center gap-2 text-[10px] text-[#8a8a84]">
          <Badge status={row.status} />
          <span>
            draft = AI SUGGESTION{row.draft?.provenance?.model ? ` (${row.draft.provenance.model})` : ""} · approved = USER
          </span>
          {row.draft?.chaptersSource && <span>· chapters: {row.draft.chaptersSource === "none" ? "none (no verified timing — timestamps never invented)" : "from scene timings"}</span>}
        </div>
      )}

      {!row && <div className="text-[11px] text-[#6a6a64]">No metadata row yet for this platform. Generation uses REAL project context (script, scenes, captions) via the configured MY AI provider; when no provider is configured you get an honest error — never placeholder text.</div>}

      {fields && (
        <div className="space-y-2">
          {FIELD_LABELS.map(([key, label]) => (
            <div key={key} className="rounded border border-[#2a2a2a] p-2">
              <div className="flex items-center justify-between">
                <div className={labelCls}>{label}</div>
                <div className="flex items-center gap-2">
                  {row?.approved && <span className="text-[9px] text-[#7fb069]">approved</span>}
                  <button type="button" className="text-[10px] text-[#6aa9c9] hover:underline disabled:opacity-40" disabled={busy === key || !row} onClick={() => void regen(key)}>
                    {busy === key ? "…" : "regenerate"}
                  </button>
                </div>
              </div>
              {key === "keywords" || key === "hashtags" ? (
                <input className={`${inputCls} mt-1`} value={(fields[key] as string[]).join(", ")} onChange={(e) => setEdit({ ...fields, [key]: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
              ) : key === "title" || key === "callToAction" ? (
                <input className={`${inputCls} mt-1`} value={fields[key] as string} onChange={(e) => setEdit({ ...fields, [key]: e.target.value })} />
              ) : (
                <textarea className={`${inputCls} mt-1 min-h-[52px]`} value={fields[key] as string} onChange={(e) => setEdit({ ...fields, [key]: e.target.value })} />
              )}
            </div>
          ))}
          <div className="rounded border border-[#2a2a2a] p-2">
            <div className={labelCls}>Chapters (from verified scene timings only)</div>
            {fields.chapters.length === 0 && <div className="mt-1 text-[10px] text-[#6a6a64]">No chapters — none can be invented without measured timings.</div>}
            {fields.chapters.map((c, i) => (
              <div key={i} className="mt-1 flex gap-1.5">
                <input className={`${inputCls} max-w-[70px]`} value={`${c.startSec}s`} readOnly />
                <input className={inputCls} value={c.label} onChange={(e) => setEdit({ ...fields, chapters: fields.chapters.map((cc, j) => (j === i ? { ...cc, label: e.target.value } : cc)) })} />
              </div>
            ))}
          </div>
          <div className="flex gap-1.5">
            <button type="button" className={btnCls} disabled={!row || busy === "approve"} onClick={approve}>
              <Check className="h-3 w-3" /> Approve as user metadata
            </button>
            {row?.approved && (
              <button
                type="button"
                className={btnCls}
                onClick={async () => {
                  await jfetch(`/api/publish/metadata/${row.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ unapprove: true }) });
                  flash("ok", "Approval cleared.");
                  void load();
                }}
              >
                <X className="h-3 w-3" /> Unapprove
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── BRAND ───────────────────────────────────────────────────────────────────

function BrandTab({ projectId, profiles, flash }: { projectId: string; profiles: ProfileInfo[]; flash: (k: "ok" | "err", t: string) => void }) {
  const [presets, setPresets] = useState<PresetView[]>([]);
  const [name, setName] = useState("");
  const [brandName, setBrandName] = useState("");
  const [primary, setPrimary] = useState("#d4a017");
  const [secondary, setSecondary] = useState("#111111");
  const [fontFamily, setFontFamily] = useState("inter");
  const [defaultProfile, setDefaultProfile] = useState("");
  const [preview, setPreview] = useState<{ presetName: string; mergedSettings: Record<string, unknown>; keysWritten: string[]; keysPreserved: string[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    jfetch<{ presets: PresetView[] }>("/api/publish/presets").then((d) => setPresets(d.presets)).catch(() => undefined);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    try {
      await jfetch("/api/publish/presets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, brandName, primaryColor: primary, secondaryColor: secondary, fontFamily, defaultExportProfile: defaultProfile || null }) });
      flash("ok", "Preset created.");
      setName("");
      setBrandName("");
      load();
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const doPreview = async (presetId: string) => {
    try {
      const d = await jfetch<{ preview: { presetName: string; mergedSettings: Record<string, unknown>; keysWritten: string[]; keysPreserved: string[] } }>(`/api/publish/presets/${presetId}/apply?projectId=${projectId}`);
      setPreview(d.preview);
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "Preview failed");
    }
  };

  const doApply = async (presetId: string) => {
    try {
      await jfetch(`/api/publish/presets/${presetId}/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, confirm: "apply" }) });
      flash("ok", "Preset applied additively — only the preset-owned keys changed; audit trail recorded.");
      setPreview(null);
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "Apply failed");
    }
  };

  const doRevert = async (presetId: string) => {
    try {
      await jfetch(`/api/publish/presets/${presetId}/apply?projectId=${projectId}`, { method: "DELETE" });
      flash("ok", "Reverted to the pre-apply settings (audit-backed).");
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "Revert failed");
    }
  };

  return (
    <div className="space-y-3">
      <div className="rounded border border-[#2a2a2a] p-2">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-[#8a8a84]">New preset</div>
        <div className="grid grid-cols-2 gap-1.5">
          <input className={inputCls} placeholder="Preset name" value={name} onChange={(e) => setName(e.target.value)} />
          <input className={inputCls} placeholder="Brand name" value={brandName} onChange={(e) => setBrandName(e.target.value)} />
          <label className="flex items-center gap-1 text-[11px] text-[#8a8a84]">
            primary <input type="color" value={primary} onChange={(e) => setPrimary(e.target.value)} className="h-6 w-8 rounded border border-[#2a2a2a] bg-transparent" />
          </label>
          <label className="flex items-center gap-1 text-[11px] text-[#8a8a84]">
            secondary <input type="color" value={secondary} onChange={(e) => setSecondary(e.target.value)} className="h-6 w-8 rounded border border-[#2a2a2a] bg-transparent" />
          </label>
          <select className={inputCls} value={fontFamily} onChange={(e) => setFontFamily(e.target.value)}>
            <option value="inter">Inter</option>
            <option value="nikki-sans">Nikki Sans</option>
            <option value="nikki-tamil">Nikki Tamil</option>
          </select>
          <select className={inputCls} value={defaultProfile} onChange={(e) => setDefaultProfile(e.target.value)}>
            <option value="">Default export profile…</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <button type="button" className={`${btnCls} mt-1.5`} disabled={busy || !name.trim()} onClick={create}>
          <Plus className="h-3 w-3" /> Create preset
        </button>
      </div>

      <div className="space-y-1.5">
        <div className={labelCls}>Presets</div>
        {presets.length === 0 && <div className="text-[11px] text-[#6a6a64]">No presets yet — create one to apply consistent brand styling across projects (additively; custom styling is never destroyed).</div>}
        {presets.map((p) => (
          <div key={p.id} className="flex items-center justify-between rounded border border-[#2a2a2a] p-2">
            <div className="flex items-center gap-2 text-xs text-[#d8d8d2]">
              <span className="h-3 w-3 rounded-full" style={{ background: p.primaryColor }} />
              <span>{p.name}</span>
              <span className="text-[10px] text-[#6a6a64]">{p.brandName} · {p.fontFamily}</span>
            </div>
            <div className="flex items-center gap-2 text-[10px]">
              <button type="button" className="text-[#6aa9c9] hover:underline" onClick={() => void doPreview(p.id)}>
                preview apply
              </button>
              <button
                type="button"
                className="text-[#8a8a84] hover:underline"
                onClick={async () => {
                  await jfetch(`/api/publish/presets/${p.id}`, { method: "POST" });
                  flash("ok", "Preset duplicated.");
                  load();
                }}
              >
                <Copy className="inline h-3 w-3" /> duplicate
              </button>
              <button
                type="button"
                className="text-[#e06c55] hover:underline"
                onClick={async () => {
                  await jfetch(`/api/publish/presets/${p.id}`, { method: "DELETE" });
                  flash("ok", "Preset deleted.");
                  load();
                }}
              >
                <Trash2 className="inline h-3 w-3" /> delete
              </button>
            </div>
          </div>
        ))}
      </div>

      {preview && (
        <div className="rounded border border-[#d4a017] p-2">
          <div className="text-[11px] text-[#d4a017]">Preview — applying &quot;{preview.presetName}&quot; writes only: {preview.keysWritten.join(", ")}</div>
          <div className="mt-1 text-[10px] text-[#8a8a84]">Preserved (untouched): {preview.keysPreserved.length ? preview.keysPreserved.join(", ") : "(none)"}</div>
          <pre className="mt-1 max-h-32 overflow-auto rounded bg-[#0b0b0a] p-1.5 text-[9px] text-[#a8a8a0]">{JSON.stringify(preview.mergedSettings, null, 2).slice(0, 1200)}</pre>
          <div className="mt-1.5 flex gap-2">
            <button type="button" className={btnCls} onClick={() => void doApply(presets.find((p) => p.name === preview.presetName)?.id ?? "")}>
              <Check className="h-3 w-3" /> Confirm apply
            </button>
            <button type="button" className={btnCls} onClick={() => void doRevert(presets.find((p) => p.name === preview.presetName)?.id ?? "")}>
              <RotateCcw className="h-3 w-3" /> Revert last apply
            </button>
            <button type="button" className={btnCls} onClick={() => setPreview(null)}>
              <X className="h-3 w-3" /> Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── PACKAGE ─────────────────────────────────────────────────────────────────

function PackageTab({ projectId, tick, flash }: { projectId: string; profiles: ProfileInfo[]; tick: number; flash: (k: "ok" | "err", t: string) => void }) {
  const [variants, setVariants] = useState<VariantView[]>([]);
  const [metadata, setMetadata] = useState<MetadataRowView[]>([]);
  const [drafts, setDrafts] = useState<ThumbnailDraftView[]>([]);
  const [packages, setPackages] = useState<PackageView[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [metadataId, setMetadataId] = useState("");
  const [draftId, setDraftId] = useState("");
  const [manifest, setManifest] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    jfetch<{ variants: VariantView[] }>(`/api/publish/variants?projectId=${projectId}`).then((d) => setVariants(d.variants.filter((v) => v.status === "COMPLETED"))).catch(() => undefined);
    jfetch<{ metadata: MetadataRowView[] }>(`/api/publish/metadata?projectId=${projectId}`).then((d) => setMetadata(d.metadata)).catch(() => undefined);
    jfetch<{ drafts: ThumbnailDraftView[] }>(`/api/publish/thumbnails?projectId=${projectId}`).then((d) => setDrafts(d.drafts)).catch(() => undefined);
    jfetch<{ packages: PackageView[] }>(`/api/publish/packages?projectId=${projectId}`).then((d) => setPackages(d.packages)).catch(() => undefined);
  }, [projectId]);
  useEffect(() => {
    load();
  }, [load, tick]);

  const create = async () => {
    if (selected.size === 0) return flash("err", "Select at least one completed variant.");
    setBusy(true);
    try {
      await jfetch("/api/publish/packages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variantIds: [...selected], projectId, metadataId: metadataId || null, thumbnailDraftId: draftId || null }),
      });
      flash("ok", "Package build queued — deterministic manifest + zip on the durable worker.");
      load();
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="rounded border border-[#2a2a2a] p-2">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-[#8a8a84]">New publication package</div>
        <div className="space-y-1">
          {variants.length === 0 && <div className="text-[11px] text-[#6a6a64]">No completed variants yet — build exports first (Exports tab).</div>}
          {variants.map((v) => (
            <label key={v.id} className="flex items-center gap-1.5 text-[11px] text-[#d8d8d2]">
              <input
                type="checkbox"
                checked={selected.has(v.id)}
                onChange={(e) => {
                  const next = new Set(selected);
                  if (e.target.checked) next.add(v.id);
                  else next.delete(v.id);
                  setSelected(next);
                }}
              />
              {v.profileId} <span className="text-[10px] text-[#6a6a64]">{v.status}</span>
            </label>
          ))}
          {metadata.length > 0 && (
            <select className={inputCls} value={metadataId} onChange={(e) => setMetadataId(e.target.value)}>
              <option value="">No metadata in package…</option>
              {metadata.filter((m) => m.status === "APPROVED").map((m) => (
                <option key={m.id} value={m.id}>
                  approved metadata · {m.platform} ({m.language})
                </option>
              ))}
            </select>
          )}
          {drafts.length > 0 && (
            <select className={inputCls} value={draftId} onChange={(e) => setDraftId(e.target.value)}>
              <option value="">No thumbnail in package…</option>
              {drafts.map((d) => (
                <option key={d.id} value={d.id}>
                  thumbnail · {d.platform} {d.compositedAssetId ? "(composited)" : d.selectedAssetId ? "(base)" : "—"}
                </option>
              ))}
            </select>
          )}
          <button type="button" className={btnCls} disabled={busy} onClick={create}>
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <PackageIcon className="h-3 w-3" />} Build package
          </button>
          <div className="text-[10px] text-[#6a6a64]">Packages contain completed variant outputs, the selected thumbnail and USER-APPROVED metadata only — never private source media or AI-only suggestions. Manifest lists every file with its sha256.</div>
        </div>
      </div>

      <div className="space-y-1.5">
        <div className={labelCls}>Packages</div>
        {packages.length === 0 && <div className="text-[11px] text-[#6a6a64]">No packages yet.</div>}
        {packages.map((p) => (
          <div key={p.id} className="rounded border border-[#2a2a2a] p-2">
            <div className="flex items-center justify-between">
              <div className="text-xs text-[#d8d8d2]">package {p.id.slice(0, 10)}… · {p.variantIds.length} variant(s)</div>
              <Badge status={p.status} />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-[#8a8a84]">
              {p.sizeBytes != null && <span>{(p.sizeBytes / 1024 / 1024).toFixed(1)} MB</span>}
              {p.manifestSha256 && <span className="font-mono">sha256 {p.manifestSha256.slice(0, 12)}…</span>}
              {p.status === "READY" && (
                <>
                  <a className="text-[#d4a017] hover:underline" href={`/api/publish/packages/${p.id}/download`}>
                    download zip
                  </a>
                  <button
                    type="button"
                    className="text-[#6aa9c9] hover:underline"
                    onClick={async () => {
                      const d = await jfetch<{ package: { manifest: Record<string, unknown> } }>(`/api/publish/packages/${p.id}`);
                      setManifest(d.package.manifest);
                    }}
                  >
                    manifest
                  </button>
                </>
              )}
              <button
                type="button"
                className="text-[#e06c55] hover:underline"
                onClick={async () => {
                  await jfetch(`/api/publish/packages/${p.id}`, { method: "DELETE" });
                  flash("ok", "Package deleted (variants and exports untouched).");
                  load();
                }}
              >
                delete
              </button>
            </div>
            {p.error && <div className="mt-1 text-[10px] text-[#e06c55]">{p.error}</div>}
          </div>
        ))}
      </div>

      {manifest && (
        <div className="rounded border border-[#2a2a2a] p-2">
          <div className="flex items-center justify-between">
            <div className={labelCls}>Manifest</div>
            <button type="button" className={btnCls} onClick={() => setManifest(null)}>
              <X className="h-3 w-3" /> close
            </button>
          </div>
          <pre className="mt-1 max-h-48 overflow-auto rounded bg-[#0b0b0a] p-1.5 text-[9px] text-[#a8a8a0]">{JSON.stringify(manifest, null, 2).slice(0, 2400)}</pre>
        </div>
      )}
    </div>
  );
}

