/**
 * M42-E — AI EDIT CHAT (RIISHE as creative director).
 *
 * A panel inside the existing AI Studio (Program Monitor and timeline stay
 * untouched and visible). Conversation is per-project and survives reloads
 * (localStorage keyed by project). Plans returned by the chat surface as a
 * preview with approve/execute/reject actions through the EXISTING MY AI
 * plan API — a plan is never presented as an applied edit; execution reports
 * the real status. Rendering goes through the existing durable batch
 * pipeline. Undo/redo use the editor session's real history.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Send, Square, Undo2, Redo2, Clapperboard, ShieldCheck, Wand2 } from "lucide-react";
import type { Sequence } from "@/lib/editor/model";
import type { EditorSession } from "@/hooks/use-editor-session";

type ModelInfo = { id: string; displayName: string; ready: boolean; readyReason: string; type: string };
type PlanSummary = { planId: string; status: string; mode?: string; engines?: string[]; steps?: number; warnings?: number; expectedChanges?: string[]; note?: string; result?: { applied?: number; failed?: number; note?: string } };
type ChatMessage = { role: "user" | "assistant"; content: string; mode?: string; styles?: Array<{ id: string; name: string; purpose: string; disclosedGaps: Array<{ capability: string; reason: string }> }>; planId?: string };

const btn = "rounded border border-[#2a2a2a] px-2 py-1 text-[10px] text-[#d8d8d2] hover:border-[#d4a017] hover:text-[#d4a017] disabled:opacity-40";
const label = "text-[10px] font-medium uppercase tracking-wide text-[#8f8f8a]";

async function jfetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export function AiEditChat({ sequence, session, projectId, selectionContext }: { sequence: Sequence; session: EditorSession; projectId: string | null; selectionContext?: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<"chat" | "plan" | "render" | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanSummary | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [models, setModels] = useState<{ ready: number; total: number; items: ModelInfo[] } | null>(null);
  const [modelPick, setModelPick] = useState<string>("auto");
  const [renderState, setRenderState] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const seqEnd = useMemo(() => {
    const fps = sequence.fps.num / sequence.fps.den;
    const end = sequence.clips.reduce((n, c) => Math.max(n, c.timelineStartFrame + c.timelineDurationFrames), 0);
    return { frames: end, sec: Math.round((end / fps) * 100) / 100 };
  }, [sequence]);

  const storeKey = useMemo(() => `beanfx-ai-chat-${projectId ?? "none"}`, [projectId]);

  // Resume the project-scoped conversation after reload.
  useEffect(() => {
    if (!projectId) return;
    try {
      const raw = localStorage.getItem(storeKey);
      if (raw) {
        const saved = JSON.parse(raw) as { messages: ChatMessage[]; conversationId: string | null };
        setMessages(saved.messages ?? []);
        setConversationId(saved.conversationId ?? null);
      }
    } catch { /* corrupted store — start fresh */ }
  }, [projectId, storeKey]);

  useEffect(() => {
    if (!projectId) return;
    try { localStorage.setItem(storeKey, JSON.stringify({ messages: messages.slice(-40), conversationId })); } catch { /* quota */ }
  }, [messages, conversationId, projectId, storeKey]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, plan]);

  // Model registry (M42-D) — honest readiness display.
  useEffect(() => {
    jfetch<{ models: ModelInfo[]; summary: { ready: number; total: number } }>("/api/ai/models")
      .then((r) => setModels({ ready: r.summary.ready, total: r.summary.total, items: r.models }))
      .catch(() => setModels({ ready: 0, total: 0, items: [] }));
  }, []);

  const send = useCallback(async () => {
    const msg = input.trim();
    if (!msg || busy || !projectId) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", content: msg }]);
    setBusy("chat");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const withCtx = selectionContext ? `${msg} [context: ${selectionContext}]` : msg;
      const res = await jfetch<{ reply: string; mode: string; conversationId: string; planId?: string; planMode?: string; planNote?: string; styles?: ChatMessage["styles"] }>(
        `/api/editor/projects/${projectId}/riishe/chat`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: withCtx.slice(0, 2000), conversationId, model: modelPick }), signal: controller.signal },
      );
      setConversationId(res.conversationId);
      setMessages((m) => [...m, { role: "assistant", content: res.reply, mode: res.mode, styles: res.styles, planId: res.planId }]);
      if (res.planId) {
        const detail = await jfetch<PlanSummary>(`/api/my-ai/plans/${res.planId}`).catch(() => null);
        setPlan(detail ?? { planId: res.planId, status: "PENDING", mode: res.planMode, note: res.planNote });
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") setMessages((m) => [...m, { role: "assistant", content: "Cancelled — the request was stopped before completion (nothing was applied).", mode: "cancelled" }]);
      else setMessages((m) => [...m, { role: "assistant", content: err instanceof Error ? err.message : "chat failed", mode: "error" }]);
    } finally {
      setBusy(null);
      abortRef.current = null;
    }
  }, [input, busy, projectId, selectionContext, conversationId, modelPick]);

  const planAction = useCallback(async (action: "approve" | "execute" | "reject" | "cancel") => {
    if (!plan || busy) return;
    setBusy("plan");
    setNotice(null);
    try {
      const res = await jfetch<PlanSummary & { ok?: boolean; status?: string; note?: string }>(`/api/my-ai/plans/${plan.planId}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }),
      });
      setPlan({ ...plan, status: res.status ?? plan.status, note: res.note ?? plan.note, result: action === "execute" ? (res.result ?? plan.result) : plan.result });
      if (action === "execute") setNotice("Execution finished — the timeline reflects the approved steps (undo/redo available in the editor history).");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "plan action failed");
    } finally {
      setBusy(null);
    }
  }, [plan, busy]);

  const renderCurrent = useCallback(async () => {
    if (!projectId || busy) return;
    setBusy("render");
    setRenderState("submitting to the durable render pipeline…");
    try {
      const sub = await jfetch<{ batch: Array<{ jobId: string; status: string }> }>("/api/editor/projects/" + projectId + "/render/batch", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: [{ format: "mp4", startFrame: 0, endFrame: seqEnd.frames }] }),
      });
      const jobId = sub.batch[0]?.jobId;
      for (let i = 0; i < 120; i++) {
        const st = await jfetch<{ items: Array<{ jobId: string; status: string; message?: string }> }>("/api/editor/projects/" + projectId + "/render/batch");
        const it = st.items.find((x) => x.jobId === jobId);
        setRenderState(`${it?.status ?? "?"} — ${it?.message ?? ""}`);
        if (it?.status === "COMPLETED" || it?.status === "FAILED" || it?.status === "CANCELLED") break;
        await new Promise((r) => setTimeout(r, 3000));
      }
    } catch (err) {
      setRenderState(`render failed: ${err instanceof Error ? err.message : "?"}`);
    } finally {
      setBusy(null);
    }
  }, [projectId, busy, seqEnd.frames]);

  const newConversation = useCallback(() => {
    setMessages([]); setConversationId(null); setPlan(null); setNotice(null);
    if (projectId) localStorage.removeItem(storeKey);
  }, [projectId, storeKey]);

  return (
    <div className="flex h-full flex-col gap-2">
      {/* Header: project + models + MCP indicator */}
      <div className="rounded border border-[#2a2a2a] bg-[#161614] p-2 text-[10px] text-[#a8a8a0]">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1 font-semibold text-[#d4a017]"><Wand2 className="h-3 w-3" /> AI EDIT CHAT · RIISHE (creative director)</span>
          <span>project: <strong className="text-[#d8d8d2]">{projectId ?? "none — save the project first"}</strong></span>
          <span>sequence: <strong className="text-[#d8d8d2]">{seqEnd.frames} f (~{seqEnd.sec} s) @ {sequence.fps.num}/{sequence.fps.den} fps</strong></span>
          <span className="inline-flex items-center gap-1"><ShieldCheck className="h-3 w-3" /> models: <strong className="text-[#d8d8d2]">{models ? `${models.ready}/${models.total} ready` : "probing…"}</strong></span>
          <span title="MCP tools run through the existing MY AI orchestration bridge (myai.status / myai.execute) with the same hash-bound approvals as every mutating tool">MCP: <strong className="text-[#d8d8d2]">via MY AI bridge + approvals</strong></span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span className={label}>model</span>
          <select value={modelPick} onChange={(e) => setModelPick(e.target.value)} className="rounded border border-[#2a2a2a] bg-[#101010] px-1 py-0.5 text-[10px] text-[#d8d8d2]">
            <option value="auto">Automatic routing (capability-aware)</option>
            {(models?.items ?? []).filter((m) => m.ready).map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
          </select>
          <button type="button" className={btn} onClick={newConversation}>New conversation</button>
          <button type="button" className={btn} onClick={() => { session.undo(); }} title="Undo the last timeline change (editor history)">Undo</button>
          <button type="button" className={btn} onClick={() => { session.redo(); }} title="Redo (editor history)">Redo</button>
        </div>
        {models && (
          <div className="mt-1 text-[9px] leading-relaxed text-[#6a6a64]">
            {models.items.map((m) => `${m.ready ? "●" : "○"} ${m.displayName}${m.ready ? "" : ` — ${m.readyReason.slice(0, 60)}`}`).join("  ·  ")}
          </div>
        )}
      </div>

      {/* Conversation */}
      <div ref={scrollRef} className="min-h-[180px] flex-1 space-y-2 overflow-y-auto rounded border border-[#2a2a2a] bg-[#101010] p-2">
        {messages.length === 0 && (
          <p className="text-[11px] text-[#6a6a64]">Describe the video you want — e.g. “Turn these clips into a 45-second cinematic trailer”, “Make a vertical Instagram Reel”, “Remove silences and add captions”, or “Show me three different editing styles”. Plans appear here for your approval before anything touches the timeline.</p>
        )}
        {messages.map((m, i) => (
          <div key={i} className="text-[11px] leading-relaxed">
            <span className={`mr-1 font-semibold ${m.role === "user" ? "text-[#d4a017]" : "text-[#7a7a76]"}`}>{m.role === "user" ? "YOU" : `RIISHE${m.mode === "deterministic" ? " (rules — LLM unavailable)" : ""}`}</span>
            <span className="whitespace-pre-wrap text-[#d8d8d2]">{m.content}</span>
          </div>
        ))}
        {plan && (
          <div className="mt-2 rounded border border-[#d4a017]/40 bg-[#161614] p-2">
            <div className="flex flex-wrap items-center gap-2 text-[10px]">
              <Clapperboard className="h-3 w-3 text-[#d4a017]" />
              <strong className="text-[#d4a017]">EDITING PLAN {plan.planId}</strong>
              <span className="text-[#8f8f8a]">status: {plan.status}{plan.mode ? ` · ${plan.mode}` : ""}</span>
              {typeof plan.steps === "number" && <span>{plan.steps} step(s)</span>}
              {typeof plan.warnings === "number" && <span>{plan.warnings} warning(s)</span>}
            </div>
            {plan.expectedChanges?.length ? (
              <ul className="mt-1 list-disc pl-4 text-[10px] text-[#a8a8a0]">{plan.expectedChanges.slice(0, 8).map((c, i) => <li key={i}>{c}</li>)}</ul>
            ) : null}
            {plan.result && <p className="mt-1 text-[10px] text-[#a8a8a0]">execution: {plan.result.applied ?? 0} applied, {plan.result.failed ?? 0} failed — {plan.result.note ?? ""}</p>}
            {plan.note && <p className="mt-1 text-[9px] text-[#6a6a64]">{plan.note}</p>}
            <div className="mt-2 flex flex-wrap gap-1">
              <button type="button" className={btn} disabled={busy !== null || plan.status !== "PENDING"} onClick={() => void planAction("approve")}>Approve</button>
              <button type="button" className={btn} disabled={busy !== null || plan.status !== "APPROVED"} onClick={() => void planAction("execute")}>Apply to timeline</button>
              <button type="button" className={btn} disabled={busy !== null} onClick={() => void planAction("reject")}>Reject</button>
              <button type="button" className={btn} disabled={busy !== null} onClick={() => void planAction("cancel")}>Cancel</button>
            </div>
            <p className="mt-1 text-[9px] text-[#6a6a64]">A plan is a proposal — nothing touches the timeline until you approve and apply. Applying goes through the canonical validated command system and is fully undoable.</p>
          </div>
        )}
        {notice && <p className="text-[10px] text-[#d4a017]">{notice}</p>}
        {renderState && <p className="text-[10px] text-[#a8a8a0]">render: {renderState}</p>}
      </div>

      {/* Input */}
      <div className="flex items-end gap-1">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
          placeholder="Describe the edit you want…"
          rows={2}
          disabled={busy !== null || !projectId}
          className="flex-1 resize-none rounded border border-[#2a2a2a] bg-[#101010] px-2 py-1.5 text-[11px] text-[#d8d8d2] placeholder:text-[#5a5a54] focus:border-[#d4a017] focus:outline-none"
        />
        {busy === "chat"
          ? <button type="button" className={btn} onClick={() => abortRef.current?.abort()} title="Cancel the running request"><Square className="h-3 w-3" /> Stop</button>
          : <button type="button" className={btn} disabled={busy !== null || !projectId} onClick={() => void send()}><Send className="h-3 w-3" /> Send</button>}
        <button type="button" className={btn} disabled={busy !== null || !projectId} onClick={() => void renderCurrent()} title="Render the current timeline through the existing durable pipeline (real FFmpeg)"><Clapperboard className="h-3 w-3" /> Render</button>
      </div>
    </div>
  );
}
