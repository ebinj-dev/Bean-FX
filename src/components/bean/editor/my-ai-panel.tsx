"use client";

/**
 * MY AI panel (M8 §10/§12) — the conversational orchestrator inside the
 * editor. Distinguishes clearly: assistant text (labeled LLM vs deterministic),
 * plans (approval-gated), execution results, and provider/usage status.
 * Includes the automation-token manager (read-only default profile).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Loader2, Send, ShieldCheck, Sparkles, Square, CheckCheck, XCircle, RefreshCw } from "lucide-react";
import type { Sequence } from "@/lib/editor/model";
import type { EditorSession } from "@/hooks/use-editor-session";

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  mode?: string;
}

interface PlanSummary {
  planId: string;
  mode: string;
  note: string;
  engines?: string[];
  steps?: { id: string; operation: string; title: string; risk: string; description: string }[];
  status?: string;
  result?: { steps?: { stepId: string; status: string; detail: string }[]; note?: string } | null;
  warnings?: string[];
}

interface UsageInfo {
  calls: number;
  totalTokens: number;
  note: string;
}

async function jfetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

export function MyAiPanel({ sequence, session, projectId }: { sequence: Sequence; session: EditorSession; projectId: string | null }) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "chat" | "plan" | "approve" | "execute" | "token">(null);
  const [plan, setPlan] = useState<PlanSummary | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [providerOk, setProviderOk] = useState<boolean | null>(null);
  const [tokenInfo, setTokenInfo] = useState<{ token?: string; profile?: string } | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [messages]);

  const refreshHealth = useCallback(async () => {
    try {
      const h = await jfetch<{ ok: boolean; usage: UsageInfo }>("/api/my-ai/health");
      setProviderOk(h.ok);
      setUsage(h.usage);
    } catch {
      setProviderOk(false);
    }
  }, []);

  useEffect(() => {
    void refreshHealth();
  }, [refreshHealth]);

  const chat = useCallback(async () => {
    if (!input.trim() || busy) return;
    const msg = input.trim();
    setInput("");
    setMessages((m) => [...m, { role: "user", content: msg }]);
    setBusy("chat");
    try {
      const res = await jfetch<{ conversationId: string; reply: string; mode: string }>("/api/my-ai/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, conversationId, message: msg.slice(0, 2000) }),
      });
      setConversationId(res.conversationId);
      setMessages((m) => [...m, { role: "assistant", content: res.reply, mode: res.mode }]);
      void refreshHealth();
    } catch (err) {
      setMessages((m) => [...m, { role: "assistant", content: err instanceof Error ? err.message : "chat failed", mode: "error" }]);
    } finally {
      setBusy(null);
    }
  }, [input, busy, projectId, conversationId, refreshHealth]);

  const makePlan = useCallback(async (request?: string) => {
    if (!projectId || busy) return;
    setBusy("plan");
    setNotice(null);
    try {
      const req = request ?? input.trim() ?? "Improve this edit";
      const res = await jfetch<PlanSummary>("/api/my-ai/plans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, request: req.slice(0, 500), conversationId }),
      });
      setPlan(res);
      setNotice(res.note);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "planning failed");
    } finally {
      setBusy(null);
    }
  }, [projectId, busy, input, conversationId]);

  const planAction = useCallback(async (action: "approve" | "execute" | "cancel") => {
    if (!plan || busy) return;
    setBusy(action === "approve" ? "approve" : "execute");
    try {
      const res = await jfetch<PlanSummary & { ok?: boolean; status?: string }>(`/api/my-ai/plans/${plan.planId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (action === "execute") {
        setPlan({ ...plan, status: res.status ?? "UNKNOWN", result: (res as { steps?: PlanSummary["result"]; note?: string }) as PlanSummary["result"] as never, note: (res as { note?: string }).note ?? plan.note });
        setNotice(`Execution: ${res.status ?? "unknown"} — ${(res as { note?: string }).note ?? ""}`);
        // Timeline changed server-side → reload the session state.
        await session.reload();
      } else if (action === "approve") {
        setPlan({ ...plan, status: "APPROVED" });
        setNotice("Plan approved — you can execute it now.");
      } else {
        setPlan({ ...plan, status: "CANCELLED" });
        setNotice("Plan cancelled.");
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : `${action} failed`);
    } finally {
      setBusy(null);
    }
  }, [plan, busy, session]);

  const createToken = useCallback(async () => {
    setBusy("token");
    try {
      const res = await jfetch<{ token: string; profile: string }>("/api/automation/tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "editor-session", profile: "read-only" }),
      });
      setTokenInfo({ token: res.token, profile: res.profile });
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "token creation failed");
    } finally {
      setBusy(null);
    }
  }, []);

  return (
    <div className="rounded-lg border border-[#2a2a2a] bg-[#0b0b0a] p-3">
      <div className="flex items-center justify-between">
        <h2 className="bean-label flex items-center gap-1.5 text-[10px] text-[#8f8f8a]">
          <Bot className="h-3 w-3 text-[#d4a017]" /> MY AI · ORCHESTRATOR
        </h2>
        <span className={`text-[9px] ${providerOk === null ? "text-[#5a5a55]" : providerOk ? "text-emerald-400" : "text-amber-400"}`}>
          {providerOk === null ? "checking…" : providerOk ? "LLM connected" : "LLM unavailable (deterministic mode)"}
        </span>
      </div>
      {notice && <p className="mt-2 text-[10px] leading-relaxed text-[#a0a09a]">{notice}</p>}

      <div ref={threadRef} className="mt-2 max-h-44 space-y-1.5 overflow-y-auto rounded border border-[#1d1d1b] bg-[#101010] p-1.5">
        {messages.length === 0 && <p className="text-[10px] text-[#5a5a55]">Ask for an edit ("tighten the pacing", "animate captions", "add B-roll about space")…</p>}
        {messages.map((m, i) => (
          <div key={i} className={`rounded px-1.5 py-1 text-[10px] leading-relaxed ${m.role === "user" ? "bg-[#d4a017]/10 text-[#d4d4d0]" : "bg-[#161615] text-[#a0a09a]"}`}>
            <span className="mr-1 font-semibold text-[#7a7a76]">{m.role === "user" ? "YOU" : m.mode === "llm" ? "MY AI (LLM)" : m.mode === "deterministic" ? "MY AI (rules)" : "MY AI"}</span>
            <span className="whitespace-pre-wrap">{m.content}</span>
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-1">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value.slice(0, 2000))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void chat();
            }
          }}
          placeholder="Ask MY AI…"
          className="min-w-0 flex-1 rounded border border-[#2a2a2a] bg-[#111110] px-1.5 py-1 text-[10px] text-[#d4d4d0] placeholder:text-[#5a5a55]"
        />
        <button type="button" onClick={() => void chat()} disabled={busy !== null || !input.trim()} className="rounded border border-[#2a2a2a] bg-[#111110] px-2 text-[#d4a017] hover:border-[#d4a017] disabled:opacity-40">
          {busy === "chat" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
        </button>
        <button type="button" onClick={() => void makePlan()} disabled={busy !== null || !projectId || !input.trim()} title="Create an approval-gated editing plan from this request" className="flex items-center gap-1 rounded border border-[#d4a017] bg-[#d4a017]/10 px-2 text-[9px] text-[#d4a017] hover:bg-[#d4a017]/20 disabled:opacity-40">
          {busy === "plan" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />} PLAN
        </button>
      </div>

      {plan && (
        <div className="mt-2 rounded border border-[#2a2a2a] bg-[#101010] p-2">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-semibold text-[#d4d4d0]">
              Plan {plan.planId.slice(-8)} · {plan.status ?? "AWAITING_APPROVAL"} · {plan.mode}
            </p>
            <div className="flex gap-1">
              {plan.status === "AWAITING_APPROVAL" && (
                <button type="button" onClick={() => void planAction("approve")} disabled={busy !== null} className="flex items-center gap-1 rounded border border-emerald-500 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] text-emerald-400 hover:bg-emerald-500/20 disabled:opacity-40">
                  <CheckCheck className="h-3 w-3" /> APPROVE
                </button>
              )}
              {plan.status === "APPROVED" && (
                <button type="button" onClick={() => void planAction("execute")} disabled={busy !== null} className="flex items-center gap-1 rounded border border-[#d4a017] bg-[#d4a017]/10 px-1.5 py-0.5 text-[9px] text-[#d4a017] hover:bg-[#d4a017]/20 disabled:opacity-40">
                  {busy === "execute" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3" />} EXECUTE
                </button>
              )}
              {["AWAITING_APPROVAL", "APPROVED"].includes(plan.status ?? "") && (
                <button type="button" onClick={() => void planAction("cancel")} disabled={busy !== null} className="flex items-center gap-1 rounded border border-[#2a2a2a] px-1.5 py-0.5 text-[9px] text-[#8f8f8a] hover:border-red-400 disabled:opacity-40">
                  <XCircle className="h-3 w-3" /> CANCEL
                </button>
              )}
            </div>
          </div>
          <div className="mt-1 space-y-0.5">
            {(plan.steps ?? []).map((s) => (
              <p key={s.id} className="text-[9px] text-[#a0a09a]">
                <span className={s.risk === "timeline" ? "text-amber-400" : s.risk === "generation" ? "text-orange-400" : "text-[#7a7a76]"}>[{s.risk}]</span> {s.title} — {s.description}
              </p>
            ))}
          </div>
          {plan.result?.steps && (
            <div className="mt-1 border-t border-[#1d1d1b] pt-1">
              {plan.result.steps.map((s, i) => (
                <p key={i} className="text-[9px]">
                  <span className={s.status === "COMPLETED" || s.status === "ROUTED" ? "text-emerald-400" : s.status === "FAILED" ? "text-red-400" : "text-[#5a5a55]"}>{s.status}</span>{" "}
                  <span className="text-[#a0a09a]">{s.stepId}: {s.detail.slice(0, 120)}</span>
                </p>
              ))}
            </div>
          )}
          {(plan.warnings ?? []).map((w, i) => (
            <p key={i} className="mt-1 text-[9px] text-amber-400/80">⚠ {w}</p>
          ))}
        </div>
      )}

      <div className="mt-2 flex items-center justify-between border-t border-[#1d1d1b] pt-2">
        <p className="text-[9px] text-[#5a5a55]" title={usage?.note}>
          {usage ? `${usage.calls} LLM calls · ${usage.totalTokens} tokens` : "usage: —"}
        </p>
        <button type="button" onClick={() => void refreshHealth()} className="text-[#5a5a55] hover:text-[#d4a017]"><RefreshCw className="h-3 w-3" /></button>
      </div>

      <details className="mt-1">
        <summary className="flex cursor-pointer items-center gap-1 text-[9px] text-[#7a7a76] hover:text-[#d4a017]">
          <ShieldCheck className="h-3 w-3" /> Automation tokens (MCP / JSON-RPC)
        </summary>
        <div className="mt-1 space-y-1 text-[9px] text-[#8f8f8a]">
          <p>Read-only by default; editing requires an explicit token. Tokens are hashed server-side and shown once.</p>
          <button type="button" onClick={() => void createToken()} disabled={busy !== null} className="rounded border border-[#2a2a2a] px-1.5 py-0.5 text-[#d4a017] hover:border-[#d4a017] disabled:opacity-40">
            Create read-only token
          </button>
          {tokenInfo?.token && (
            <p className="break-all rounded bg-[#111110] p-1 font-mono text-[9px] text-[#d4d4d0]">
              {tokenInfo.token} <span className="text-[#5a5a55]">(copy now — shown once)</span>
            </p>
          )}
          <p className="text-[#5a5a55]">Use: POST /api/automation/mcp (MCP clients) or /api/automation/rpc (scripts) with Authorization: Bearer.</p>
        </div>
      </details>
    </div>
  );
}
