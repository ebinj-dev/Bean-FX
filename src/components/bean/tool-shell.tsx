"use client";

import { useState, type ReactNode } from "react";
import { StudioHeader } from "@/components/bean/studio-header";
import type { SessionUser } from "@/lib/types";

export function ToolShell({
  user,
  onLogout,
  route,
  label,
  title,
  description,
  children,
  wide,
}: {
  user: SessionUser;
  onLogout: () => void;
  route: string;
  label: string;
  title: string;
  description: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-[#050505]">
      <StudioHeader user={user} onLogout={onLogout} route={route} />
      <main className={wide ? "mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6" : "mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6"}>
        <div className="mb-7">
          <p className="bean-label text-[11px] text-[#d4a017]">{label}</p>
          <h1 className="mt-2 text-2xl font-extrabold tracking-tight text-white sm:text-3xl">{title}</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[#8f8f8a]">{description}</p>
        </div>
        {children}
      </main>
      <footer className="mt-auto border-t border-[#141414] py-5">
        <p className="px-4 text-center text-[11px] text-[#4c4c48] sm:px-6">
          BEAN FX — originals are never modified; all results are new validated exports.
        </p>
      </footer>
    </div>
  );
}
