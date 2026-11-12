"use client";

import { cn } from "@/lib/utils";

/** BEAN FX brand mark — a stylized gold bean glyph + wordmark. */
export function BeanMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={cn("h-7 w-7", className)} aria-hidden="true">
      <path
        d="M16 3C9.4 3 4.5 8.6 4.5 16S9.4 29 16 29s11.5-5.6 11.5-13c0-2.8-.7-5.4-2-7.5-.5-.9-1.5-1.2-2.3-.7-.8.5-1.1 1.5-.7 2.3 1 1.7 1.6 3.7 1.6 5.9 0 5.8-3.7 10.2-8.1 10.2S7.9 21.8 7.9 16 11.6 5.8 16 5.8c1.4 0 2.7.4 3.9 1.2.9.5 2 .3 2.5-.6.5-.9.3-2-.6-2.5C20 3.3 18.1 3 16 3z"
        fill="currentColor"
      />
      <circle cx="21.5" cy="16" r="2.6" fill="currentColor" opacity="0.55" />
    </svg>
  );
}

export function BeanLogo({ className, markClassName }: { className?: string; markClassName?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 select-none", className)}>
      <BeanMark className={cn("text-[#d4a017]", markClassName)} />
      <span className="font-extrabold tracking-tight text-white text-[17px] leading-none">
        BEAN<span className="text-[#d4a017]"> FX</span>
      </span>
    </span>
  );
}
