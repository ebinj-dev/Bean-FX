import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Pricing — BEAN FX",
  description: "BEAN FX pricing status: the product is not yet accepting payments. No payment integrations exist; this page will present real plans when billing ships.",
  alternates: { canonical: "/pricing" },
};

export default function PricingPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-14 sm:px-6">
      <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#d4a017]">Pricing</p>
      <h1 className="mt-2 text-3xl font-bold text-white sm:text-4xl">Not yet accepting payments</h1>
      <p className="mt-4 max-w-3xl text-[15px] leading-relaxed text-[#b8b8b0]">
        BEAN FX does not currently have a billing system. There is no payment provider integration, no paid plan,
        and no subscription to buy. You do not need a credit card to use the product: register an account and start
        editing.
      </p>
      <div className="mt-8 rounded-lg border border-[#d4a017]/40 bg-[#d4a017]/5 p-5">
        <h2 className="text-[14px] font-bold text-[#d4a017]">What this page will become</h2>
        <p className="mt-2 text-[13.5px] leading-relaxed text-[#b8b8b0]">
          When billing ships, this page will present the actual plans, their limits (storage, render minutes, AI
          generation quotas) and the refund terms that are actually implemented — not placeholders.
        </p>
      </div>
      <p className="mt-8 text-[13px] text-[#8f8f8a]">
        Questions about future plans? Use the <Link href="/contact" className="text-[#d4a017] hover:underline">contact page</Link>.
      </p>
    </div>
  );
}
