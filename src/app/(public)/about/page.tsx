import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "About — BEAN FX",
  description: "What BEAN FX is, honestly: an independent browser-based video editing product in active development.",
  alternates: { canonical: "/about" },
};

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-14 sm:px-6">
      <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#d4a017]">About</p>
      <h1 className="mt-2 text-3xl font-bold text-white sm:text-4xl">About BEAN FX</h1>
      <div className="mt-6 space-y-5 text-[15px] leading-relaxed text-[#b8b8b0]">
        <p>
          BEAN FX is a browser-based professional video editing workspace built around a multitrack timeline, a
          deterministic playback and audio engine, and a set of AI assistants that propose — but never silently
          apply — edits to your project.
        </p>
        <p>
          The product is in active development, delivered in public milestones: the editing workspace (M15), the
          playback and audio engines (M16), long-form playback and rendering hardening (M17), end-to-end editing
          validation including a verified ten-minute multitrack export (M18), and the public website, security
          hardening and legal framework you are reading now (M19).
        </p>
        <p>
          We keep the claims honest: features listed on this site exist in the product; effects parity is measured
          and documented; AI features run only when a provider is configured; and anything not yet true — billing,
          email delivery, formal compliance certifications — is labeled as such rather than implied.
        </p>
        <p className="text-[13px] text-[#8f8f8a]">
          Legal entity, registered address and jurisdiction: <strong className="text-[#d4a017]">to be confirmed by the product owner</strong> and
          reviewed by a qualified professional before public commercial launch. See the Terms of Service for the current status.
        </p>
      </div>
    </div>
  );
}
