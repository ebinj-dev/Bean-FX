import type { Metadata } from "next";
import { LegalDraftBanner } from "../draft-note";

export const metadata: Metadata = {
  title: "Copyright & IP Policy (draft) — BEAN FX",
  description: "Your rights to uploaded media, BEAN FX's IP position, takedown reporting channels and India-aware grievance placeholders.",
  alternates: { canonical: "/legal/copyright" },
};

const UPDATED = "2026-11-26";

export default function CopyrightPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-14 sm:px-6">
      <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#d4a017]">Legal (draft)</p>
      <h1 className="mt-2 text-3xl font-bold text-white sm:text-4xl">Copyright &amp; Intellectual Property Policy</h1>
      <LegalDraftBanner document="policy draft" updated={UPDATED} />

      <h2 className="mt-9 text-xl font-bold text-white">1. Your media, your rights</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        You retain ownership of everything you upload or create in BEAN FX. We claim no license over your content
        beyond what is technically required to process it for you (storage, transcoding, rendering) — and original
        source files are never modified; exports are new files. Generated assets are produced for you from your own
        parameters and references.
      </p>

      <h2 className="mt-8 text-xl font-bold text-white">2. BEAN FX&apos;s own rights</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        The BEAN FX application code, brand and product identity belong to the repository owner. Third-party
        components are governed by their own licenses — see the{" "}
        <a href="/open-source" className="text-[#d4a017] hover:underline">Open Source &amp; Credits Center</a> for the
        audited inventory, license texts and risk report. AI-assistant-generated modifications do not remove upstream
        license obligations.
      </p>

      <h2 className="mt-8 text-xl font-bold text-white">3. Reporting infringement</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        If you believe content accessible through BEAN FX infringes your copyright or other rights, send a notice
        including: identification of the work, the allegedly infringing material (URL or project reference), your
        contact details, a good-faith statement, and your authority to act (owner or authorized agent), to{" "}
        <em>[OWNER TO CONFIRM: copyright notice email]</em>. We will act on valid notices — removal or disabling access
        — and inform the affected user where required.
      </p>
      <p className="mt-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        Counter-notices follow the same channel; repeat-infringer handling will be defined in the final approved
        policy.
      </p>

      <h2 className="mt-8 text-xl font-bold text-white">4. India-aware provisions (placeholders)</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        Where the operator is established in India, the Information Technology Act, 2000 and the IT (Intermediary
        Guidelines and Digital Media Ethics Code) Rules, 2021 require a designated grievance officer and
        time-bound redressal. Because no owner entity has been confirmed yet, these details are intentionally not
        invented:
      </p>
      <ul className="mt-2 space-y-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        <li>Grievance officer: <em>[OWNER TO CONFIRM — name and contact; must be published before claiming intermediary status]</em></li>
        <li>Redressal timelines: <em>[OWNER TO CONFIRM — final policy will state the statutory periods]</em></li>
        <li>Registered entity and address: <em>[OWNER TO CONFIRM]</em></li>
      </ul>
      <p className="mt-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        Nothing in this draft asserts that BEAN FX currently claims intermediary safe-harbor status.
      </p>

      <h2 className="mt-8 text-xl font-bold text-white">5. Third-party licenses in the product</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-[#b8b8b0]">
        Bundled fonts are OFL-1.1; the dependency tree is audited continuously (see the credits center). Items with
        unresolved commercial-use terms are excluded from commercial distribution until resolved — currently flagged:
        the GPL-enabled FFmpeg system build and the @codesandbox/nodebox transitive package.
      </p>
    </div>
  );
}
