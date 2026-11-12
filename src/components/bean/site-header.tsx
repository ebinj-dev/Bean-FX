"use client";

import { useState } from "react";
import { ArrowRight, Menu, X } from "lucide-react";
import { BeanLogo } from "@/components/bean/logo";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { label: "AUTO CUT", href: "#/autocut" },
  { label: "CAPTIONS", href: "#/captions" },
  { label: "WATERMARK", href: "#/watermark" },
  { label: "AUDIO", href: "#/audio" },
  { label: "B-ROLL", href: "#/broll" },
];

interface SiteHeaderProps {
  currentRoute: string;
  onOpenStudio: () => void;
  onLogin: () => void;
  isAuthenticated: boolean;
  variant?: "landing" | "transparent";
}

export function SiteHeader({ currentRoute, onOpenStudio, onLogin, isAuthenticated, variant = "landing" }: SiteHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header
      className={cn(
        "sticky top-0 z-40 w-full border-b border-[#1a1a1a] bg-[#050505]/95 backdrop-blur-sm",
        variant === "landing" ? "" : "bg-[#050505]"
      )}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <a href="#/" className="shrink-0" aria-label="BEAN FX home">
          <BeanLogo />
        </a>

        {/* Desktop nav */}
        <nav className="hidden items-center gap-7 lg:flex" aria-label="Primary">
          {NAV_ITEMS.map((item) => {
            const active = currentRoute === item.href.slice(1);
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

        <div className="hidden items-center gap-5 lg:flex">
          {isAuthenticated ? (
            <button
              onClick={onOpenStudio}
              className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#9a9a94] transition-colors hover:text-white"
            >
              STUDIO
            </button>
          ) : (
            <button
              onClick={onLogin}
              className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#9a9a94] transition-colors hover:text-white"
            >
              LOGIN
            </button>
          )}
          <button
            onClick={onOpenStudio}
            className="bean-glow inline-flex h-9 items-center gap-1.5 rounded-md bg-[#d4a017] px-4 text-[11px] font-extrabold uppercase tracking-[0.12em] text-[#0c0c0c] transition-colors hover:bg-[#e9b52a]"
          >
            GET STARTED
            <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.5} />
          </button>
        </div>

        {/* Mobile menu button */}
        <button
          className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-[#232323] text-white lg:hidden"
          onClick={() => setMenuOpen((v) => !v)}
          aria-expanded={menuOpen}
          aria-label={menuOpen ? "Close menu" : "Open menu"}
        >
          {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {/* Mobile dropdown */}
      {menuOpen && (
        <div className="border-t border-[#1a1a1a] bg-[#0a0a0a] px-4 pb-5 pt-3 lg:hidden">
          <nav className="flex flex-col gap-1" aria-label="Mobile">
            {NAV_ITEMS.map((item) => {
              const active = currentRoute === item.href.slice(1);
              return (
                <a
                  key={item.label}
                  href={item.href}
                  onClick={() => setMenuOpen(false)}
                  className={cn(
                    "rounded-md px-3 py-2.5 text-xs font-bold uppercase tracking-[0.14em]",
                    active ? "bg-[#161616] text-[#d4a017]" : "text-[#9a9a94] hover:bg-[#141414] hover:text-white"
                  )}
                >
                  {item.label}
                </a>
              );
            })}
            <div className="mt-3 flex flex-col gap-2.5 border-t border-[#1e1e1e] pt-4">
              <button
                onClick={() => {
                  setMenuOpen(false);
                  if (isAuthenticated) onOpenStudio();
                  else onLogin();
                }}
                className="text-xs font-bold uppercase tracking-[0.14em] text-[#9a9a94] px-3 py-2 text-left"
              >
                {isAuthenticated ? "STUDIO" : "LOGIN"}
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  onOpenStudio();
                }}
                className="bean-glow inline-flex h-10 items-center justify-center gap-1.5 rounded-md bg-[#d4a017] px-4 text-xs font-extrabold uppercase tracking-[0.12em] text-[#0c0c0c]"
              >
                GET STARTED
                <ArrowRight className="h-4 w-4" strokeWidth={2.5} />
              </button>
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}
