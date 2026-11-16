import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Contact & Support — BEAN FX",
  description: "How to reach BEAN FX support, report bugs, request features, and report security vulnerabilities.",
  alternates: { canonical: "/contact" },
};

const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? process.env.SUPPORT_EMAIL ?? "";

export default function ContactPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-14 sm:px-6">
      <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#d4a017]">Contact</p>
      <h1 className="mt-2 text-3xl font-bold text-white sm:text-4xl">Contact &amp; support</h1>

      {SUPPORT_EMAIL ? (
        <p className="mt-5 text-[15px] leading-relaxed text-[#b8b8b0]">
          Support email: <a className="text-[#d4a017] hover:underline" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
        </p>
      ) : (
        <div className="mt-5 rounded-lg border border-[#c45c4c]/50 bg-[#c45c4c]/5 p-4 text-[13.5px] leading-relaxed text-[#c9c9c2]">
          <strong className="text-[#c45c4c]">Support email not configured.</strong> This deployment has not set a
          support address (SUPPORT_EMAIL), so no contact link is shown — we will not publish a broken one.
          The operator can configure it via the environment; see the FAQ meanwhile.
        </div>
      )}

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <section className="rounded-lg border border-[#1c1c1a] bg-[#101010] p-4">
          <h2 className="text-[13px] font-bold tracking-[0.14em] text-[#d4a017]">Bug reports</h2>
          <p className="mt-2 text-[13.5px] leading-relaxed text-[#b8b8b0]">
            Include what you clicked, what you expected, what happened, and (if an error code appeared) the code and
            the request ID shown with it. Request IDs let the operator match your report to server-side diagnostics.
          </p>
        </section>
        <section className="rounded-lg border border-[#1c1c1a] bg-[#101010] p-4">
          <h2 className="text-[13px] font-bold tracking-[0.14em] text-[#d4a017]">Feature requests</h2>
          <p className="mt-2 text-[13.5px] leading-relaxed text-[#b8b8b0]">
            Describe the editing outcome you are trying to reach — concrete workflows are far more actionable than
            feature lists.
          </p>
        </section>
        <section className="rounded-lg border border-[#1c1c1a] bg-[#101010] p-4 sm:col-span-2">
          <h2 className="text-[13px] font-bold tracking-[0.14em] text-[#d4a017]">Security vulnerabilities</h2>
          <p className="mt-2 text-[13.5px] leading-relaxed text-[#b8b8b0]">
            Report suspected security issues privately and do not open public threads for them. Include reproduction
            steps and affected URLs. If a support email is configured above, use it with the subject line starting
            &quot;[security]&quot;; reports are triaged before feature work.
          </p>
        </section>
      </div>
      <p className="mt-8 text-[13px] text-[#8f8f8a]">
        Documentation lives at <a className="text-[#d4a017] hover:underline" href="/help">Help</a>.
      </p>
    </div>
  );
}
