import type { Metadata } from "next";
import VerifyEmailClient from "./verify-email-client";

export const metadata: Metadata = { title: "Verify email — BEAN FX", robots: { index: false } };

export default function VerifyEmailPage() {
  return (
    <div className="mx-auto max-w-xl px-4 py-16 sm:px-6">
      <h1 className="text-2xl font-bold text-white">Verify your email</h1>
      <VerifyEmailClient />
    </div>
  );
}
