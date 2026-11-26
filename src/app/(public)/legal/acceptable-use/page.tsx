import type { Metadata } from "next";
import { LegalDraftBanner } from "../draft-note";

export const metadata: Metadata = {
  title: "Acceptable Use Policy (draft) — BEAN FX",
  description: "Content you may process in BEAN FX, prohibited uses, automation limits and enforcement.",
  alternates: { canonical: "/legal/acceptable-use" },
};

const UPDATED = "2026-11-26";

export default function AcceptableUsePage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-14 sm:px-6">
      <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#d4a017]">Legal (draft)</p>
      <h1 className="mt-2 text-3xl font-bold text-white sm:text-4xl">Acceptable Use Policy</h1>
      <LegalDraftBanner document="policy draft" updated={UPDATED} />

      <h2 className="mt-9 text-xl font-bold text-white">1. Media you may process</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        BEAN FX processes <strong className="text-white">your own media</strong> — recordings, footage, music and
        images you created, own, or are licensed to edit. You keep the rights and the responsibility. Processing
        another person&apos;s copyrighted work without a license or legal justification is not permitted.
      </p>

      <h2 className="mt-8 text-xl font-bold text-white">2. Prohibited uses</h2>
      <ul className="mt-2 space-y-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        <li className="flex gap-3"><span className="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[#d4a017]" aria-hidden />Uploading or processing unlawful content: material that is illegal in the applicable jurisdiction, including non-consensual intimate imagery, child sexual abuse material, or content inciting violence.</li>
        <li className="flex gap-3"><span className="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[#d4a017]" aria-hidden />Infringing others&apos; rights: copyright, trademark, publicity, privacy — including circumvention of technical protection measures.</li>
        <li className="flex gap-3"><span className="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[#d4a017]" aria-hidden />Deceptive media: using generation or editing tools to fabricate evidence, defraud, or impersonate real people without clear disclosure.</li>
        <li className="flex gap-3"><span className="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[#d4a017]" aria-hidden />Abusing the service: automated bulk access outside your granted automation tokens, attempts to bypass approval gates, security testing without written permission, or resource exhaustion.</li>
        <li className="flex gap-3"><span className="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[#d4a017]" aria-hidden />Reselling raw processing capacity: BEAN FX is a workspace, not an API quota reseller.</li>
      </ul>

      <h2 className="mt-8 text-xl font-bold text-white">3. Automation</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        Automation tokens (MCP) are scoped, approval-gated and revocable. Automated agents act under your account and
        are bound by this policy; you are responsible for what they do.
      </p>

      <h2 className="mt-8 text-xl font-bold text-white">4. Enforcement</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        Violations may result in content quarantine, feature restriction, suspension, or termination. Where the law
        requires, affected users are informed. Legal requests are honored only through the proper channels.{" "}
        <em>[OWNER TO CONFIRM: enforcement authority, jurisdiction, and escalation contact.]</em>
      </p>

      <h2 className="mt-8 text-xl font-bold text-white">5. Reports</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        Report policy violations to <em>[OWNER TO CONFIRM: abuse contact email]</em>. Reports that identify specific
        content and a specific violation are actionable; mass accusations are not.
      </p>
    </div>
  );
}
