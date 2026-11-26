"use client";

/**
 * M47 — compact studio navigation for the product destinations.
 * M47.1 §B — adds the dedicated Creative Tools Hub as destination 7 (a real
 * page route); the original six destinations and their keyboard numbers are
 * unchanged. Keyboard: 1-7 jumps between destinations. Rendered on every
 * workspace page so the product reads as one environment, not a set of
 * disconnected tools.
 */
import { AgentDot, Kbd } from "@/components/bean/ui";
export type StudioNavUser = { name?: string | null; email?: string };
import type { SessionUser } from "@/lib/types";
import type { MouseEvent } from "react";

export const STUDIO_DESTINATIONS = [
  { id: "chat", num: "1", label: "Studio Chat", href: "#/home", glyph: "◆" },
  { id: "crew", num: "2", label: "Production Crew", href: "#/crew", glyph: "◇" },
  { id: "editor", num: "3", label: "Editor", href: "#/editor", glyph: "▤" },
  { id: "library", num: "4", label: "Media Library", href: "#/library", glyph: "▥" },
  { id: "intelligence", num: "5", label: "Intelligence", href: "#/intelligence", glyph: "◈" },
  { id: "settings", num: "6", label: "Settings", href: "#/settings", glyph: "◉" },
  // M47.1 §B — the dedicated Creative Tools Hub (a real page route, not a hash
  // route). Numbered 7 so the existing six keyboard shortcuts stay stable.
  { id: "tools", num: "7", label: "Creative Tools", href: "/studio/tools", glyph: "▣" },
] as const;

export type DestinationId = (typeof STUDIO_DESTINATIONS)[number]["id"];

/** Global keyboard shortcuts — digits 1-7 navigate; ignored while typing. */
export function useStudioShortcuts(active: DestinationId | null) {
  if (typeof window === "undefined") return;
  const handler = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const hit = STUDIO_DESTINATIONS.find((d) => d.num === e.key);
    if (hit && active !== hit.id) {
      e.preventDefault();
      // M47.1 — assign() handles both fragment navigation (hashchange fires,
      // same document) and real page routes (Creative Tools).
      window.location.assign(hit.href);
    }
  };
  window.addEventListener("keydown", handler);
  return () => window.removeEventListener("keydown", handler);
}

export function StudioNav({
  user,
  active,
  onLogout,
  footer,
}: {
  user: StudioNavUser | SessionUser;
  active: DestinationId | null;
  onLogout: () => void;
  footer?: React.ReactNode;
}) {
  const go = (e: MouseEvent, href: string) => {
    e.preventDefault();
    // M47.1 — assign() covers both: fragment navigation into the SPA shell
    // (hashchange fires, same document) and real page routes (Creative Tools).
    window.location.assign(href);
  };
  return (
    <nav className="m47-nav" aria-label="Studio destinations">
      <div className="px-2.5 pb-3 pt-1">
        <p className="text-[13px] font-extrabold tracking-[0.18em] text-[var(--m47-gold)]">BEAN FX</p>
        <p className="mt-0.5 text-[9px] uppercase tracking-[0.16em] text-[var(--m47-ink-dim)]">Creative Production Studio</p>
      </div>
      <p className="m47-nav-section px-3 pb-1 text-[8.5px] font-bold uppercase tracking-[0.18em] text-[var(--m47-ink-dim)]">Studio</p>
      {STUDIO_DESTINATIONS.map((d) => (
        <a
          key={d.id}
          href={d.href}
          data-active={active === d.id}
          className="m47-nav-item"
          onClick={(e) => go(e, d.href)}
          title={`${d.label} (${d.num})`}
        >
          <span aria-hidden="true" className="text-[11px] text-[var(--m47-gold-soft)]">{d.glyph}</span>
          <span className="m47-nav-label flex-1">{d.label}</span>
          <span className="m47-nav-label"><Kbd>{d.num}</Kbd></span>
        </a>
      ))}
      <div className="mt-auto">
        {footer}
        <div className="mt-2 flex items-center gap-2 border-t border-[var(--m47-line)] px-2.5 pt-3">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--m47-gold-dim)] text-[10px] font-bold text-[var(--m47-gold-soft)]" aria-hidden="true">
            {(user.name || user.email || "?").slice(0, 1).toUpperCase()}
          </span>
          <span className="m47-nav-label min-w-0 flex-1 truncate text-[11px] text-[var(--m47-ink-mid)]" title={user.email}>
            {user.name || user.email}
          </span>
          <button onClick={onLogout} className="m47-nav-label text-[10px] text-[var(--m47-ink-dim)] hover:text-[var(--m47-err)]">
            Sign out
          </button>
        </div>
      </div>
    </nav>
  );
}

/** Top strip for destinations that need a project context header. */
export function StudioTopbar({ title, context, right }: { title: string; context?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <header className="flex min-h-[52px] flex-shrink-0 items-center justify-between gap-3 border-b border-[var(--m47-line)] bg-[var(--m47-bg)] px-5 py-2.5">
      <div className="flex min-w-0 items-center gap-3">
        <h1 className="truncate text-[14px] font-bold tracking-[0.08em] text-[var(--m47-ink)]">{title}</h1>
        {context}
      </div>
      <div className="flex items-center gap-2">{right}</div>
    </header>
  );
}
