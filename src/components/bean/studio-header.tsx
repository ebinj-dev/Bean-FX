"use client";

import { useState } from "react";
import { ArrowRight, ChevronDown, LogOut, LayoutDashboard } from "lucide-react";
import { BeanLogo } from "@/components/bean/logo";
import { SITE_NAV_ITEMS } from "@/components/bean/nav-items";
import type { SessionUser } from "@/lib/types";
import { cn } from "@/lib/utils";

export function StudioHeader({ user, onLogout, route }: { user: SessionUser; onLogout: () => void; route: string }) {
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 w-full border-b border-[#1a1a1a] bg-[#050505]/95 backdrop-blur-sm">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-3 px-4 sm:px-6">
        <div className="flex items-center gap-5">
          <a href="#/studio" aria-label="BEAN FX studio home" className="shrink-0">
            <BeanLogo />
          </a>
          <span className="hidden h-5 w-px bg-[#242424] sm:block" aria-hidden="true" />
          <a
            href="#/studio"
            className={cn(
              "hidden items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.14em] transition-colors sm:inline-flex",
              route === "/studio" ? "text-[#d4a017]" : "text-[#9a9a94] hover:text-white"
            )}
          >
            <LayoutDashboard className="h-3.5 w-3.5" />
            STUDIO
          </a>
        </div>

        {/* Desktop tool nav */}
        <nav className="hidden items-center gap-6 lg:flex" aria-label="Tools">
          {SITE_NAV_ITEMS.map((item) => {
            const active = route === item.href.slice(1);
            return (
              <a
                key={item.label}
                href={item.href}
                className={cn(
                  "text-[11px] font-bold uppercase tracking-[0.14em] transition-colors",
                  active ? "text-[#d4a017]" : "text-[#9a9a94] hover:text-white"
                )}
                aria-current={active ? "page" : undefined}
              >
                {item.label}
              </a>
            );
          })}
        </nav>

        <div className="flex items-center gap-3">
          <div className="relative">
            <button
              onClick={() => setUserMenuOpen((v) => !v)}
              className="flex h-9 items-center gap-2 rounded-md border border-[#232323] bg-[#111111] px-3 text-xs font-semibold text-white hover:border-[#333]"
              aria-expanded={userMenuOpen}
              aria-haspopup="menu"
            >
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#d4a017] text-[10px] font-extrabold text-[#0c0c0c]">
                {(user.name ?? user.email).slice(0, 1).toUpperCase()}
              </span>
              <span className="hidden max-w-[120px] truncate sm:block">{user.name ?? user.email}</span>
              <ChevronDown className="h-3.5 w-3.5 text-[#8f8f8a]" />
            </button>
            {userMenuOpen && (
              <div
                className="absolute right-0 top-11 w-52 overflow-hidden rounded-md border border-[#232323] bg-[#121212] py-1 shadow-xl"
                role="menu"
              >
                <div className="border-b border-[#1e1e1e] px-3 py-2">
                  <p className="truncate text-xs font-semibold text-white">{user.name ?? "Creator"}</p>
                  <p className="truncate text-[11px] text-[#8f8f8a]">{user.email}</p>
                </div>
                <button
                  onClick={onLogout}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold text-[#c9c9c4] hover:bg-[#1a1a1a] hover:text-white"
                  role="menuitem"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  LOG OUT
                </button>
              </div>
            )}
          </div>

          <a
            href="#/"
            className="hidden h-9 items-center gap-1.5 rounded-md bg-[#d4a017] px-3.5 text-[11px] font-extrabold uppercase tracking-[0.12em] text-[#0c0c0c] hover:bg-[#e9b52a] sm:inline-flex"
          >
            HOME
            <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.5} />
          </a>

          <button
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-[#232323] text-white lg:hidden"
            onClick={() => setMobileOpen((v) => !v)}
            aria-label="Toggle tool menu"
            aria-expanded={mobileOpen}
          >
            <ChevronDown className={cn("h-4 w-4 transition-transform", mobileOpen && "rotate-180")} />
          </button>
        </div>
      </div>

      {mobileOpen && (
        <div className="border-t border-[#1a1a1a] bg-[#0a0a0a] px-4 py-2 lg:hidden">
          <nav className="flex flex-wrap gap-2 pb-2" aria-label="Mobile tools">
            <a
              href="#/studio"
              className={cn(
                "rounded-md px-3 py-2 text-xs font-bold uppercase tracking-[0.14em]",
                route === "/studio" ? "bg-[#161616] text-[#d4a017]" : "text-[#9a9a94] hover:bg-[#141414]"
              )}
            >
              STUDIO
            </a>
            {SITE_NAV_ITEMS.map((item) => (
              <a
                key={item.label}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                className={cn(
                  "rounded-md px-3 py-2 text-xs font-bold uppercase tracking-[0.14em]",
                  route === item.href.slice(1) ? "bg-[#161616] text-[#d4a017]" : "text-[#9a9a94] hover:bg-[#141414]"
                )}
              >
                {item.label}
              </a>
            ))}
          </nav>
        </div>
      )}
    </header>
  );
}
