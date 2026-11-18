import type { Metadata } from "next";
import ResetPasswordClient from "./reset-password-client";

export const metadata: Metadata = { title: "Choose a new password — BEAN FX", robots: { index: false } };

export default function ResetPasswordPage() {
  return (
    <div className="mx-auto max-w-xl px-4 py-16 sm:px-6">
      <h1 className="text-2xl font-bold text-white">Choose a new password</h1>
      <p className="mt-3 text-[14px] leading-relaxed text-[#b8b8b0]">
        Paste the token from your reset email and choose a new password (at least 8 characters). Completing a reset
        signs out every existing session for safety.
      </p>
      <ResetPasswordClient />
    </div>
  );
}
