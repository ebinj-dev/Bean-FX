import type { Metadata } from "next";
import Link from "next/link";
import { LegalDraftBanner } from "./draft-note";

export const metadata: Metadata = {
  title: "Legal & Trust Center — BEAN FX",
  description: "Draft policies: Terms of Service, Privacy, AI Processing & Data Usage, Voice & Audio Data, Acceptable Use, Copyright & IP, and Open Source notices.",
  alternates: { canonical: "/legal" },
};

const UPDATED = "2026-11-26";

const POLICIES: Array<{ href: string; title: string; status: string; note: string }> = [
  { href: "/terms", title: "Terms of Service", status: "DRAFT", note: "Account, media processing and usage terms. Payment terms intentionally omitted until a billing launch is approved." },
  { href: "/privacy", title: "Privacy Policy", status: "DRAFT", note: "Account data, project data, media, voice audio, AI processing and data export/deletion — based on verified behavior." },
  { href: "/legal/ai-processing", title: "AI Processing & Data Usage Policy", status: "DRAFT", note: "What the configured AI gateway receives, how model involvement is disclosed, provenance, and what is never claimed." },
  { href: "/legal/voice-data", title: "Voice & Audio Data Policy", status: "DRAFT", note: "Microphone activation, transcription path, TTS, language-status honesty, retention-by-default-none." },
  { href: "/legal/acceptable-use", title: "Acceptable Use Policy", status: "DRAFT", note: "Content you may process, prohibited uses, automation limits and enforcement." },
  { href: "/legal/copyright", title: "Copyright & Intellectual Property Policy", status: "DRAFT", note: "Your rights to uploaded media, reporting channels and India-aware grievance placeholders." },
  { href: "/open-source", title: "Open Source & Third-Party Notices", status: "LIVE DATA", note: "Audited dependency inventory, SBOM, license copies and risk report — generated from the real manifests." },
];

export default function LegalCenterPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-14 sm:px-6">
      <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#d4a017]">Trust</p>
      <h1 className="mt-2 text-3xl font-bold text-white sm:text-4xl">Legal &amp; Trust Center</h1>
      <LegalDraftBanner document="policy set" updated={UPDATED} />

      <div className="mt-8 space-y-3">
        {POLICIES.map((p) => (
          <Link key={p.href} href={p.href} className="block rounded-lg border border-[#1c1c1c] bg-[#0d0d0d] p-4 transition-colors hover:border-[#2e2e2e] hover:bg-[#111111]">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-[14.5px] font-bold text-white">{p.title}</span>
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.1em] ${p.status === "LIVE DATA" ? "bg-[#153b1e] text-[#4cc47f]" : "bg-[#3b2b10] text-[#dcc27e]"}`}>{p.status}</span>
            </span>
            <span className="mt-1.5 block text-[12.5px] leading-relaxed text-[#8f8f8a]">{p.note}</span>
          </Link>
        ))}
      </div>

      <h2 className="mt-10 text-xl font-bold text-white">Acceptance and consent — how this works today</h2>
      <ul className="mt-3 space-y-2.5 text-[13.5px] leading-relaxed text-[#b8b8b0]">
        <li>
          <strong className="text-white">Account acceptance is explicit and mandatory:</strong> registration requires an
          unchecked-by-default checkbox accepting the draft Terms and the AI Processing Policy, with their draft status
          stated in the same sentence.
        </li>
        <li>
          <strong className="text-white">No marketing consent is requested</strong> — BEAN FX sends no marketing
          communications, so none is bundled with account acceptance. If marketing ever launches, it will be a separate,
          optional, independently revocable consent.
        </li>
        <li>
          <strong className="text-white">Browsing the credits page binds you to nothing:</strong> the Open Source &amp;
          Credits Center never requires acceptance of third-party license terms — viewing it accepts no licenses.
        </li>
        <li>
          <strong className="text-white">Acceptance tracking is deliberately not implemented yet:</strong> per-account
          acceptance records and policy versioning start only after owner-approved final terms exist; recording consent
          for drafts would misrepresent their status.
        </li>
      </ul>

      <h2 className="mt-10 text-xl font-bold text-white">Contact</h2>
      <p className="mt-3 text-[13.5px] leading-relaxed text-[#b8b8b0]">
        Legal, privacy and grievance contact details are not yet published because no owner entity has been confirmed.
        When appointed, the grievance officer details required by the Indian IT Rules will appear here and in the
        Copyright policy — with a real name, not a placeholder.
      </p>
    </div>
  );
}
