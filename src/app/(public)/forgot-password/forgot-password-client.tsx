"use client";
/** M20 §4 — real forgot-password flow (the M19 page was descriptive only). */
import { useState } from "react";

export default function ForgotPasswordClient() {
  const [email, setEmail] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="mt-6 space-y-4">
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!email || busy) return;
          setBusy(true);
          setResult(null);
          try {
            const res = await fetch("/api/auth/forgot-password", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ email: email.trim() }),
            });
            const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
            // Intentionally identical wording for known and unknown addresses.
            setResult(res.ok ? body.message ?? "If that email is registered, a reset link is on its way (valid for 30 minutes)." : body.error ?? `Request failed (${res.status}).`);
          } catch {
            setResult("Request failed. Please retry.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <input
          type="email"
          required
          placeholder="you@studio.com"
          aria-label="Account email"
          className="w-full rounded border border-[#2a2a2a] bg-[#101010] px-3 py-2 text-[14px] text-white outline-none focus:border-[#d4a017]"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <button
          type="submit"
          disabled={busy || !email}
          className="rounded bg-[#d4a017] px-4 py-2 text-[12px] font-bold uppercase tracking-[0.14em] text-[#0b0b0a] hover:bg-[#e0b23a] disabled:opacity-40"
        >
          {busy ? "Sending…" : "Send reset link"}
        </button>
      </form>
      {result && (
        <p role="status" className="text-[14px] text-[#d8d8d2]">
          {result}
        </p>
      )}
      <p className="text-[13px] text-[#8f8f8a]">
        Already have a reset token? Continue to <a className="text-[#d4a017] hover:underline" href="/reset-password">reset-password</a>.
      </p>
    </div>
  );
}
