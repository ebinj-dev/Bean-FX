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
import { Loader2, Sparkles, ClipboardList, Timer, Gauge, Wrench, GitCompareArrows, History, RefreshCw, Check, X, Send, Ban } from "lucide-react";

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

type Tab = "assistant" | "review" | "retention" | "scorecard" | "recommendations" | "ab" | "history";

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
