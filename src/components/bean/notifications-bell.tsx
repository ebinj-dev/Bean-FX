"use client";
/** M30 §7 — notifications bell for the editor toolbar. Polls the durable
 * in-app notification store; unread badge, bounded list, mark-read/dismiss.
 * Existing design system only (black/yellow, glass-free dropdown). */
import { useCallback, useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";

type Notification = {
  id: string; type: string; projectId: string | null;
  payload: Record<string, unknown> | null; readAt: string | null; createdAt: string;
};

function label(n: Notification): string {
  const p = (n.payload ?? {}) as Record<string, unknown>;
  const t = typeof p.title === "string" ? p.title : "";
  switch (n.type) {
    case "invitation.accepted": return `Invitation accepted · ${p.workspaceName ?? ""}`;
    case "invitation.rejected": return `Invitation declined · ${p.workspaceName ?? ""}`;
    case "workspace.member_joined": return `${p.memberEmail ?? "A collaborator"} joined ${p.workspaceName ?? "your workspace"}`;
    case "project.shared": return `Project shared with you: ${p.projectName ?? ""} (${p.role ?? ""})`;
    case "review.requested": return `Review requested: #${p.sessionNo ?? ""} ${t}`;
    case "revision.ready": return `Review session #${p.sessionNo} preview is ready: ${t}`;
    case "revision.processing": return `Review session #${p.sessionNo} is rendering…`;
    case "revision.superseded": return `Review session #${p.sessionNo} was superseded by #${p.newSessionNo}`;
    case "comment.created": return `New comment on session #${p.sessionNo}${p.frame !== null && p.frame !== undefined ? ` (frame ${p.frame})` : ""} — ${p.author ?? ""}`;
    case "comment.replied": return `Reply on session #${p.sessionNo} — ${p.author ?? ""}`;
    case "comment.resolved": return `A comment on session #${p.sessionNo} was resolved`;
    case "review.approved": return `Review APPROVED: session #${p.sessionNo} ${t}`;
    case "review.changes_requested": return `Changes requested: session #${p.sessionNo} ${t}`;
    case "review.cancelled": return `Review session #${p.sessionNo} was cancelled`;
    default: return n.type;
  }
}

export function NotificationsBell({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/notifications?take=20").then((x) => x.json()).catch(() => null);
    if (r?.notifications) { setItems(r.notifications); setUnread(r.unreadCount ?? 0); }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const markAll = async () => {
    await fetch("/api/notifications", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ all: true }) });
    void load();
  };
  const dismiss = async (id: string) => {
    await fetch(`/api/notifications?id=${id}`, { method: "DELETE" });
    void load();
  };

  return (
    <div className="relative" ref={boxRef}>
      <button type="button" onClick={() => setOpen(!open)}
        className={`relative rounded border border-[#2a2a2a] ${compact ? "px-1.5 py-1" : "px-2 py-1.5"} text-[#d8d8d2] hover:border-[#d4a017] hover:text-[#d4a017]`}
        title="Notifications" aria-label="Notifications">
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 rounded-full bg-[#d4a017] px-1 text-[9px] leading-4 text-black">{unread > 9 ? "9+" : unread}</span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-80 rounded border border-[#2a2a2a] bg-[#0b0b0a] p-2 shadow-xl">
          <div className="mb-1 flex items-center justify-between">
            <span className="bean-label text-[10px] text-[#d4a017]">NOTIFICATIONS</span>
            {unread > 0 && <button type="button" onClick={markAll} className="text-[10px] text-[#d4a017]">mark all read</button>}
          </div>
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {items.length === 0 && <p className="p-2 text-xs text-[#8f8f8a]">No notifications yet.</p>}
            {items.map((n) => (
              <div key={n.id} className={`rounded border px-2 py-1.5 text-xs ${n.readAt ? "border-[#1a1a1a] text-[#8f8f8a]" : "border-[#2a2a2a] text-[#d8d8d2]"}`}>
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 flex-1">{label(n)}</span>
                  <button type="button" onClick={() => void dismiss(n.id)} className="shrink-0 text-[10px] text-[#8f8f8a] hover:text-[#e05c5c]">✕</button>
                </div>
                <div className="mt-0.5 text-[10px] text-[#8f8f8a]">{new Date(n.createdAt).toLocaleString()}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
