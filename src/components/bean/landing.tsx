"use client";

import { ArrowRight, AudioLines, ScanLine, ShieldCheck, Scissors, Captions, Droplets, AudioWaveform, Film } from "lucide-react";
import { BeanLogo } from "@/components/bean/logo";
import { SITE_LEGAL_ITEMS, SITE_NAV_ITEMS } from "@/components/bean/nav-items";

const CAPABILITIES = [
  { icon: AudioLines, label: "MP3 · WAV · M4A · AAC · FLAC" },
  { icon: ScanLine, label: "10 ms frame analysis" },
  { icon: ShieldCheck, label: "Originals never modified" },
];

const TOOLS = [
  {
    icon: Scissors,
    name: "AUTO CUT",
    title: "Silence removal with review-first cut planning",
    body: "Analyze the real waveform with an adaptive noise floor, preview proposed cuts on a zoomable timeline, and approve every removal before anything is applied. RIISHE adds content-aware classification when inference is configured.",
    href: "#/autocut",
  },
  {
    icon: Captions,
    name: "CAPTIONS",
    title: "Real transcription and a full caption editor",
    body: "Transcribe with the configured ASR provider, then edit text and timing with split, merge, add and delete. Import and export SRT and VTT with validation — Unicode text in English, Tamil, Hindi and mixed-language content is preserved.",
    href: "#/captions",
  },
  {
    icon: Droplets,
    name: "WATERMARK",
    title: "Honest watermark removal, three real methods",
    body: "Select the region directly on the video frame and choose blur, delogo interpolation, or edge crop. Each method states exactly what it can and cannot do — no illusion of perfect reconstruction.",
    href: "#/watermark",
  },
  {
    icon: AudioWaveform,
    name: "AUDIO",
    title: "Clean, shape and export professional audio",
    body: "Trim, gain, fades, loudness or peak normalization, FFT noise reduction and channel handling — processed by a real ffmpeg pipeline with validated MP3, WAV, M4A, AAC and FLAC exports.",
    href: "#/audio",
  },
  {
    icon: Film,
    name: "B-ROLL",
    title: "A local B-roll library tied to your transcript",
    body: "Build a library of your own footage with real metadata, search it by keyword, and get insertion suggestions linked to transcript segments when genuine transcript evidence exists. Export a valid editing plan.",
    href: "#/broll",
  },
];

export function LandingPage({ onOpenStudio, onLogin }: { onOpenStudio: () => void; onLogin?: () => void }) {
  return (
    <div className="min-h-screen bg-[#050505]">
      {/* HERO */}
      <section className="bean-hero-light relative overflow-hidden">
        <div className="mx-auto max-w-6xl px-4 pb-16 pt-20 text-center sm:px-6 sm:pt-24">
          <h1 className="text-[42px] font-extrabold leading-[1.04] tracking-[-0.02em] text-white sm:text-6xl md:text-[76px]">
            EDIT <span className="text-[#d4a017]">FASTER.</span>
            <br />
            CREATE <span className="text-[#d4a017]">BETTER.</span>
          </h1>

          <p className="mx-auto mt-7 max-w-xl text-base font-semibold text-white sm:text-lg">
            AI-powered editing tools built for creators.
          </p>
          <p className="mx-auto mt-2.5 max-w-xl text-sm leading-relaxed text-[#8f8f8a] sm:text-[15px]">
            Cut silence, generate captions, remove watermarks, clean audio and export professional media — all from one
            workspace.
          </p>

          <div className="mt-9 flex flex-wrap items-center justify-center gap-3.5">
            <button
              onClick={onOpenStudio}
              className="bean-glow inline-flex h-11 items-center gap-2 rounded-md bg-[#d4a017] px-6 text-[12px] font-extrabold uppercase tracking-[0.14em] text-[#0c0c0c] transition-colors hover:bg-[#e9b52a]"
            >
              OPEN STUDIO
              <ArrowRight className="h-4 w-4" strokeWidth={2.5} />
            </button>
            <a
              href="#features"
              className="inline-flex h-11 items-center gap-2 rounded-md border border-[#2a2a2a] bg-[#121212] px-6 text-[12px] font-extrabold uppercase tracking-[0.14em] text-white transition-colors hover:border-[#3a3a3a] hover:bg-[#181818]"
            >
              EXPLORE FEATURES
            </a>
          </div>

          {/* Capability strip */}
          <div className="mt-12 flex justify-center px-2">
            <div className="inline-flex max-w-full flex-wrap items-center justify-center gap-x-0 gap-y-2 rounded-xl border border-[#1f1f1f] bg-[#0d0d0d] px-3 py-2.5 sm:gap-x-1 sm:px-4">
              {CAPABILITIES.map((cap, i) => (
                <span key={cap.label} className="flex items-center">
                  {i > 0 && <span className="mx-2 hidden h-4 w-px bg-[#242424] sm:block" aria-hidden="true" />}
                  <span className="flex items-center gap-2 whitespace-nowrap px-1.5">
                    <cap.icon className="h-3.5 w-3.5 text-[#d4a017]" strokeWidth={2.2} />
                    <span className="text-[10.5px] font-semibold tracking-wide text-[#8f8f8a] sm:text-[11.5px]">
                      {cap.label}
                    </span>
                  </span>
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* FEATURES */}
      <section id="features" className="scroll-mt-20 border-t border-[#141414]">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <div className="text-center">
            <span className="mx-auto block h-0.5 w-9 bg-[#d4a017]" aria-hidden="true" />
            <p className="bean-label mt-5 text-[11px] text-[#d4a017]">HOW BEAN FX WORKS</p>
            <h2 className="mt-3 text-3xl font-extrabold tracking-tight text-white sm:text-4xl">
              One workspace. Every step handled.
            </h2>
          </div>

          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {TOOLS.map((tool) => (
              <a
                key={tool.name}
                href={tool.href}
                className="group flex flex-col rounded-xl border border-[#1c1c1c] bg-[#0d0d0d] p-6 transition-colors hover:border-[#2e2e2e] hover:bg-[#111111]"
              >
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-[#242424] bg-[#141414]">
                  <tool.icon className="h-5 w-5 text-[#d4a017]" strokeWidth={2} />
                </span>
                <span className="bean-label mt-5 text-[11px] text-[#d4a017]">{tool.name}</span>
                <span className="mt-2 text-[15px] font-bold leading-snug text-white">{tool.title}</span>
                <span className="mt-2.5 flex-1 text-[13px] leading-relaxed text-[#8f8f8a]">{tool.body}</span>
                <span className="mt-5 inline-flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-[0.14em] text-white transition-colors group-hover:text-[#d4a017]">
                  OPEN TOOL
                  <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" strokeWidth={2.5} />
                </span>
              </a>
            ))}

            {/* Sixth card: workflow overview (keeps grid balanced) */}
            <div className="flex flex-col rounded-xl border border-[#241f10] bg-gradient-to-b from-[#141007] to-[#0d0d0d] p-6">
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-[#2e2410] bg-[#191307]">
                <ShieldCheck className="h-5 w-5 text-[#d4a017]" strokeWidth={2} />
              </span>
              <span className="bean-label mt-5 text-[11px] text-[#d4a017]">SAFE BY DESIGN</span>
              <span className="mt-2 text-[15px] font-bold leading-snug text-white">
                Non-destructive, evidence-backed editing
              </span>
              <span className="mt-2.5 flex-1 text-[13px] leading-relaxed text-[#8f8f8a]">
                Your original recordings are never modified. Every export is a new, validated file. Cuts require explicit
                approval, deterministic suggestions are labeled as such, and AI claims appear only when real inference ran.
              </span>
              <button
                onClick={onOpenStudio}
                className="mt-5 inline-flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-[0.14em] text-white transition-colors hover:text-[#d4a017]"
              >
                OPEN STUDIO
                <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.5} />
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* CTA BAND */}
      <section className="border-t border-[#141414]">
        <div className="mx-auto max-w-6xl px-4 py-16 text-center sm:px-6">
          <h2 className="text-2xl font-extrabold tracking-tight text-white sm:text-3xl">
            Ready to edit <span className="text-[#d4a017]">faster</span>?
          </h2>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3.5">
            <button
              onClick={onOpenStudio}
              className="bean-glow inline-flex h-11 items-center gap-2 rounded-md bg-[#d4a017] px-6 text-[12px] font-extrabold uppercase tracking-[0.14em] text-[#0c0c0c] transition-colors hover:bg-[#e9b52a]"
            >
              GET STARTED
              <ArrowRight className="h-4 w-4" strokeWidth={2.5} />
            </button>
            {!onLogin ? null : (
              <button
                onClick={onLogin}
                className="inline-flex h-11 items-center rounded-md border border-[#2a2a2a] bg-[#121212] px-6 text-[12px] font-extrabold uppercase tracking-[0.14em] text-white transition-colors hover:border-[#3a3a3a]"
              >
                LOGIN
              </button>
            )}
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="mt-auto border-t border-[#161616] bg-[#070707]">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-5 px-4 py-8 sm:px-6 md:flex-row">
          <BeanLogo />
          <nav className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2" aria-label="Footer">
            {SITE_NAV_ITEMS.map((item) => (
              <a
                key={item.label}
                href={item.href}
                className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-[#8f8f8a] transition-colors hover:text-white"
              >
                {item.label}
              </a>
            ))}
            {/* M19: legal & marketing pages — real routes, not SPA hashes */}
            {SITE_LEGAL_ITEMS.filter((_, i) => i % 3 === 0 || i > 5).map((item) => (
              <a
                key={item.href}
                href={item.href}
                className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-[#6f6f68] transition-colors hover:text-white"
              >
                {item.label.toUpperCase()}
              </a>
            ))}
          </nav>
          <p className="text-[11px] text-[#5c5c58]">© {new Date().getFullYear()} BEAN FX. Process your own media.</p>
        </div>
      </footer>
    </div>
  );
}
