"use client";
/** M20 §4 — real reset-password flow (the M19 page was descriptive only).
 * Accepts `?token=` from the email link and a manual paste form. */
import { useEffect, useState } from "react";

export default function ResetPasswordClient() {
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Prefill the token from the emailed link.
  useEffect(() => {
    const t = new URL(window.location.href).searchParams.get("token");
    if (t) setToken(t);
  }, []);

  const passwordsMatch = password.length >= 8 && password === confirm;

  return (
    <div className="mt-6 space-y-4">
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!passwordsMatch || busy) return;
          setBusy(true);
          setResult(null);
          try {
            const res = await fetch("/api/auth/reset-password", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ token: token.trim(), password }),
            });
            const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
            setResult({ ok: res.ok && Boolean(body.ok), message: body.message ?? body.error ?? `Reset failed (${res.status}).` });
          } catch {
            setResult({ ok: false, message: "Reset request failed. Please retry." });
          } finally {
            setBusy(false);
          }
        }}
      >
        <input
          placeholder="Reset token from the email"
          aria-label="Reset token"
          className="w-full rounded border border-[#2a2a2a] bg-[#101010] px-3 py-2 text-[14px] text-white outline-none focus:border-[#d4a017]"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <input
          type="password"
          placeholder="New password (8+ chars, letters and numbers)"
          aria-label="New password"
          autoComplete="new-password"
          className="w-full rounded border border-[#2a2a2a] bg-[#101010] px-3 py-2 text-[14px] text-white outline-none focus:border-[#d4a017]"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <input
          type="password"
          placeholder="Repeat the new password"
          aria-label="Confirm new password"
          autoComplete="new-password"
          className="w-full rounded border border-[#2a2a2a] bg-[#101010] px-3 py-2 text-[14px] text-white outline-none focus:border-[#d4a017]"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <button
          type="submit"
          disabled={busy || !passwordsMatch || !token}
          className="rounded bg-[#d4a017] px-4 py-2 text-[12px] font-bold uppercase tracking-[0.14em] text-[#0b0b0a] hover:bg-[#e0b23a] disabled:opacity-40"
        >
          {busy ? "Resetting…" : "Choose new password"}
        </button>
      </form>
      {result && (
        <p role="status" className={result.ok ? "text-[14px] text-emerald-400" : "text-[14px] text-[#c45c4c]"}>
          {result.ok ? "✓ " : ""}{result.message}
          {result.ok && " Continue to the sign-in page."}
        </p>
      )}
    </div>
  );
}
