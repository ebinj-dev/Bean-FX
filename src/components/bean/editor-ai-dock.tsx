"use client";

/**
 * M47 Phase E — persistent AI chat dock for the Professional Editor.
 * Understands the active project and timeline: every instruction carries the
 * project id plus the live editor context (playhead, selected clip, clip
 * count). Plans are created through the EXISTING canonical planner
 * (/api/studio/plans) and applied through the EXISTING approval-gated
 * assemble flow — no second executor, no fake editing.
 *
 * Voice: optional capture through the M47 voice capture component; the
 * transcript is editable before submission and routed through the SAME flow.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Btn, Empty, ErrorNote, TextArea, StatusBadge, statusSense } from "@/components/bean/ui";
import { VoiceCapture } from "@/components/bean/voice-capture";

type PlanLite = { planId: string; topic: string; status: string; plannerMode?: string; sceneCount?: number };
type DockMsg = { role: "user" | "assistant"; text: string; planId?: string; mode?: string };

export function EditorAiDock({
  projectId,
  conversationId,
  timelineContext,
}: {
  projectId: string;
  /** M48-G1 — conversation identity from the chat deep link (may be null:
   *  the dock then attaches to the project's latest conversation, creating
   *  one on first send). Turns persist in the canonical Conversation store. */
  conversationId?: string | null;
  /** Live editor facts appended to every instruction so RIISHE resolves references. */
  timelineContext: () => { playheadSec?: number; selectedClipLabel?: string | null; clipCount?: number; durationSec?: number };
}) {
  const [msgs, setMsgs] = useState<DockMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plans, setPlans] = useState<PlanLite[]>([]);
  const [applyState, setApplyState] = useState<{ planId: string; state: string; error?: string } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // M48-G1 — resolved durable conversation (canonical Conversation store).
  const [convId, setConvId] = useState<string | null>(conversationId ?? null);
  const convRef = useRef<string | null>(conversationId ?? null);
  const historyLoadedRef = useRef(false);

  /** Append one turn to the durable conversation. Idempotent per clientTurnId;
   *  failures degrade gracefully — the dock still works without persistence. */
  const persistTurn = useCallback(async (turn: { role: "user" | "assistant"; content: string; meta?: Record<string, unknown>; clientTurnId: string }) => {
    const id = convRef.current;
    if (!id) return;
    try {
      await fetch(`/api/my-ai/conversations/${id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(turn),
      });
    } catch { /* persistence is best-effort; the plan pipeline is canonical */ }
  }, []);

  // Resolve the conversation identity: the chat deep link wins; otherwise the
  // project's latest conversation; creation happens lazily on first send.
  useEffect(() => {
    let cancelled = false;
    const resolve = async () => {
      if (historyLoadedRef.current) return;
      historyLoadedRef.current = true;
      try {
        let id = conversationId ?? null;
        if (!id) {
          const res = await fetch(`/api/my-ai/conversations${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`);
          if (res.ok) {
            const d = await res.json();
            id = (d.conversations ?? [])[0]?.id ?? null;
          }
        }
        if (cancelled) return;
        if (id) {
          convRef.current = id;
          setConvId(id);
          const hres = await fetch(`/api/my-ai/conversations/${id}/messages`);
          if (hres.ok && !cancelled) {
            const hd = await hres.json();
            const history: DockMsg[] = (hd.messages ?? [])
              .filter((m: { role: string }) => m.role === "user" || m.role === "assistant")
              .map((m: { role: "user" | "assistant"; content: string; meta: { planId?: string; plannerMode?: string } | null }) => ({
                role: m.role,
                text: m.content,
                planId: m.meta?.planId,
                mode: m.meta?.plannerMode,
              }));
            if (history.length > 0) setMsgs(history);
          }
        }
      } catch { /* the dock still works without history restore */ }
    };
    void resolve();
    return () => { cancelled = true; };
  }, [conversationId, projectId]);

  const loadPlans = useCallback(async () => {
    try {
      const res = await fetch("/api/studio/plans");
      const d = await res.json();
      setPlans(d.plans ?? []);
    } catch { /* the dock still works without plan history */ }
  }, []);

  useEffect(() => { void loadPlans(); }, [loadPlans]);
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [msgs]);

  const send = useCallback(async (raw: string) => {
    const text = raw.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    // M48-G1 — lazy durable-conversation attach: on the very first send, if no
    // conversation is linked yet, create one for this project (canonical store).
    if (!convRef.current) {
      try {
        const cres = await fetch("/api/my-ai/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId, title: "RIISHE editor session" }),
        });
        if (cres.ok) {
          const cd = await cres.json();
          convRef.current = cd.conversation?.id ?? null;
          setConvId(convRef.current);
        }
      } catch { /* degrade to in-memory only */ }
    }
    const userTurnId = `dock-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    void persistTurn({ role: "user", content: text.slice(0, 8000), clientTurnId: userTurnId });
    const ctx = timelineContext();
    const contextLine = [
      ctx.clipCount !== undefined ? `timeline: ${ctx.clipCount} clips` : null,
      ctx.durationSec !== undefined ? `duration ${ctx.durationSec.toFixed(1)}s` : null,
      ctx.playheadSec !== undefined ? `playhead at ${ctx.playheadSec.toFixed(1)}s` : null,
      ctx.selectedClipLabel ? `selected clip: "${ctx.selectedClipLabel}"` : null,
    ].filter(Boolean).join(", ");
    setMsgs((m) => [...m, { role: "user", text }]);
    setDraft("");
    try {
      // Voice/chat edits stay inside the canonical planner (StudioBriefSchema).
      // The editor context rides INSIDE the topic within the schema's 300-char
      // limit, letting RIISHE resolve "this clip" against the real selection.
      const topic = contextLine
        ? `${text.slice(0, 190)}\n[editor: ${contextLine.slice(0, 100)}]`.slice(0, 300)
        : text.slice(0, 300);
      const res = await fetch("/api/studio/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brief: { topic },
          projectId,
        }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) {
        setError(d?.error ?? `Plan creation failed (HTTP ${res.status}).`);
        return;
      }
      const plan: PlanLite | null = d.plan ?? null;
      const replyText = plan
        ? `Structured editing plan drafted (${plan.sceneCount ?? 0} step${plan.sceneCount === 1 ? "" : "s"}).${plan.plannerMode ? ` Planner mode: ${plan.plannerMode}.` : ""} Review and apply below — approval-gated as always.`
        : String(d.reply ?? "The planner returned no structured plan — the instruction may need more detail.");
      setMsgs((m) => [...m, {
        role: "assistant",
        text: replyText,
        planId: plan?.planId,
        mode: plan?.plannerMode,
      }]);
      void persistTurn({
        role: "assistant",
        content: replyText.slice(0, 8000),
        meta: plan?.planId ? { planId: plan.planId, plannerMode: plan.plannerMode, kind: "riishe-proposal" } : undefined,
        clientTurnId: `${userTurnId}-r`,
      });
      void loadPlans();
    } catch (err) {
      setError(`Network error: ${err instanceof Error ? err.message : "connection failed"}`);
    } finally {
      setBusy(false);
    }
  }, [busy, projectId, timelineContext, loadPlans, persistTurn]);

  const applyPlan = useCallback(async (planId: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/studio/plans/${planId}/assemble`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "assemble" }), // the canonical approval token
      });
      const d = await res.json().catch(() => null);
      setApplyState({ planId, state: res.ok ? String(d?.state ?? "APPLIED") : "FAILED", error: res.ok ? undefined : d?.error });
      void loadPlans();
    } catch (err) {
      setApplyState({ planId, state: "FAILED", error: err instanceof Error ? err.message : "connection failed" });
    } finally {
      setBusy(false);
    }
  }, [loadPlans]);

  const recent = plans.filter((p) => p.status !== "APPLIED").slice(0, 3);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-[var(--m47-line)] px-3 py-2">
        <h3 className="m47-title">RIISHE — Editor AI</h3>
        <span className="m47-chip m47-chip-gold">canonical commands</span>
      </div>

      <div ref={listRef} className="bean-panel-scroll min-h-0 flex-1 overflow-y-auto p-3">
        {msgs.length === 0 && (
          <Empty>
            Describe an edit — e.g. “move this clip two seconds earlier”, “add a title at the beginning”, “add a marker at frame 45”. The dock knows the active project and timeline; ambiguous targets will trigger a clarification.
          </Empty>
        )}
        <ul className="flex flex-col gap-2">
          {msgs.map((m, i) => (
            <li key={i} className={`rounded-lg px-3 py-2 text-[11.5px] leading-relaxed ${m.role === "user" ? "border border-[var(--m47-line-strong)] bg-[var(--m47-bg-graphite)] text-[var(--m47-ink)]" : "border border-[rgba(212,160,23,.25)] bg-[var(--m47-gold-dim)] text-[var(--m47-ink)]"}`}>
              <p className="whitespace-pre-wrap">{m.text}</p>
              {m.planId && (
                <div className="mt-2 flex items-center gap-2">
                  <Btn variant="primary" disabled={busy} onClick={() => void applyPlan(m.planId!)}>Apply to timeline</Btn>
                  <span className="text-[10px] text-[var(--m47-ink-dim)]">plan …{m.planId.slice(-6)}</span>
                </div>
              )}
            </li>
          ))}
        </ul>
        {applyState && (
          <p className="mt-2 text-[10.5px]">
            <StatusBadge s={statusSense(applyState.state)}>apply {applyState.state.toLowerCase()}</StatusBadge>
            {applyState.error && <span className="ml-2 text-[var(--m47-err)]">{applyState.error}</span>}
          </p>
        )}
      </div>

      {recent.length > 0 && (
        <div className="border-t border-[var(--m47-line)] px-3 py-2">
          <p className="m47-title mb-1">Open plans</p>
          <ul className="space-y-1">
            {recent.map((p) => (
              <li key={p.planId} className="flex items-center gap-2 text-[10.5px]">
                <span className="truncate text-[var(--m47-ink-mid)]" title={p.topic}>{p.topic}</span>
                <span className="ml-auto"><StatusBadge s={statusSense(p.status)}>{p.status}</StatusBadge></span>
                <Btn variant="ghost" disabled={busy} onClick={() => void applyPlan(p.planId)}>Apply</Btn>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="border-t border-[var(--m47-line)] p-3">
        <ErrorNote>{error}</ErrorNote>
        <VoiceCapture
          onTranscript={(t) => setDraft((prev) => (prev ? `${prev} ${t}` : t))}
          disabled={busy}
        />
        <TextArea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(draft); } }}
          rows={2}
          placeholder="Describe the edit — RIISHE proposes, you approve…"
          className="mt-2 w-full resize-none text-[12px]"
          aria-label="Editor AI instruction"
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[9.5px] text-[var(--m47-ink-dim)]">Enter to send · plan is approval-gated</span>
          <Btn variant="primary" disabled={busy || !draft.trim()} onClick={() => void send(draft)}>{busy ? "Thinking…" : "Propose"}</Btn>
        </div>
      </div>
    </div>
  );
}
