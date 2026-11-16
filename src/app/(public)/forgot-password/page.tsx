import type { Metadata } from "next";

export const metadata: Metadata = { title: "Reset password — BEAN FX", robots: { index: false } };

export default function ForgotPasswordPage() {
  return (
    <div className="mx-auto max-w-xl px-4 py-16 sm:px-6">
      <h1 className="text-2xl font-bold text-white">Forgot your password?</h1>
      <p className="mt-3 text-[14px] leading-relaxed text-[#b8b8b0]">
        Enter your account email. If it is registered, a reset link valid for 30 minutes will be sent. The answer
        is intentionally identical for unknown addresses — BEAN FX does not reveal which emails exist.
      </p>
      <p className="mt-4 rounded border border-[#2a2a2a] bg-[#101010] p-3 font-mono text-[12px] text-[#8f8f8a]">
        POST /api/auth/forgot-password {`{ "email": "you@example.com" }`}
      </p>
      <p className="mt-4 text-[13px] text-[#8f8f8a]">
        Already have a reset token? Continue to <a className="text-[#d4a017] hover:underline" href="/reset-password">reset-password</a>.
      </p>
    </div>
  );
}
