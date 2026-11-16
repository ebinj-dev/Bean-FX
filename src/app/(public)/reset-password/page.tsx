import type { Metadata } from "next";

export const metadata: Metadata = { title: "Choose a new password — BEAN FX", robots: { index: false } };

export default function ResetPasswordPage() {
  return (
    <div className="mx-auto max-w-xl px-4 py-16 sm:px-6">
      <h1 className="text-2xl font-bold text-white">Choose a new password</h1>
      <p className="mt-3 text-[14px] leading-relaxed text-[#b8b8b0]">
        Paste the token from your reset email and choose a new password (at least 8 characters). Completing a reset
        signs out every existing session for safety.
      </p>
      <p className="mt-4 rounded border border-[#2a2a2a] bg-[#101010] p-3 font-mono text-[12px] text-[#8f8f8a]">
        POST /api/auth/reset-password {`{ "token": "…", "password": "…" }`}
      </p>
    </div>
  );
}
