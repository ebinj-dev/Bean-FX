"use client";

/**
 * AI Creative Director panel (M10 §2) — integrated into the existing editor
 * shell. Tabs: ASSISTANT (project-aware chat routing), REVIEW (overview +
 * creative brief), RETENTION (evidence-based findings), SCORECARD (explained
 * dimensions), RECOMMENDATIONS (typed proposals → approve/execute via the M1
 * engine), A/B STUDIO (creative alternatives), HISTORY (past reviews).
 * Uses the BEAN FX visual language; no separate editor is created.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Sparkles, ClipboardList, Timer, Gauge, Wrench, GitCompareArrows, History, RefreshCw, Check, X, Send, Ban, Eye, Search, Activity, Layers } from "lucide-react";

interface ReviewRow {
  id: string;
  scope: string;
  language: string;
  status: string;
  progress: number;
  stage: string | null;
  contextVersion: string;
  headVersion: number;
  provider: string | null;
  model: string | null;
  error: string | null;
  jobId: string | null;
  stale?: boolean;
  createdAt: string;
}

interface FindingRow {
  findingNo: number;
  category: string;
  startSec: number | null;
  endSec: number | null;
  severity: string;
  confidence: number | null;
  evidenceLabel: string;
  evidence: Record<string, unknown>;
  explanation: string;
  suggestion: string | null;
  engine: string;
}

interface RecommendationRow {
  id: string;
  recNo: number;
  kind: string;
  engine: string;
  title: string;
  detail: string;
  target: { clipId?: string | null; startSec?: number | null; endSec?: number | null } | null;
  payload: { kind: string; commands?: { type: string }[]; note?: string };
  preview: Record<string, unknown> | null;
  status: string;
  stale?: boolean;
  executedVersion: number | null;
  result: Record<string, unknown> | null;
}

interface ScorecardRow {
  modelVersion: string;
  dimensions: { key: string; score: number | null; basis: string; evidence: string[]; explanation: string; confidence: number | null; missingData: string[]; suggestions: string[] }[];
  overallNote: string | null;
}

interface BriefRow {
  mainSubject: string;
  mainMessage: string;
  storyStructure: string;
  openingHook: { summary: string; evidenceSec: number | null; basis: string };
  supportingPoints: string[];
  observed: string[];
  interpreted: string[];
  audience: string | null;
  missingElements: string[];
}

interface VariantRow {
  id: string;
  kind: string;
  label: string;
  description: string;
  text: string | null;
  assetId: string | null;
  status: string;
  evaluationNote?: string;
}

type Tab = "assistant" | "review" | "retention" | "scorecard" | "recommendations" | "ab" | "visual" | "motion" | "compose" | "history";

async function jfetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

const STATUS_COLOR: Record<string, string> = { COMPLETED: "#7fb069", READY: "#7fb069", EXECUTED: "#7fb069", FAILED: "#e06c55", STALE: "#e0a094", CANCELLED: "#8a8a84", QUEUED: "#d4a017", RUNNING: "#d4a017", PROPOSED: "#6aa9c9", REJECTED: "#8a8a84", APPLIED: "#7fb069", SELECTED: "#6aa9c9", DISCARDED: "#8a8a84" };

function Badge({ status }: { status: string }) {
  return (
    <span className="rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ background: "rgba(255,255,255,0.06)", color: STATUS_COLOR[status] ?? "#d8d8d2" }}>
      {status}
    </span>
  );
}

function LabelChip({ label }: { label: string }) {
  const color = label === "measured" ? "#7fb069" : label === "inferred" ? "#6aa9c9" : label === "ai-interpretation" ? "#d4a017" : "#e0a094";
  return <span className="rounded px-1 py-0.5 text-[9px]" style={{ border: `1px solid ${color}`, color }}>{label}</span>;
}

const inputCls = "w-full rounded border border-[#2a2a2a] bg-[#141413] px-2 py-1.5 text-xs text-[#d8d8d2] placeholder-[#6a6a64] focus:border-[#d4a017] focus:outline-none";
const btnCls = "inline-flex items-center gap-1 rounded border border-[#2a2a2a] px-2 py-1 text-[11px] text-[#d8d8d2] hover:border-[#d4a017] hover:text-[#d4a017] disabled:opacity-40";
const labelCls = "text-[10px] uppercase tracking-wide text-[#8a8a84]";

export function CreativeDirectorPanel({ projectId, onSeekSec }: { projectId: string; onSeekSec?: (sec: number) => void }) {
  const [tab, setTab] = useState<Tab>("assistant");
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [tick, setTick] = useState(0);
  const flash = useCallback((kind: "ok" | "err", text: string) => {
    setNotice({ kind, text });
    setTimeout(() => setNotice(null), 7000);
  }, []);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 3500);
    return () => clearInterval(t);
  }, []);

  const TABS: [Tab, string, typeof Sparkles][] = [
    ["assistant", "Assistant", Sparkles],
    ["review", "Review", ClipboardList],
    ["retention", "Retention", Timer],
    ["scorecard", "Scorecard", Gauge],
    ["recommendations", "Recommendations", Wrench],
    ["ab", "A/B", GitCompareArrows],
    ["visual", "Visual", Eye],
    ["motion", "Motion", Activity],
    ["compose", "Compose", Layers],
    ["history", "History", History],
  ];

  return (
    <div className="rounded-lg border border-[#2a2a2a] bg-[#101010] p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-[#d4a017]">
        <Sparkles className="h-3.5 w-3.5" /> AI Creative Director
      </div>
      <div className="mb-2 flex flex-wrap gap-1">
        {TABS.map(([id, label, Icon]) => (
          <button key={id} type="button" onClick={() => setTab(id)} className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-[11px] ${tab === id ? "border-[#d4a017] text-[#d4a017]" : "border-[#2a2a2a] text-[#8a8a84] hover:text-[#d8d8d2]"}`}>
            <Icon className="h-3 w-3" /> {label}
          </button>
        ))}
      </div>
      {notice && <div className={`mb-2 rounded border px-2 py-1 text-[11px] ${notice.kind === "ok" ? "border-[#3a5a3a] text-[#a8c9a0]" : "border-[#6a3a30] text-[#e0a094]"}`}>{notice.text}</div>}
      {tab === "assistant" && <AssistantTab projectId={projectId} flash={flash} />}
      {tab === "review" && <ReviewTab projectId={projectId} tick={tick} flash={flash} />}
      {tab === "retention" && <RetentionTab projectId={projectId} tick={tick} flash={flash} onSeekSec={onSeekSec} />}
      {tab === "scorecard" && <ScorecardTab projectId={projectId} tick={tick} flash={flash} />}
      {tab === "recommendations" && <RecommendationsTab projectId={projectId} tick={tick} flash={flash} onSeekSec={onSeekSec} />}
      {tab === "ab" && <AbTab projectId={projectId} tick={tick} flash={flash} />}
      {tab === "visual" && <VisualTab projectId={projectId} tick={tick} flash={flash} onSeekSec={onSeekSec} />}
      {tab === "motion" && <MotionTab projectId={projectId} tick={tick} flash={flash} onSeekSec={onSeekSec} />}
      {tab === "compose" && <ComposeTab projectId={projectId} tick={tick} flash={flash} />}
      {tab === "history" && <HistoryTab projectId={projectId} tick={tick} flash={flash} />}
    </div>
  );
}

// ── shared review selection hook ────────────────────────────────────────────
function useReviews(projectId: string, tick: number) {
  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const load = useCallback(() => {
    jfetch<{ reviews: ReviewRow[] }>(`/api/creative/reviews?projectId=${projectId}`).then((d) => setReviews(d.reviews)).catch(() => undefined);
  }, [projectId]);
  useEffect(() => {
    load();
  }, [load, tick]);
  const completed = useMemo(() => reviews.filter((r) => r.status === "COMPLETED"), [reviews]);
  const active = useMemo(() => reviews.filter((r) => r.status === "QUEUED" || r.status === "RUNNING"), [reviews]);
  return { reviews, completed, active, reload: load };
}

// ── ASSISTANT ───────────────────────────────────────────────────────────────
function AssistantTab({ projectId, flash }: { projectId: string; flash: (k: "ok" | "err", t: string) => void }) {
  const [message, setMessage] = useState("");
  const [language, setLanguage] = useState<"en" | "ta">("en");
  const [busy, setBusy] = useState(false);
  const [turns, setTurns] = useState<{ role: "user" | "assistant"; text: string }[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [turns]);

  const send = async () => {
    if (!message.trim()) return;
    const text = message.trim();
    setMessage("");
    setTurns((t) => [...t, { role: "user", text }]);
    setBusy(true);
    try {
      const d = await jfetch<{ reply: string; reviewQueuedJobId: string | null; recommendationsCreated: number }>("/api/creative/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, message: text, language }),
      });
      setTurns((t) => [...t, { role: "assistant", text: d.reply }]);
      if (d.reviewQueuedJobId) flash("ok", `Full review queued (job ${d.reviewQueuedJobId.slice(0, 8)}…) — check History.`);
    } catch (e) {
      setTurns((t) => [...t, { role: "assistant", text: `Error: ${e instanceof Error ? e.message : "assistant failed"}` }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div ref={scroller} className="max-h-64 space-y-1.5 overflow-y-auto rounded border border-[#2a2a2a] p-2">
        {turns.length === 0 && <div className="text-[11px] text-[#6a6a64]">Ask things like &quot;Review my video&quot;, &quot;Find unnecessary pauses&quot;, &quot;Improve the first 10 seconds&quot;, &quot;காலை பகுதியை மேம்படுத்து&quot;, &quot;Show me what needs improvement before export&quot;. Answers come from measured project evidence; timeline changes always require your approval.</div>}
        {turns.map((t, i) => (
          <div key={i} className={`rounded px-2 py-1.5 text-[11px] ${t.role === "user" ? "bg-[#1c1a12] text-[#d8d8d2]" : "bg-[#141413] text-[#a8c9a0]"}`}>
            <div className={labelCls}>{t.role === "user" ? "You" : "Director"}</div>
            <div className="whitespace-pre-wrap">{t.text}</div>
          </div>
        ))}
        {busy && <div className="flex items-center gap-1 text-[10px] text-[#d4a017]"><Loader2 className="h-3 w-3 animate-spin" /> thinking…</div>}
      </div>
      <div className="flex gap-1.5">
        <select className={`${inputCls} max-w-[90px]`} value={language} onChange={(e) => setLanguage(e.target.value as "en" | "ta")}>
          <option value="en">EN</option>
          <option value="ta">தமிழ்</option>
        </select>
        <input
          className={inputCls}
          placeholder="Ask the Creative Director…"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !busy) void send();
          }}
        />
        <button type="button" className={btnCls} disabled={busy} onClick={() => void send()}>
          <Send className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

// ── REVIEW (overview + brief) ───────────────────────────────────────────────
function ReviewTab({ projectId, tick, flash }: { projectId: string; tick: number; flash: (k: "ok" | "err", t: string) => void }) {
  const { reviews, active, reload } = useReviews(projectId, tick);
  const [detail, setDetail] = useState<{ brief: BriefRow | null; missingEvidence: { items?: string[] } | null; evidenceSources: { engine: string; detail: string }[] | null; model: string | null } | null>(null);
  const [scope, setScope] = useState("full");
  const [language, setLanguage] = useState<"en" | "ta">("en");
  const latestCompleted = useMemo(() => reviews.find((r) => r.status === "COMPLETED") ?? null, [reviews]);

  useEffect(() => {
    if (!latestCompleted) return;
    let open = true;
    jfetch<{ review: { brief: BriefRow | null; missingEvidence: { items?: string[] } | null; evidenceSources: { engine: string; detail: string }[] | null; model: string | null } }>(`/api/creative/reviews/${latestCompleted.id}`)
      .then((d) => {
        if (open) setDetail({ brief: d.review.brief, missingEvidence: d.review.missingEvidence, evidenceSources: d.review.evidenceSources, model: d.review.model });
      })
      .catch(() => undefined);
    return () => {
      open = false;
    };
  }, [latestCompleted?.id, tick]);

  const enqueue = async () => {
    try {
      if (scope === "multimodal") {
        const d = await jfetch<{ jobId: string }>("/api/creative/analyze/unified", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, language, withTranscript: true }) });
        flash("ok", `Multimodal review queued (job ${d.jobId.slice(0, 8)}…) — embedded audio, local scene analysis, cross-modal findings, transcript and surgery plan.`);
        reload();
        return;
      }
      const d = await jfetch<{ jobId: string }>("/api/creative/reviews", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, scope, language, enqueueEvidence: true }) });
      flash("ok", `Review queued (job ${d.jobId.slice(0, 8)}…) — the worker will gather GANGZII evidence, findings and recommendations.`);
      reload();
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "Failed");
    }
  };

  return (
    <div className="space-y-3">
      <div className="rounded border border-[#2a2a2a] p-2">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-[#8a8a84]">Project analysis</div>
        <div className="flex gap-1.5">
          <select className={inputCls} value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="full">Full review (brief + findings + scorecard)</option>
            <option value="multimodal">Multimodal (embedded audio + scenes + transcript)</option>
            <option value="retention">Retention/pacing only</option>
            <option value="scorecard">Scorecard only</option>
            <option value="brief">Creative brief only</option>
          </select>
          <select className={`${inputCls} max-w-[90px]`} value={language} onChange={(e) => setLanguage(e.target.value as "en" | "ta")}>
            <option value="en">EN</option>
            <option value="ta">தமிழ்</option>
          </select>
          <button type="button" className={btnCls} onClick={() => void enqueue()}>
            <RefreshCw className="h-3 w-3" /> Review project
          </button>
        </div>
        {active.length > 0 && (
          <div className="mt-1.5 space-y-1">
            {active.map((r) => (
              <div key={r.id} className="flex items-center gap-2 text-[10px] text-[#d4a017]">
                <Loader2 className="h-3 w-3 animate-spin" /> {r.scope} · {r.stage ?? "queued"} · {r.progress}% · job {r.jobId?.slice(0, 8)}
              </div>
            ))}
          </div>
        )}
        {latestCompleted && <div className="mt-1 text-[10px] text-[#8a8a84]">Latest completed: {latestCompleted.contextVersion}{latestCompleted.stale ? " (timeline changed since — results may be stale)" : ""} {latestCompleted.model ? `· ${latestCompleted.model}` : "· deterministic"}</div>}
      </div>

      {detail?.brief && (
        <div className="space-y-2">
          <div className="rounded border border-[#2a2a2a] p-2">
            <div className={labelCls}>Creative brief {detail.model ? `(interpretation via ${detail.model})` : ""}</div>
            <div className="mt-1 text-xs text-[#d8d8d2]">{detail.brief.mainSubject}</div>
            <div className="mt-1 text-[11px] text-[#a8a8a0]">{detail.brief.mainMessage}</div>
            <div className="mt-1 text-[11px] text-[#a8a8a0]">{detail.brief.storyStructure}</div>
            <div className="mt-1 text-[11px] text-[#a8a8a0]">Hook: {detail.brief.openingHook.summary} <LabelChip label={detail.brief.openingHook.basis} /></div>
            {detail.brief.audience && <div className="mt-1 text-[11px] text-[#a8a8a0]">Audience (as supplied by you): {detail.brief.audience}</div>}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded border border-[#2a2a2a] p-2">
              <div className={labelCls}>Observed (measured/sourced)</div>
              {detail.brief.observed.map((o, i) => (
                <div key={i} className="mt-0.5 text-[11px] text-[#a8c9a0]">• {o}</div>
              ))}
            </div>
            <div className="rounded border border-[#2a2a2a] p-2">
              <div className={labelCls}>AI interpretation</div>
              {detail.brief.interpreted.map((o, i) => (
                <div key={i} className="mt-0.5 text-[11px] text-[#e0c98a]">• {o}</div>
              ))}
            </div>
          </div>
          {detail.brief.missingElements.length > 0 && (
            <div className="rounded border border-[#3a3a30] p-2">
              <div className={labelCls}>Missing / unclear narrative elements</div>
              {detail.brief.missingElements.map((o, i) => (
                <div key={i} className="mt-0.5 text-[11px] text-[#e0a094]">• {o}</div>
              ))}
            </div>
          )}
        </div>
      )}
      {detail?.missingEvidence?.items && detail.missingEvidence.items.length > 0 && (
        <div className="rounded border border-[#2a2a2a] p-2">
          <div className={labelCls}>Not inspected (partial analysis — honest)</div>
          {detail.missingEvidence.items.map((m, i) => (
            <div key={i} className="mt-0.5 text-[10px] text-[#e0a094]">• {m}</div>
          ))}
        </div>
      )}
      <TranscriptsBlock projectId={projectId} flash={flash} />
    </div>
  );
}

// ── §4 integrated transcripts: version list + approve/discard ───────────────
function TranscriptsBlock({ projectId, flash }: { projectId: string; flash: (k: "ok" | "err", t: string) => void }) {
  const [rows, setRows] = useState<{ id: string; versionNo: number; language: string; provider: string | null; segments: number; textExcerpt: string; warnings: string[]; status: string; staleReason: string | null; captionAssetId: string | null; wordsAvailable: boolean }[]>([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    jfetch<{ transcripts: typeof rows }>(`/api/creative/analyze/transcripts?projectId=${projectId}`).then((d) => setRows(d.transcripts)).catch(() => undefined);
  }, [projectId]);
  useEffect(() => {
    load();
  }, [load]);
  const act = async (id: string, action: "approve" | "discard") => {
    setBusy(true);
    try {
      const d = await jfetch<{ note?: string }>(`/api/creative/analyze/transcripts/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, applyCaptions: action === "approve" }) });
      flash("ok", `${action}: ${d.note ?? "done"}`);
      load();
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };
  if (!rows.length) return null;
  return (
    <div className="rounded border border-[#2a2a2a] p-2">
      <div className={labelCls}>Integrated transcripts (approval required before captions)</div>
      {rows.map((t) => (
        <div key={t.id} className="mt-1 rounded border border-[#232323] p-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge status={t.status.toUpperCase()} />
            <span className="text-[10px] text-[#d8d8d2]">v{t.versionNo} · {t.language} · {t.segments} segment(s) · {t.provider ?? "?"}</span>
            {t.staleReason && <LabelChip label="stale" />}
          </div>
          <div className="mt-0.5 text-[10px] text-[#a8a8a0]">{t.textExcerpt || "(empty transcript — see warnings)"}</div>
          {t.warnings.slice(0, 2).map((w, i) => (
            <div key={i} className="text-[9px] text-[#e0a094]">• {w}</div>
          ))}
          {t.status === "PENDING_REVIEW" && (
            <div className="mt-1 flex gap-1.5">
              <button type="button" className={btnCls} disabled={busy} onClick={() => void act(t.id, "approve")}>
                <Check className="h-3 w-3" /> approve (+SRT asset)
              </button>
              <button type="button" className={btnCls} disabled={busy} onClick={() => void act(t.id, "discard")}>
                <X className="h-3 w-3" /> discard
              </button>
            </div>
          )}
          {t.captionAssetId && <div className="text-[9px] text-[#7fb069]">SRT asset created (existing captions untouched)</div>}
        </div>
      ))}
    </div>
  );
}

// ── RETENTION ───────────────────────────────────────────────────────────────
const FILTER_GROUPS: Record<string, string[]> = {
  audio: ["long-pause", "dead-air", "audio-quality", "audio-gap", "av-sync"],
  speech: ["opening-hook", "repeated-narration", "ending-cta", "speech-across-cut", "narration-without-visuals"],
  captions: ["caption-timing", "caption-mismatch"],
  visuals: ["visual-repetition", "static-visuals", "visuals-without-narration"],
  pacing: ["pacing", "scene-structure", "transition"],
  sync: ["av-sync", "speech-across-cut", "audio-gap"],
  technical: ["technical"],
};

function RetentionTab({ projectId, tick, flash, onSeekSec }: { projectId: string; tick: number; flash: (k: "ok" | "err", t: string) => void; onSeekSec?: (sec: number) => void }) {
  const { reviews, active } = useReviews(projectId, tick);
  const [data, setData] = useState<{ findings: FindingRow[]; disclaimer: string | null } | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const latestCompleted = useMemo(() => reviews.find((r) => r.status === "COMPLETED") ?? null, [reviews]);

  useEffect(() => {
    if (!latestCompleted) return;
    jfetch<{ findings: FindingRow[] }>(`/api/creative/reviews/${latestCompleted.id}`)
      .then((d) => setData({ findings: d.findings, disclaimer: "No viewer-retention analytics exist in this deployment — everything below is content pacing evidence, not audience behavior." }))
      .catch(() => setData(null));
  }, [latestCompleted?.id, tick]);

  const visible = data?.findings.filter((f) => filter === "all" || (FILTER_GROUPS[filter] ?? []).includes(f.category)) ?? [];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {["all", "audio", "speech", "captions", "visuals", "pacing", "sync", "technical"].map((k) => (
          <button key={k} type="button" onClick={() => setFilter(k)} className={`rounded border px-1.5 py-0.5 text-[10px] ${filter === k ? "border-[#d4a017] text-[#d4a017]" : "border-[#2a2a2a] text-[#8a8a84] hover:text-[#d8d8d2]"}`}>
            {k}
          </button>
        ))}
      </div>
      {active.length > 0 && <div className="text-[10px] text-[#d4a017]"><Loader2 className="inline h-3 w-3 animate-spin" /> analysis running…</div>}
      {!latestCompleted && !active.length && <div className="text-[11px] text-[#6a6a64]">Run a review first (Review tab) — findings come from real GANGZII audio measurements (embedded or external), RIISHE transcripts, local scene analysis and timeline structure.</div>}
      {visible.map((f) => (
        <div key={f.findingNo} className="rounded border border-[#2a2a2a] p-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge status={f.severity.toUpperCase()} />
            <LabelChip label={f.evidenceLabel} />
            <span className="text-[11px] text-[#d8d8d2]">#{f.findingNo} {f.category}</span>
            {f.startSec !== null && (
              <>
                <span className="text-[10px] text-[#6a6a64]">@ {f.startSec.toFixed(1)}s{f.endSec !== null ? `–${f.endSec.toFixed(1)}s` : ""}</span>
                {onSeekSec && (
                  <button type="button" className="text-[10px] text-[#6aa9c9] hover:underline" onClick={() => onSeekSec(f.startSec as number)}>
                    open in timeline ↗
                  </button>
                )}
              </>
            )}
            {f.confidence !== null && <span className="text-[10px] text-[#6a6a64]">confidence {Math.round(f.confidence * 100)}%</span>}
            <span className="text-[10px] text-[#6a6a64]">· {f.engine}</span>
          </div>
          <div className="mt-1 text-[11px] text-[#a8a8a0]">{f.explanation}</div>
          <details className="mt-1">
            <summary className="cursor-pointer text-[10px] text-[#6aa9c9]">evidence</summary>
            <pre className="mt-0.5 max-h-24 overflow-auto rounded bg-[#0b0b0a] p-1 text-[9px] text-[#8a8a84]">{JSON.stringify(f.evidence, null, 1).slice(0, 600)}</pre>
          </details>
          {f.suggestion && <div className="mt-1 text-[11px] text-[#d4a017]">→ {f.suggestion}</div>}
        </div>
      ))}
      {data?.disclaimer && <div className="text-[9px] text-[#6a6a64]">{data.disclaimer}</div>}
    </div>
  );
}

// ── SCORECARD ───────────────────────────────────────────────────────────────
function ScorecardTab({ projectId, tick }: { projectId: string; tick: number; flash: (k: "ok" | "err", t: string) => void }) {
  const { reviews } = useReviews(projectId, tick);
  const [card, setCard] = useState<ScorecardRow | null>(null);
  const latestCompleted = useMemo(() => reviews.find((r) => r.status === "COMPLETED") ?? null, [reviews]);
  useEffect(() => {
    if (!latestCompleted) return;
    jfetch<{ scorecard: ScorecardRow | null }>(`/api/creative/reviews/${latestCompleted.id}`).then((d) => setCard(d.scorecard)).catch(() => setCard(null));
  }, [latestCompleted?.id, tick]);

  return (
    <div className="space-y-2">
      {!card && <div className="text-[11px] text-[#6a6a64]">No scorecard yet — run a Full review. Unscored dimensions (missing data) are shown honestly, never invented.</div>}
      {card?.dimensions.map((d) => (
        <div key={d.key} className="rounded border border-[#2a2a2a] p-2">
          <div className="flex items-center justify-between">
            <div className="text-[11px] text-[#d8d8d2]">{d.key}</div>
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-semibold" style={{ color: d.score === null ? "#8a8a84" : d.score >= 4 ? "#7fb069" : d.score >= 3 ? "#d4a017" : "#e06c55" }}>{d.score === null ? "n/a" : `${d.score}/5`}</span>
              <LabelChip label={d.basis} />
              {d.confidence !== null && <span className="text-[9px] text-[#6a6a64]">{Math.round(d.confidence * 100)}%</span>}
            </div>
          </div>
          <div className="mt-1 text-[11px] text-[#a8a8a0]">{d.explanation}</div>
          {d.evidence.length > 0 && <div className="mt-0.5 text-[10px] text-[#6a6a64]">evidence: {d.evidence.join(" · ")}</div>}
          {d.missingData.length > 0 && <div className="mt-0.5 text-[10px] text-[#e0a094]">missing: {d.missingData.join(" · ")}</div>}
          {d.suggestions.length > 0 && <div className="mt-0.5 text-[10px] text-[#d4a017]">→ {d.suggestions.join(" · ")}</div>}
        </div>
      ))}
      {card?.overallNote && <div className="text-[9px] text-[#6a6a64]">{card.overallNote}</div>}
    </div>
  );
}

// ── RECOMMENDATIONS ─────────────────────────────────────────────────────────
function RecommendationsTab({ projectId, tick, flash, onSeekSec }: { projectId: string; tick: number; flash: (k: "ok" | "err", t: string) => void; onSeekSec?: (sec: number) => void }) {
  const { reviews, reload } = useReviews(projectId, tick);
  const [recs, setRecs] = useState<RecommendationRow[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const latestCompleted = useMemo(() => reviews.find((r) => r.status === "COMPLETED") ?? null, [reviews]);

  const load = useCallback(() => {
    if (!latestCompleted) return setRecs([]);
    jfetch<{ recommendations: RecommendationRow[] }>(`/api/creative/reviews/${latestCompleted.id}`).then((d) => setRecs(d.recommendations)).catch(() => undefined);
  }, [latestCompleted?.id]);
  useEffect(() => {
    load();
  }, [load, tick]);

  const act = async (id: string, action: "preview" | "approve-execute" | "reject") => {
    setBusyId(id);
    try {
      const d = await jfetch<{ status?: string; detail?: string }>(`/api/creative/recommendations/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      flash(d.status === "EXECUTED" ? "ok" : action === "reject" ? "ok" : "ok", `${action}: ${d.status ?? "done"} — ${d.detail ?? ""}`.trim());
      load();
      reload();
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "Failed");
    } finally {
      setBusyId(null);
    }
  };

  const executable = recs.filter((r) => r.kind === "executable");
  const informational = recs.filter((r) => r.kind === "informational");

  return (
    <div className="space-y-2">
      {!recs.length && <div className="text-[11px] text-[#6a6a64]">No recommendations yet — run a review. Executable proposals run through the M1 engine ONLY after your explicit approval, and are refused if the timeline changed since (stale).</div>}
      {[...executable, ...informational].map((r) => (
        <div key={r.id} className="rounded border border-[#2a2a2a] p-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge status={r.status.toUpperCase()} />
            {r.stale && <LabelChip label="stale" />}
            <span className="text-[11px] text-[#d8d8d2]">#{r.recNo} {r.title}</span>
            <span className="text-[10px] text-[#6a6a64]">· {r.engine} · {r.kind}</span>
            {r.target?.startSec != null && <span className="text-[10px] text-[#6a6a64]">@ {r.target.startSec.toFixed(1)}s</span>}
          </div>
          <div className="mt-1 text-[11px] text-[#a8a8a0]">{r.detail}</div>
          {r.target?.startSec != null && onSeekSec && (
            <button type="button" className="ml-1 text-[10px] text-[#6aa9c9] hover:underline" onClick={() => onSeekSec(r.target!.startSec as number)}>
              open in timeline ↗
            </button>
          )}
          {r.payload.commands && <div className="mt-0.5 text-[10px] text-[#6aa9c9]">M1 commands: {r.payload.commands.map((c) => c.type).join(" → ")}{r.payload.commands.length > 3 ? ` (${r.payload.commands.length})` : ""}</div>}
          {r.status === "PROPOSED" && r.payload.commands && (
            <PreviewBlock projectId={projectId} recId={r.id} flash={flash} />
          )}
          {r.result && (r.status === "EXECUTED" || r.status === "FAILED" || r.status === "STALE") && <div className="mt-0.5 text-[10px] text-[#8a8a84]">{JSON.stringify(r.result).slice(0, 220)}</div>}
          {r.status === "PROPOSED" && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <button type="button" className={btnCls} disabled={busyId === r.id || r.stale} onClick={() => void act(r.id, "preview")}>
                preview (dry-run)
              </button>
              <button type="button" className={btnCls} disabled={busyId === r.id || r.stale} onClick={() => void act(r.id, "approve-execute")}>
                <Check className="h-3 w-3" /> approve &amp; apply
              </button>
              <button type="button" className={btnCls} disabled={busyId === r.id} onClick={() => void act(r.id, "reject")}>
                <X className="h-3 w-3" /> reject
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── §8 preview (dry-run simulation — structural, not a rendered export) ─────
function PreviewBlock({ projectId, recId, flash }: { projectId: string; recId: string; flash: (k: "ok" | "err", t: string) => void }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ ok: boolean; error?: string; before?: { clipCount: number; durationSec: number }; after?: { clipCount: number; durationSec: number } | null; durationDeltaSec?: number | null; cuts?: { startSec: number; endSec: number; removedSec: number }[]; movedClips?: { clipId: string; fromStartSec: number; toStartSec: number }[]; warnings?: string[] } | null>(null);
  const load = () => {
    setOpen(true);
    if (data) return;
    jfetch<{ preview: { ok: boolean; error?: string; before?: { clipCount: number; durationSec: number }; after?: { clipCount: number; durationSec: number } | null; durationDeltaSec?: number | null; cuts?: { startSec: number; endSec: number; removedSec: number }[]; movedClips?: { clipId: string; fromStartSec: number; toStartSec: number }[]; warnings?: string[] } }>(`/api/creative/plans/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "recommendation", projectId, recommendationId: recId }),
    })
      .then((d) => setData(d.preview))
      .catch((e) => flash("err", e instanceof Error ? e.message : "Preview failed"));
  };
  return (
    <div className="mt-1">
      <button type="button" className="text-[10px] text-[#6aa9c9] hover:underline" onClick={load}>
        {open && data ? "hide preview" : "preview (before/after simulation)"}
      </button>
      {open && data && (
        <div className="mt-1 rounded border border-[#2a2a2a] bg-[#0b0b0a] p-1.5 text-[10px] text-[#a8a8a0]">
          {!data.ok && <div className="text-[#e0a094]">Simulation refused: {data.error}</div>}
          {data.ok && data.before && data.after && (
            <>
              <div>before: {data.before.clipCount} clips · {data.before.durationSec}s → after: {data.after.clipCount} clips · {data.after.durationSec}s (Δ {data.durationDeltaSec}s)</div>
              {data.cuts && data.cuts.length > 0 && <div>cuts: {data.cuts.map((c) => `${c.startSec}s–${c.endSec}s (−${c.removedSec}s)`).join(", ")}</div>}
              {data.movedClips && data.movedClips.length > 0 && <div>moved: {data.movedClips.slice(0, 6).map((m) => `${m.clipId.slice(0, 8)} ${m.fromStartSec}s→${m.toStartSec}s`).join(", ")}</div>}
              {data.warnings?.map((w, i) => (
                <div key={i} className="text-[#d4a017]">⚠ {w}</div>
              ))}
              <div className="text-[#6a6a64]">structural simulation — not a rendered export; nothing was written.</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── A/B STUDIO ──────────────────────────────────────────────────────────────
function AbTab({ projectId, tick, flash }: { projectId: string; tick: number; flash: (k: "ok" | "err", t: string) => void }) {
  const [variants, setVariants] = useState<VariantRow[]>([]);
  const [kind, setKind] = useState("hook");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    jfetch<{ variants: VariantRow[] }>(`/api/creative/variants?projectId=${projectId}`).then((d) => setVariants(d.variants)).catch(() => undefined);
  }, [projectId]);
  useEffect(() => {
    load();
  }, [load, tick]);

  const generate = async () => {
    setBusy(true);
    try {
      const d = await jfetch<{ jobId: string }>("/api/creative/variants", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "generate", projectId, kind, language: "en", instruction: instruction || null }) });
      flash("ok", `Variant generation queued (job ${d.jobId.slice(0, 8)}…).`);
      setTimeout(load, 1500);
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const registerThumbs = async () => {
    try {
      const d = await jfetch<{ registered: number; note: string }>("/api/creative/variants", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "register-thumbnails", projectId, platform: "youtube_landscape" }) });
      flash("ok", d.note);
      load();
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "Failed");
    }
  };

  const act = async (id: string, action: "apply" | "discard") => {
    try {
      const d = await jfetch<{ detail?: string; note?: string; promotedRecommendationId?: string }>(`/api/creative/variants/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      flash("ok", d.detail ?? d.note ?? "Done — decision recorded.");
      load();
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "Failed");
    }
  };

  return (
    <div className="space-y-2">
      <div className="rounded border border-[#2a2a2a] p-2">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-[#8a8a84]">Generate alternatives (creative evaluation — no performance prediction without real experiments)</div>
        <div className="flex gap-1.5">
          <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value)}>
            {["hook", "title", "description", "cta", "narration-section"].map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <input className={inputCls} placeholder="Instruction (optional)…" value={instruction} onChange={(e) => setInstruction(e.target.value)} />
          <button type="button" className={btnCls} disabled={busy} onClick={() => void generate()}>
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Generate
          </button>
        </div>
        <button type="button" className={`${btnCls} mt-1.5`} onClick={() => void registerThumbs()}>
          <GitCompareArrows className="h-3 w-3" /> Compare M9 thumbnail candidates
        </button>
      </div>
      {variants.map((v) => (
        <div key={v.id} className="rounded border border-[#2a2a2a] p-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge status={v.status.toUpperCase()} />
            <span className="text-[11px] text-[#d8d8d2]">{v.label}</span>
            <span className="text-[10px] text-[#6a6a64]">· {v.kind}</span>
          </div>
          <div className="mt-1 text-[11px] text-[#a8a8a0]">{v.description}</div>
          {v.text && <div className="mt-1 rounded bg-[#0b0b0a] p-1.5 text-[11px] text-[#d8d8d2]">{v.text}</div>}
          {v.assetId && (
            <img src={`/api/media/${v.assetId}/file`} alt="variant" className="mt-1 max-h-24 rounded border border-[#2a2a2a]" />
          )}
          {v.evaluationNote && <div className="mt-0.5 text-[9px] text-[#6a6a64]">{v.evaluationNote}</div>}
          {v.status === "PROPOSED" && (
            <div className="mt-1.5 flex gap-1.5">
              <button type="button" className={btnCls} onClick={() => void act(v.id, "apply")}>
                <Check className="h-3 w-3" /> apply
              </button>
              <button type="button" className={btnCls} onClick={() => void act(v.id, "discard")}>
                <Ban className="h-3 w-3" /> discard
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── HISTORY ─────────────────────────────────────────────────────────────────
function HistoryTab({ projectId, tick, flash }: { projectId: string; tick: number; flash: (k: "ok" | "err", t: string) => void }) {
  const { reviews, reload } = useReviews(projectId, tick);
  const cancel = async (id: string) => {
    try {
      await jfetch(`/api/creative/reviews/${id}`, { method: "DELETE" });
      flash("ok", "Review cancelled.");
      reload();
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "Failed");
    }
  };
  return (
    <div className="space-y-1.5">
      {reviews.length === 0 && <div className="text-[11px] text-[#6a6a64]">No reviews yet.</div>}
      {reviews.map((r) => (
        <div key={r.id} className="flex items-center justify-between rounded border border-[#2a2a2a] p-2">
          <div className="text-[11px] text-[#d8d8d2]">
            {r.scope} · {r.contextVersion} <Badge status={r.status.toUpperCase()} />
            {r.stale && <LabelChip label="stale" />}
            <div className="text-[10px] text-[#6a6a64]">{r.stage ?? ""} {r.error ? `· ${r.error.slice(0, 120)}` : ""} {r.model ? `· ${r.model}` : "· deterministic"}</div>
          </div>
          {(r.status === "QUEUED" || r.status === "RUNNING") && (
            <button type="button" className="text-[10px] text-[#e06c55] hover:underline" onClick={() => void cancel(r.id)}>
              cancel
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// ── VISUAL INTELLIGENCE (M12 §9) ────────────────────────────────────────────
interface VisualSceneRow {
  sceneId: string;
  assetId: string;
  index: number;
  sourceStartSec: number;
  sourceEndSec: number;
  timelinePlacements: { clipId: string; timelineStartSec: number; timelineEndSec: number }[];
  representativeFrameId: string | null;
  representativeAssetId: string | null;
  description: string | null;
  objects: string[];
  activities: string[];
  similarSceneIds: string[];
  repeatGroup: number | null;
  understanding: "semantic" | "heuristic-only";
  provider: string | null;
  model: string | null;
}
interface VisualIndexRow {
  assetId: string;
  assetName: string;
  settings: { sampleIntervalSec: number; maxFramesPerAsset: number; maxFrameWidth: number };
  frames: { frameId: string; sourceSec: number; timelineSec: number | null; status: string; analysis: { description: string; objects: string[]; shotType: string | null } | null; provider: string | null; model: string | null }[];
  scenes: VisualSceneRow[];
  measurement: { framesExtracted: number; framesDeduped: number; framesAnalyzed: number; sceneCount: number; consentVisual: boolean };
  notes: string[];
}
interface VisualMatchRow {
  segmentIndex: number;
  text: string;
  language: string;
  timelineStartSec: number | null;
  timelineEndSec: number | null;
  matchedSceneIds: string[];
  coverage: string;
  relevance: string;
  relevanceScore: number | null;
  explanation: string;
  missingData: string[];
  evidenceLabel: string;
  provider: string | null;
  model: string | null;
}
interface VisualApiPayload {
  index: { id: string; kind: string; status: string; stale: boolean; staleReason: string | null; provider: string | null; model: string | null; consentVisual: boolean; missingEvidence: string[]; result: VisualIndexRow | null; updatedAt: string } | null;
  matches: { status: string; stale: boolean; provider: string | null; model: string | null; missingEvidence: string[]; result: { matches: VisualMatchRow[]; notes: string[]; transcriptVersionNo: number | null } | null } | null;
  continuity: { status: string; stale: boolean; missingEvidence: string[]; result: { findings: FindingRow[] } | null } | null;
  review: { id: string; status: string; stage: string; progress: number; error: string | null; jobId: string | null } | null;
}
interface VisualSearchHit {
  sceneId: string;
  representativeAssetId: string | null;
  sourceStartSec: number;
  sourceEndSec: number;
  timelineStartSec: number | null;
  description: string | null;
  relevanceScore: number;
  evidence: string;
}

function VisualTab({ projectId, tick, flash, onSeekSec }: { projectId: string; tick: number; flash: (k: "ok" | "err", t: string) => void; onSeekSec?: (sec: number) => void }) {
  const [data, setData] = useState<VisualApiPayload | null>(null);
  const [consent, setConsent] = useState(false);
  const [maxFrames, setMaxFrames] = useState(16);
  const [sampleSec, setSampleSec] = useState(4);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchRes, setSearchRes] = useState<{ available: boolean; method: string; results: VisualSearchHit[]; notes: string[] } | null>(null);
  const [openScene, setOpenScene] = useState<string | null>(null);

  const load = useCallback(() => {
    jfetch<VisualApiPayload>(`/api/creative/visual/index?projectId=${projectId}`).then(setData).catch(() => undefined);
  }, [projectId]);
  useEffect(() => {
    load();
  }, [load, tick]);

  const run = async () => {
    setBusy(true);
    try {
      const d = await jfetch<{ jobId: string; estimatedVisionCalls: string }>("/api/creative/visual/index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, consentVisual: consent, settings: { maxFramesPerAsset: maxFrames, sampleIntervalSec: sampleSec } }),
      });
      flash("ok", `Visual intelligence queued (job ${d.jobId.slice(0, 8)}…). ${d.estimatedVisionCalls}`);
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "Failed to queue");
    } finally {
      setBusy(false);
    }
  };

  const doSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    try {
      const d = await jfetch<{ available: boolean; method: string; results: VisualSearchHit[]; notes: string[] }>("/api/creative/visual/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, query }),
      });
      setSearchRes(d);
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "Search failed");
    } finally {
      setSearching(false);
    }
  };

  const index = data?.index?.result ?? null;
  const running = data?.review && (data.review.status === "QUEUED" || data.review.status === "RUNNING");
  const seeking = (tl: number | null) => {
    if (tl !== null && onSeekSec) onSeekSec(tl);
  };

  return (
    <div className="space-y-2.5">
      {/* run controls */}
      <div className="rounded border border-[#2a2a2a] p-2">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-[10px] text-[#a8a8a0]">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            consent: send extracted frames (≤{maxFrames} JPEG, ≤512 px) to the configured vision provider
          </label>
          <select className={`${inputCls} max-w-[86px]`} value={maxFrames} onChange={(e) => setMaxFrames(Number(e.target.value))}>
            {[8, 16, 24].map((n) => (
              <option key={n} value={n}>{n} frames</option>
            ))}
          </select>
          <select className={`${inputCls} max-w-[96px]`} value={sampleSec} onChange={(e) => setSampleSec(Number(e.target.value))}>
            {[2, 4, 8].map((n) => (
              <option key={n} value={n}>every {n}s</option>
            ))}
          </select>
          <button type="button" className={btnCls} disabled={busy || Boolean(running)} onClick={() => void run()}>
            {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Eye className="h-3 w-3" />} {running ? "running…" : "Run visual intelligence"}
          </button>
        </div>
        <div className="mt-1 text-[9px] text-[#6a6a64]">Without consent the run is deterministic-only (frames never leave the server; no semantic descriptions). Never Ollama. {data?.review ? `Review ${data.review.status} ${data.review.stage} (${data.review.progress}%)` : ""}</div>
        {data?.review?.error && <div className="mt-1 text-[10px] text-[#e0a094]">{data.review.error}</div>}
      </div>

      {data?.index && (
        <div className="text-[9px] text-[#6a6a64]">
          index {data.index.status}
          {data.index.stale && <span className="text-[#e0a094]"> · STALE: {data.index.staleReason ?? "reason pending"}</span>} · provider {data.index.provider ?? "—"} / {data.index.model ?? "—"}
        </div>
      )}
      {(data?.index?.missingEvidence?.length ?? 0) > 0 && (
        <div className="rounded border border-[#4a3a20] bg-[#1a150c] p-1.5 text-[9px] text-[#d4a017]">
          {data?.index?.missingEvidence.slice(0, 4).map((m, i) => <div key={i}>· {m}</div>)}
        </div>
      )}

      {/* Scene Browser + Frame Evidence Inspector */}
      {index && (
        <div>
          <div className={labelCls}>Scene Browser — {index.scenes.length} scene(s) of {index.assetName.slice(0, 40)} · {index.measurement.framesAnalyzed} analyzed / {index.measurement.framesExtracted} extracted ({index.measurement.framesDeduped} deduped)</div>
          <div className="mt-1 grid grid-cols-2 gap-1.5">
            {index.scenes.map((s) => (
              <div key={s.sceneId} className="rounded border border-[#2a2a2a] p-1.5">
                {s.representativeAssetId ? (
                  <img src={`/api/media/${s.representativeAssetId}/file`} alt={`scene ${s.index}`} className="mb-1 h-20 w-full cursor-pointer rounded object-cover" onClick={() => setOpenScene(openScene === s.sceneId ? null : s.sceneId)} />
                ) : (
                  <div className="mb-1 flex h-20 w-full items-center justify-center rounded bg-[#0b0b0a] text-[9px] text-[#6a6a64]" onClick={() => setOpenScene(openScene === s.sceneId ? null : s.sceneId)}>no registered frame</div>
                )}
                <div className="flex items-center gap-1 text-[9px] text-[#a8a8a0]">
                  <span className="text-[#d4a017]">#{s.index}</span> src {s.sourceStartSec.toFixed(1)}–{s.sourceEndSec.toFixed(1)}s
                  {s.timelinePlacements[0] && (
                    <button type="button" className="text-[#6aa9c9] hover:underline" onClick={() => seeking(s.timelinePlacements[0].timelineStartSec)}>
                      tl {s.timelinePlacements[0].timelineStartSec.toFixed(1)}s ↗
                    </button>
                  )}
                  <span style={{ color: s.understanding === "semantic" ? "#7fb069" : "#8a8a84" }}>{s.understanding}</span>
                  {s.repeatGroup !== null && <span className="text-[#d4a017]">repeat×{s.similarSceneIds.length + 1}</span>}
                </div>
                {s.description && <div className="mt-0.5 line-clamp-2 text-[9px] text-[#d8d8d2]">{s.description}</div>}
                {s.objects.length > 0 && <div className="mt-0.5 text-[9px] text-[#6a6a64]">{s.objects.slice(0, 5).join(", ")}</div>}
                {openScene === s.sceneId && (
                  <div className="mt-1 rounded bg-[#0b0b0a] p-1">
                    <div className={labelCls}>Frame Evidence Inspector</div>
                    {index.frames.filter((f) => Math.abs(f.sourceSec - (s.sourceStartSec + s.sourceEndSec) / 2) < (s.sourceEndSec - s.sourceStartSec) / 2 + 0.3).slice(0, 4).map((f) => (
                      <div key={f.frameId} className="mt-0.5 text-[9px] text-[#a8a8a0]">
                        <span className="text-[#d4a017]">{f.sourceSec.toFixed(2)}s</span> (tl {f.timelineSec?.toFixed(2) ?? "—"}s) {f.status}
                        {f.analysis && <> · {f.analysis.description.slice(0, 140)}</>}
                        {f.provider && <> · {f.provider}/{f.model}</>}
                      </div>
                    ))}
                    {s.similarSceneIds.length > 0 && <div className="mt-0.5 text-[9px] text-[#6a6a64]">similar: {s.similarSceneIds.join(", ")}</div>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {!index && !running && <div className="text-[11px] text-[#6a6a64]">No visual index yet — run Visual Intelligence to extract REAL frames{consent ? " and analyze them with the configured vision provider" : " (add consent for semantic descriptions)"}.</div>}

      {/* Visual Search */}
      {index && (
        <div>
          <div className={labelCls}>Visual Search (natural language, EN/TA)</div>
          <div className="mt-1 flex gap-1.5">
            <input className={inputCls} placeholder='e.g. "scenes with a person speaking" / "கணினி காட்சிகள்"' value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !searching) void doSearch(); }} />
            <button type="button" className={btnCls} disabled={searching} onClick={() => void doSearch()}>
              {searching ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />}
            </button>
          </div>
          {searchRes && (
            <div className="mt-1 space-y-1">
              <div className="text-[9px] text-[#6a6a64]">method: {searchRes.method}{searchRes.notes.length > 0 && ` · ${searchRes.notes[0]}`}</div>
              {searchRes.results.map((r) => (
                <div key={r.sceneId} className="flex gap-1.5 rounded border border-[#2a2a2a] p-1.5">
                  {r.representativeAssetId && <img src={`/api/media/${r.representativeAssetId}/file`} alt="result" className="h-12 w-20 rounded object-cover" />}
                  <div className="flex-1 text-[9px] text-[#a8a8a0]">
                    <span className="text-[#d4a017]">{(r.relevanceScore * 100).toFixed(0)}%</span> src {r.sourceStartSec.toFixed(1)}–{r.sourceEndSec.toFixed(1)}s
                    {r.timelineStartSec !== null && (
                      <button type="button" className="ml-1 text-[#6aa9c9] hover:underline" onClick={() => seeking(r.timelineStartSec)}>
                        tl {r.timelineStartSec.toFixed(1)}s ↗
                      </button>
                    )}
                    <div>{r.description ?? "(heuristic-only scene)"}</div>
                    <div className="text-[#6a6a64]">{r.evidence.slice(0, 160)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Narration Match */}
      {data?.matches?.result && (
        <div>
          <div className={labelCls}>Narration Match — transcript v{data.matches.result.transcriptVersionNo ?? "?"} × scenes {data.matches.provider ? `(${data.matches.provider}/${data.matches.model})` : "(coverage-only)"}</div>
          {data.matches.result.matches.slice(0, 10).map((m) => (
            <div key={m.segmentIndex} className="mt-1 rounded border border-[#2a2a2a] p-1.5 text-[9px]">
              <div className="flex flex-wrap items-center gap-1">
                <LabelChip label={m.evidenceLabel} />
                <span className="text-[#d8d8d2]">[{m.coverage}]</span>
                <span style={{ color: m.relevance === "supported" ? "#7fb069" : m.relevance === "unrelated" ? "#e0a094" : "#a8a8a0" }}>{m.relevance}</span>
                {m.timelineStartSec !== null && (
                  <button type="button" className="text-[#6aa9c9] hover:underline" onClick={() => seeking(m.timelineStartSec)}>
                    tl {m.timelineStartSec.toFixed(1)}s ↗
                  </button>
                )}
              </div>
              <div className="mt-0.5 text-[#a8a8a0]">&ldquo;{m.text.slice(0, 160)}&rdquo;</div>
              <div className="text-[#6a6a64]">{m.explanation.slice(0, 220)}</div>
              {m.missingData.length > 0 && <div className="text-[#e0a094]">missing: {m.missingData[0]}</div>}
            </div>
          ))}
        </div>
      )}

      {/* Visual Continuity Review */}
      {data?.continuity?.result && (
        <div>
          <div className={labelCls}>Visual Continuity Review</div>
          {data.continuity.result.findings.slice(0, 8).map((f) => (
            <div key={f.findingNo} className="mt-1 rounded border border-[#2a2a2a] p-1.5 text-[9px]">
              <div className="flex items-center gap-1">
                <LabelChip label={f.evidenceLabel} />
                <span className="text-[#d8d8d2]">{f.category}</span>
                {f.startSec !== null && (
                  <button type="button" className="text-[#6aa9c9] hover:underline" onClick={() => seeking(f.startSec)}>
                    {f.startSec.toFixed(1)}s ↗
                  </button>
                )}
                <span className="text-[#6a6a64]">conf {f.confidence?.toFixed(2) ?? "—"}</span>
              </div>
              <div className="text-[#a8a8a0]">{f.explanation.slice(0, 220)}</div>
            </div>
          ))}
        </div>
      )}
      <div className="text-[9px] text-[#6a6a64]">Scene boundaries are deterministic ffmpeg detections; descriptions exist ONLY where a real vision provider inspected extracted frames. Mismatches are observations, not editing errors.</div>
    </div>
  );
}

// ── MOTION / TEMPORAL INTELLIGENCE (M13 §10) ────────────────────────────────
interface TemporalTrackRow {
  trackId: string;
  category: string | null;
  categoryProvenance: string | null;
  samples: { sourceSec: number; timelineSec: number | null; nx: number; ny: number; confidence: number; visibility: string; bbox: { x: number; y: number; w: number; h: number } }[];
  entrySourceSec: number;
  exitSourceSec: number;
  entryTimelineSec: number | null;
  exitTimelineSec: number | null;
  occlusionIntervals: { startSec: number; endSec: number; reason: string }[];
  terminationReason: string;
  confidence: number | null;
  reappearsAs: string[];
  provider: string | null;
}
interface TemporalIndexRow {
  assetName: string;
  width: number | null;
  height: number | null;
  settings: { sampleFps: number; windowSec: number; maxTracks: number; providerLabels: boolean };
  tracks: TemporalTrackRow[];
  motion: { trackId: string; direction: string | null; speedPxPerSec: number | null; displacementPx: number; accelTrend: string | null; repeatedPatternSec: number | null; suddenJumps: { sourceSec: number; px: number }[]; limitations: string }[];
  camera: { windowIndex: number; classification: string; medianDxPx: number | null; medianDyPx: number | null; medianScaleRatio: number | null; confidence: number | null; note: string }[];
  events: { eventId: string; type: string; sourceStartSec: number; sourceEndSec: number; timelineStartSec: number | null; description: string; evidenceLabel: string; confidence: number | null; trackIds: string[] }[];
  sceneSummaries: { sceneId: string; description: string | null; representativeAssetId: string | null; sourceStartSec: number }[];
  measurement: { framesSampled: number; windows: number; tracksTotal: number; tracksLost: number; cameraClassified: number; providerLabelsUsed: number; consentVisual: boolean };
  notes: string[];
}
interface MographProposalRow {
  proposalId: string;
  trackId: string;
  label: string;
  primaryText: string;
  templateId: string;
  durationFrames: number;
  keyframes: { property: string; frame: number; value: number }[];
  gaps: { fromFrame: number; toFrame: number; note: string }[];
  warnings: string[];
  previewAssetIds: string[];
  confidence: number | null;
}
interface TemporalApiPayload {
  index: { status: string; stale: boolean; staleReason: string | null; provider: string | null; consentVisual: boolean; missingEvidence: string[]; result: TemporalIndexRow | null } | null;
  mograph: { status: string; stale: boolean; result: { proposals: MographProposalRow[] } | null } | null;
  review: { status: string; stage: string; progress: number; error: string | null } | null;
}
interface TemporalSearchHit {
  kind: string;
  refId: string;
  sourceStartSec: number;
  sourceEndSec: number;
  timelineStartSec: number | null;
  description: string | null;
  previewAssetId: string | null;
  relevanceScore: number;
  evidence: string;
}

function MotionTab({ projectId, tick, flash, onSeekSec }: { projectId: string; tick: number; flash: (k: "ok" | "err", t: string) => void; onSeekSec?: (sec: number) => void }) {
  const [data, setData] = useState<TemporalApiPayload | null>(null);
  const [consent, setConsent] = useState(false);
  const [sampleFps, setSampleFps] = useState(5);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchRes, setSearchRes] = useState<{ available: boolean; method: string; results: TemporalSearchHit[]; notes: string[] } | null>(null);
  const [openTrack, setOpenTrack] = useState<string | null>(null);
  const [mographBusy, setMographBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    jfetch<TemporalApiPayload>(`/api/creative/temporal/index?projectId=${projectId}`).then(setData).catch(() => undefined);
  }, [projectId]);
  useEffect(() => {
    load();
  }, [load, tick]);

  const run = async () => {
    setBusy(true);
    try {
      const d = await jfetch<{ jobId: string; disclosure: string }>("/api/creative/temporal/index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, consentVisual: consent, settings: { sampleFps, providerLabels: consent } }),
      });
      flash("ok", `Motion analysis queued (job ${d.jobId.slice(0, 8)}…). ${d.disclosure}`);
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "Failed to queue");
    } finally {
      setBusy(false);
    }
  };

  const doSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    try {
      const d = await jfetch<{ available: boolean; method: string; results: TemporalSearchHit[]; notes: string[] }>("/api/creative/temporal/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, query }),
      });
      setSearchRes(d);
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "Search failed");
    } finally {
      setSearching(false);
    }
  };

  const buildMograph = async (trackId: string) => {
    setMographBusy(trackId);
    try {
      const d = await jfetch<{ proposal: MographProposalRow; note: string }>("/api/creative/temporal/mograph", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, trackId }),
      });
      flash("ok", `Motion-graphics proposal built (${d.proposal.keyframes.length} keyframes) — approve it in the Recommendations tab.`);
    } catch (e) {
      flash("err", e instanceof Error ? e.message : "Proposal failed");
    } finally {
      setMographBusy(null);
    }
  };

  const index = data?.index?.result ?? null;
  const running = data?.review && (data.review.status === "QUEUED" || data.review.status === "RUNNING");
  const seeking = (tl: number | null) => {
    if (tl !== null && onSeekSec) onSeekSec(tl);
  };

  return (
    <div className="space-y-2.5">
      <div className="rounded border border-[#2a2a2a] p-2">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-[10px] text-[#a8a8a0]">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            consent: label tracked subjects with the vision provider (≤4 small crops)
          </label>
          <select className={`${inputCls} max-w-[110px]`} value={sampleFps} onChange={(e) => setSampleFps(Number(e.target.value))}>
            {[3, 5, 8, 10].map((n) => (
              <option key={n} value={n}>{n} fps sampling</option>
            ))}
          </select>
          <button type="button" className={btnCls} disabled={busy || Boolean(running)} onClick={() => void run()}>
            {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Activity className="h-3 w-3" />} {running ? "tracking…" : "Run motion analysis"}
          </button>
        </div>
        <div className="mt-1 text-[9px] text-[#6a6a64]">Local tracking (OpenCV CSRT) and camera registration upload NOTHING — consent only controls optional subject labeling. {data?.review ? `Review ${data.review.status} ${data.review.stage} (${data.review.progress}%)` : ""}</div>
        {data?.review?.error && <div className="mt-1 text-[10px] text-[#e0a094]">{data.review.error}</div>}
      </div>

      {data?.index && (
        <div className="text-[9px] text-[#6a6a64]">
          temporal index {data.index.status}
          {data.index.stale && <span className="text-[#e0a094]"> · STALE: {data.index.staleReason ?? "reason pending"}</span>} · {index?.measurement.framesSampled ?? 0} frames / {index?.measurement.windows ?? 0} windows
        </div>
      )}
      {(data?.index?.missingEvidence?.length ?? 0) > 0 && (
        <div className="rounded border border-[#4a3a20] bg-[#1a150c] p-1.5 text-[9px] text-[#d4a017]">
          {data?.index?.missingEvidence.slice(0, 4).map((m, i) => <div key={i}>· {m}</div>)}
        </div>
      )}

      {index && (
        <>
          {/* Object Tracks + Track Inspector */}
          <div>
            <div className={labelCls}>Object Tracks — {index.tracks.length} track(s) ({index.measurement.tracksLost} lost) of {index.assetName.slice(0, 36)}</div>
            {index.tracks.map((t) => {
              const m = index.motion.find((mm) => mm.trackId === t.trackId);
              return (
                <div key={t.trackId} className="mt-1 rounded border border-[#2a2a2a] p-1.5 text-[9px]">
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="text-[#d4a017]">{t.category ?? "subject"}</span>
                    <span className="text-[#6a6a64]">({t.categoryProvenance})</span>
                    <span className="text-[#a8a8a0]">{t.samples.length} samples</span>
                    <span style={{ color: t.terminationReason === "tracker-lost" ? "#e06c55" : "#7fb069" }}>{t.terminationReason}</span>
                    {t.entryTimelineSec !== null && (
                      <button type="button" className="text-[#6aa9c9] hover:underline" onClick={() => seeking(t.entryTimelineSec)}>
                        entry {t.entryTimelineSec.toFixed(1)}s ↗
                      </button>
                    )}
                    <span className="text-[#6a6a64]">exit {t.exitSourceSec.toFixed(1)}s{t.exitTimelineSec !== null ? ` (tl ${t.exitTimelineSec.toFixed(1)}s)` : ""}</span>
                    {t.occlusionIntervals.length > 0 && <span className="text-[#d4a017]">occl×{t.occlusionIntervals.length}</span>}
                    {t.reappearsAs.length > 0 && <span className="text-[#6aa9c9]">reappears→{t.reappearsAs.length} (inferred)</span>}
                    <span className="text-[#6a6a64]">conf {t.confidence?.toFixed(2) ?? "—"}</span>
                  </div>
                  {m && (
                    <div className="mt-0.5 text-[#a8a8a0]">
                      {m.direction ?? "unknown"} · {m.speedPxPerSec?.toFixed(1) ?? "0"} px/s · {m.displacementPx.toFixed(0)} px total{m.accelTrend && m.accelTrend !== "insufficient-data" ? ` · ${m.accelTrend}` : ""}
                      {m.repeatedPatternSec ? ` · repeats ~${m.repeatedPatternSec}s` : ""}
                    </div>
                  )}
                  <div className="mt-0.5 flex gap-1.5">
                    <button type="button" className="text-[#6aa9c9] hover:underline" onClick={() => setOpenTrack(openTrack === t.trackId ? null : t.trackId)}>
                      {openTrack === t.trackId ? "hide inspector" : "track inspector"}
                    </button>
                    <button type="button" className="text-[#7fb069] hover:underline" disabled={mographBusy === t.trackId} onClick={() => void buildMograph(t.trackId)}>
                      {mographBusy === t.trackId ? "building…" : "motion graphic ⟶"}
                    </button>
                  </div>
                  {openTrack === t.trackId && (
                    <div className="mt-1 rounded bg-[#0b0b0a] p-1">
                      {t.samples.slice(0, 12).map((s, i) => (
                        <div key={i} className="text-[9px] text-[#a8a8a0]">
                          <span className="text-[#d4a017]">{s.sourceSec.toFixed(2)}s</span> (tl {s.timelineSec?.toFixed(2) ?? "—"}s) box [{s.bbox.x},{s.bbox.y} {s.bbox.w}×{s.bbox.h}] center ({s.nx.toFixed(2)},{s.ny.toFixed(2)}) {s.visibility}
                          {s.timelineSec !== null && (
                            <button type="button" className="ml-1 text-[#6aa9c9] hover:underline" onClick={() => seeking(s.timelineSec)}>
                              ↗
                            </button>
                          )}
                        </div>
                      ))}
                      {t.occlusionIntervals.slice(0, 2).map((o, i) => (
                        <div key={`o${i}`} className="text-[9px] text-[#e0a094]">occlusion {o.startSec.toFixed(2)}–{o.endSec.toFixed(2)}s: {o.reason}</div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Camera Movement */}
          {index.camera.length > 0 && (
            <div>
              <div className={labelCls}>Camera Movement — {index.measurement.cameraClassified} window(s) classified</div>
              {index.camera.map((c) => (
                <div key={c.windowIndex} className="mt-1 rounded border border-[#2a2a2a] p-1.5 text-[9px]">
                  <div className="flex items-center gap-1">
                    <span style={{ color: c.classification === "static" ? "#7fb069" : c.classification === "uncertain" ? "#8a8a84" : "#d4a017" }}>{c.classification}</span>
                    <span className="text-[#6a6a64]">conf {c.confidence?.toFixed(2) ?? "—"} · window {c.windowIndex}</span>
                  </div>
                  <div className="text-[#a8a8a0]">median {c.medianDxPx?.toFixed(1) ?? "?"}px/frame x · {c.medianDyPx?.toFixed(1) ?? "?"}px/frame y · scale {c.medianScaleRatio?.toFixed(4) ?? "n/a"}</div>
                  <div className="text-[#6a6a64]">{c.note.slice(0, 180)}</div>
                </div>
              ))}
            </div>
          )}

          {/* Temporal Events */}
          <div>
            <div className={labelCls}>Temporal Events — {index.events.length} observation(s)</div>
            {index.events.slice(0, 10).map((e) => (
              <div key={e.eventId} className="mt-1 rounded border border-[#2a2a2a] p-1.5 text-[9px]">
                <div className="flex flex-wrap items-center gap-1">
                  <LabelChip label={e.evidenceLabel} />
                  <span className="text-[#d8d8d2]">{e.type}</span>
                  {e.timelineStartSec !== null && (
                    <button type="button" className="text-[#6aa9c9] hover:underline" onClick={() => seeking(e.timelineStartSec)}>
                      {e.timelineStartSec.toFixed(1)}s ↗
                    </button>
                  )}
                  <span className="text-[#6a6a64]">conf {e.confidence?.toFixed(2) ?? "—"}</span>
                </div>
                <div className="text-[#a8a8a0]">{e.description.slice(0, 200)}</div>
              </div>
            ))}
          </div>

          {/* Temporal Search */}
          <div>
            <div className={labelCls}>Temporal Search (tracks · motion · camera · events)</div>
            <div className="mt-1 flex gap-1.5">
              <input className={inputCls} placeholder='e.g. "moving left to right" / "camera pan" / "almost no movement"' value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !searching) void doSearch(); }} />
              <button type="button" className={btnCls} disabled={searching} onClick={() => void doSearch()}>
                {searching ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />}
              </button>
            </div>
            {searchRes && (
              <div className="mt-1 space-y-1">
                <div className="text-[9px] text-[#6a6a64]">method: {searchRes.method}{searchRes.notes.length > 0 && ` · ${searchRes.notes[0]}`}</div>
                {searchRes.results.map((r) => (
                  <div key={r.refId} className="flex gap-1.5 rounded border border-[#2a2a2a] p-1.5">
                    {r.previewAssetId && <img src={`/api/media/${r.previewAssetId}/file`} alt="result" className="h-10 w-16 rounded object-cover" />}
                    <div className="flex-1 text-[9px] text-[#a8a8a0]">
                      <span className="text-[#d4a017]">{(r.relevanceScore * 100).toFixed(0)}%</span> {r.kind} · src {r.sourceStartSec.toFixed(1)}–{r.sourceEndSec.toFixed(1)}s
                      {r.timelineStartSec !== null && (
                        <button type="button" className="ml-1 text-[#6aa9c9] hover:underline" onClick={() => seeking(r.timelineStartSec)}>
                          tl {r.timelineStartSec.toFixed(1)}s ↗
                        </button>
                      )}
                      <div>{r.description?.slice(0, 140)}</div>
                      <div className="text-[#6a6a64]">{r.evidence.slice(0, 140)}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Motion Graphics Proposals (from the run artifact) */}
          {data?.mograph?.result?.proposals && data.mograph.result.proposals.length > 0 && (
            <div>
              <div className={labelCls}>Motion Graphics Proposals — approve in the Recommendations tab</div>
              {data.mograph.result.proposals.map((p) => (
                <div key={p.proposalId} className="mt-1 rounded border border-[#2a2a2a] p-1.5 text-[9px]">
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="text-[#7fb069]">{p.label}</span>
                    <span className="text-[#6a6a64]">{p.keyframes.length} keyframes · {p.durationFrames} frames · template {p.templateId}</span>
                    {p.gaps.length > 0 && <span className="text-[#d4a017]">gaps×{p.gaps.length} (held, not extrapolated)</span>}
                  </div>
                  <div className="mt-0.5 flex gap-1">
                    {p.previewAssetIds.slice(0, 3).map((a) => (
                      <img key={a} src={`/api/media/${a}/file`} alt="preview" className="h-10 w-16 rounded object-cover" />
                    ))}
                  </div>
                  {p.warnings.slice(0, 2).map((w, i) => (
                    <div key={i} className="text-[#e0a094]">{w}</div>
                  ))}
                </div>
              ))}
            </div>
          )}
          <div className="text-[9px] text-[#6a6a64]">Tracks are real OpenCV CSRT correspondences across consecutive frames. Pixel speeds are not real-world speeds. Lost tracking produces broken tracks — identity is never invented across gaps.</div>
        </>
      )}
      {!index && !running && <div className="text-[11px] text-[#6a6a64]">No temporal index yet — run Motion Analysis to sample consecutive frames and track real subjects{consent ? " (provider labeling on)" : ""}.</div>}
    </div>
  );
}

// ── M14 COMPOSE WORKSPACE (§10) ─────────────────────────────────────────────
interface M14Candidate { id: string; name?: string; direction: M14Direction }
interface M14Direction {
  name: string;
  rationale: string;
  styleProfile: { palette: { hex: string; role: string; source: string }[]; medium: string; composition: string; consistencyRules: string[] };
  typography: string;
  motionLanguage: string;
  constraints: string[];
}
interface M14Scene { sceneId: string; startSec: number; endSec: number; timingSource: string; visualConcept: string; onScreenText: string; approvalStatus: string; evidence: string }
interface M14Plan { id: string; version: number; doc: { scenes: M14Scene[]; notes: string[] } }
interface M14Layer {
  id: string; name: string; kind: string; sourceAssetId: string | null; color: string | null; text: string | null;
  visible: boolean; locked: boolean; blend: string;
  transform: { x: number; y: number; scale: number; rotation: number; opacity: number };
  startFrame: number; endFrame: number;
  keyframes: { id: string; property: string; frame: number; value: number; interpolation: string }[];
  trackBinding: { temporalTrackId: string; attachedFrameRange: { startFrame: number; endFrame: number } } | null;
}
interface M14Doc { width: number; height: number; fps: number; durationFrames: number; layers: M14Layer[] }
interface M14Composition { id: string; name: string; version: number; doc: M14Doc; versions: { version: number; note: string | null }[] }

function ComposeTab({ projectId, tick, flash }: { projectId: string; tick: number; flash: (k: "ok" | "err", t: string) => void }) {
  const [section, setSection] = useState<"direction" | "scenes" | "assets" | "composition" | "motion" | "review">("direction");
  const [candidates, setCandidates] = useState<{ id: string; name: string; direction: M14Direction }[]>([]);
  const [approved, setApproved] = useState<{ id: string; direction: M14Direction } | null>(null);
  const [story, setStory] = useState("");
  const [style, setStyle] = useState("");
  const [intensity, setIntensity] = useState("moderate");
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<M14Plan | null>(null);
  const [assets, setAssets] = useState<{ assetId: string; role: string; hasAlpha: boolean }[]>([]);
  const [comps, setComps] = useState<{ id: string; name: string; version: number }[]>([]);
  const [comp, setComp] = useState<M14Composition | null>(null);
  const [renderMsg, setRenderMsg] = useState<string | null>(null);

  const loadAll = useCallback(() => {
    jfetch<{ candidates: { id: string; name: string; direction: M14Direction }[]; approved: { id: string; direction: M14Direction } | null }>(`/api/creative/m14/direction?projectId=${projectId}`).then((d) => { setCandidates(d.candidates); setApproved(d.approved); }).catch(() => undefined);
    jfetch<{ plan: M14Plan | null }>(`/api/creative/m14/scenes?projectId=${projectId}`).then((d) => setPlan(d.plan)).catch(() => undefined);
    jfetch<{ compositions: { id: string; name: string; version: number }[] }>(`/api/creative/m14/compose?projectId=${projectId}`).then((d) => setComps(d.compositions)).catch(() => undefined);
  }, [projectId]);
  useEffect(() => {
    loadAll();
  }, [loadAll, tick]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      flash("err", e instanceof Error ? e.message.slice(0, 220) : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const openComp = (id: string) => {
    void run(async () => {
      const d = await jfetch<M14Composition>(`/api/creative/m14/compose?projectId=${projectId}&compositionId=${id}`);
      setComp(d);
    });
  };

  const commitDoc = (doc: M14Doc, note: string) => {
    if (!comp) return;
    void run(async () => {
      const d = await jfetch<{ version: number; issues: string[] }>("/api/creative/m14/compose", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, compositionId: comp.id, expectedVersion: comp.version, doc, note }),
      });
      setComp({ ...comp, version: d.version, doc });
      if (d.issues.length > 0) flash("err", `Committed v${d.version} with warnings: ${d.issues[0]}`);
      else flash("ok", `Committed v${d.version} (undo = switch to v${d.version - 1}).`);
    });
  };

  const mutateLayer = (layerId: string, mut: (l: M14Layer) => void, note: string) => {
    if (!comp) return;
    const doc = JSON.parse(JSON.stringify(comp.doc)) as M14Doc;
    const layer = doc.layers.find((l) => l.id === layerId);
    if (!layer || layer.locked) {
      if (layer?.locked) flash("err", "Layer is locked.");
      return;
    }
    mut(layer);
    commitDoc(doc, note);
  };

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap gap-1">
        {(["direction", "scenes", "assets", "composition", "motion", "review"] as const).map((s) => (
          <button key={s} type="button" onClick={() => setSection(s)} className={`rounded border px-2 py-0.5 text-[10px] uppercase ${section === s ? "border-[#d4a017] text-[#d4a017]" : "border-[#2a2a2a] text-[#8a8a84] hover:text-[#d8d8d2]"}`}>
            {s}
          </button>
        ))}
      </div>

      {/* ART DIRECTION */}
      {section === "direction" && (
        <div className="space-y-2">
          <div className={labelCls}>Art Direction — 3 candidates, approval-gated</div>
          <input className={inputCls} placeholder="Story/product brief" value={story} onChange={(e) => setStory(e.target.value)} />
          <div className="flex gap-1.5">
            <input className={inputCls} placeholder="Requested style (optional)" value={style} onChange={(e) => setStyle(e.target.value)} />
            <select className={`${inputCls} max-w-[110px]`} value={intensity} onChange={(e) => setIntensity(e.target.value)}>
              {["subtle", "moderate", "dynamic"].map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
            <button type="button" className={btnCls} disabled={busy || !story.trim()} onClick={() => void run(async () => {
              const d = await jfetch<{ directions: { id: string; direction: M14Direction }[]; disclosure: string }>("/api/creative/m14/direction", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ projectId, brief: { storyOrProduct: story, requestedStyle: style, motionIntensity: intensity, format: "16:9" } }),
              });
              setCandidates(d.directions.map((x) => ({ id: x.id, name: x.direction.name, direction: x.direction })));
              flash("ok", d.disclosure.slice(0, 200));
            })}>
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />} Generate 3
            </button>
          </div>
          {candidates.map((c) => (
            <div key={c.id} className="rounded border border-[#2a2a2a] p-2 text-[10px]">
              <div className="flex items-center gap-1">
                <span className="text-[#d4a017]">{c.direction.name}</span>
                <div className="flex gap-0.5">{c.direction.styleProfile.palette.slice(0, 6).map((p, i) => <span key={i} className="h-3 w-3 rounded-sm border border-[#2a2a2a]" style={{ background: p.hex }} title={`${p.role} (${p.source})`} />)}</div>
                <button type="button" className="ml-auto text-[#7fb069] hover:underline" onClick={() => void run(async () => {
                  await jfetch("/api/creative/m14/direction", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, directionId: c.id, action: "approve" }) });
                  flash("ok", `"${c.direction.name}" approved — asset generation now unlocked.`);
                  loadAll();
                })}>approve</button>
              </div>
              <div className="text-[#a8a8a0]">{c.direction.rationale.slice(0, 180)}</div>
              <div className="text-[#6a6a64]">{c.direction.styleProfile.medium} · {c.direction.styleProfile.composition}</div>
              {c.direction.constraints.slice(0, 1).map((x, i) => <div key={i} className="text-[#e0a094]">{x}</div>)}
            </div>
          ))}
          {approved && <div className="text-[10px] text-[#7fb069]">Approved: {approved.direction.name} — assets may now derive from its style profile.</div>}
        </div>
      )}

      {/* SCENE PLAN */}
      {section === "scenes" && (
        <div className="space-y-2">
          <div className={labelCls}>Scene Plan — RIISHE-verbatim timings, editable</div>
          <button type="button" className={btnCls} disabled={busy} onClick={() => void run(async () => {
            const d = await jfetch<{ plan: M14Plan["doc"] }>("/api/creative/m14/scenes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, artDirectionId: approved?.id ?? null, brief: { language: "en" } }) });
            flash("ok", `Scene plan built (${d.plan.scenes.length} scenes).`);
            loadAll();
          })}>
            Build plan from narration
          </button>
          {plan?.doc.scenes.map((s) => (
            <div key={s.sceneId} className="rounded border border-[#2a2a2a] p-1.5 text-[10px]">
              <div className="flex flex-wrap items-center gap-1">
                <span className="text-[#d4a017]">{s.sceneId}</span>
                <span className="text-[#a8a8a0]">{s.startSec.toFixed(1)}–{s.endSec.toFixed(1)}s</span>
                <span className={s.timingSource === "riishe-verbatim" ? "text-[#7fb069]" : "text-[#d4a017]"}>{s.timingSource === "riishe-verbatim" ? "verbatim" : "ESTIMATE"}</span>
                <span className="text-[#6a6a64]">{s.approvalStatus}</span>
                <button type="button" className="text-[#7fb069] hover:underline" onClick={() => void run(async () => {
                  await jfetch("/api/creative/m14/scenes", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, planId: plan.id, approve: [s.sceneId] }) });
                  loadAll();
                })}>approve</button>
                <button type="button" className="text-[#6aa9c9] hover:underline" onClick={() => void run(async () => {
                  await jfetch("/api/creative/m14/scenes", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, planId: plan.id, sceneId: s.sceneId }) });
                  flash("ok", `Scene ${s.sceneId} regenerated (approved scenes untouched).`);
                  loadAll();
                })}>regenerate</button>
              </div>
              <div className="text-[#a8a8a0]">{s.visualConcept.slice(0, 160) || "(no concept yet)"}</div>
              {s.onScreenText && <div className="text-[#d8d8d2]">on-screen: {s.onScreenText}</div>}
            </div>
          ))}
          {plan?.doc.notes.slice(0, 2).map((n, i) => <div key={i} className="text-[9px] text-[#6a6a64]">{n}</div>)}
        </div>
      )}

      {/* VISUAL ASSETS */}
      {section === "assets" && (
        <div className="space-y-2">
          <div className={labelCls}>Visual Assets — LAXII, approved direction required</div>
          {!approved && <div className="text-[10px] text-[#e0a094]">Approve an art direction first — nothing is generated without approval.</div>}
          {approved && plan && (
            <button type="button" className={btnCls} disabled={busy} onClick={() => void run(async () => {
              const scene = plan.doc.scenes[0];
              const d = await jfetch<{ assets: { assetId: string; hasAlpha: boolean }[]; disclosure: string; limitations: string[] }>("/api/creative/m14/assets", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ projectId, sceneId: scene?.sceneId ?? "sc1", role: "background", prompt: `Scene artwork following the approved direction: ${approved.direction.name}. ${scene?.visualConcept.slice(0, 200)}`, alternatives: 1 }),
              });
              setAssets((a) => [...a, ...d.assets.map((x) => ({ ...x, role: "background" }))]);
              flash("ok", d.disclosure.slice(0, 180));
              if (d.limitations[0]) flash("err", d.limitations[0].slice(0, 160));
            })}>
              Generate scene artwork (scene 1)
            </button>
          )}
          {assets.map((a, i) => (
            <div key={i} className="text-[10px] text-[#a8a8a0]">{a.role} asset {a.assetId.slice(0, 12)}… · alpha: {a.hasAlpha ? "verified RGBA" : "none (provider returns opaque pixels)"}</div>
          ))}
        </div>
      )}

      {/* COMPOSITION */}
      {section === "composition" && (
        <div className="space-y-2">
          <div className={labelCls}>Composition — layers, masks, versioned</div>
          <button type="button" className={btnCls} disabled={busy} onClick={() => void run(async () => {
            const d = await jfetch<{ id: string; version: number; issues: string[] }>("/api/creative/m14/compose", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                projectId,
                name: `Compose ${new Date().toISOString().slice(11, 19)}`,
                doc: {
                  width: 640, height: 360, fps: 30, durationFrames: 90,
                  layers: [
                    { id: "bg1", name: "Background", kind: "background", color: approved?.direction.styleProfile.palette[0]?.hex ?? "#101010", visible: true, locked: false, blend: "normal", transform: { x: 320, y: 180, scale: 1, rotation: 0, opacity: 1 }, anchor: { x: 0.5, y: 0.5 }, startFrame: 0, endFrame: 90, keyframes: [], mask: null, trackBinding: null },
                    { id: "fg1", name: "Foreground", kind: "shape", color: approved?.direction.styleProfile.palette[1]?.hex ?? "#d4a017", visible: true, locked: false, blend: "normal", transform: { x: 320, y: 180, scale: 1, rotation: 0, opacity: 1 }, anchor: { x: 0.5, y: 0.5 }, startFrame: 0, endFrame: 90, keyframes: [{ id: "k1", property: "opacity", frame: 0, value: 0, interpolation: "EASE_OUT" }, { id: "k2", property: "opacity", frame: 20, value: 1, interpolation: "EASE_OUT" }, { id: "k3", property: "x", frame: 0, value: 260, interpolation: "EASE_OUT" }, { id: "k4", property: "x", frame: 25, value: 320, interpolation: "EASE_OUT" }], mask: null, trackBinding: null },
                  ],
                },
              }),
            });
            flash("ok", `Composition created (v${d.version})${d.issues.length ? ` — ${d.issues[0]}` : ""}.`);
            loadAll();
          })}>
            New composition (direction palette)
          </button>
          {comps.map((c) => (
            <button key={c.id} type="button" className="block rounded border border-[#2a2a2a] p-1.5 text-left text-[10px] text-[#a8a8a0] hover:text-[#d4a017]" onClick={() => openComp(c.id)}>
              {c.name} · v{c.version}
            </button>
          ))}
          {comp && (
            <div className="space-y-1">
              <div className="text-[10px] text-[#d4a017]">{comp.name} v{comp.version} · {comp.doc.width}×{comp.doc.height} @{comp.doc.fps}fps · {comp.doc.layers.length} layers</div>
              {comp.doc.layers.map((l) => (
                <div key={l.id} className="rounded border border-[#2a2a2a] p-1.5 text-[10px]">
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="text-[#d8d8d2]">{l.name}</span>
                    <span className="text-[#6a6a64]">{l.kind} · {l.blend}</span>
                    {l.trackBinding && <span className="text-[#6aa9c9]">bound→{l.trackBinding.temporalTrackId.split(":").pop()}</span>}
                    <button type="button" className="text-[#a8a8a0] hover:underline" onClick={() => mutateLayer(l.id, (x) => { x.visible = !x.visible; }, `toggle ${l.id}`)}>{l.visible ? "hide" : "show"}</button>
                    <button type="button" className="text-[#a8a8a0] hover:underline" onClick={() => mutateLayer(l.id, (x) => { x.transform.opacity = x.transform.opacity > 0.5 ? 0.3 : 1; }, `opacity ${l.id}`)}>opacity {l.transform.opacity.toFixed(1)}</button>
                    <button type="button" className="text-[#a8a8a0] hover:underline" onClick={() => mutateLayer(l.id, (x) => { x.locked = !x.locked; }, `lock ${l.id}`)}>{l.locked ? "unlock" : "lock"}</button>
                  </div>
                  <div className="text-[9px] text-[#6a6a64]">x {l.transform.x} · y {l.transform.y} · scale {l.transform.scale} · {l.keyframes.length} keyframes</div>
                </div>
              ))}
              <button type="button" className={btnCls} disabled={busy || comp.version < 2} onClick={() => void run(async () => {
                const d = await jfetch<{ version: number; doc: M14Doc }>("/api/creative/m14/compose", {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ projectId, compositionId: comp.id, targetVersion: comp.version - 1 }),
                });
                setComp({ ...comp, version: d.version, doc: d.doc });
                flash("ok", `Undo → now at v${d.version}.`);
              })}>
                Undo (switch to previous version)
              </button>
            </div>
          )}
        </div>
      )}

      {/* MOTION */}
      {section === "motion" && (
        <div className="space-y-2">
          <div className={labelCls}>Motion — NIIKI-evaluated presets (deterministic)</div>
          {!comp && <div className="text-[10px] text-[#6a6a64]">Open a composition first.</div>}
          {comp && (
            <div className="flex flex-wrap gap-1">
              {(["soft-reveal", "cinematic-push-in", "floating-movement", "bounce-entrance", "parallax-drift", "emphasis-pulse"] as const).map((p) => (
                <button key={p} type="button" className="rounded border border-[#2a2a2a] px-2 py-0.5 text-[10px] text-[#a8a8a0] hover:text-[#d4a017]" disabled={busy} onClick={() => {
                  const layer = comp.doc.layers.find((l) => l.kind !== "background" && !l.locked);
                  if (!layer) { flash("err", "No unlocked foreground layer."); return; }
                  mutateLayer(layer.id, (x) => {
                    const generated = [
                      { id: `m14${p}o1`, property: "opacity", frame: 0, value: 0, interpolation: "EASE_OUT" as const },
                      { id: `m14${p}o2`, property: "opacity", frame: Math.round(comp.doc.fps / 3), value: 1, interpolation: "EASE_OUT" as const },
                      { id: `m14${p}s1`, property: "scale", frame: 0, value: 0.94, interpolation: "EASE_OUT" as const },
                      { id: `m14${p}s2`, property: "scale", frame: Math.round(comp.doc.fps / 3), value: 1, interpolation: "EASE_OUT" as const },
                    ];
                    x.keyframes = [...x.keyframes, ...generated].slice(0, 400);
                  }, `${p} on ${layer.id}`);
                  flash("ok", `${p} applied to ${layer.name} (committed as a new version).`);
                }}>{p}</button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* REVIEW */}
      {section === "review" && (
        <div className="space-y-2">
          <div className={labelCls}>Review &amp; Render — validation + durable render job</div>
          {!comp && <div className="text-[10px] text-[#6a6a64]">Open a composition first.</div>}
          {comp && (
            <>
              <button type="button" className={btnCls} disabled={busy} onClick={() => void run(async () => {
                const d = await jfetch<{ jobId: string; disclosure: string }>("/api/creative/m14/render", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ projectId, compositionId: comp.id }),
                });
                setRenderMsg(`${d.disclosure} job=${d.jobId.slice(0, 8)}…`);
                flash("ok", "Render queued through the durable worker.");
                const poll = setInterval(() => {
                  void jfetch<{ job: { status: string; message: string | null; exportId: string | null } }>(`/api/creative/m14/render?compositionId=${comp.id}`).then((r) => {
                    if (r.job && (r.job.status === "COMPLETED" || r.job.status === "FAILED")) {
                      clearInterval(poll);
                      setRenderMsg(`${r.job.status}: ${r.job.message ?? ""}${r.job.exportId ? ` → asset ${r.job.exportId.slice(0, 12)}…` : ""}`);
                      flash(r.job.status === "COMPLETED" ? "ok" : "err", `Render ${r.job.status}.`);
                    }
                  });
                }, 3000);
              })}>
                Render composition (real FFmpeg pipeline)
              </button>
              {renderMsg && <div className="text-[10px] text-[#a8a8a0]">{renderMsg}</div>}
              <div className="text-[9px] text-[#6a6a64]">Preview and export evaluate the SAME canonical composition state; blend modes normal/multiply/screen are pixel-tested on both paths. Resource limits: ≤24 layers, ≤1920px, ≤3600 frames.</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
