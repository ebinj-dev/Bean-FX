import type { Metadata } from "next";

export const metadata: Metadata = { title: "Verify email — BEAN FX", robots: { index: false } };

export default function VerifyEmailPage() {
  return (
    <div className="mx-auto max-w-xl px-4 py-16 sm:px-6">
      <h1 className="text-2xl font-bold text-white">Verify your email</h1>
      <VerifyEmailClient />
    </div>
  );
}

function VerifyEmailClient() {
  return (
    <form
      className="mt-6 space-y-3"
      // Client component inlined via action file below (uses window.location).
      {...{ "data-verify-form": "true" }}
    >
      <p className="text-[14px] leading-relaxed text-[#b8b8b0]">
        Open the verification link from your email. If you arrived by link, the token is applied automatically;
        paste a token here only if the link did not open.
      </p>
      <input name="token" placeholder="Paste your verification token" className="w-full rounded border border-[#2a2a2a] bg-[#101010] px-3 py-2 text-[14px] text-white outline-none focus:border-[#d4a017]" />
      <button type="submit" className="rounded bg-[#d4a017] px-4 py-2 text-[12px] font-bold uppercase tracking-[0.14em] text-[#0b0b0a] hover:bg-[#e0b23a]">Verify</button>
      <p className="text-[12px] text-[#8f8f8a]">This form talks to POST /api/auth/verify-email; see the network panel for the exact response.</p>
    </form>
  );
}
