"use client";
/**
 * M20 §4 step 5 fix — the M19 page rendered a decorative form with no event
 * wiring (found by the M20 browser journey). Real behavior now:
 *  - a `?token=` link auto-submits once on mount;
 *  - the paste form POSTs to /api/auth/verify-email and shows the result.
 */
import { useCallback, useEffect, useRef, useState } from "react";

type Result = { ok: boolean; message: string };

export default function VerifyEmailClient() {
  const [token, setToken] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const autoRan = useRef(false);

  const verify = useCallback(async (raw: string) => {
    if (!raw || busy) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/auth/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: raw.trim() }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
      setResult({ ok: res.ok && Boolean(body.ok), message: body.message ?? body.error ?? `Verification failed (${res.status}).` });
    } catch {
      setResult({ ok: false, message: "Verification request failed. Please retry." });
    } finally {
      setBusy(false);
    }
  }, [busy]);

  // Email links arrive as /verify-email?token=… — apply automatically once.
  useEffect(() => {
    if (autoRan.current) return;
    const url = new URL(window.location.href);
    const t = url.searchParams.get("token");
    if (t) {
      autoRan.current = true;
      setToken(t);
      void verify(t);
    }
  }, [verify]);

  // Verified state replaces the form entirely: re-submitting a consumed
  // token would overwrite the success with a red "invalid/expired" error
  // (found by the M20 journey — the auto-verify succeeds, then a programmatic
  // paste+click re-POSTs the same token and clobbers the result).
  if (result?.ok) {
    return (
      <div className="mt-6 space-y-3">
        <p role="status" className="text-[14px] text-emerald-400">
          ✓ {result.message} You can now sign in.
        </p>
      </div>
    );
  }
  return (
    <div className="mt-6 space-y-3">
      <p className="text-[14px] leading-relaxed text-[#b8b8b0]">
        Open the verification link from your email — the token is applied automatically.
        Paste a token here only if the link did not open.
      </p>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void verify(token);
        }}
      >
        <input
          name="token"
          placeholder="Paste your verification token"
          className="w-full rounded border border-[#2a2a2a] bg-[#101010] px-3 py-2 text-[14px] text-white outline-none focus:border-[#d4a017]"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <button
          type="submit"
          disabled={busy || !token}
          className="rounded bg-[#d4a017] px-4 py-2 text-[12px] font-bold uppercase tracking-[0.14em] text-[#0b0b0a] hover:bg-[#e0b23a] disabled:opacity-40"
        >
          {busy ? "Verifying…" : "Verify"}
        </button>
      </form>
      {result && (
        <p role="status" className={result.ok ? "text-[14px] text-emerald-400" : "text-[14px] text-[#c45c4c]"}>
          {result.ok ? "✓ " : ""}{result.message}
          {result.ok && " You can now sign in."}
        </p>
      )}
    </div>
  );
}
