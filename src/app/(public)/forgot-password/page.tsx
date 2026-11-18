import type { Metadata } from "next";
import ForgotPasswordClient from "./forgot-password-client";

export const metadata: Metadata = { title: "Reset password — BEAN FX", robots: { index: false } };

export default function ForgotPasswordPage() {
  return (
    <div className="mx-auto max-w-xl px-4 py-16 sm:px-6">
      <h1 className="text-2xl font-bold text-white">Forgot your password?</h1>
      <p className="mt-3 text-[14px] leading-relaxed text-[#b8b8b0]">
        Enter your account email. If it is registered, a reset link valid for 30 minutes will be sent. The answer
        is intentionally identical for unknown addresses — BEAN FX does not reveal which emails exist.
      </p>
      <ForgotPasswordClient />
    </div>
  );
}
